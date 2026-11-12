import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { applyOutcome, applyPending, pendingCount, sqlNow, syncQueue } from "../../../src/shared/offline";
import type { PendingSale, SendResult } from "../../../src/shared/offline";
import { computePayment, parseEuro } from "../../../src/shared/money";
import { ApiError, api, errMsg, go } from "../api";
import { fmtTime } from "../format";
import { clearCachedState, newSaleId, readCachedState, readQueue, writeCachedState, writeQueue } from "../offlineStore";
import { shiftReportPdf } from "../pdf";
import type { Article, CashierState, Report, Sale } from "../types";
import { MoneyField, Modal, Stat, diffLabel, diffTone, euro, toast } from "../ui";

type Cart = Record<string, number>;
type BookResult = { change: number; donation: number; total: number; queued: boolean };

/** Fehler, bei denen ein Verkauf nicht verloren geht, sondern später nachgesendet wird */
const isRetryable = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status === 401 || e.status === 429 || e.status >= 500);

async function sendOne(s: PendingSale): Promise<SendResult> {
  try {
    await api(
      "/api/cashier/sales",
      "POST",
      {
        id: s.id,
        shift_id: s.shift_id,
        offline: true,
        created_at: s.created_at,
        items: s.items.map((i) => ({ article_id: i.article_id, qty: i.qty, unit_price_cents: i.unit_price_cents })),
        paid: s.paid_cents,
        donation: s.donation_cents,
      },
      8000,
    );
    return { kind: "ok" };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401) return { kind: "auth" };
      if (isRetryable(e)) return { kind: "retry" };
      return { kind: "rejected", error: e.message };
    }
    return { kind: "retry" };
  }
}

export function Cashier() {
  const [server, setServer] = useState<CashierState | null>(() => (navigator.onLine ? null : readCachedState()));
  const [queue, setQueue] = useState<PendingSale[]>(() => readQueue());
  const [offline, setOffline] = useState(!navigator.onLine);
  const [authLost, setAuthLost] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [cart, setCart] = useState<Cart>({});
  const [pay, setPay] = useState(false);
  const [result, setResult] = useState<BookResult | null>(null);
  const [history, setHistory] = useState(false);
  const [closing, setClosing] = useState(false);

  // Aktuelle Werte für Zeitgeber und Browser-Ereignisse (deren Funktionen sonst veraltete Werte sehen würden)
  const serverRef = useRef(server);
  serverRef.current = server;
  const offlineRef = useRef(offline);
  offlineRef.current = offline;
  const syncingRef = useRef(false);

  async function load(): Promise<CashierState | null> {
    try {
      const s = await api<CashierState>("/api/cashier/state", "GET", undefined, 8000);
      writeCachedState(s);
      setServer(s);
      setOffline(false);
      setAuthLost(false);
      return s;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        if (readQueue().length > 0) toast("Sitzung abgelaufen. Bitte den Code neu eingeben, wartende Verkäufe bleiben gespeichert.", "err");
        go("/");
        return null;
      }
      if (e instanceof ApiError && e.status === 0) {
        setOffline(true);
        setServer((cur) => cur ?? readCachedState());
        return null;
      }
      toast(errMsg(e), "err");
      return null;
    }
  }

  /** Wartende Verkäufe an den Server senden. Danach frischen Stand holen und beides gemeinsam übernehmen. */
  async function sync(shiftIdArg?: string) {
    const shiftId = shiftIdArg ?? serverRef.current?.shift.id;
    if (!shiftId || syncingRef.current) return;
    const snapshot = readQueue();
    if (!snapshot.some((q) => q.shift_id === shiftId && q.status === "pending")) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const out = await syncQueue(snapshot, shiftId, sendOne);
      setAuthLost(out.stoppedBy === "auth");
      if (out.stoppedBy === "retry") setOffline(true);
      else if (out.stoppedBy === null) setOffline(false);
      if (out.synced === 0 && out.rejected === 0) return;

      let fresh: CashierState | null = null;
      try {
        fresh = await api<CashierState>("/api/cashier/state", "GET", undefined, 8000);
      } catch {
        /* Verbindung wieder weg: übertragene Verkäufe bleiben vorerst in der Liste, beim nächsten Mal sind sie sofort "doppelt" und werden ignoriert */
      }
      // Neu hinzugekommene Verkäufe bleiben erhalten, deshalb auf die aktuell gespeicherte Liste anwenden
      const merged = applyOutcome(readQueue(), fresh ? out : { syncedIds: [], rejectedById: out.rejectedById });
      writeQueue(merged);
      setQueue(merged);
      if (fresh) {
        writeCachedState(fresh);
        setServer(fresh);
        if (out.synced > 0) toast(`${out.synced} wartende${out.synced === 1 ? "r Verkauf" : " Verkäufe"} übertragen ✓`);
      }
      if (out.rejected > 0) toast(`${out.rejected} Verkauf abgelehnt. Bitte unter „wartende Verkäufe“ prüfen.`, "err");
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }

  useEffect(() => {
    load().then((s) => s && sync(s.shift.id));
    const goOnline = () => {
      setOffline(false);
      load().then((s) => s && sync(s.shift.id));
    };
    const goOffline = () => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    // Auch ohne Browser-Meldung regelmäßig prüfen (WLAN mit Verbindung, aber ohne Internet)
    const timer = setInterval(() => {
      const shiftId = serverRef.current?.shift.id;
      if (shiftId && readQueue().some((q) => q.shift_id === shiftId && q.status === "pending")) sync(shiftId);
      else if (offlineRef.current) load();
    }, 15000);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      clearInterval(timer);
    };
  }, []);

  /** Verkauf buchen. Ohne Verbindung wird er auf dem Gerät gespeichert und später nachgesendet. */
  async function book(lines: { a: Article; qty: number }[], paid: number, donation: number, change: number): Promise<BookResult> {
    const shiftId = serverRef.current!.shift.id;
    const id = newSaleId();
    const createdAt = sqlNow();
    const total = lines.reduce((sum, l) => sum + l.a.price_cents * l.qty, 0);
    try {
      const r = await api<{ change: number; donation: number; total: number }>(
        "/api/cashier/sales",
        "POST",
        { id, shift_id: shiftId, items: lines.map((l) => ({ article_id: l.a.id, qty: l.qty })), paid, donation },
        8000,
      );
      setOffline(false);
      return { ...r, queued: false };
    } catch (e) {
      if (!isRetryable(e)) throw e;
      const sale: PendingSale = {
        id,
        shift_id: shiftId,
        created_at: createdAt,
        items: lines.map((l) => ({ article_id: l.a.id, name: l.a.name, emoji: l.a.emoji, unit_price_cents: l.a.price_cents, qty: l.qty })),
        total_cents: total,
        donation_cents: donation,
        paid_cents: paid,
        change_cents: change,
        status: "pending",
      };
      const next = [...readQueue(), sale];
      if (!writeQueue(next)) {
        throw new Error("Der Verkauf konnte nicht auf dem Gerät gespeichert werden (Speicher voll oder gesperrt). Bitte Verbindung prüfen.");
      }
      setQueue(next);
      if (e instanceof ApiError && e.status === 0) setOffline(true);
      if (e instanceof ApiError && e.status === 401) setAuthLost(true);
      return { change, donation, total, queued: true };
    }
  }

  const state = useMemo(() => (server ? applyPending(server, queue) : null), [server, queue]);
  const counts = pendingCount(queue, server?.shift.id ?? "");

  const byId = useMemo(() => new Map((state?.articles ?? []).map((a) => [a.id, a])), [state]);
  const lines = Object.entries(cart)
    .map(([id, qty]) => ({ a: byId.get(id), qty }))
    .filter((l): l is { a: Article; qty: number } => !!l.a && l.qty > 0);
  const total = lines.reduce((s, l) => s + l.a.price_cents * l.qty, 0);
  const count = lines.reduce((s, l) => s + l.qty, 0);

  if (!state) {
    return (
      <>
        <div class="topbar">
          <h1>SV-Kasse</h1>
        </div>
        {offline ? (
          <div class="page">
            <p class="empty">Keine Verbindung. Beim ersten Start auf diesem Gerät wird Internet benötigt.</p>
            <p style="text-align:center">
              <button class="btn primary" onClick={() => load()}>
                Erneut versuchen
              </button>
            </p>
          </div>
        ) : (
          <p class="empty">Lade …</p>
        )}
      </>
    );
  }

  if (state.shift.status === "closed") {
    return <ClosedScreen state={state} unbooked={queue.filter((q) => q.shift_id === state.shift.id)} />;
  }

  const { shift, totals, settings } = state;

  function add(a: Article) {
    const have = cart[a.id] ?? 0;
    if (have >= a.stock) return toast(`„${a.name}“: nur noch ${a.stock} auf Lager`, "err");
    setCart({ ...cart, [a.id]: have + 1 });
  }
  function dec(id: string) {
    const n = (cart[id] ?? 0) - 1;
    const next = { ...cart };
    if (n <= 0) delete next[id];
    else next[id] = n;
    setCart(next);
  }

  async function logout() {
    if (counts.pending > 0 && !confirm(`${counts.pending} Verkauf/Verkäufe sind noch nicht übertragen. Sie bleiben gespeichert und werden nach erneuter Anmeldung mit demselben Code gesendet. Trotzdem abmelden?`)) return;
    await api("/api/cashier/logout", "POST").catch(() => {});
    clearCachedState();
    go("/");
  }

  return (
    <>
      <div class="topbar">
        <h1>
          {state.project?.name ?? settings.sv_name} · {shift.name}
        </h1>
        <span class="sp" />
        <button class="btn sm" onClick={() => setHistory(true)}>
          Verkäufe ({totals.sales_count})
        </button>
        <button class="btn sm" onClick={() => setClosing(true)}>
          Kasse abschließen
        </button>
      </div>

      {(offline || counts.pending > 0 || counts.rejected > 0 || authLost) && (
        <div class={`netbar ${counts.rejected > 0 || authLost ? "bad" : ""}`} role="status">
          <span>
            {authLost
              ? "Sitzung abgelaufen: Gerät abmelden und den Code neu eingeben."
              : offline
                ? "Offline: Verkäufe werden auf dem Gerät gespeichert."
                : counts.pending > 0
                  ? syncing
                    ? "Übertrage wartende Verkäufe …"
                    : "Wartende Verkäufe werden übertragen."
                  : "Es gibt abgelehnte Verkäufe."}
            {counts.pending > 0 && ` ${counts.pending} wartend.`}
            {counts.rejected > 0 && ` ${counts.rejected} abgelehnt.`}
          </span>
          <span class="sp" />
          {(counts.pending > 0 || counts.rejected > 0) && (
            <button class="btn sm" onClick={() => setPendingOpen(true)}>
              Ansehen
            </button>
          )}
          {counts.pending > 0 && !authLost && (
            <button class="btn sm" disabled={syncing} onClick={() => load().then((s) => s && sync(s.shift.id))}>
              Jetzt senden
            </button>
          )}
        </div>
      )}

      <div class="page">
        <div class="stats">
          <Stat label="Kassenbestand (soll)" value={euro(totals.expected)} />
          <Stat label="Verkäufe" value={euro(totals.revenue)} />
          <Stat label="SV-Spenden" value={euro(totals.donations)} />
          <Stat label="Startbetrag" value={euro(shift.starting_cents)} />
        </div>

        <div class="pos">
          <section aria-label="Artikel">
            {state.articles.length === 0 ? (
              <p class="empty">Keine Artikel angelegt. Bitte im Adminbereich Artikel hinzufügen.</p>
            ) : (
              <div class="tiles">
                {state.articles.map((a) => {
                  const q = cart[a.id] ?? 0;
                  const out = a.stock <= 0;
                  const low = !out && a.stock <= settings.low_stock;
                  return (
                    <button key={a.id} class="tile" style={{ "--tile": a.color }} disabled={out} onClick={() => add(a)} aria-label={`${a.name}, ${euro(a.price_cents)}, ${a.stock} auf Lager`}>
                      {q > 0 && <span class="qtybadge">{q}</span>}
                      <span class={`badge ${low ? "low" : ""}`}>{out ? "ausverkauft" : `${a.stock}×`}</span>
                      <span class="em">{a.emoji || "🛍️"}</span>
                      <span>
                        <span class="nm">{a.name}</span>
                        <br />
                        <span class="pr">{euro(a.price_cents)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <aside class="cart" aria-label="Warenkorb">
            <div class="cart-lines">
              {lines.length === 0 ? (
                <p class="muted" style="margin:0 0 .5rem">
                  Artikel antippen, um sie hinzuzufügen.
                </p>
              ) : (
                lines.map(({ a, qty }) => (
                  <div class="line" key={a.id}>
                    <span>
                      {a.emoji} {a.name}
                    </span>
                    <span class="qty">
                      <button onClick={() => dec(a.id)} aria-label="weniger">
                        −
                      </button>
                      <span>{qty}</span>
                      <button onClick={() => add(a)} aria-label="mehr">
                        +
                      </button>
                    </span>
                    <b class="right">{euro(a.price_cents * qty)}</b>
                  </div>
                ))
              )}
            </div>
            <div class="total">
              <span>Summe</span>
              <span>{euro(total)}</span>
            </div>
            <div class="row">
              <button class="btn" disabled={count === 0} onClick={() => setCart({})}>
                Leeren
              </button>
              <button class="btn primary grow" disabled={count === 0} onClick={() => setPay(true)}>
                Bezahlen
              </button>
            </div>
          </aside>
        </div>
        <p style="text-align:center;margin-top:1.5rem">
          <button class="btn ghost sm" onClick={logout}>
            Gerät abmelden (Kasse bleibt offen)
          </button>
        </p>
      </div>

      {pay && (
        <PayModal
          total={total}
          quick={settings.donation_quick}
          onClose={() => setPay(false)}
          onDone={(r) => {
            setPay(false);
            setCart({});
            setResult(r);
            if (!r.queued) load();
          }}
          book={(paid, donation, change) => book(lines, paid, donation, change)}
        />
      )}

      {result && (
        <Modal title={result.queued ? "Verkauf gespeichert ✓" : "Verkauf gebucht ✓"}>
          {result.queued && (
            <p class="muted" style="margin-top:0">
              Keine Verbindung: Der Verkauf liegt auf dem Gerät und wird automatisch übertragen.
            </p>
          )}
          <div class="changebox">
            {result.change > 0 ? (
              <>
                <div class="muted">Rückgeld</div>
                <div class="amount">{euro(result.change)}</div>
              </>
            ) : (
              <div class="amount">Passt!</div>
            )}
            {result.donation > 0 && <p class="muted">Dazu {euro(result.donation)} SV-Spende. Danke! 💚</p>}
          </div>
          <button class="btn primary big" autoFocus onClick={() => setResult(null)}>
            Nächster Kunde
          </button>
        </Modal>
      )}

      {history && <HistoryModal sales={state.sales} offline={offline} onClose={() => setHistory(false)} onChanged={load} />}
      {closing && <CloseModal state={state} blocked={counts.pending + counts.rejected} syncing={syncing} onSync={() => load().then((s) => s && sync(s.shift.id))} onClose={() => setClosing(false)} onClosed={load} />}
      {pendingOpen && (
        <PendingModal
          queue={queue.filter((q) => q.shift_id === state.shift.id)}
          syncing={syncing}
          onSync={() => load().then((s) => s && sync(s.shift.id))}
          onDiscard={(id) => {
            const next = readQueue().filter((q) => q.id !== id);
            writeQueue(next);
            setQueue(next);
          }}
          onClose={() => setPendingOpen(false)}
        />
      )}
    </>
  );
}

// ---------- Bezahlen ----------
function PayModal(props: {
  total: number;
  quick: number[];
  book: (paid: number, donation: number, change: number) => Promise<BookResult>;
  onClose: () => void;
  onDone: (r: BookResult) => void;
}) {
  const { total } = props;
  const [paidStr, setPaidStr] = useState("");
  const [donation, setDonation] = useState(0);
  const [donStr, setDonStr] = useState("");
  const [busy, setBusy] = useState(false);

  const paidInput = paidStr.trim() === "" ? null : parseEuro(paidStr);
  const paidInvalid = paidStr.trim() !== "" && paidInput === null;
  // Ohne Eingabe: passend bezahlt (plus Spende)
  const effDonation = paidInput != null ? Math.min(donation, Math.max(0, paidInput - total)) : donation;
  const paid = paidInput ?? total + effDonation;
  const p = computePayment(total, paid, effDonation);
  const missing = paidInput != null && paidInput < total ? total - paidInput : 0;

  const cashOptions = [...new Set([Math.ceil(total / 100) * 100, 500, 1000, 2000, 5000].filter((v) => v >= total))].slice(0, 5);
  const surplus = paidInput != null ? paidInput - total : 0;

  function setDon(v: number) {
    setDonation(v);
    setDonStr(v ? (v / 100).toFixed(2).replace(".", ",") : "");
  }

  async function submit() {
    if (!p.ok || paidInvalid) return;
    setBusy(true);
    try {
      props.onDone(await props.book(p.paid, p.donation, p.change));
    } catch (e) {
      toast(errMsg(e), "err");
      setBusy(false);
    }
  }

  return (
    <Modal title="Bezahlen" onClose={props.onClose}>
      <div class="total">
        <span>Zu zahlen</span>
        <span>{euro(total)}</span>
      </div>

      <div class="field">
        <span>Gegeben (bar)</span>
        <div class="chips">
          <button class={`chip ${paidStr === "" ? "on" : ""}`} onClick={() => setPaidStr("")}>
            Passend
          </button>
          {cashOptions.map((v) => (
            <button key={v} class={`chip ${paidInput === v ? "on" : ""}`} onClick={() => setPaidStr((v / 100).toFixed(2).replace(".", ","))}>
              {euro(v).replace(",00", "")}
            </button>
          ))}
        </div>
        <MoneyField label="" value={paidStr} onInput={setPaidStr} placeholder="anderer Betrag" />
      </div>

      <div class="field">
        <span>SV-Spende (Mehrbetrag)</span>
        <div class="chips">
          <button class={`chip ${effDonation === 0 ? "on" : ""}`} onClick={() => setDon(0)}>
            Keine
          </button>
          {props.quick.map((v) => (
            <button key={v} class={`chip ${effDonation === v ? "on" : ""}`} onClick={() => setDon(v)}>
              +{euro(v)}
            </button>
          ))}
          {surplus > 0 && (
            <button class={`chip ${effDonation === surplus ? "on" : ""}`} onClick={() => setDon(surplus)}>
              Rückgeld spenden
            </button>
          )}
        </div>
        <MoneyField
          label=""
          value={donStr}
          placeholder="andere Spende"
          onInput={(v) => {
            setDonStr(v);
            const c = v.trim() === "" ? 0 : parseEuro(v);
            if (c != null) setDonation(c);
          }}
        />
      </div>

      <div class="sum">
        <div>
          <span>Artikel</span>
          <span>{euro(total)}</span>
        </div>
        {effDonation > 0 && (
          <div>
            <span>SV-Spende</span>
            <span>{euro(effDonation)}</span>
          </div>
        )}
        <div>
          <span>Gegeben</span>
          <span>{euro(paid)}</span>
        </div>
        <div class={`big ${missing ? "neg" : ""}`}>
          <span>{missing ? "Es fehlen" : "Rückgeld"}</span>
          <span>{missing ? euro(missing) : euro(p.change)}</span>
        </div>
      </div>

      <button class="btn primary big" disabled={busy || !p.ok || paidInvalid} onClick={submit}>
        {busy ? "Buche …" : "Verkauf buchen"}
      </button>
    </Modal>
  );
}

// ---------- Verkäufe / Storno ----------
function HistoryModal(props: { sales: Sale[]; offline: boolean; onClose: () => void; onChanged: () => void }) {
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  async function doVoid(id: string) {
    try {
      await api(`/api/cashier/sales/${id}/void`, "POST", { reason });
      toast("Verkauf storniert, Bestand zurückgebucht");
      setVoiding(null);
      setReason("");
      props.onChanged();
    } catch (e) {
      toast(errMsg(e), "err");
    }
  }

  return (
    <Modal title="Letzte Verkäufe" onClose={props.onClose} wide>
      {props.sales.length === 0 ? (
        <p class="empty">Noch keine Verkäufe.</p>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Artikel</th>
                <th class="num">Summe</th>
                <th class="num">Spende</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {props.sales.map((s) => (
                <>
                  <tr key={s.id} class={s.voided_at ? "dim" : ""}>
                    <td class="nowrap">{fmtTime(s.created_at)}</td>
                    <td>{s.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}</td>
                    <td class="num">{euro(s.total_cents)}</td>
                    <td class="num">{s.donation_cents ? euro(s.donation_cents) : ""}</td>
                    <td class="right">
                      {s.voided_at ? (
                        <span class="pill bad">storniert</span>
                      ) : s.pending ? (
                        <span class="pill warn">wartet auf Übertragung</span>
                      ) : (
                        <button class="btn sm danger" disabled={props.offline} title={props.offline ? "Stornieren geht nur mit Verbindung" : undefined} onClick={() => setVoiding(s.id)}>
                          Stornieren
                        </button>
                      )}
                    </td>
                  </tr>
                  {voiding === s.id && (
                    <tr>
                      <td colSpan={5}>
                        <div class="row">
                          <input class="grow" type="text" placeholder="Grund (z. B. falsch gebucht)" value={reason} autoFocus onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
                          <button class="btn danger" disabled={!reason.trim()} onClick={() => doVoid(s.id)}>
                            Stornierung bestätigen
                          </button>
                          <button class="btn" onClick={() => setVoiding(null)}>
                            Abbrechen
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ---------- Abschluss ----------
function CloseModal(props: { state: CashierState; blocked: number; syncing: boolean; onSync: () => void; onClose: () => void; onClosed: () => void }) {
  const { totals, shift } = props.state;
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const cents = parseEuro(counted);
  const diff = cents == null ? null : cents - totals.expected;

  async function submit() {
    if (cents == null) return;
    setBusy(true);
    try {
      await api("/api/cashier/close", "POST", { counted_cents: cents, note });
      props.onClosed();
    } catch (e) {
      toast(errMsg(e), "err");
      setBusy(false);
    }
  }

  return (
    <Modal title="Kasse abschließen" onClose={props.onClose}>
      <p class="muted" style="margin-top:0">
        Bitte das Bargeld in der Kasse zählen und den Betrag eingeben. Danach ist der Code ungültig und keine Verkäufe mehr möglich.
      </p>
      <div class="sum">
        <div>
          <span>Startbetrag</span>
          <span>{euro(shift.starting_cents)}</span>
        </div>
        <div>
          <span>+ Verkäufe</span>
          <span>{euro(totals.revenue)}</span>
        </div>
        <div>
          <span>+ SV-Spenden</span>
          <span>{euro(totals.donations)}</span>
        </div>
        <div class="big">
          <span>Soll in der Kasse</span>
          <span>{euro(totals.expected)}</span>
        </div>
      </div>
      {props.blocked > 0 && (
        <div class="netbar bad" style="border-radius:10px;margin-bottom:.8rem">
          <span>{props.blocked} Verkauf/Verkäufe sind noch nicht übertragen. Die Kasse kann erst geschlossen werden, wenn alles beim Server angekommen ist.</span>
          <button class="btn sm" disabled={props.syncing} onClick={props.onSync}>
            Jetzt senden
          </button>
        </div>
      )}
      <MoneyField label="Gezählter Kassenbestand" value={counted} onInput={setCounted} autofocus />
      {diff != null && (
        <div class="stats">
          <Stat label="Differenz" value={diffLabel(diff)} tone={diffTone(diff)} />
        </div>
      )}
      <label class="field">
        <span>Anmerkung (optional)</span>
        <input type="text" value={note} maxLength={500} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
      </label>
      <button class="btn primary big" disabled={busy || cents == null || props.blocked > 0} onClick={submit}>
        {busy ? "Schließe …" : "Kasse endgültig schließen"}
      </button>
    </Modal>
  );
}

function ClosedScreen({ state, unbooked }: { state: CashierState; unbooked: PendingSale[] }) {
  const [busy, setBusy] = useState(false);
  const { totals, shift } = state;

  async function pdf() {
    setBusy(true);
    try {
      await shiftReportPdf(await api<Report>("/api/cashier/report"));
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  }
  async function leave() {
    await api("/api/cashier/logout", "POST").catch(() => {});
    clearCachedState();
    go("/");
  }

  return (
    <main class="hero">
      <div class="card hero-card" style="width:min(520px,100%)">
        <div class="logo" aria-hidden="true">
          ✅
        </div>
        <h1>Kasse geschlossen</h1>
        <p class="muted">{shift.name}</p>
        <div class="stats" style="text-align:left;margin-top:1rem">
          <Stat label="Verkäufe" value={euro(totals.revenue)} />
          <Stat label="SV-Spenden" value={euro(totals.donations)} />
          <Stat label="Soll" value={euro(totals.expected)} />
          <Stat label="Gezählt" value={shift.counted_cents == null ? "–" : euro(shift.counted_cents)} />
        </div>
        <div class="stats" style="text-align:left">
          <Stat label="Differenz" value={diffLabel(totals.difference)} tone={diffTone(totals.difference)} />
        </div>
        {unbooked.length > 0 && (
          <div class="netbar bad" style="border-radius:10px;margin:.8rem 0;text-align:left">
            <span>
              {unbooked.length} Verkauf/Verkäufe wurden nicht mehr gebucht, weil die Kasse schon geschlossen war ({euro(unbooked.reduce((n, q) => n + q.total_cents + q.donation_cents, 0))}). Das Geld ist in der Kasse, steht aber nicht im Bericht. Bitte der Aufsicht melden:
              {unbooked.map((q) => ` ${fmtTime(q.created_at)} ${q.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}`).join(";")}
            </span>
          </div>
        )}
        <button class="btn primary big" disabled={busy} onClick={pdf}>
          {busy ? "Erstelle PDF …" : "PDF-Kassenbericht herunterladen"}
        </button>
        <p>
          <button class="btn ghost" onClick={leave}>
            Zur Startseite
          </button>
        </p>
      </div>
    </main>
  );
}

// ---------- Wartende Verkäufe ----------
function PendingModal(props: { queue: PendingSale[]; syncing: boolean; onSync: () => void; onDiscard: (id: string) => void; onClose: () => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <Modal title="Wartende Verkäufe" onClose={props.onClose} wide>
      {props.queue.length === 0 ? (
        <p class="empty">Alles übertragen ✓</p>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Artikel</th>
                <th class="num">Summe</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {props.queue.map((q) => (
                <tr key={q.id}>
                  <td class="nowrap">{fmtTime(q.created_at)}</td>
                  <td>{q.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}</td>
                  <td class="num">{euro(q.total_cents + q.donation_cents)}</td>
                  <td>
                    {q.status === "pending" ? (
                      <span class="pill warn">wartet</span>
                    ) : (
                      <>
                        <span class="pill bad">abgelehnt</span>
                        <br />
                        <small>{q.error}</small>
                      </>
                    )}
                  </td>
                  <td class="right">
                    {q.status === "rejected" &&
                      (confirm === q.id ? (
                        <button class="btn sm danger" onClick={() => props.onDiscard(q.id)}>
                          Wirklich verwerfen
                        </button>
                      ) : (
                        <button class="btn sm" onClick={() => setConfirm(q.id)}>
                          Verwerfen
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p class="muted">
        Abgelehnte Verkäufe wurden vom Server nicht gebucht (zum Beispiel weil die Kasse inzwischen geschlossen wurde). Das Geld dafür ist trotzdem in der Kasse: bitte der Aufsicht melden, bevor ein Verkauf verworfen wird.
      </p>
      <button class="btn primary big" disabled={props.syncing || !props.queue.some((q) => q.status === "pending")} onClick={props.onSync}>
        {props.syncing ? "Sende …" : "Jetzt senden"}
      </button>
    </Modal>
  );
}
