import { describe, expect, it } from "vitest";
import { type KV, type PendingSale, applyOutcome, applyPending, loadQueue, pendingCount, saveQueue, syncQueue } from "./offline";

const sale = (id: string, over: Partial<PendingSale> = {}): PendingSale => ({
  id,
  shift_id: "s1",
  created_at: "2026-11-12 10:00:00",
  items: [{ article_id: "a1", name: "Brezel", emoji: "🥨", unit_price_cents: 150, qty: 2 }],
  total_cents: 300,
  donation_cents: 50,
  paid_cents: 400,
  change_cents: 50,
  status: "pending",
  ...over,
});

const state = () => ({
  shift: { id: "s1", starting_cents: 5000, counted_cents: null as number | null },
  totals: { sales_count: 1, voided_count: 0, revenue: 200, donations: 0, expected: 5200, difference: null as number | null },
  articles: [
    { id: "a1", stock: 3 },
    { id: "a2", stock: 9 },
  ],
  sales: [{ id: "old" }] as unknown[],
});

describe("applyPending", () => {
  it("zieht Bestand ab und addiert Summen", () => {
    const v = applyPending(state(), [sale("x1")]);
    expect(v.articles.find((a) => a.id === "a1")!.stock).toBe(1);
    expect(v.articles.find((a) => a.id === "a2")!.stock).toBe(9);
    expect(v.totals).toMatchObject({ sales_count: 2, revenue: 500, donations: 50, expected: 5550 });
    expect(v.sales).toHaveLength(2);
    expect((v.sales[0] as { pending: boolean }).pending).toBe(true);
  });

  it("Bestand wird nie negativ", () => {
    const v = applyPending(state(), [sale("x1"), sale("x2")]);
    expect(v.articles.find((a) => a.id === "a1")!.stock).toBe(0);
  });

  it("ignoriert abgelehnte Verkäufe und andere Kassen", () => {
    const s = state();
    expect(applyPending(s, [sale("x1", { status: "rejected" }), sale("x2", { shift_id: "andere" })])).toBe(s);
  });

  it("neueste wartende Verkäufe stehen oben", () => {
    const v = applyPending(state(), [sale("erst"), sale("zweit")]);
    expect((v.sales[0] as { id: string }).id).toBe("zweit");
  });
});

describe("syncQueue", () => {
  it("überträgt der Reihe nach und entfernt erledigte", async () => {
    const sent: string[] = [];
    const out = await syncQueue([sale("a"), sale("b")], "s1", async (s) => {
      sent.push(s.id);
      return { kind: "ok" };
    });
    expect(sent).toEqual(["a", "b"]);
    expect(out.queue).toEqual([]);
    expect(out.synced).toBe(2);
    expect(out.stoppedBy).toBeNull();
  });

  it("bricht bei Netzproblem ab und behält die Reihenfolge", async () => {
    const out = await syncQueue([sale("a"), sale("b"), sale("c")], "s1", async (s) => (s.id === "b" ? { kind: "retry" } : { kind: "ok" }));
    expect(out.queue.map((q) => q.id)).toEqual(["b", "c"]);
    expect(out.synced).toBe(1);
    expect(out.stoppedBy).toBe("retry");
  });

  it("markiert abgelehnte Verkäufe und macht weiter", async () => {
    const out = await syncQueue([sale("a"), sale("b")], "s1", async (s) => (s.id === "a" ? { kind: "rejected", error: "Kasse geschlossen" } : { kind: "ok" }));
    expect(out.queue).toHaveLength(1);
    expect(out.queue[0]).toMatchObject({ id: "a", status: "rejected", error: "Kasse geschlossen" });
    expect(out.synced).toBe(1);
    expect(out.rejected).toBe(1);
  });

  it("sendet nichts von anderen Kassen und nichts Abgelehntes", async () => {
    const sent: string[] = [];
    const q = [sale("fremd", { shift_id: "s2" }), sale("alt", { status: "rejected" }), sale("neu")];
    const out = await syncQueue(q, "s1", async (s) => {
      sent.push(s.id);
      return { kind: "ok" };
    });
    expect(sent).toEqual(["neu"]);
    expect(out.queue.map((x) => x.id)).toEqual(["fremd", "alt"]);
  });

  it("meldet abgelaufene Sitzung", async () => {
    const out = await syncQueue([sale("a")], "s1", async () => ({ kind: "auth" }));
    expect(out.stoppedBy).toBe("auth");
    expect(out.queue).toHaveLength(1);
  });
});

describe("applyOutcome", () => {
  it("behält Verkäufe, die während des Sendens dazukamen", () => {
    const current = [sale("a"), sale("b"), sale("neu")];
    const merged = applyOutcome(current, { syncedIds: ["a"], rejectedById: { b: "Fehler" } });
    expect(merged.map((q) => q.id)).toEqual(["b", "neu"]);
    expect(merged[0]).toMatchObject({ status: "rejected", error: "Fehler" });
    expect(merged[1].status).toBe("pending");
  });
});

describe("Speicher", () => {
  const memory = (): KV & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  };

  it("speichert und lädt die Warteschlange", () => {
    const kv = memory();
    expect(saveQueue(kv, [sale("a")])).toBe(true);
    expect(loadQueue(kv)).toEqual([sale("a")]);
    saveQueue(kv, []);
    expect(kv.data.size).toBe(0);
  });

  it("meldet false, wenn der Speicher voll ist", () => {
    const kv = memory();
    kv.setItem = () => {
      throw new Error("QuotaExceeded");
    };
    expect(saveQueue(kv, [sale("a")])).toBe(false);
  });

  it("übersteht kaputte Daten", () => {
    const kv = memory();
    kv.setItem("svkasse.queue.v1", "{kaputt");
    expect(loadQueue(kv)).toEqual([]);
  });

  it("zählt pro Kasse", () => {
    expect(pendingCount([sale("a"), sale("b", { status: "rejected" }), sale("c", { shift_id: "s2" })], "s1")).toEqual({ pending: 1, rejected: 1 });
  });
});
