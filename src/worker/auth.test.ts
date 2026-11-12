import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signToken } from "./auth";
import { ADMIN_PASSWORD, SESSION_SECRET, type TestWorld, api, createWorld, loginCashier, seed } from "./testkit";

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
}, 60_000);
afterAll(async () => {
  await w?.close();
});

let ipN = 0;
/** Jeder Test bekommt eine eigene "Adresse", damit die Sperre nach Fehlversuchen nicht auf andere Tests abfärbt */
const freshIp = () => ({ "cf-connecting-ip": `10.0.0.${++ipN}` });
const adminLogin = (password: string, ip = freshIp()) => api.anonymous(w.env, "POST", "/api/admin/login", { password }, ip);
const cashierLogin = (code: string, ip = freshIp()) => api.anonymous(w.env, "POST", "/api/cashier/login", { code }, ip);
const future = () => Math.floor(Date.now() / 1000) + 3600;

describe("Adminbereich", () => {
  it("Anmeldung mit richtigem Passwort liefert ein Token", async () => {
    const r = await adminLogin(ADMIN_PASSWORD);
    expect(r.status).toBe(200);
    expect(typeof r.body.token).toBe("string");
  });

  it("falsches Passwort wird abgelehnt", async () => {
    for (const pw of ["", "falsch", `${ADMIN_PASSWORD} `, ADMIN_PASSWORD.toUpperCase()]) {
      expect((await adminLogin(pw)).status, pw).toBe(401);
    }
  });

  it("ohne Token, mit kaputtem oder abgelaufenem Token gibt es keine Daten", async () => {
    const real = (await adminLogin(ADMIN_PASSWORD)).body.token as string;
    const expired = await signToken({ role: "admin", exp: Math.floor(Date.now() / 1000) - 10 }, SESSION_SECRET);
    const foreign = await signToken({ role: "admin", exp: future() }, "ein-ganz-anderes-geheimnis-123456");
    const tampered = `${real.split(".")[0]}.${"A".repeat(43)}`;
    for (const token of [undefined, "", "abc", real.split(".")[0], tampered, expired, foreign]) {
      const r = await api.anonymous(w.env, "GET", "/api/admin/articles", undefined, token ? { Authorization: `Bearer ${token}` } : {});
      expect(r.status, String(token).slice(0, 20)).toBe(401);
    }
    expect((await api.anonymous(w.env, "GET", "/api/admin/articles", undefined, { Authorization: `Bearer ${real}` })).status).toBe(200);
  });

  it("ein Kassen-Token öffnet den Adminbereich nicht", async () => {
    const cashierToken = await signToken({ role: "cashier", shift: "x", exp: future() }, SESSION_SECRET);
    const r = await api.anonymous(w.env, "GET", "/api/admin/articles", undefined, { Authorization: `Bearer ${cashierToken}` });
    expect(r.status).toBe(401);
  });

  it("alle Admin-Wege verlangen eine Anmeldung", async () => {
    const paths: [string, string][] = [
      ["GET", "/api/admin/settings"],
      ["PUT", "/api/admin/settings"],
      ["GET", "/api/admin/projects"],
      ["POST", "/api/admin/projects"],
      ["GET", "/api/admin/articles"],
      ["POST", "/api/admin/articles"],
      ["GET", "/api/admin/shifts"],
      ["POST", "/api/admin/shifts"],
      ["POST", "/api/admin/shifts/x/close"],
      ["DELETE", "/api/admin/shifts/x"],
      ["POST", "/api/admin/sales/x/void"],
      ["GET", "/api/admin/stats"],
      ["POST", "/api/admin/password"],
      ["GET", "/api/admin/stock-movements"],
    ];
    for (const [method, path] of paths) {
      const r = await api.anonymous(w.env, method, path, method === "GET" ? undefined : {});
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });

  it("ohne SESSION_SECRET ist nichts erreichbar", async () => {
    const env = { ...w.env, SESSION_SECRET: "" };
    expect((await api.anonymous(env, "POST", "/api/admin/login", { password: ADMIN_PASSWORD }, freshIp())).status).toBe(403);
    expect((await api.anonymous(env, "POST", "/api/cashier/login", { code: "X" }, freshIp())).status).toBe(403);
  });
});

describe("Passwort ändern", () => {
  it("prüft das alte Passwort und die Länge, dann gilt nur noch das neue", async () => {
    const tooShort = await api.admin(w.env, "POST", "/api/admin/password", { current: ADMIN_PASSWORD, next: "kurz" });
    expect(tooShort.status).toBe(400);
    const wrong = await api.admin(w.env, "POST", "/api/admin/password", { current: "nope", next: "ein-neues-passwort" });
    expect(wrong.status).toBe(403);
    expect((await adminLogin(ADMIN_PASSWORD)).status).toBe(200);

    const ok = await api.admin(w.env, "POST", "/api/admin/password", { current: ADMIN_PASSWORD, next: "ein-neues-passwort" });
    expect(ok.status).toBe(200);
    expect((await adminLogin(ADMIN_PASSWORD)).status).toBe(401);
    expect((await adminLogin("ein-neues-passwort")).status).toBe(200);

    // zurücksetzen, damit andere Tests mit dem Standardpasswort laufen
    await w.env.DB.prepare("DELETE FROM settings WHERE key = 'admin_hash'").run();
    expect((await adminLogin(ADMIN_PASSWORD)).status).toBe(200);
  });

  it("speichert das Passwort nicht im Klartext", async () => {
    await api.admin(w.env, "POST", "/api/admin/password", { current: ADMIN_PASSWORD, next: "geheim-geheim-123" });
    const row = await w.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_hash'").first<{ value: string }>();
    expect(row!.value).not.toContain("geheim-geheim-123");
    expect(row!.value.split("$")).toHaveLength(3);
    await w.env.DB.prepare("DELETE FROM settings WHERE key = 'admin_hash'").run();
  });
});

describe("Kassencode", () => {
  it("unbekannter Code wird abgelehnt", async () => {
    for (const code of ["", "NOPE99", "   "]) expect((await cashierLogin(code)).status, code).toBe(401);
  });

  it("Groß- und Kleinschreibung ist egal, Leerzeichen am Rand auch", async () => {
    const s = await seed(w.env);
    expect((await cashierLogin(s.code.toLowerCase())).status).toBe(200);
    expect((await cashierLogin(`  ${s.code} `)).status).toBe(200);
  });

  it("erster Login öffnet die Kasse, weitere Geräte können mit demselben Code mitarbeiten", async () => {
    const created = await api.admin(w.env, "POST", "/api/admin/projects", { name: "Login-Test" });
    const shift = await api.admin(w.env, "POST", "/api/admin/shifts", { name: "P", starting_cents: 0, code: "LOGIN1", project_id: created.body.id });
    const row = () => w.env.DB.prepare("SELECT status, opened_at FROM shifts WHERE id = ?").bind(shift.body.id).first<{ status: string; opened_at: string | null }>();
    expect((await row())!.status).toBe("ready");
    expect((await cashierLogin("LOGIN1")).status).toBe(200);
    const opened = await row();
    expect(opened!.status).toBe("open");
    expect((await cashierLogin("LOGIN1")).status).toBe(200);
    expect((await row())!.opened_at).toBe(opened!.opened_at);
  });

  it("zwei offene Kassen können nicht denselben Code haben", async () => {
    const s = await seed(w.env);
    const r = await api.admin(w.env, "POST", "/api/admin/shifts", { name: "Zweite", starting_cents: 0, code: s.code, project_id: s.projectId });
    expect(r.status).toBe(409);
  });

  it("generierte Codes haben die eingestellte Länge", async () => {
    const created = await api.admin(w.env, "POST", "/api/admin/projects", { name: "Code-Länge" });
    const r = await api.admin(w.env, "POST", "/api/admin/shifts", { name: "P", starting_cents: 0, project_id: created.body.id });
    expect(r.body.code).toMatch(/^\d{6}$/);
  });

  it("Kassen-Cookie öffnet keinen Adminbereich und ein Admin-Token keine Kasse", async () => {
    const s = await seed(w.env);
    expect((await api.cashier(w.env, s.cookie, "GET", "/api/admin/articles")).status).toBe(401);
    // selbst ein gültig signiertes Admin-Token mit Kassen-Angabe darf nicht als Kasse durchgehen
    const adminAsCashier = await signToken({ role: "admin", shift: s.shiftId, exp: future() }, SESSION_SECRET);
    expect((await api.cashier(w.env, `cashier=${adminAsCashier}`, "GET", "/api/cashier/state")).status).toBe(401);
    expect((await api.cashier(w.env, `cashier=${adminAsCashier}`, "POST", "/api/cashier/sales", { items: [{ article_id: s.articles.Brezel.id, qty: 1 }] })).status).toBe(401);
  });

  it("kaputte oder abgelaufene Kassen-Cookies werden abgelehnt", async () => {
    const s = await seed(w.env);
    const expired = await signToken({ role: "cashier", shift: s.shiftId, exp: Math.floor(Date.now() / 1000) - 5 }, SESSION_SECRET);
    const tampered = `${s.cookie.split(".")[0]}.${"B".repeat(43)}`;
    for (const cookie of ["cashier=abc", `cashier=${expired}`, tampered]) {
      expect((await api.cashier(w.env, cookie, "GET", "/api/cashier/state")).status, cookie.slice(0, 30)).toBe(401);
    }
    expect((await api.cashier(w.env, s.cookie, "GET", "/api/cashier/state")).status).toBe(200);
  });

  it("jede Kasse sieht nur ihre eigenen Daten", async () => {
    const a = await seed(w.env);
    const b = await seed(w.env);
    await api.cashier(w.env, a.cookie, "POST", "/api/cashier/sales", { items: [{ article_id: a.articles.Brezel.id, qty: 1 }] });
    const sa = await api.cashier(w.env, a.cookie, "GET", "/api/cashier/state");
    const sb = await api.cashier(w.env, b.cookie, "GET", "/api/cashier/state");
    expect(sa.body.shift.id).toBe(a.shiftId);
    expect(sb.body.shift.id).toBe(b.shiftId);
    expect(sa.body.totals.sales_count).toBe(1);
    expect(sb.body.totals.sales_count).toBe(0);
    expect(sb.body.articles.map((x: { id: string }) => x.id)).not.toContain(a.articles.Brezel.id);
  });
});

describe("Sperre nach Fehlversuchen", () => {
  it("sperrt nach 10 Fehlversuchen, auch für den richtigen Code und das richtige Passwort", async () => {
    const ip = freshIp();
    const s = await seed(w.env);
    for (let i = 0; i < 10; i++) expect((await cashierLogin("FALSCH", ip)).status).toBe(401);
    expect((await cashierLogin("FALSCH", ip)).status).toBe(429);
    expect((await cashierLogin(s.code, ip)).status).toBe(429);
    expect((await adminLogin(ADMIN_PASSWORD, ip)).status).toBe(429);
  });

  it("andere Geräte bleiben dabei unberührt", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) await adminLogin("falsch", ip);
    expect((await adminLogin("falsch", ip)).status).toBe(429);
    expect((await adminLogin(ADMIN_PASSWORD)).status).toBe(200);
  });

  it("9 Fehlversuche reichen noch nicht", async () => {
    const ip = freshIp();
    const s = await seed(w.env);
    for (let i = 0; i < 9; i++) await cashierLogin("FALSCH", ip);
    expect((await cashierLogin(s.code, ip)).status).toBe(200);
  });

  it("alte Fehlversuche verfallen nach 10 Minuten", async () => {
    const ip = freshIp();
    const s = await seed(w.env);
    const old = Math.floor(Date.now() / 1000) - 11 * 60;
    for (let i = 0; i < 12; i++) await w.env.DB.prepare("INSERT INTO login_attempts (ip, at) VALUES (?, ?)").bind(ip["cf-connecting-ip"], old).run();
    expect((await cashierLogin(s.code, ip)).status).toBe(200);
  });
});

describe("Öffentliche Daten", () => {
  it("zeigt nur Namen, keine Einstellungen oder Zugangsdaten", async () => {
    const r = await api.anonymous(w.env, "GET", "/api/public/settings");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["school_name", "sv_name"]);
  });

  it("Kassen-Login nach Abmeldung: Cookie wird gelöscht", async () => {
    const s = await seed(w.env);
    const r = await api.cashier(w.env, s.cookie, "POST", "/api/cashier/logout");
    expect(r.status).toBe(200);
    expect(await loginCashier(w.env, s.code)).toContain("cashier=");
  });
});
