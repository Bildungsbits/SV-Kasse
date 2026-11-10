import { Hono } from "hono";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { computePayment } from "../shared/money";
import { hashPassword, randomCode, signToken, timingSafeEqual, verifyPassword, verifyToken } from "./auth";

type Bindings = { DB: D1Database; ADMIN_PASSWORD?: string; SESSION_SECRET?: string };
type Vars = { shiftId?: string };
type C = Context<{ Bindings: Bindings; Variables: Vars }>;

const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();

const ADMIN_TTL = 60 * 60 * 2;
const CASHIER_TTL = 60 * 60 * 12;
const MAX_FAILS = 10;
const FAIL_WINDOW_S = 600;

// ---------- Helfer ----------
const secret = (c: C) => c.env.SESSION_SECRET || "";
const bad = (c: C, msg: string, status: 400 | 401 | 403 | 404 | 409 | 429 = 400) => c.json({ error: msg }, status);
const pid = (c: C) => c.req.param("id") ?? "";
const nowIso = () => new Date().toISOString().replace("T", " ").slice(0, 19); // UTC, wie SQLite datetime()
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

async function body<T>(c: C): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

async function getSetting(db: D1Database, key: string, fallback = ""): Promise<string> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? fallback;
}

async function publicSettings(db: D1Database) {
  const rows = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const m = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  let quick: number[] = [50, 100, 200];
  try {
    quick = JSON.parse(m.donation_quick ?? "[]");
  } catch {
    /* Standard bleibt */
  }
  return {
    school_name: m.school_name ?? "",
    sv_name: m.sv_name ?? "SV-Kasse",
    low_stock: Number(m.low_stock ?? 5),
    code_length: Number(m.code_length ?? 6),
    donation_quick: quick,
  };
}

function setSession(c: C, name: string, token: string, ttl: number) {
  setCookie(c, name, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: ttl,
  });
}

async function tooManyFails(c: C): Promise<boolean> {
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const since = Math.floor(Date.now() / 1000) - FAIL_WINDOW_S;
  await c.env.DB.prepare("DELETE FROM login_attempts WHERE at < ?").bind(since).run();
  const r = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at >= ?")
    .bind(ip, since)
    .first<{ n: number }>();
  return (r?.n ?? 0) >= MAX_FAILS;
}
async function recordFail(c: C) {
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  await c.env.DB.prepare("INSERT INTO login_attempts (ip, at) VALUES (?, ?)")
    .bind(ip, Math.floor(Date.now() / 1000))
    .run();
}

// ---------- Middleware ----------
async function requireAdmin(c: C, next: Next) {
  if (!secret(c)) return bad(c, "SESSION_SECRET ist nicht konfiguriert", 403);
  // Admin-Token wird nur im Arbeitsspeicher der Seite gehalten (nie als Cookie/Storage gespeichert)
  const auth = c.req.header("Authorization") ?? "";
  const p = await verifyToken(auth.startsWith("Bearer ") ? auth.slice(7) : undefined, secret(c));
  if (p?.role !== "admin") return bad(c, "Nicht angemeldet", 401);
  await next();
}

async function requireCashier(c: C, next: Next) {
  if (!secret(c)) return bad(c, "SESSION_SECRET ist nicht konfiguriert", 403);
  const p = await verifyToken(getCookie(c, "cashier"), secret(c));
  if (p?.role !== "cashier" || !p.shift) return bad(c, "Nicht angemeldet", 401);
  c.set("shiftId", p.shift);
  await next();
}

// ---------- Berichte ----------
interface ShiftRow {
  id: string;
  name: string;
  code: string;
  starting_cents: number;
  status: "ready" | "open" | "closed";
  created_at: string;
  opened_at: string | null;
  closed_at: string | null;
  counted_cents: number | null;
  note: string;
}

async function shiftTotals(db: D1Database, shift: ShiftRow) {
  const t = await db
    .prepare(
      `SELECT COUNT(*) AS sales_count,
              COALESCE(SUM(total_cents),0) AS revenue,
              COALESCE(SUM(donation_cents),0) AS donations
       FROM sales WHERE shift_id = ? AND voided_at IS NULL`,
    )
    .bind(shift.id)
    .first<{ sales_count: number; revenue: number; donations: number }>();
  const v = await db
    .prepare("SELECT COUNT(*) AS n FROM sales WHERE shift_id = ? AND voided_at IS NOT NULL")
    .bind(shift.id)
    .first<{ n: number }>();
  const revenue = t?.revenue ?? 0;
  const donations = t?.donations ?? 0;
  const expected = shift.starting_cents + revenue + donations;
  return {
    sales_count: t?.sales_count ?? 0,
    voided_count: v?.n ?? 0,
    revenue,
    donations,
    expected,
    difference: shift.counted_cents == null ? null : shift.counted_cents - expected,
  };
}

async function salesWithItems(db: D1Database, shiftId: string, limit?: number) {
  const sales = await db
    .prepare(
      `SELECT * FROM sales WHERE shift_id = ? ORDER BY created_at DESC, rowid DESC ${limit ? "LIMIT " + Number(limit) : ""}`,
    )
    .bind(shiftId)
    .all<Record<string, unknown> & { id: string }>();
  if (!sales.results.length) return [];
  const items = await db
    .prepare(
      `SELECT si.sale_id, si.article_id, si.name, si.unit_price_cents, si.qty
       FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.shift_id = ?`,
    )
    .bind(shiftId)
    .all<{ sale_id: string; name: string; unit_price_cents: number; qty: number; article_id: string }>();
  const by = new Map<string, typeof items.results>();
  for (const i of items.results) by.set(i.sale_id, [...(by.get(i.sale_id) ?? []), i]);
  return sales.results.map((s) => ({ ...s, items: by.get(s.id) ?? [] }));
}

async function buildReport(db: D1Database, shiftId: string) {
  const shift = await db.prepare("SELECT * FROM shifts WHERE id = ?").bind(shiftId).first<ShiftRow>();
  if (!shift) return null;
  const totals = await shiftTotals(db, shift);
  const items = await db
    .prepare(
      `SELECT si.article_id, si.name, si.unit_price_cents, SUM(si.qty) AS qty, SUM(si.qty * si.unit_price_cents) AS revenue
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.shift_id = ? AND s.voided_at IS NULL
       GROUP BY si.article_id, si.name, si.unit_price_cents ORDER BY si.name`,
    )
    .bind(shiftId)
    .all();
  const sales = await salesWithItems(db, shiftId);
  const settings = await publicSettings(db);
  return { shift, totals, items: items.results, sales: [...sales].reverse(), settings };
}

async function voidSale(db: D1Database, saleId: string, reason: string, shiftId?: string) {
  const sale = await db
    .prepare("SELECT id, shift_id, voided_at FROM sales WHERE id = ?")
    .bind(saleId)
    .first<{ id: string; shift_id: string; voided_at: string | null }>();
  if (!sale || (shiftId && sale.shift_id !== shiftId)) return { ok: false as const, error: "Verkauf nicht gefunden", status: 404 as const };
  if (sale.voided_at) return { ok: false as const, error: "Bereits storniert", status: 409 as const };
  const items = await db
    .prepare("SELECT article_id, qty FROM sale_items WHERE sale_id = ?")
    .bind(saleId)
    .all<{ article_id: string; qty: number }>();
  const stmts = [
    db.prepare("UPDATE sales SET voided_at = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL").bind(nowIso(), reason, saleId),
    ...items.results.flatMap((i) => [
      db.prepare("UPDATE articles SET stock = stock + ? WHERE id = ?").bind(i.qty, i.article_id),
      db
        .prepare("INSERT INTO stock_movements (article_id, delta, reason, sale_id, note) VALUES (?, ?, 'void', ?, ?)")
        .bind(i.article_id, i.qty, saleId, reason),
    ]),
  ];
  await db.batch(stmts);
  return { ok: true as const };
}

// ---------- Öffentlich ----------
app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/public/settings", async (c) => {
  const s = await publicSettings(c.env.DB);
  return c.json({ school_name: s.school_name, sv_name: s.sv_name });
});

// ---------- Kasse (Lehrkraft-Code) ----------
app.post("/api/cashier/login", async (c) => {
  if (!secret(c)) return bad(c, "SESSION_SECRET ist nicht konfiguriert", 403);
  if (await tooManyFails(c)) return bad(c, "Zu viele Fehlversuche. Bitte in 10 Minuten erneut versuchen.", 429);
  const b = await body<{ code?: string }>(c);
  const code = (b?.code ?? "").trim().toUpperCase();
  const shift = code
    ? await c.env.DB.prepare("SELECT * FROM shifts WHERE code = ? AND status IN ('ready','open')").bind(code).first<ShiftRow>()
    : null;
  if (!shift) {
    await recordFail(c);
    return bad(c, "Code ungültig oder Kasse bereits geschlossen", 401);
  }
  if (shift.status === "ready") {
    await c.env.DB.prepare("UPDATE shifts SET status = 'open', opened_at = ? WHERE id = ?").bind(nowIso(), shift.id).run();
  }
  const token = await signToken({ role: "cashier", shift: shift.id, exp: Math.floor(Date.now() / 1000) + CASHIER_TTL }, secret(c));
  setSession(c, "cashier", token, CASHIER_TTL);
  return c.json({ ok: true });
});

app.post("/api/cashier/logout", (c) => {
  deleteCookie(c, "cashier", { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/cashier/state", requireCashier, async (c) => {
  const db = c.env.DB;
  const shift = await db.prepare("SELECT * FROM shifts WHERE id = ?").bind(c.get("shiftId")).first<ShiftRow>();
  if (!shift) return bad(c, "Schicht nicht gefunden", 404);
  const { code: _code, ...safeShift } = shift;
  const articles = await db
    .prepare("SELECT id, name, price_cents, stock, emoji, color FROM articles WHERE active = 1 ORDER BY sort, name")
    .all();
  return c.json({
    shift: safeShift,
    totals: await shiftTotals(db, shift),
    articles: articles.results,
    sales: await salesWithItems(db, shift.id, 15),
    settings: await publicSettings(db),
  });
});

app.post("/api/cashier/sales", requireCashier, async (c) => {
  const db = c.env.DB;
  const shift = await db.prepare("SELECT status FROM shifts WHERE id = ?").bind(c.get("shiftId")).first<{ status: string }>();
  if (shift?.status !== "open") return bad(c, "Die Kasse ist geschlossen", 409);

  const b = await body<{ items?: { article_id: string; qty: number }[]; paid?: number; donation?: number }>(c);
  if (!b || !Array.isArray(b.items) || b.items.length === 0) return bad(c, "Warenkorb ist leer");

  const qtyById = new Map<string, number>();
  for (const i of b.items) {
    if (typeof i.article_id !== "string" || !isInt(i.qty) || i.qty < 1 || i.qty > 999) return bad(c, "Ungültige Menge");
    qtyById.set(i.article_id, (qtyById.get(i.article_id) ?? 0) + i.qty);
  }
  const ids = [...qtyById.keys()];
  const rows = await db
    .prepare(`SELECT id, name, price_cents, stock, active FROM articles WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: string; name: string; price_cents: number; stock: number; active: number }>();
  if (rows.results.length !== ids.length) return bad(c, "Artikel nicht gefunden");

  let total = 0;
  for (const a of rows.results) {
    const qty = qtyById.get(a.id)!;
    if (!a.active) return bad(c, `„${a.name}“ ist nicht mehr verfügbar`, 409);
    if (a.stock < qty) return bad(c, `„${a.name}“: nur noch ${a.stock} auf Lager`, 409);
    total += a.price_cents * qty;
  }

  const donation = b.donation ?? 0;
  const paid = b.paid ?? total + donation; // ohne Angabe: passend bezahlt
  const pay = computePayment(total, paid, donation);
  if (!pay.ok) return bad(c, pay.error ?? "Zahlung ungültig");

  const saleId = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare("INSERT INTO sales (id, shift_id, total_cents, donation_cents, paid_cents, change_cents, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(saleId, c.get("shiftId"), total, donation, paid, pay.change, nowIso()),
  ];
  for (const a of rows.results) {
    const qty = qtyById.get(a.id)!;
    stmts.push(
      db.prepare("INSERT INTO sale_items (sale_id, article_id, name, unit_price_cents, qty) VALUES (?,?,?,?,?)").bind(saleId, a.id, a.name, a.price_cents, qty),
      // CHECK (stock >= 0) lässt die ganze Transaktion scheitern, falls parallel ausverkauft wurde
      db.prepare("UPDATE articles SET stock = stock - ? WHERE id = ?").bind(qty, a.id),
      db.prepare("INSERT INTO stock_movements (article_id, delta, reason, sale_id) VALUES (?, ?, 'sale', ?)").bind(a.id, -qty, saleId),
    );
  }
  try {
    await db.batch(stmts);
  } catch {
    return bad(c, "Bestand hat sich geändert. Bitte Warenkorb prüfen und erneut versuchen.", 409);
  }
  return c.json({ ok: true, id: saleId, total, donation, paid, change: pay.change });
});

app.post("/api/cashier/sales/:id/void", requireCashier, async (c) => {
  const shift = await c.env.DB.prepare("SELECT status FROM shifts WHERE id = ?").bind(c.get("shiftId")).first<{ status: string }>();
  if (shift?.status !== "open") return bad(c, "Die Kasse ist geschlossen", 409);
  const b = await body<{ reason?: string }>(c);
  const reason = (b?.reason ?? "").trim().slice(0, 200);
  if (!reason) return bad(c, "Bitte einen Grund angeben");
  const r = await voidSale(c.env.DB, pid(c), reason, c.get("shiftId"));
  return r.ok ? c.json({ ok: true }) : bad(c, r.error, r.status);
});

app.post("/api/cashier/close", requireCashier, async (c) => {
  const b = await body<{ counted_cents?: number; note?: string }>(c);
  if (!b || !isInt(b.counted_cents) || b.counted_cents < 0) return bad(c, "Bitte den gezählten Kassenbetrag angeben");
  const r = await c.env.DB.prepare(
    "UPDATE shifts SET status = 'closed', closed_at = ?, counted_cents = ?, note = ? WHERE id = ? AND status = 'open'",
  )
    .bind(nowIso(), b.counted_cents, (b.note ?? "").slice(0, 500), c.get("shiftId"))
    .run();
  if (!r.meta.changes) return bad(c, "Kasse ist bereits geschlossen", 409);
  return c.json({ ok: true });
});

app.get("/api/cashier/report", requireCashier, async (c) => {
  const r = await buildReport(c.env.DB, c.get("shiftId")!);
  if (!r) return bad(c, "Nicht gefunden", 404);
  return c.json({ ...r, shift: { ...r.shift, code: undefined } });
});

// ---------- Admin ----------
app.post("/api/admin/login", async (c) => {
  if (!secret(c)) return bad(c, "SESSION_SECRET ist nicht konfiguriert", 403);
  if (await tooManyFails(c)) return bad(c, "Zu viele Fehlversuche. Bitte in 10 Minuten erneut versuchen.", 429);
  const b = await body<{ password?: string }>(c);
  const pw = b?.password ?? "";
  const stored = await getSetting(c.env.DB, "admin_hash");
  let ok = false;
  if (stored) ok = await verifyPassword(pw, stored);
  else if (c.env.ADMIN_PASSWORD) ok = timingSafeEqual(pw, c.env.ADMIN_PASSWORD);
  else return bad(c, "ADMIN_PASSWORD ist nicht konfiguriert", 403);
  if (!ok) {
    await recordFail(c);
    return bad(c, "Passwort falsch", 401);
  }
  const token = await signToken({ role: "admin", exp: Math.floor(Date.now() / 1000) + ADMIN_TTL }, secret(c));
  return c.json({ ok: true, token });
});

app.post("/api/admin/logout", (c) => c.json({ ok: true }));

app.post("/api/admin/password", requireAdmin, async (c) => {
  const b = await body<{ current?: string; next?: string }>(c);
  if (!b?.next || b.next.length < 8) return bad(c, "Neues Passwort: mindestens 8 Zeichen");
  const stored = await getSetting(c.env.DB, "admin_hash");
  const okCurrent = stored ? await verifyPassword(b.current ?? "", stored) : timingSafeEqual(b.current ?? "", c.env.ADMIN_PASSWORD ?? "\u0000");
  if (!okCurrent) return bad(c, "Aktuelles Passwort falsch", 403);
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('admin_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(await hashPassword(b.next))
    .run();
  return c.json({ ok: true });
});

// Einstellungen
app.get("/api/admin/settings", requireAdmin, async (c) => c.json(await publicSettings(c.env.DB)));
app.put("/api/admin/settings", requireAdmin, async (c) => {
  const b = await body<Record<string, unknown>>(c);
  if (!b) return bad(c, "Ungültige Daten");
  const upserts: [string, string][] = [];
  if (typeof b.school_name === "string") upserts.push(["school_name", b.school_name.slice(0, 120)]);
  if (typeof b.sv_name === "string") upserts.push(["sv_name", b.sv_name.slice(0, 120)]);
  if (isInt(b.low_stock) && b.low_stock >= 0) upserts.push(["low_stock", String(b.low_stock)]);
  if (isInt(b.code_length) && b.code_length >= 4 && b.code_length <= 10) upserts.push(["code_length", String(b.code_length)]);
  if (Array.isArray(b.donation_quick) && b.donation_quick.every((n) => isInt(n) && n > 0) && b.donation_quick.length <= 6)
    upserts.push(["donation_quick", JSON.stringify(b.donation_quick)]);
  if (upserts.length)
    await c.env.DB.batch(
      upserts.map(([k, v]) =>
        c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v),
      ),
    );
  return c.json(await publicSettings(c.env.DB));
});

// Artikel
app.get("/api/admin/articles", requireAdmin, async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM articles ORDER BY active DESC, sort, name").all();
  return c.json(r.results);
});

function parseArticle(b: Record<string, unknown> | null) {
  if (!b) return { error: "Ungültige Daten" } as const;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
  if (!name) return { error: "Name fehlt" } as const;
  if (!isInt(b.price_cents) || b.price_cents < 0 || b.price_cents > 100000) return { error: "Ungültiger Preis" } as const;
  const emoji = typeof b.emoji === "string" ? b.emoji.slice(0, 8) : "";
  const color = typeof b.color === "string" && /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : "#3b82f6";
  const sort = isInt(b.sort) ? b.sort : 0;
  return { name, price_cents: b.price_cents, emoji, color, sort, active: b.active === false ? 0 : 1 } as const;
}

app.post("/api/admin/articles", requireAdmin, async (c) => {
  const b = await body<Record<string, unknown>>(c);
  const a = parseArticle(b);
  if ("error" in a) return bad(c, String(a.error));
  const stock = isInt(b?.stock) && (b!.stock as number) >= 0 ? (b!.stock as number) : 0;
  const id = crypto.randomUUID();
  const stmts = [
    c.env.DB.prepare("INSERT INTO articles (id, name, price_cents, stock, emoji, color, active, sort) VALUES (?,?,?,?,?,?,?,?)").bind(
      id, a.name, a.price_cents, stock, a.emoji, a.color, a.active, a.sort,
    ),
  ];
  if (stock > 0)
    stmts.push(c.env.DB.prepare("INSERT INTO stock_movements (article_id, delta, reason, note) VALUES (?, ?, 'restock', 'Anfangsbestand')").bind(id, stock));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, id });
});

app.put("/api/admin/articles/:id", requireAdmin, async (c) => {
  const a = parseArticle(await body<Record<string, unknown>>(c));
  if ("error" in a) return bad(c, String(a.error));
  const r = await c.env.DB.prepare("UPDATE articles SET name=?, price_cents=?, emoji=?, color=?, sort=?, active=? WHERE id=?")
    .bind(a.name, a.price_cents, a.emoji, a.color, a.sort, a.active, pid(c))
    .run();
  return r.meta.changes ? c.json({ ok: true }) : bad(c, "Artikel nicht gefunden", 404);
});

app.delete("/api/admin/articles/:id", requireAdmin, async (c) => {
  const id = pid(c);
  const used = await c.env.DB.prepare("SELECT 1 FROM sale_items WHERE article_id = ? LIMIT 1").bind(id).first();
  if (used) {
    await c.env.DB.prepare("UPDATE articles SET active = 0 WHERE id = ?").bind(id).run();
    return c.json({ ok: true, deactivated: true });
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM stock_movements WHERE article_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true, deleted: true });
});

app.post("/api/admin/articles/:id/stock", requireAdmin, async (c) => {
  const b = await body<{ delta?: number; reason?: string; note?: string }>(c);
  if (!b || !isInt(b.delta) || b.delta === 0 || Math.abs(b.delta) > 100000) return bad(c, "Ungültige Menge");
  const reason = b.reason === "correction" ? "correction" : "restock";
  const id = pid(c);
  const a = await c.env.DB.prepare("SELECT stock FROM articles WHERE id = ?").bind(id).first<{ stock: number }>();
  if (!a) return bad(c, "Artikel nicht gefunden", 404);
  if (a.stock + b.delta < 0) return bad(c, "Bestand kann nicht negativ werden");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE articles SET stock = stock + ? WHERE id = ?").bind(b.delta, id),
    c.env.DB.prepare("INSERT INTO stock_movements (article_id, delta, reason, note) VALUES (?, ?, ?, ?)").bind(id, b.delta, reason, (b.note ?? "").slice(0, 200)),
  ]);
  return c.json({ ok: true, stock: a.stock + b.delta });
});

app.get("/api/admin/stock-movements", requireAdmin, async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT m.*, a.name AS article_name FROM stock_movements m LEFT JOIN articles a ON a.id = m.article_id
     ORDER BY m.id DESC LIMIT 200`,
  ).all();
  return c.json(r.results);
});

// Schichten
app.get("/api/admin/shifts", requireAdmin, async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT s.*,
       (SELECT COALESCE(SUM(total_cents),0) FROM sales WHERE shift_id = s.id AND voided_at IS NULL) AS revenue,
       (SELECT COALESCE(SUM(donation_cents),0) FROM sales WHERE shift_id = s.id AND voided_at IS NULL) AS donations,
       (SELECT COUNT(*) FROM sales WHERE shift_id = s.id AND voided_at IS NULL) AS sales_count
     FROM shifts s ORDER BY s.created_at DESC, s.rowid DESC LIMIT 200`,
  ).all<ShiftRow & { revenue: number; donations: number }>();
  return c.json(
    r.results.map((s) => {
      const expected = s.starting_cents + s.revenue + s.donations;
      return { ...s, expected, difference: s.counted_cents == null ? null : s.counted_cents - expected };
    }),
  );
});

app.post("/api/admin/shifts", requireAdmin, async (c) => {
  const b = await body<{ name?: string; starting_cents?: number; code?: string }>(c);
  const name = (b?.name ?? "").trim().slice(0, 60);
  if (!name) return bad(c, "Bitte einen Namen angeben (z. B. „1. große Pause“)");
  if (!isInt(b?.starting_cents) || (b!.starting_cents as number) < 0 || (b!.starting_cents as number) > 1_000_000) return bad(c, "Ungültiger Startbetrag");

  const length = Number(await getSetting(c.env.DB, "code_length", "6"));
  let code = (b?.code ?? "").trim().toUpperCase();
  if (code && !/^[A-Z0-9]{4,10}$/.test(code)) return bad(c, "Code: 4–10 Zeichen, nur Buchstaben und Ziffern");
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = code || randomCode(length);
    const clash = await c.env.DB.prepare("SELECT 1 FROM shifts WHERE code = ? AND status IN ('ready','open')").bind(candidate).first();
    if (!clash) {
      code = candidate;
      break;
    }
    if (b?.code) return bad(c, "Dieser Code ist bereits vergeben", 409);
    code = "";
  }
  if (!code) return bad(c, "Konnte keinen freien Code erzeugen", 409);

  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO shifts (id, name, code, starting_cents, created_at) VALUES (?,?,?,?,?)")
    .bind(id, name, code, b!.starting_cents, nowIso())
    .run();
  return c.json({ ok: true, id, code });
});

app.post("/api/admin/shifts/:id/close", requireAdmin, async (c) => {
  const b = await body<{ counted_cents?: number; note?: string }>(c);
  if (!b || !isInt(b.counted_cents) || b.counted_cents < 0) return bad(c, "Bitte den gezählten Kassenbetrag angeben");
  const r = await c.env.DB.prepare(
    "UPDATE shifts SET status = 'closed', closed_at = ?, counted_cents = ?, note = ? WHERE id = ? AND status != 'closed'",
  )
    .bind(nowIso(), b.counted_cents, (b.note ?? "").slice(0, 500), pid(c))
    .run();
  return r.meta.changes ? c.json({ ok: true }) : bad(c, "Schicht nicht gefunden oder bereits geschlossen", 409);
});

app.delete("/api/admin/shifts/:id", requireAdmin, async (c) => {
  const id = pid(c);
  const sales = await c.env.DB.prepare("SELECT 1 FROM sales WHERE shift_id = ? LIMIT 1").bind(id).first();
  if (sales) return bad(c, "Schichten mit Verkäufen können nicht gelöscht werden", 409);
  const r = await c.env.DB.prepare("DELETE FROM shifts WHERE id = ?").bind(id).run();
  return r.meta.changes ? c.json({ ok: true }) : bad(c, "Schicht nicht gefunden", 404);
});

app.get("/api/admin/shifts/:id/report", requireAdmin, async (c) => {
  const r = await buildReport(c.env.DB, pid(c));
  return r ? c.json(r) : bad(c, "Nicht gefunden", 404);
});

app.post("/api/admin/sales/:id/void", requireAdmin, async (c) => {
  const b = await body<{ reason?: string }>(c);
  const reason = (b?.reason ?? "").trim().slice(0, 200);
  if (!reason) return bad(c, "Bitte einen Grund angeben");
  const r = await voidSale(c.env.DB, pid(c), reason);
  return r.ok ? c.json({ ok: true }) : bad(c, r.error, r.status);
});

// Auswertung über Zeitraum (Datum YYYY-MM-DD, UTC)
app.get("/api/admin/stats", requireAdmin, async (c) => {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = c.req.query("from") ?? "0000-01-01";
  const to = c.req.query("to") ?? "9999-12-31";
  if (!re.test(from) && from !== "0000-01-01") return bad(c, "Ungültiges Datum (von)");
  if (!re.test(to) && to !== "9999-12-31") return bad(c, "Ungültiges Datum (bis)");
  const db = c.env.DB;
  const range = [from, to + " 23:59:59"];
  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS sales_count, COALESCE(SUM(total_cents),0) AS revenue, COALESCE(SUM(donation_cents),0) AS donations
       FROM sales WHERE voided_at IS NULL AND created_at >= ? AND created_at <= ?`,
    )
    .bind(...range)
    .first();
  const byDay = await db
    .prepare(
      `SELECT substr(created_at,1,10) AS day, COUNT(*) AS sales_count, SUM(total_cents) AS revenue, SUM(donation_cents) AS donations
       FROM sales WHERE voided_at IS NULL AND created_at >= ? AND created_at <= ? GROUP BY day ORDER BY day`,
    )
    .bind(...range)
    .all();
  const byArticle = await db
    .prepare(
      `SELECT si.name, SUM(si.qty) AS qty, SUM(si.qty * si.unit_price_cents) AS revenue
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.voided_at IS NULL AND s.created_at >= ? AND s.created_at <= ? GROUP BY si.name ORDER BY qty DESC`,
    )
    .bind(...range)
    .all();
  const shifts = await db
    .prepare(
      `SELECT s.id, s.name, s.created_at, s.status, s.starting_cents, s.counted_cents,
         (SELECT COALESCE(SUM(total_cents),0) FROM sales WHERE shift_id = s.id AND voided_at IS NULL) AS revenue,
         (SELECT COALESCE(SUM(donation_cents),0) FROM sales WHERE shift_id = s.id AND voided_at IS NULL) AS donations
       FROM shifts s WHERE s.created_at >= ? AND s.created_at <= ? ORDER BY s.created_at`,
    )
    .bind(...range)
    .all();
  return c.json({ totals, byDay: byDay.results, byArticle: byArticle.results, shifts: shifts.results, settings: await publicSettings(db) });
});

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Nicht gefunden" }, 404) : c.text("Not found", 404)));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Interner Fehler" }, 500);
});

export default app;
