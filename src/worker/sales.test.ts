import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Seeded, type TestWorld, api, createWorld, movements, seed, stockOf, uuid } from "./testkit";

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
}, 60_000);
afterAll(async () => {
  await w?.close();
});

const sell = (s: Seeded, body: Record<string, unknown>) => api.cashier(w.env, s.cookie, "POST", "/api/cashier/sales", body);
const state = (s: Seeded) => api.cashier(w.env, s.cookie, "GET", "/api/cashier/state");

describe("Verkauf", () => {
  it("bucht Summe, Rückgeld und Spende richtig", async () => {
    const s = await seed(w.env);
    const r = await sell(s, { items: [{ article_id: s.articles.Brezel.id, qty: 2 }, { article_id: s.articles.Saft.id, qty: 1 }], paid: 1000, donation: 50 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 400, donation: 50, paid: 1000, change: 550 });
  });

  it("ohne Angabe gilt passend bezahlt", async () => {
    const s = await seed(w.env);
    const r = await sell(s, { items: [{ article_id: s.articles.Brezel.id, qty: 3 }] });
    expect(r.body).toMatchObject({ total: 450, paid: 450, change: 0 });
  });

  it("zieht den Bestand ab und schreibt einen Bestandseintrag", async () => {
    const s = await seed(w.env);
    const r = await sell(s, { items: [{ article_id: s.articles.Brezel.id, qty: 4 }] });
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(6);
    const m = await movements(w.env, s.articles.Brezel.id);
    expect(m.at(-1)).toMatchObject({ delta: -4, reason: "sale", sale_id: r.body.id });
  });

  it("zählt gleiche Artikel in mehreren Zeilen zusammen", async () => {
    const s = await seed(w.env);
    const r = await sell(s, { items: [{ article_id: s.articles.Brezel.id, qty: 1 }, { article_id: s.articles.Brezel.id, qty: 2 }] });
    expect(r.body.total).toBe(450);
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(7);
  });

  it("nimmt die Summen in den Kassenstand auf", async () => {
    const s = await seed(w.env, undefined, 5000);
    await sell(s, { items: [{ article_id: s.articles.Brezel.id, qty: 2 }], paid: 500, donation: 100 });
    const st = await state(s);
    expect(st.body.totals).toMatchObject({ sales_count: 1, revenue: 300, donations: 100, expected: 5400 });
  });

  describe("lehnt ab", () => {
    it("leeren Warenkorb", async () => {
      const s = await seed(w.env);
      expect((await sell(s, { items: [] })).status).toBe(400);
      expect((await sell(s, {})).status).toBe(400);
    });

    it("ungültige Mengen", async () => {
      const s = await seed(w.env);
      for (const qty of [0, -1, 1.5, 1000, "2"]) {
        const r = await sell(s, { items: [{ article_id: s.articles.Brezel.id, qty }] });
        expect(r.status, `qty ${String(qty)}`).toBe(400);
      }
      expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(10);
    });

    it("mehr als vorhanden, ohne etwas zu ändern", async () => {
      const s = await seed(w.env, { Brezel: { price: 150, stock: 2 } });
      const r = await sell(s, { items: [{ article_id: s.articles.Brezel.id, qty: 3 }] });
      expect(r.status).toBe(409);
      // die Kasse soll erfahren, was fehlt, nicht nur "irgendein Konflikt"
      expect(r.body.error).toContain("nur noch 2 auf Lager");
      expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(2);
      expect((await state(s)).body.totals.sales_count).toBe(0);
    });

    it("zu wenig Geld", async () => {
      const s = await seed(w.env);
      const r = await sell(s, { items: [{ article_id: s.articles.Brezel.id, qty: 2 }], paid: 299 });
      expect(r.status).toBe(400);
      expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(10);
    });

    it("negative oder krumme Beträge", async () => {
      const s = await seed(w.env);
      for (const body of [{ paid: -100 }, { paid: 300.5 }, { donation: -50, paid: 300 }]) {
        const r = await sell(s, { items: [{ article_id: s.articles.Brezel.id, qty: 2 }], ...body });
        expect(r.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("Artikel aus einem anderen Projekt", async () => {
      const s = await seed(w.env);
      const other = await seed(w.env);
      const r = await sell(s, { items: [{ article_id: other.articles.Brezel.id, qty: 1 }] });
      expect(r.status).toBe(409);
      expect(await stockOf(w.env, other.articles.Brezel.id)).toBe(10);
    });

    it("unbekannte Artikel", async () => {
      const s = await seed(w.env);
      expect((await sell(s, { items: [{ article_id: uuid(), qty: 1 }] })).status).toBe(400);
    });

    it("deaktivierte Artikel", async () => {
      const s = await seed(w.env);
      await api.admin(w.env, "PUT", `/api/admin/articles/${s.articles.Brezel.id}`, { name: "Brezel", price_cents: 150, emoji: "", color: "#3b82f6", active: false, sort: 0 });
      const r = await sell(s, { items: [{ article_id: s.articles.Brezel.id, qty: 1 }] });
      expect(r.status).toBe(409);
    });

    it("ohne Anmeldung", async () => {
      const s = await seed(w.env);
      const r = await api.anonymous(w.env, "POST", "/api/cashier/sales", { items: [{ article_id: s.articles.Brezel.id, qty: 1 }] });
      expect(r.status).toBe(401);
    });

    it("Verkäufe, die einer anderen Kasse gehören", async () => {
      const s = await seed(w.env);
      const r = await sell(s, { shift_id: uuid(), items: [{ article_id: s.articles.Brezel.id, qty: 1 }] });
      expect(r.status).toBe(409);
    });
  });

  it("rechnet ohne Rundungsfehler bei vielen kleinen Beträgen", async () => {
    const s = await seed(w.env, { Bonbon: { price: 10, stock: 500 } });
    const r = await sell(s, { items: [{ article_id: s.articles.Bonbon.id, qty: 333 }], paid: 5000 });
    expect(r.body).toMatchObject({ total: 3330, change: 1670 });
  });
});

describe("Doppelt gesendet (Wiederholung nach Verbindungsabbruch)", () => {
  it("bucht dieselbe ID nur einmal", async () => {
    const s = await seed(w.env);
    const id = uuid();
    const body = { id, items: [{ article_id: s.articles.Brezel.id, qty: 2 }], paid: 300 };
    const a = await sell(s, body);
    const b = await sell(s, body);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ id, duplicate: true, total: 300, change: 0 });
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(8);
    expect((await state(s)).body.totals.sales_count).toBe(1);
  });

  it("liefert beim zweiten Mal das gespeicherte Ergebnis, auch wenn der Bestand inzwischen fehlt", async () => {
    const s = await seed(w.env, { Brezel: { price: 150, stock: 2 } });
    const id = uuid();
    const body = { id, items: [{ article_id: s.articles.Brezel.id, qty: 2 }], paid: 500, donation: 50 };
    await sell(s, body);
    const again = await sell(s, body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, total: 300, donation: 50, change: 150 });
  });

  it("gleichzeitige Wiederholung bucht ebenfalls nur einmal", async () => {
    const s = await seed(w.env);
    const id = uuid();
    const body = { id, items: [{ article_id: s.articles.Brezel.id, qty: 1 }] };
    const results = await Promise.all([sell(s, body), sell(s, body), sell(s, body)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(9);
    expect((await state(s)).body.totals.sales_count).toBe(1);
  });

  it("gibt eine ID, die zu einer anderen Kasse gehört, nicht heraus", async () => {
    const a = await seed(w.env);
    const b = await seed(w.env);
    const id = uuid();
    await sell(a, { id, items: [{ article_id: a.articles.Brezel.id, qty: 1 }] });
    const r = await sell(b, { id, items: [{ article_id: b.articles.Brezel.id, qty: 1 }] });
    expect(r.status).toBe(409);
    expect(await stockOf(w.env, b.articles.Brezel.id)).toBe(10);
  });

  it("lehnt kaputte IDs ab", async () => {
    const s = await seed(w.env);
    for (const id of ["abc", "", 123, "11111111-1111-1111-1111-11111111111Z"]) {
      expect((await sell(s, { id, items: [{ article_id: s.articles.Brezel.id, qty: 1 }] })).status, String(id)).toBe(400);
    }
  });
});

describe("Nachgereichter Verkauf (offline gebucht)", () => {
  it("wird gebucht, auch wenn der Bestand inzwischen nicht reicht, und fällt nie unter 0", async () => {
    const s = await seed(w.env, { Brezel: { price: 150, stock: 1 } });
    const r = await sell(s, { id: uuid(), offline: true, items: [{ article_id: s.articles.Brezel.id, qty: 3 }], paid: 450 });
    expect(r.status).toBe(200);
    expect(await stockOf(w.env, s.articles.Brezel.id)).toBe(0);
    const m = (await movements(w.env, s.articles.Brezel.id)).at(-1)!;
    expect(m.delta).toBe(-1);
    expect(m.note).toContain("Bestand reichte nicht");
    expect(m.note).toContain("2");
  });

  it("verbucht den vollen Umsatz, auch wenn der Bestand fehlte", async () => {
    const s = await seed(w.env, { Brezel: { price: 150, stock: 0 } });
    await sell(s, { id: uuid(), offline: true, items: [{ article_id: s.articles.Brezel.id, qty: 2 }], paid: 300 });
    expect((await state(s)).body.totals).toMatchObject({ sales_count: 1, revenue: 300 });
  });

  it("verwendet den Preis, den der Kunde an der Kasse gesehen hat", async () => {
    const s = await seed(w.env);
    const r = await sell(s, { id: uuid(), offline: true, items: [{ article_id: s.articles.Brezel.id, qty: 2, unit_price_cents: 120 }], paid: 300, donation: 60 });
    expect(r.body).toMatchObject({ total: 240, donation: 60, change: 0 });
    const row = await w.env.DB.prepare("SELECT unit_price_cents FROM sale_items WHERE sale_id = ?").bind(r.body.id).first<{ unit_price_cents: number }>();
    expect(row!.unit_price_cents).toBe(120);
  });

  it("ignoriert den Gerätepreis bei normalen Verkäufen", async () => {
    const s = await seed(w.env);
    const r = await sell(s, { items: [{ article_id: s.articles.Brezel.id, qty: 2, unit_price_cents: 1 }] });
    expect(r.body.total).toBe(300);
  });

  it("nimmt unsinnige Gerätepreise nicht an", async () => {
    const s = await seed(w.env);
    const r = await sell(s, { id: uuid(), offline: true, items: [{ article_id: s.articles.Brezel.id, qty: 1, unit_price_cents: -5 }] });
    expect(r.body.total).toBe(150);
  });

  it("behält die Uhrzeit vom Gerät, aber nie in der Zukunft", async () => {
    const s = await seed(w.env);
    const future = "2999-01-01 00:00:00";
    const r = await sell(s, { id: uuid(), offline: true, created_at: future, items: [{ article_id: s.articles.Brezel.id, qty: 1 }] });
    const row = await w.env.DB.prepare("SELECT created_at FROM sales WHERE id = ?").bind(r.body.id).first<{ created_at: string }>();
    expect(row!.created_at < future).toBe(true);
  });

  it("setzt zu frühe Zeitpunkte auf den Kassenstart", async () => {
    const s = await seed(w.env);
    const r = await sell(s, { id: uuid(), offline: true, created_at: "2000-01-01 00:00:00", items: [{ article_id: s.articles.Brezel.id, qty: 1 }] });
    const row = await w.env.DB.prepare("SELECT s.created_at AS at, sh.opened_at AS opened FROM sales s JOIN shifts sh ON sh.id = s.shift_id WHERE s.id = ?").bind(r.body.id).first<{ at: string; opened: string }>();
    expect(row!.at).toBe(row!.opened);
  });

  it("lehnt Artikel aus fremden Projekten trotzdem ab", async () => {
    const s = await seed(w.env);
    const other = await seed(w.env);
    const r = await sell(s, { id: uuid(), offline: true, items: [{ article_id: other.articles.Brezel.id, qty: 1 }] });
    expect(r.status).toBe(409);
  });

  it("wird nach dem Kassenschluss abgelehnt", async () => {
    const s = await seed(w.env);
    await api.cashier(w.env, s.cookie, "POST", "/api/cashier/close", { counted_cents: 5000 });
    const r = await sell(s, { id: uuid(), offline: true, items: [{ article_id: s.articles.Brezel.id, qty: 1 }] });
    expect(r.status).toBe(409);
  });

  it("bestätigt eine schon gebuchte ID auch nach dem Kassenschluss (kein Fehlalarm)", async () => {
    const s = await seed(w.env);
    const id = uuid();
    const body = { id, offline: true, items: [{ article_id: s.articles.Brezel.id, qty: 1 }] };
    await sell(s, body);
    await api.cashier(w.env, s.cookie, "POST", "/api/cashier/close", { counted_cents: 5150 });
    const again = await sell(s, body);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
  });
});
