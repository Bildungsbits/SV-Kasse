import { useEffect, useState } from "preact/hooks";
import { ApiError, api, errMsg, go } from "../api";
import { hasCachedState } from "../offlineStore";
import { RegisterIcon } from "../ui";

export function Home() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState({ sv_name: "SV-Kasse", school_name: "" });

  useEffect(() => {
    api<{ sv_name: string; school_name: string }>("/api/public/settings").then(setTitle).catch(() => {});
    // Läuft bereits eine Sitzung auf diesem Gerät? Dann direkt weiter.
    api("/api/cashier/state", "GET", undefined, 5000)
      .then(() => go("/kasse"))
      .catch((e) => {
        // Kein Netz, aber die Kasse lief auf diesem Gerät schon: offline weiterarbeiten
        if (e instanceof ApiError && e.status === 0 && hasCachedState()) go("/kasse");
      });
  }, []);

  async function submit(e: Event) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/cashier/login", "POST", { code });
      go("/kasse");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="hero">
      <div class="card hero-card">
        <div class="logo" aria-hidden="true">
          <RegisterIcon />
        </div>
        <h1>{title.sv_name}</h1>
        {title.school_name && <p class="muted">{title.school_name}</p>}
        <form onSubmit={submit} style="margin-top:1.4rem">
          <label class="field">
            <span>Kassencode</span>
            <input
              class="code-input"
              type="text"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              autoFocus
              maxLength={10}
              value={code}
              placeholder="······"
              onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            />
          </label>
          {error && (
            <p class="err" role="alert">
              {error}
            </p>
          )}
          <button class="btn primary big" disabled={busy || !code}>
            {busy ? "Prüfe …" : "Kasse starten"}
          </button>
        </form>
        <p style="margin-top:1.4rem">
          <a href="#/admin" class="muted">
            Adminbereich für Lehrkräfte
          </a>
          {" · "}
          <a href="#/impressum" class="muted">
            Impressum
          </a>
        </p>
      </div>
    </main>
  );
}
