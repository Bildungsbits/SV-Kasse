import { useEffect, useMemo, useState } from "preact/hooks";
import { computePayment, parseEuro } from "../../../src/shared/money";
import { ApiError, api, errMsg, go } from "../api";
import { fmtTime } from "../format";
import { shiftReportPdf } from "../pdf";
import type { Article, CashierState, Report, Sale } from "../types";
import { MoneyField, Modal, Stat, diffLabel, diffTone, euro, toast } from "../ui";

type Cart = Record<string, number>;

export function Cashier() {
  const [state, setState] = useState<CashierState | null>(null);
  const [cart, setCart] = useState<Cart>({});
  const [pay, setPay] = useState(false);
  const [result, setResult] = useState<{ change: number; donation: number; total: number } | null>(null);
  const [history, setHistory] = useState(false);
  const [closing, setClosing] = useState(false);

  async function load() {
    try {
      setState(await api<CashierState>("/api/cashier/state"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return go("/");
      toast(errMsg(e), "err");
    }
  }
  useEffect(() => {
    load();
  }, []);

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
        <p class="empty">Lade …</p>
      </>
    );
  }

  if (state.shift.status === "closed") {
    return <ClosedScreen state={state} />;
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
    await api("/api/cashier/logout", "POST").catch(() => {});
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
            load();
          }}
          lines={lines.map((l) => ({ article_id: l.a.id, qty: l.qty }))}
        />
      )}

      {result && (
        <Modal title="Verkauf gebucht ✓">
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

      {history && <HistoryModal sales={state.sales} onClose={() => setHistory(false)} onChanged={load} />}
      {closing && <CloseModal state={state} onClose={() => setClosing(false)} onClosed={load} />}
    </>
  );
}

// ---------- Bezahlen ----------
function PayModal(props: {
  total: number;
  quick: number[];
  lines: { article_id: string; qty: number }[];
  onClose: () => void;
  onDone: (r: { change: number; donation: number; total: number }) => void;
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
      const r = await api<{ change: number; donation: number; total: number }>("/api/cashier/sales", "POST", {
        items: props.lines,
        paid: p.paid,
        donation: p.donation,
      });
      props.onDone(r);
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
function HistoryModal(props: { sales: Sale[]; onClose: () => void; onChanged: () => void }) {
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
                      ) : (
                        <button class="btn sm danger" onClick={() => setVoiding(s.id)}>
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
function CloseModal(props: { state: CashierState; onClose: () => void; onClosed: () => void }) {
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
      <button class="btn primary big" disabled={busy || cents == null} onClick={submit}>
        {busy ? "Schließe …" : "Kasse endgültig schließen"}
      </button>
    </Modal>
  );
}

function ClosedScreen({ state }: { state: CashierState }) {
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
