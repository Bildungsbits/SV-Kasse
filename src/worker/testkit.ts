/**
 * Hilfen für die API-Tests: eine echte (lokale) D1-Datenbank mit den Migrationen des Projekts,
 * die Worker-App wird direkt aufgerufen, so wie es der Browser über HTTP tut.
 */
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import app from "./index";

export const ADMIN_PASSWORD = "test-admin-passwort";
export const SESSION_SECRET = "test-geheimnis-test-geheimnis-test";

// Alle Migrationen des Projekts (Vite liest sie beim Testlauf als Text ein)
const migrations = import.meta.glob("../../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export interface Env {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
}

export interface TestWorld {
  env: Env;
  close: () => Promise<void>;
}

/** Migrationen in Einzelanweisungen zerlegen (D1 führt nur eine Anweisung pro prepare aus) */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function createWorld(): Promise<TestWorld> {
  // Miniflare 5 kennt ein neues Optionsformat; die bekannte flache Schreibweise wird hier umgewandelt
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "test" },
    }),
  );
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const file of Object.keys(migrations).sort()) {
    for (const stmt of statements(migrations[file])) await db.prepare(stmt).run();
  }
  return {
    env: { DB: db, ADMIN_PASSWORD, SESSION_SECRET },
    close: () => mf.dispose(),
  };
}

export interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
  cookie?: string;
}

async function call<T = Record<string, any>>(env: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
  const res = await app.request(
    path,
    {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    env,
  );
  let json: unknown = {};
  try {
    json = await res.json();
  } catch {
    /* leer */
  }
  const set = res.headers.get("set-cookie");
  return { status: res.status, body: json as T, cookie: set?.split(";")[0] };
}

export const api = {
  /** Admin-Anfrage mit frischem Token */
  async admin<T = Record<string, any>>(env: Env, method: string, path: string, body?: unknown): Promise<Res<T>> {
    const token = await adminToken(env);
    return call<T>(env, method, path, body, { Authorization: `Bearer ${token}` });
  },
  /** Kassen-Anfrage mit dem Cookie aus loginCashier */
  cashier<T = Record<string, any>>(env: Env, cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
    return call<T>(env, method, path, body, { Cookie: cookie });
  },
  anonymous: call,
};

export async function adminToken(env: Env): Promise<string> {
  const r = await call<{ token: string }>(env, "POST", "/api/admin/login", { password: ADMIN_PASSWORD });
  if (r.status !== 200) throw new Error(`Admin-Login fehlgeschlagen: ${r.status}`);
  return r.body.token;
}

export async function loginCashier(env: Env, code: string): Promise<string> {
  const r = await call(env, "POST", "/api/cashier/login", { code });
  if (r.status !== 200 || !r.cookie) throw new Error(`Kassen-Login fehlgeschlagen: ${r.status}`);
  return r.cookie;
}

export interface Seeded {
  projectId: string;
  shiftId: string;
  code: string;
  cookie: string;
  articles: Record<string, { id: string; price: number }>;
}

let counter = 0;

/** Neues Projekt mit Artikeln und einer geöffneten Kasse. Jeder Aufruf ist von den anderen getrennt. */
export async function seed(env: Env, articles: Record<string, { price: number; stock: number }> = { Brezel: { price: 150, stock: 10 }, Saft: { price: 100, stock: 20 } }, startingCents = 5000): Promise<Seeded> {
  const n = ++counter;
  const p = await api.admin(env, "POST", "/api/admin/projects", { name: `Projekt ${n}` });
  const projectId = p.body.id as string;
  const made: Seeded["articles"] = {};
  for (const [name, a] of Object.entries(articles)) {
    const r = await api.admin(env, "POST", "/api/admin/articles", { name, price_cents: a.price, stock: a.stock, emoji: "", color: "#3b82f6", project_id: projectId });
    if (r.status !== 200) throw new Error(`Artikel anlegen fehlgeschlagen: ${JSON.stringify(r.body)}`);
    made[name] = { id: r.body.id as string, price: a.price };
  }
  const code = `T${String(n).padStart(5, "0")}`;
  const s = await api.admin(env, "POST", "/api/admin/shifts", { name: `Pause ${n}`, starting_cents: startingCents, code, project_id: projectId });
  if (s.status !== 200) throw new Error(`Schicht anlegen fehlgeschlagen: ${JSON.stringify(s.body)}`);
  const cookie = await loginCashier(env, code);
  return { projectId, shiftId: s.body.id as string, code, cookie, articles: made };
}

export const uuid = () => crypto.randomUUID();

export async function stockOf(env: Env, articleId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT stock FROM articles WHERE id = ?").bind(articleId).first<{ stock: number }>();
  return r!.stock;
}

export async function movements(env: Env, articleId: string) {
  const r = await env.DB.prepare("SELECT delta, reason, sale_id, note FROM stock_movements WHERE article_id = ? ORDER BY id").bind(articleId).all<{ delta: number; reason: string; sale_id: string | null; note: string }>();
  return r.results;
}

export async function resetLoginAttempts(env: Env) {
  await env.DB.prepare("DELETE FROM login_attempts").run();
}
