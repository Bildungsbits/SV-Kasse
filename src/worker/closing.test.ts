import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Seeded, type TestWorld, api, createWorld, loginCashier, movements, seed, stockOf, uuid } from "./testkit";

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
}, 60_000);
afterAll(async () => {
  await w?.close();
});

const sell = (s: Seeded, items: [string, number][], extra: Record<string, unknown> = {}) =>
  api.cashier(w.env, s.cookie, "POST", "/api/cashier/sales", { items: items.map(([name, qty]) => ({ article_id: s.articles[name].id, qty })), ...extra });
const state = (s: Seeded) => api.cashier(w.env, s.cookie, "GET", "/api/cashier/state");
const voidIt = (s: Seeded, id: string, body: Record<string, unknown> = { reason: "falsch gebucht" }) => api.cashier(w.env, s.cookie, "POST", `/api/cashier/sales/${id}/void`, body);
const close = (s: Seeded, counted: unknown, note = "") => api.cashier(w.env, s.cookie, "POST", "/api/cashier/close", { counted_cents: counted, note });

describe("Storno", () => {
  it("bucht den Bestand zurück und schreibt einen Bestandseintrag", async () => {
    const s = await seed(w.env);
    const sale = await sell(s, [["Brezel", 3]]);
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(7);
    const r = await voidIt(s, sale.body.id);
    expect(r.status).toBe(200);
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(10);
    const m = (await movements(w.env, s.articles.Brezel.id)).at(-1)!;
    expect(m).toMatchObject({ delta: 3, reason: "void", sale_id: sale.body.id, note: "falsch gebucht" });
  });

  it("nimmt Umsatz und Spende wieder aus dem Kassenstand", async () => {
    const s = await seed(w.env, undefined, 5000);
    const keep = await sell(s, [["Saft", 1]], { paid: 100 });
    const gone = await sell(s, [["Brezel", 2]], { paid: 500, donation: 100 });
    expect(keep.status).toBe(200);
    await voidIt(s, gone.body.id);
    const t = (await state(s)).body.totals;
    expect(t).toMatchObject({ sales_count: 1, voided_count: 1, revenue: 100, donations: 0, expected: 5100 });
  });

  it("verlangt einen Grund", async () => {
    const s = await seed(w.env);
    const sale = await sell(s, [["Brezel", 1]]);
    for (const body of [{ reason: "" }, { reason: "   " }, {}]) {
      expect((await voidIt(s, sale.body.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(9);
  });

  it("storniert nicht zweimal (Bestand wird nicht doppelt zurückgebucht)", async () => {
    const s = await seed(w.env);
    const sale = await sell(s, [["Brezel", 2]]);
    await voidIt(s, sale.body.id);
    expect((await voidIt(s, sale.body.id)).status).toBe(409);
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(10);
  });

  it("kennt keine unbekannten Verkäufe", async () => {
    const s = await seed(w.env);
    expect((await voidIt(s, uuid())).status).toBe(404);
  });

  it("lässt eine Kasse nicht die Verkäufe einer anderen stornieren", async () => {
    const a = await seed(w.env);
    const b = await seed(w.env);
    const sale = await sell(a, [["Brezel", 2]]);
    expect((await voidIt(b, sale.body.id)).status).toBe(404);
    expect(await stockOf(w.env, a.articles.Brezel.id)).toBe(8);
  });

  it("geht nicht mehr, wenn die Kasse geschlossen ist", async () => {
    const s = await seed(w.env);
    const sale = await sell(s, [["Brezel", 1]]);
    await close(s, 5150);
    expect((await voidIt(s, sale.body.id)).status).toBe(409);
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(9);
  });

  it("geht für die Aufsicht auch nach dem Schluss, solange das Projekt nicht archiviert ist", async () => {
    const s = await seed(w.env);
    const sale = await sell(s, [["Brezel", 1]]);
    await close(s, 5150);
    const r = await api.admin(w.env, "POST", `/api/admin/sales/${sale.body.id}/void`, { reason: "Korrektur" });
    expect(r.status).toBe(200);
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(10);
  });

  it("geht in archivierten Projekten nicht mehr", async () => {
    const s = await seed(w.env);
    const sale = await sell(s, [["Brezel", 1]]);
    await close(s, 5150);
    expect((await api.admin(w.env, "POST", `/api/admin/projects/${s.projectId}/archive`)).status).toBe(200);
    const r = await api.admin(w.env, "POST", `/api/admin/sales/${sale.body.id}/void`, { reason: "zu spät" });
    expect(r.status).toBe(409);
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(9);
  });
});

describe("Kassenabschluss", () => {
  it("rechnet Soll, Gezählt und Differenz richtig", async () => {
    const s = await seed(w.env, undefined, 5000);
    await sell(s, [["Brezel", 2]], { paid: 500, donation: 100 });
    await sell(s, [["Saft", 1]]);
    // Soll: 5000 Start + 300 + 100 Spende + 100 = 5500
    expect((await close(s, 5450)).status).toBe(200);
    const t = (await state(s)).body.totals;
    expect(t).toMatchObject({ revenue: 400, donations: 100, expected: 5500, difference: -50 });
  });

  it("zeigt Überschuss und genaue Kasse", async () => {
    const a = await seed(w.env, undefined, 1000);
    await close(a, 1000);
    expect((await state(a)).body.totals.difference).toBe(0);
    const b = await seed(w.env, undefined, 1000);
    await close(b, 1200);
    expect((await state(b)).body.totals.difference).toBe(200);
  });

  it("speichert Anmerkung und Zeitpunkt", async () => {
    const s = await seed(w.env);
    await close(s, 5000, "2 Euro Trinkgeld");
    const st = await state(s);
    expect(st.body.shift).toMatchObject({ status: "closed", counted_cents: 5000, note: "2 Euro Trinkgeld" });
    expect(st.body.shift.closed_at).toBeTruthy();
  });

  it("verlangt einen gültigen gezählten Betrag", async () => {
    const s = await seed(w.env);
    for (const bad of [undefined, null, -1, 10.5, "50", NaN]) {
      expect((await close(s, bad)).status, String(bad)).toBe(400);
    }
    expect((await state(s)).body.shift.status).toBe("open");
  });

  it("lässt sich nicht zweimal abschließen und ändert dann nichts mehr", async () => {
    const s = await seed(w.env);
    await close(s, 5000);
    expect((await close(s, 9999)).status).toBe(409);
    expect((await state(s)).body.shift.counted_cents).toBe(5000);
  });

  it("sperrt danach Verkäufe", async () => {
    const s = await seed(w.env);
    await close(s, 5000);
    const r = await sell(s, [["Brezel", 1]]);
    expect(r.status).toBe(409);
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(10);
  });

  it("macht den Kassencode ungültig", async () => {
    const s = await seed(w.env);
    await close(s, 5000);
    await expect(loginCashier(w.env, s.code)).rejects.toThrow();
  });

  it("ist auch durch die Aufsicht möglich, nur einmal", async () => {
    const s = await seed(w.env);
    const a = await api.admin(w.env, "POST", `/api/admin/shifts/${s.shiftId}/close`, { counted_cents: 5000 });
    expect(a.status).toBe(200);
    expect((await api.admin(w.env, "POST", `/api/admin/shifts/${s.shiftId}/close`, { counted_cents: 5000 })).status).toBe(409);
    expect((await sell(s, [["Brezel", 1]])).status).toBe(409);
  });
});

describe("Kassenbericht", () => {
  it("fasst Artikel zusammen und lässt stornierte Verkäufe weg", async () => {
    const s = await seed(w.env);
    await sell(s, [["Brezel", 2]]);
    await sell(s, [["Brezel", 1], ["Saft", 3]]);
    const gone = await sell(s, [["Saft", 5]]);
    await voidIt(s, gone.body.id);
    const rep = await api.cashier(w.env, s.cookie, "GET", "/api/cashier/report");
    expect(rep.status).toBe(200);
    const byName = Object.fromEntries(rep.body.items.map((i: { name: string; qty: number; revenue: number }) => [i.name, i]));
    expect(byName.Brezel).toMatchObject({ qty: 3, revenue: 450 });
    expect(byName.Saft).toMatchObject({ qty: 3, revenue: 300 });
    expect(rep.body.totals).toMatchObject({ sales_count: 2, voided_count: 1, revenue: 750 });
  });

  it("verrät den Kassencode nicht", async () => {
    const s = await seed(w.env);
    const rep = await api.cashier(w.env, s.cookie, "GET", "/api/cashier/report");
    expect(JSON.stringify(rep.body)).not.toContain(s.code);
    expect(JSON.stringify((await state(s)).body)).not.toContain(s.code);
  });
});

describe("Schichten und Projekte", () => {
  it("löschen: Schichten mit Verkäufen bleiben erhalten", async () => {
    const s = await seed(w.env);
    await sell(s, [["Brezel", 1]]);
    expect((await api.admin(w.env, "DELETE", `/api/admin/shifts/${s.shiftId}`)).status).toBe(409);
    const empty = await seed(w.env);
    expect((await api.admin(w.env, "DELETE", `/api/admin/shifts/${empty.shiftId}`)).status).toBe(200);
  });

  it("Projekt archivieren geht erst, wenn alle Kassen geschlossen sind", async () => {
    const s = await seed(w.env);
    expect((await api.admin(w.env, "POST", `/api/admin/projects/${s.projectId}/archive`)).status).toBe(409);
    await close(s, 5000);
    expect((await api.admin(w.env, "POST", `/api/admin/projects/${s.projectId}/archive`)).status).toBe(200);
  });

  it("archivierte Projekte sind schreibgeschützt", async () => {
    const s = await seed(w.env);
    await close(s, 5000);
    await api.admin(w.env, "POST", `/api/admin/projects/${s.projectId}/archive`);
    const art = await api.admin(w.env, "POST", "/api/admin/articles", { name: "Neu", price_cents: 100, stock: 1, project_id: s.projectId });
    expect(art.status).toBe(409);
    const shift = await api.admin(w.env, "POST", "/api/admin/shifts", { name: "Neu", starting_cents: 0, project_id: s.projectId });
    expect(shift.status).toBe(409);
  });
});

describe("Bestand", () => {
  it("lässt Korrekturen nicht unter 0 fallen", async () => {
    const s = await seed(w.env, { Brezel: { price: 150, stock: 3 } });
    const id = s.articles.Brezel.id;
    expect((await api.admin(w.env, "POST", `/api/admin/articles/${id}/stock`, { delta: -4 })).status).toBe(400);
    expect(await stockOf(w.env, id)).toBe(3);
    expect((await api.admin(w.env, "POST", `/api/admin/articles/${id}/stock`, { delta: -3, reason: "correction" })).status).toBe(200);
    expect(await stockOf(w.env, id)).toBe(0);
  });

  it("Bestandseinträge ergeben immer den aktuellen Bestand", async () => {
    const s = await seed(w.env, { Brezel: { price: 150, stock: 10 } });
    const id = s.articles.Brezel.id;
    const a = await sell(s, [["Brezel", 4]]);
    await sell(s, [["Brezel", 2]]);
    await voidIt(s, a.body.id);
    await api.admin(w.env, "POST", `/api/admin/articles/${id}/stock`, { delta: 5 });
    const sum = (await movements(w.env, id)).reduce((n, m) => n + m.delta, 0);
    expect(sum).toBe(await stockOf(w.env, id));
    expect(sum).toBe(13);
  });
});
