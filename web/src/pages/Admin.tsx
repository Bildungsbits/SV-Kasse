import { useEffect, useState } from "preact/hooks";
import { parseEuro } from "../../../src/shared/money";
import { ApiError, api, errMsg, go, setAdminToken } from "../api";
import { csvLine, download, fmtDate, fmtDateTime, fmtTime, todayIso } from "../format";
import { rangeReportPdf, shiftReportPdf } from "../pdf";
import type { Article, Project, ProjectRow, Report, Settings, ShiftRow, Stats, StockMovement } from "../types";
import { MoneyField, Modal, Stat, diffLabel, diffTone, euro, toast } from "../ui";

type Tab = "shifts" | "articles" | "stock" | "stats";
const PROJECT_TABS: [Tab, string][] = [
  ["shifts", "Schichten"],
  ["articles", "Artikel"],
  ["stock", "Bestand"],
  ["stats", "Auswertung"],
];
type PW = { pid: string; readOnly: boolean };

export function Admin() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("shifts");
  const [view, setView] = useState<"projects" | "settings">("projects");
  const [project, setProject] = useState<Project | null>(null);

  // Beim Verlassen des Adminbereichs wird die Anmeldung verworfen
  useEffect(() => () => setAdminToken(null), []);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  function logout() {
    setAdminToken(null);
    setAuthed(false);
    setProject(null);
  }
  function open(p: Project) {
    setTab("shifts");
    setProject(p);
  }
  const readOnly = project?.status === "archived";

  return (
    <>
      <div class="topbar">
        <h1>SV-Kasse · Admin</h1>
        <span class="sp" />
        <button class="btn sm" onClick={() => go("/")}>
          Zur Kasse
        </button>
        <button class="btn sm" onClick={logout}>
          Abmelden
        </button>
      </div>
      <nav class="tabs" aria-label="Bereiche">
        {project ? (
          <>
            <button class="tab" onClick={() => setProject(null)}>
              ← Projekte
            </button>
            {PROJECT_TABS.map(([k, label]) => (
              <button key={k} class={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </>
        ) : (
          <>
            <button class={`tab ${view === "projects" ? "on" : ""}`} onClick={() => setView("projects")}>
              Projekte
            </button>
            <button class={`tab ${view === "settings" ? "on" : ""}`} onClick={() => setView("settings")}>
              Einstellungen
            </button>
          </>
        )}
      </nav>
      <div class="page">
        {!project && view === "projects" && <Projects onOpen={open} />}
        {!project && view === "settings" && <SettingsTab />}
        {project && (
          <>
            <div class="row" style="margin-bottom:.8rem">
              <b style="font-size:1.1rem">{project.name}</b>
              {readOnly && <span class="pill warn">archiviert (nur lesbar)</span>}
            </div>
            {tab === "shifts" && <Shifts key={project.id} pid={project.id} readOnly={readOnly} />}
            {tab === "articles" && <Articles key={project.id} pid={project.id} readOnly={readOnly} />}
            {tab === "stock" && <StockTab key={project.id} pid={project.id} readOnly={readOnly} />}
            {tab === "stats" && <StatsTab key={project.id} pid={project.id} project={project} />}
          </>
        )}
      </div>
    </>
  );
}

function useAuthGuard() {
  return (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) {
      setAdminToken(null);
      toast("Sitzung abgelaufen. Bitte neu anmelden.", "err");
      setTimeout(() => location.reload(), 800);
    } else toast(errMsg(e), "err");
  };
}

// ---------- Login ----------
function Login(props: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ token: string }>("/api/admin/login", "POST", { password: pw });
      setAdminToken(r.token);
      setPw("");
      props.onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main class="hero">
      <form class="card hero-card" onSubmit={submit}>
        <div class="logo" aria-hidden="true">
          🔐
        </div>
        <h1>Adminbereich</h1>
        <label class="field" style="margin-top:1.2rem;text-align:left">
          <span>Passwort</span>
          <input type="password" autoFocus autoComplete="off" name="sv-admin-code" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
        </label>
        {error && (
          <p class="err" role="alert">
            {error}
          </p>
        )}
        <button class="btn primary big" disabled={busy || !pw}>
          {busy ? "Prüfe …" : "Anmelden"}
        </button>
        <p style="margin-top:1rem">
          <a href="#/" class="muted">
            Zurück zur Kasse
          </a>
        </p>
      </form>
    </main>
  );
}

// ---------- Projekte ----------
function Projects({ onOpen }: { onOpen: (p: Project) => void }) {
  const fail = useAuthGuard();
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [create, setCreate] = useState(false);
  const [rename, setRename] = useState<ProjectRow | null>(null);
  const [del, setDel] = useState<ProjectRow | null>(null);

  const load = () =>
    api<ProjectRow[]>("/api/admin/projects")
      .then(setRows)
      .catch(fail);
  useEffect(() => {
    load();
  }, []);

  async function archive(p: ProjectRow) {
    if (!confirm(`„${p.name}“ archivieren?\n\nDanach sind keine Verkäufe oder Änderungen mehr möglich. Alle Daten und der PDF-Bericht bleiben erhalten, und du kannst das Projekt jederzeit wieder aktivieren.`)) return;
    try {
      await api(`/api/admin/projects/${p.id}/archive`, "POST");
      toast("Projekt archiviert");
      load();
    } catch (e) {
      fail(e);
    }
  }
  async function unarchive(p: ProjectRow) {
    try {
      await api(`/api/admin/projects/${p.id}/unarchive`, "POST");
      toast("Projekt wieder aktiv");
      load();
    } catch (e) {
      fail(e);
    }
  }
  async function pdf(p: ProjectRow) {
    try {
      await rangeReportPdf(await api<Stats>(`/api/admin/stats?project=${p.id}`), "", "");
    } catch (e) {
      fail(e);
    }
  }

  const active = rows?.filter((p) => p.status === "active") ?? [];
  const archived = rows?.filter((p) => p.status === "archived") ?? [];
  const card = (p: ProjectRow) => (
    <div class="card" key={p.id}>
      <div class="row between">
        <div>
          <h3 style="margin:0">{p.name}</h3>
          <small>
            angelegt {fmtDate(p.created_at)}
            {p.archived_at ? `, archiviert ${fmtDate(p.archived_at)}` : ""}
          </small>
        </div>
        <span class={`pill ${p.status === "active" ? "good" : ""}`}>{p.status === "active" ? "aktiv" : "archiviert"}</span>
      </div>
      <div class="stats" style="margin:.8rem 0">
        <Stat label="Verkäufe" value={euro(p.revenue)} />
        <Stat label="SV-Spenden" value={euro(p.donations)} />
        <Stat label="Schichten" value={String(p.shift_count)} />
        <Stat label="Artikel" value={String(p.article_count)} />
      </div>
      <div class="row">
        <button class="btn primary sm" onClick={() => onOpen(p)}>
          Öffnen
        </button>
        <button class="btn sm" onClick={() => pdf(p)}>
          PDF-Gesamtbericht
        </button>
        {p.status === "active" ? (
          <button class="btn sm" onClick={() => archive(p)}>
            Archivieren
          </button>
        ) : (
          <button class="btn sm" onClick={() => unarchive(p)}>
            Wieder aktivieren
          </button>
        )}
        <button class="btn sm" onClick={() => setRename(p)}>
          Umbenennen
        </button>
        <button class="btn sm danger" onClick={() => setDel(p)}>
          Löschen
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div class="row between" style="margin-bottom:1rem">
        <div>
          <h2>Verkaufsprojekte</h2>
          <small>Pro Aktion ein Projekt (z. B. „Nikolausaktion“) mit eigenen Artikeln, Schichten und Auswertung.</small>
        </div>
        <button class="btn primary" onClick={() => setCreate(true)}>
          + Neues Projekt
        </button>
      </div>
      {!rows ? (
        <p class="empty">Lade …</p>
      ) : rows.length === 0 ? (
        <p class="empty">Noch kein Projekt. Lege das erste an, z. B. „Nikolausaktion“.</p>
      ) : (
        <>
          {active.map(card)}
          {archived.length > 0 && <h3 style="margin:1.4rem 0 .6rem">Archiv</h3>}
          {archived.map(card)}
        </>
      )}

      {create && (
        <CreateProject
          projects={rows ?? []}
          onClose={() => setCreate(false)}
          onCreated={() => {
            setCreate(false);
            load();
          }}
        />
      )}
      {rename && (
        <RenameProject
          project={rename}
          onClose={() => setRename(null)}
          onDone={() => {
            setRename(null);
            load();
          }}
        />
      )}
      {del && (
        <DeleteProject
          project={del}
          onClose={() => setDel(null)}
          onDone={() => {
            setDel(null);
            load();
          }}
        />
      )}
    </>
  );
}

function CreateProject(props: { projects: ProjectRow[]; onClose: () => void; onCreated: () => void }) {
  const fail = useAuthGuard();
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [withStock, setWithStock] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    try {
      await api("/api/admin/projects", "POST", { name, copy_from: from || undefined, copy_stock: withStock });
      toast("Projekt angelegt");
      props.onCreated();
    } catch (err) {
      fail(err);
    }
  }
  return (
    <Modal title="Neues Projekt" onClose={props.onClose}>
      <form onSubmit={submit}>
        <label class="field">
          <span>Name</span>
          <input type="text" autoFocus placeholder="z. B. Nikolausaktion" maxLength={60} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        {props.projects.length > 0 && (
          <>
            <label class="field">
              <span>Artikel übernehmen aus (optional)</span>
              <select value={from} onChange={(e) => setFrom((e.target as HTMLSelectElement).value)}>
                <option value="">Nein, leer starten</option>
                {props.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.article_count} Artikel)
                  </option>
                ))}
              </select>
            </label>
            {from && (
              <label class="check">
                <input type="checkbox" checked={withStock} onChange={(e) => setWithStock((e.target as HTMLInputElement).checked)} /> Auch den Bestand übernehmen
              </label>
            )}
          </>
        )}
        <button class="btn primary big" disabled={!name.trim()}>
          Projekt anlegen
        </button>
      </form>
    </Modal>
  );
}

function RenameProject(props: { project: ProjectRow; onClose: () => void; onDone: () => void }) {
  const fail = useAuthGuard();
  const [name, setName] = useState(props.project.name);
  async function submit(e: Event) {
    e.preventDefault();
    try {
      await api(`/api/admin/projects/${props.project.id}`, "PUT", { name });
      props.onDone();
    } catch (err) {
      fail(err);
    }
  }
  return (
    <Modal title="Projekt umbenennen" onClose={props.onClose}>
      <form onSubmit={submit}>
        <label class="field">
          <span>Name</span>
          <input type="text" autoFocus maxLength={60} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <button class="btn primary big" disabled={!name.trim()}>
          Speichern
        </button>
      </form>
    </Modal>
  );
}

function DeleteProject(props: { project: ProjectRow; onClose: () => void; onDone: () => void }) {
  const fail = useAuthGuard();
  const p = props.project;
  const [typed, setTyped] = useState("");
  async function submit() {
    try {
      await api(`/api/admin/projects/${p.id}`, "DELETE", { confirm_name: typed });
      toast("Projekt gelöscht");
      props.onDone();
    } catch (err) {
      fail(err);
    }
  }
  return (
    <Modal title={`„${p.name}“ endgültig löschen?`} onClose={props.onClose}>
      <p style="margin-top:0">
        Gelöscht werden <b>alle Daten</b> dieses Projekts: {p.article_count} Artikel, {p.shift_count} Schichten, alle Verkäufe ({euro(p.revenue)} Umsatz, {euro(p.donations)} Spenden) und der Bestandsverlauf. Das lässt sich <b>nicht rückgängig machen</b>.
      </p>
      {p.open_shifts > 0 && <p class="err">Achtung: {p.open_shifts} Schicht(en) sind noch nicht geschlossen. Ein offenes Verkaufsgerät verliert die Kasse.</p>}
      <p class="muted">Tipp: Lade vorher den PDF-Gesamtbericht herunter.</p>
      <label class="field">
        <span>Zur Bestätigung den Projektnamen eingeben</span>
        <input type="text" autoFocus autoComplete="off" value={typed} placeholder={p.name} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} />
      </label>
      <button class="btn danger big" disabled={typed.trim() !== p.name} onClick={submit}>
        Projekt endgültig löschen
      </button>
    </Modal>
  );
}

// ---------- Schichten ----------
function Shifts({ pid, readOnly }: PW) {
  const fail = useAuthGuard();
  const [rows, setRows] = useState<ShiftRow[] | null>(null);
  const [create, setCreate] = useState(false);
  const [created, setCreated] = useState<{ name: string; code: string } | null>(null);
  const [closeFor, setCloseFor] = useState<ShiftRow | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  const load = () =>
    api<ShiftRow[]>(`/api/admin/shifts?project=${pid}`)
      .then(setRows)
      .catch(fail);
  useEffect(() => {
    load();
  }, []);

  async function pdf(id: string) {
    try {
      await shiftReportPdf(await api<Report>(`/api/admin/shifts/${id}/report`));
    } catch (e) {
      fail(e);
    }
  }
  async function del(s: ShiftRow) {
    if (!confirm(`Schicht „${s.name}“ löschen?`)) return;
    try {
      await api(`/api/admin/shifts/${s.id}`, "DELETE");
      load();
    } catch (e) {
      fail(e);
    }
  }

  return (
    <>
      <div class="row between" style="margin-bottom:1rem">
        <div>
          <h2>Kassenschichten</h2>
          <small>Pro Pause eine Schicht anlegen, den Code an die Lehrkraft am Verkaufsgerät geben.</small>
        </div>
        {!readOnly && (
          <button class="btn primary" onClick={() => setCreate(true)}>
            + Neue Schicht
          </button>
        )}
      </div>

      <div class="card">
        {!rows ? (
          <p class="empty">Lade …</p>
        ) : rows.length === 0 ? (
          <p class="empty">Noch keine Schicht. Lege die erste Pause an.</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Schicht</th>
                  <th>Status</th>
                  <th>Code</th>
                  <th class="num">Start</th>
                  <th class="num">Verkauf</th>
                  <th class="num">Spenden</th>
                  <th class="num">Differenz</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <b>{s.name}</b>
                      <br />
                      <small>{fmtDateTime(s.created_at)}</small>
                    </td>
                    <td>
                      <span class={`pill ${s.status === "open" ? "good" : s.status === "ready" ? "warn" : ""}`}>{s.status === "open" ? "offen" : s.status === "ready" ? "bereit" : "geschlossen"}</span>
                    </td>
                    <td>{s.status !== "closed" ? <span class="codebox">{s.code}</span> : <small>–</small>}</td>
                    <td class="num">{euro(s.starting_cents)}</td>
                    <td class="num">{euro(s.revenue)}</td>
                    <td class="num">{euro(s.donations)}</td>
                    <td class="num">{s.difference == null ? "–" : <span class={`pill ${diffTone(s.difference) ?? ""}`}>{s.difference > 0 ? "+" : ""}{euro(s.difference)}</span>}</td>
                    <td class="right nowrap">
                      <button class="btn sm" onClick={() => setDetail(s.id)}>
                        Details
                      </button>{" "}
                      <button class="btn sm" onClick={() => pdf(s.id)}>
                        PDF
                      </button>{" "}
                      {!readOnly && s.status !== "closed" && (
                        <button class="btn sm" onClick={() => setCloseFor(s)}>
                          Schließen
                        </button>
                      )}{" "}
                      {!readOnly && s.sales_count === 0 && (
                        <button class="btn sm danger" onClick={() => del(s)} aria-label="Schicht löschen">
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {create && (
        <CreateShift
          pid={pid}
          onClose={() => setCreate(false)}
          onCreated={(name, code) => {
            setCreate(false);
            setCreated({ name, code });
            load();
          }}
        />
      )}
      {created && (
        <Modal title={`Code für „${created.name}“`} onClose={() => setCreated(null)}>
          <p class="muted" style="margin-top:0">
            Diesen Code gibt die Lehrkraft am Verkaufsgerät auf der Startseite ein.
          </p>
          <div class="bigcode">{created.code}</div>
          <button class="btn primary big" onClick={() => setCreated(null)}>
            Fertig
          </button>
        </Modal>
      )}
      {closeFor && (
        <CloseShift
          shift={closeFor}
          onClose={() => setCloseFor(null)}
          onDone={() => {
            setCloseFor(null);
            load();
          }}
        />
      )}
      {detail && <ShiftDetail id={detail} readOnly={readOnly} onClose={() => setDetail(null)} onChanged={load} />}
    </>
  );
}

function CreateShift(props: { pid: string; onClose: () => void; onCreated: (name: string, code: string) => void }) {
  const fail = useAuthGuard();
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const cents = parseEuro(start);

  async function submit(e: Event) {
    e.preventDefault();
    if (cents == null) return;
    setBusy(true);
    try {
      const r = await api<{ code: string }>("/api/admin/shifts", "POST", { project_id: props.pid, name, starting_cents: cents, code: code || undefined });
      props.onCreated(name, r.code);
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  }
  return (
    <Modal title="Neue Kassenschicht" onClose={props.onClose}>
      <form onSubmit={submit}>
        <label class="field">
          <span>Name der Pause</span>
          <input type="text" autoFocus placeholder="z. B. 1. große Pause" value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <MoneyField label="Startbetrag (Wechselgeld in der Kasse)" value={start} onInput={setStart} hint="Bargeld, das zu Beginn in der Kasse liegt." />
        <label class="field">
          <span>Code (optional)</span>
          <input type="text" placeholder="leer lassen = zufällig" value={code} maxLength={10} onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
        </label>
        <button class="btn primary big" disabled={busy || !name.trim() || cents == null}>
          {busy ? "Lege an …" : "Schicht anlegen"}
        </button>
      </form>
    </Modal>
  );
}

function CloseShift(props: { shift: ShiftRow; onClose: () => void; onDone: () => void }) {
  const fail = useAuthGuard();
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const cents = parseEuro(counted);
  const diff = cents == null ? null : cents - props.shift.expected;

  async function submit() {
    try {
      await api(`/api/admin/shifts/${props.shift.id}/close`, "POST", { counted_cents: cents, note });
      toast("Schicht geschlossen");
      props.onDone();
    } catch (e) {
      fail(e);
    }
  }
  return (
    <Modal title={`„${props.shift.name}“ schließen`} onClose={props.onClose}>
      <div class="stats">
        <Stat label="Soll in der Kasse" value={euro(props.shift.expected)} />
      </div>
      <MoneyField label="Gezählter Kassenbestand" value={counted} onInput={setCounted} autofocus />
      {diff != null && (
        <div class="stats">
          <Stat label="Differenz" value={diffLabel(diff)} tone={diffTone(diff)} />
        </div>
      )}
      <label class="field">
        <span>Anmerkung (optional)</span>
        <input type="text" value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
      </label>
      <button class="btn primary big" disabled={cents == null} onClick={submit}>
        Schicht schließen
      </button>
    </Modal>
  );
}

function ShiftDetail(props: { id: string; readOnly: boolean; onClose: () => void; onChanged: () => void }) {
  const fail = useAuthGuard();
  const [r, setR] = useState<Report | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const load = () =>
    api<Report>(`/api/admin/shifts/${props.id}/report`)
      .then(setR)
      .catch(fail);
  useEffect(() => {
    load();
  }, []);

  async function doVoid(id: string) {
    try {
      await api(`/api/admin/sales/${id}/void`, "POST", { reason });
      toast("Verkauf storniert");
      setVoiding(null);
      setReason("");
      load();
      props.onChanged();
    } catch (e) {
      fail(e);
    }
  }

  return (
    <Modal title={r ? `Schicht: ${r.shift.name}` : "Details"} onClose={props.onClose} wide>
      {!r ? (
        <p class="empty">Lade …</p>
      ) : (
        <>
          <div class="stats">
            <Stat label="Startbetrag" value={euro(r.shift.starting_cents)} />
            <Stat label="Verkäufe" value={euro(r.totals.revenue)} />
            <Stat label="Spenden" value={euro(r.totals.donations)} />
            <Stat label="Soll" value={euro(r.totals.expected)} />
            <Stat label="Gezählt" value={r.shift.counted_cents == null ? "–" : euro(r.shift.counted_cents)} />
            <Stat label="Differenz" value={diffLabel(r.totals.difference)} tone={diffTone(r.totals.difference)} />
          </div>
          <h3 style="margin:.5rem 0">Verkaufte Artikel</h3>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th class="num">Menge</th>
                  <th class="num">Umsatz</th>
                </tr>
              </thead>
              <tbody>
                {r.items.map((i) => (
                  <tr key={i.article_id + i.unit_price_cents}>
                    <td>{i.name}</td>
                    <td class="num">{i.qty}</td>
                    <td class="num">{euro(i.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 style="margin:1rem 0 .5rem">Einzelbuchungen</h3>
          <div class="table-wrap">
            <table>
              <tbody>
                {[...r.sales].reverse().map((s) => (
                  <>
                    <tr key={s.id} class={s.voided_at ? "dim" : ""}>
                      <td class="nowrap">{fmtTime(s.created_at)}</td>
                      <td>{s.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}</td>
                      <td class="num">{euro(s.total_cents)}</td>
                      <td class="num">{s.donation_cents ? `+${euro(s.donation_cents)}` : ""}</td>
                      <td class="right">
                        {s.voided_at ? (
                          <span class="pill bad" title={s.void_reason ?? ""}>
                            storniert
                          </span>
                        ) : props.readOnly ? null : (
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
                            <input class="grow" type="text" placeholder="Grund" value={reason} autoFocus onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
                            <button class="btn danger" disabled={!reason.trim()} onClick={() => doVoid(s.id)}>
                              Bestätigen
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
        </>
      )}
    </Modal>
  );
}

// ---------- Artikel ----------
const COLORS = ["#2563eb", "#0f766e", "#16a34a", "#d97706", "#dc2626", "#9333ea", "#db2777", "#475569"];

function Articles({ pid, readOnly }: PW) {
  const fail = useAuthGuard();
  const [rows, setRows] = useState<Article[] | null>(null);
  const [edit, setEdit] = useState<Partial<Article> | null>(null);
  const load = () =>
    api<Article[]>(`/api/admin/articles?project=${pid}`)
      .then(setRows)
      .catch(fail);
  useEffect(() => {
    load();
  }, []);

  async function del(a: Article) {
    if (!confirm(`„${a.name}“ entfernen? Artikel mit bisherigen Verkäufen werden nur deaktiviert.`)) return;
    try {
      const r = await api<{ deactivated?: boolean }>(`/api/admin/articles/${a.id}`, "DELETE");
      toast(r.deactivated ? "Artikel deaktiviert (hat Verkäufe)" : "Artikel gelöscht");
      load();
    } catch (e) {
      fail(e);
    }
  }

  return (
    <>
      <div class="row between" style="margin-bottom:1rem">
        <div>
          <h2>Artikel</h2>
          <small>Festpreise. Bestand wird im Reiter „Bestand“ aufgefüllt.</small>
        </div>
        {!readOnly && (
          <button class="btn primary" onClick={() => setEdit({ color: COLORS[0], emoji: "", stock: 0, active: 1 })}>
            + Neuer Artikel
          </button>
        )}
      </div>
      <div class="card">
        {!rows ? (
          <p class="empty">Lade …</p>
        ) : rows.length === 0 ? (
          <p class="empty">Noch keine Artikel.</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th class="num">Preis</th>
                  <th class="num">Bestand</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} class={a.active ? "" : "dim"}>
                    <td>
                      <span class="swatch" style={{ background: a.color }} /> {a.emoji} <b>{a.name}</b>
                    </td>
                    <td class="num">{euro(a.price_cents)}</td>
                    <td class="num">{a.stock}</td>
                    <td>{a.active ? <span class="pill good">aktiv</span> : <span class="pill">inaktiv</span>}</td>
                    <td class="right nowrap">
                      {!readOnly && (
                        <>
                          <button class="btn sm" onClick={() => setEdit(a)}>
                            Bearbeiten
                          </button>{" "}
                          <button class="btn sm danger" onClick={() => del(a)} aria-label="Entfernen">
                            ✕
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {edit && (
        <ArticleForm
          pid={pid}
          initial={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            load();
          }}
        />
      )}
    </>
  );
}

function ArticleForm(props: { pid: string; initial: Partial<Article>; onClose: () => void; onSaved: () => void }) {
  const fail = useAuthGuard();
  const a = props.initial;
  const isNew = !a.id;
  const [name, setName] = useState(a.name ?? "");
  const [price, setPrice] = useState(a.price_cents != null ? (a.price_cents / 100).toFixed(2).replace(".", ",") : "");
  const [emoji, setEmoji] = useState(a.emoji ?? "");
  const [color, setColor] = useState(a.color ?? COLORS[0]);
  const [stock, setStock] = useState(String(a.stock ?? 0));
  const [sort, setSort] = useState(String(a.sort ?? 0));
  const [active, setActive] = useState(a.active !== 0);
  const cents = parseEuro(price);
  const stockN = Number(stock);

  async function submit(e: Event) {
    e.preventDefault();
    if (cents == null) return;
    const payload = { project_id: props.pid, name, price_cents: cents, emoji, color, sort: Number(sort) || 0, active, stock: Math.max(0, Math.floor(stockN) || 0) };
    try {
      if (isNew) await api("/api/admin/articles", "POST", payload);
      else await api(`/api/admin/articles/${a.id}`, "PUT", payload);
      toast("Gespeichert");
      props.onSaved();
    } catch (err) {
      fail(err);
    }
  }
  return (
    <Modal title={isNew ? "Neuer Artikel" : "Artikel bearbeiten"} onClose={props.onClose}>
      <form onSubmit={submit}>
        <label class="field">
          <span>Name</span>
          <input type="text" autoFocus maxLength={60} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <div class="grid2">
          <MoneyField label="Preis" value={price} onInput={setPrice} />
          <label class="field">
            <span>Symbol (Emoji)</span>
            <input type="text" maxLength={4} placeholder="🥨" value={emoji} onInput={(e) => setEmoji((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <div class="field">
          <span>Farbe</span>
          <div class="chips">
            {COLORS.map((c) => (
              <button type="button" key={c} class={`chip ${color === c ? "on" : ""}`} style={{ background: c, borderColor: c, minWidth: "44px" }} aria-label={`Farbe ${c}`} onClick={() => setColor(c)}>
                {color === c ? "✓" : ""}
              </button>
            ))}
          </div>
        </div>
        <div class="grid2">
          {isNew && (
            <label class="field">
              <span>Anfangsbestand</span>
              <input type="number" min={0} value={stock} onInput={(e) => setStock((e.target as HTMLInputElement).value)} />
            </label>
          )}
          <label class="field">
            <span>Reihenfolge</span>
            <input type="number" value={sort} onInput={(e) => setSort((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <label class="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive((e.target as HTMLInputElement).checked)} /> In der Kasse anzeigen
        </label>
        <button class="btn primary big" disabled={!name.trim() || cents == null}>
          Speichern
        </button>
      </form>
    </Modal>
  );
}

// ---------- Bestand ----------
function StockTab({ pid, readOnly }: PW) {
  const fail = useAuthGuard();
  const [rows, setRows] = useState<Article[] | null>(null);
  const [moves, setMoves] = useState<StockMovement[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [adj, setAdj] = useState<Article | null>(null);

  const load = () => {
    api<Article[]>(`/api/admin/articles?project=${pid}`).then(setRows).catch(fail);
    api<StockMovement[]>(`/api/admin/stock-movements?project=${pid}`).then(setMoves).catch(fail);
  };
  useEffect(() => {
    load();
    api<Settings>("/api/admin/settings").then(setSettings).catch(() => {});
  }, []);
  const low = settings?.low_stock ?? 5;
  const REASON: Record<string, string> = { sale: "Verkauf", restock: "Wareneingang", correction: "Korrektur", void: "Storno" };

  return (
    <>
      <h2 style="margin-bottom:1rem">Bestand</h2>
      <div class="card">
        {!rows ? (
          <p class="empty">Lade …</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th class="num">Bestand</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((a) => a.active)
                  .map((a) => (
                    <tr key={a.id}>
                      <td>
                        {a.emoji} <b>{a.name}</b>
                      </td>
                      <td class="num">
                        <span class={`pill ${a.stock === 0 ? "bad" : a.stock <= low ? "warn" : "good"}`}>{a.stock}</span>
                      </td>
                      <td class="right">
                        {!readOnly && (
                          <button class="btn sm" onClick={() => setAdj(a)}>
                            Bestand ändern
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div class="card">
        <h3>Bewegungen (letzte 200)</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Artikel</th>
                <th>Art</th>
                <th class="num">Menge</th>
                <th>Notiz</th>
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id}>
                  <td class="nowrap">{fmtDateTime(m.created_at)}</td>
                  <td>{m.article_name ?? "(gelöscht)"}</td>
                  <td>{REASON[m.reason] ?? m.reason}</td>
                  <td class="num">
                    <b class={m.delta < 0 ? "err" : ""}>{m.delta > 0 ? `+${m.delta}` : m.delta}</b>
                  </td>
                  <td>{m.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {adj && (
        <AdjustStock
          article={adj}
          onClose={() => setAdj(null)}
          onDone={() => {
            setAdj(null);
            load();
          }}
        />
      )}
    </>
  );
}

function AdjustStock(props: { article: Article; onClose: () => void; onDone: () => void }) {
  const fail = useAuthGuard();
  const [mode, setMode] = useState<"restock" | "correction">("restock");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const n = Math.floor(Number(amount));
  const valid = Number.isFinite(n) && n !== 0 && props.article.stock + (mode === "restock" ? Math.abs(n) : n) >= 0;

  async function submit() {
    const delta = mode === "restock" ? Math.abs(n) : n;
    try {
      await api(`/api/admin/articles/${props.article.id}/stock`, "POST", { delta, reason: mode, note });
      toast("Bestand aktualisiert");
      props.onDone();
    } catch (e) {
      fail(e);
    }
  }
  return (
    <Modal title={`Bestand: ${props.article.name}`} onClose={props.onClose}>
      <p class="muted" style="margin-top:0">
        Aktuell: <b>{props.article.stock}</b>
      </p>
      <div class="chips">
        <button class={`chip ${mode === "restock" ? "on" : ""}`} onClick={() => setMode("restock")}>
          Wareneingang (+)
        </button>
        <button class={`chip ${mode === "correction" ? "on" : ""}`} onClick={() => setMode("correction")}>
          Korrektur (+/−)
        </button>
      </div>
      <label class="field">
        <span>{mode === "restock" ? "Menge" : "Änderung (z. B. -3 oder 2)"}</span>
        <input type="number" autoFocus value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
      </label>
      <label class="field">
        <span>Notiz (optional)</span>
        <input type="text" value={note} placeholder={mode === "restock" ? "z. B. Einkauf Bäcker" : "z. B. Inventur"} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
      </label>
      <button class="btn primary big" disabled={!valid} onClick={submit}>
        Speichern
      </button>
    </Modal>
  );
}

// ---------- Auswertung ----------
function StatsTab({ pid, project }: { pid: string; project: Project }) {
  const fail = useAuthGuard();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(todayIso());
  const [st, setSt] = useState<Stats | null>(null);

  const load = () => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    q.set("project", pid);
    api<Stats>(`/api/admin/stats?${q}`)
      .then(setSt)
      .catch(fail);
  };
  useEffect(load, [from, to]);

  function csv() {
    if (!st) return;
    const out = [csvLine(["Schicht", "Datum", "Status", "Startbetrag", "Erlös", "Spenden", "Gezählt"])];
    for (const s of st.shifts) out.push(csvLine([s.name, fmtDate(s.created_at), s.status, s.starting_cents / 100, s.revenue / 100, s.donations / 100, s.counted_cents == null ? "" : s.counted_cents / 100]));
    out.push("", csvLine(["Artikel", "Menge", "Umsatz"]));
    for (const a of st.byArticle) out.push(csvLine([a.name, a.qty, a.revenue / 100]));
    download(`SV-Kasse_${project.name.replace(/[^a-zA-Z0-9äöüÄÖÜß_-]+/g, "_")}_${from || "alle"}_${to || "heute"}.csv`, out.join("\n"));
  }

  return (
    <>
      <div class="row between" style="margin-bottom:1rem">
        <h2>Auswertung</h2>
        <div class="row">
          <button class="btn" disabled={!st} onClick={csv}>
            CSV
          </button>
          <button class="btn primary" disabled={!st} onClick={() => st && rangeReportPdf(st, from, to).catch(fail)}>
            PDF-Gesamtbericht
          </button>
        </div>
      </div>
      <div class="card">
        <div class="grid2">
          <label class="field">
            <span>Von</span>
            <input type="date" value={from} onInput={(e) => setFrom((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>Bis</span>
            <input type="date" value={to} onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        {st && (
          <div class="stats" style="margin-bottom:0">
            <Stat label="Verkaufserlöse" value={euro(st.totals.revenue)} />
            <Stat label="SV-Spenden" value={euro(st.totals.donations)} />
            <Stat label="Gesamt" value={euro(st.totals.revenue + st.totals.donations)} tone="good" />
            <Stat label="Verkäufe" value={String(st.totals.sales_count)} />
          </div>
        )}
      </div>
      {st && (
        <>
          <div class="card">
            <h3>Nach Tag</h3>
            {st.byDay.length === 0 ? (
              <p class="empty">Keine Daten im Zeitraum.</p>
            ) : (
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th class="num">Verkäufe</th>
                      <th class="num">Erlös</th>
                      <th class="num">Spenden</th>
                    </tr>
                  </thead>
                  <tbody>
                    {st.byDay.map((d) => (
                      <tr key={d.day}>
                        <td>{d.day.split("-").reverse().join(".")}</td>
                        <td class="num">{d.sales_count}</td>
                        <td class="num">{euro(d.revenue)}</td>
                        <td class="num">{euro(d.donations)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div class="card">
            <h3>Nach Artikel</h3>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Artikel</th>
                    <th class="num">Menge</th>
                    <th class="num">Umsatz</th>
                  </tr>
                </thead>
                <tbody>
                  {st.byArticle.map((a) => (
                    <tr key={a.name}>
                      <td>{a.name}</td>
                      <td class="num">{a.qty}</td>
                      <td class="num">{euro(a.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ---------- Einstellungen ----------
function SettingsTab() {
  const fail = useAuthGuard();
  const [s, setS] = useState<Settings | null>(null);
  const [quick, setQuick] = useState("");
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");

  useEffect(() => {
    api<Settings>("/api/admin/settings")
      .then((x) => {
        setS(x);
        setQuick(x.donation_quick.map((c) => (c / 100).toFixed(2).replace(".", ",")).join("; "));
      })
      .catch(fail);
  }, []);
  if (!s) return <p class="empty">Lade …</p>;

  async function save(e: Event) {
    e.preventDefault();
    const parts = quick.split(/[;\s]+/).filter(Boolean);
    const cents = parts.map(parseEuro);
    if (cents.some((c) => c == null || c <= 0)) return toast("Spenden-Schnellwerte: Beträge wie 0,50; 1; 2 eingeben", "err");
    try {
      await api("/api/admin/settings", "PUT", { ...s, donation_quick: cents });
      toast("Einstellungen gespeichert");
    } catch (err) {
      fail(err);
    }
  }
  async function changePw(e: Event) {
    e.preventDefault();
    try {
      await api("/api/admin/password", "POST", { current: cur, next });
      toast("Passwort geändert");
      setCur("");
      setNext("");
    } catch (err) {
      fail(err);
    }
  }
  const set = (k: keyof Settings) => (e: Event) => setS({ ...s, [k]: (e.target as HTMLInputElement).value } as Settings);
  const setNum = (k: keyof Settings) => (e: Event) => setS({ ...s, [k]: Math.floor(Number((e.target as HTMLInputElement).value)) } as Settings);

  return (
    <>
      <h2 style="margin-bottom:1rem">Einstellungen</h2>
      <form class="card" onSubmit={save}>
        <h3>Allgemein</h3>
        <div class="grid2">
          <label class="field">
            <span>Name der SV / Kasse</span>
            <input type="text" value={s.sv_name} onInput={set("sv_name")} />
          </label>
          <label class="field">
            <span>Schule</span>
            <input type="text" value={s.school_name} onInput={set("school_name")} />
          </label>
          <label class="field">
            <span>Warnung bei Bestand bis</span>
            <input type="number" min={0} value={s.low_stock} onInput={setNum("low_stock")} />
          </label>
          <label class="field">
            <span>Länge des Kassencodes (4–10)</span>
            <input type="number" min={4} max={10} value={s.code_length} onInput={setNum("code_length")} />
          </label>
        </div>
        <label class="field">
          <span>Schnellwerte für SV-Spenden (in €, mit Semikolon getrennt)</span>
          <input type="text" value={quick} onInput={(e) => setQuick((e.target as HTMLInputElement).value)} />
        </label>
        <button class="btn primary">Speichern</button>
      </form>

      <form class="card" onSubmit={changePw}>
        <h3>Admin-Passwort ändern</h3>
        <div class="grid2">
          <label class="field">
            <span>Aktuelles Passwort</span>
            <input type="password" autoComplete="off" value={cur} onInput={(e) => setCur((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>Neues Passwort (mind. 8 Zeichen)</span>
            <input type="password" autoComplete="new-password" value={next} onInput={(e) => setNext((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <button class="btn" disabled={!cur || next.length < 8}>
          Passwort ändern
        </button>
      </form>
    </>
  );
}
