/**
 * Offline-Logik der Kasse (ohne Browser-Abhängigkeiten, daher testbar).
 *
 * Idee: Ein Verkauf bekommt auf dem Gerät eine feste ID. Gelingt das Senden nicht (kein Netz),
 * landet er in einer Warteschlange und wird später mit derselben ID nachgesendet. Der Server
 * bucht dieselbe ID nur einmal, ein erneutes Senden ist also gefahrlos.
 */

export interface PendingItem {
  article_id: string;
  name: string;
  emoji: string;
  unit_price_cents: number;
  qty: number;
}

export interface PendingSale {
  id: string;
  shift_id: string;
  /** UTC im SQLite-Format "YYYY-MM-DD HH:MM:SS" (Geräteuhr) */
  created_at: string;
  items: PendingItem[];
  total_cents: number;
  donation_cents: number;
  paid_cents: number;
  change_cents: number;
  /** pending: wartet auf Übertragung. rejected: vom Server abgelehnt, muss geprüft werden */
  status: "pending" | "rejected";
  error?: string;
}

// ---------- Anzeige: Serverstand + wartende Verkäufe ----------
interface StateLike {
  shift: { id: string; starting_cents: number; counted_cents: number | null };
  totals: { sales_count: number; revenue: number; donations: number; expected: number; difference: number | null; voided_count: number };
  articles: { id: string; stock: number }[];
  sales: unknown[];
}

/** Legt die wartenden Verkäufe über den zuletzt bekannten Serverstand (Bestand, Summen, Verkaufsliste). */
export function applyPending<S extends StateLike>(state: S, queue: PendingSale[]): S {
  const mine = queue.filter((q) => q.shift_id === state.shift.id && q.status === "pending");
  if (mine.length === 0) return state;

  const sold = new Map<string, number>();
  let revenue = 0;
  let donations = 0;
  for (const q of mine) {
    revenue += q.total_cents;
    donations += q.donation_cents;
    for (const i of q.items) sold.set(i.article_id, (sold.get(i.article_id) ?? 0) + i.qty);
  }
  const expected = state.totals.expected + revenue + donations;
  const pendingSales = [...mine].reverse().map((q) => ({
    id: q.id,
    total_cents: q.total_cents,
    donation_cents: q.donation_cents,
    paid_cents: q.paid_cents,
    change_cents: q.change_cents,
    created_at: q.created_at,
    voided_at: null,
    void_reason: null,
    pending: true,
    items: q.items.map(({ article_id, name, unit_price_cents, qty }) => ({ article_id, name, unit_price_cents, qty })),
  }));

  return {
    ...state,
    articles: state.articles.map((a) => (sold.has(a.id) ? { ...a, stock: Math.max(0, a.stock - sold.get(a.id)!) } : a)),
    totals: {
      ...state.totals,
      sales_count: state.totals.sales_count + mine.length,
      revenue: state.totals.revenue + revenue,
      donations: state.totals.donations + donations,
      expected,
      difference: state.shift.counted_cents == null ? null : state.shift.counted_cents - expected,
    },
    sales: [...pendingSales, ...state.sales],
  };
}

// ---------- Senden ----------
export type SendResult =
  | { kind: "ok" }
  | { kind: "rejected"; error: string }
  /** Kein Netz, Zeitüberschreitung oder Serverfehler: später erneut versuchen */
  | { kind: "retry" }
  /** Sitzung abgelaufen: erst neu anmelden */
  | { kind: "auth" };

export interface SyncOutcome {
  queue: PendingSale[];
  /** IDs der übertragenen Verkäufe */
  syncedIds: string[];
  /** ID -> Grund der Ablehnung */
  rejectedById: Record<string, string>;
  synced: number;
  rejected: number;
  /** Grund für einen vorzeitigen Abbruch */
  stoppedBy: "retry" | "auth" | null;
}

/**
 * Sendet die wartenden Verkäufe der aktuellen Schicht der Reihe nach.
 * Bei Netzproblemen wird abgebrochen (Reihenfolge bleibt erhalten), abgelehnte Verkäufe
 * werden markiert und bleiben sichtbar in der Warteschlange.
 */
export async function syncQueue(queue: PendingSale[], shiftId: string, send: (s: PendingSale) => Promise<SendResult>): Promise<SyncOutcome> {
  const next = [...queue];
  const syncedIds: string[] = [];
  const rejectedById: Record<string, string> = {};
  let synced = 0;
  let rejected = 0;
  let stoppedBy: SyncOutcome["stoppedBy"] = null;

  for (const sale of queue) {
    if (sale.shift_id !== shiftId || sale.status !== "pending") continue;
    const r = await send(sale);
    const idx = next.findIndex((q) => q.id === sale.id);
    if (r.kind === "ok") {
      next.splice(idx, 1);
      syncedIds.push(sale.id);
      synced++;
    } else if (r.kind === "rejected") {
      next[idx] = { ...sale, status: "rejected", error: r.error };
      rejectedById[sale.id] = r.error;
      rejected++;
    } else {
      stoppedBy = r.kind;
      break;
    }
  }
  return { queue: next, syncedIds, rejectedById, synced, rejected, stoppedBy };
}

/**
 * Überträgt das Ergebnis eines Sendevorgangs auf die aktuell gespeicherte Warteschlange.
 * Währenddessen neu hinzugekommene Verkäufe bleiben dabei erhalten.
 */
export function applyOutcome(current: PendingSale[], out: Pick<SyncOutcome, "syncedIds" | "rejectedById">): PendingSale[] {
  return current
    .filter((q) => !out.syncedIds.includes(q.id))
    .map((q) => (q.id in out.rejectedById ? { ...q, status: "rejected" as const, error: out.rejectedById[q.id] } : q));
}

// ---------- Speicher ----------
/** Minimaler Schlüssel-Wert-Speicher (im Browser localStorage, in Tests eine Map) */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const QUEUE_KEY = "svkasse.queue.v1";

export function loadQueue(kv: KV): PendingSale[] {
  try {
    const v = JSON.parse(kv.getItem(QUEUE_KEY) ?? "[]");
    return Array.isArray(v) ? (v as PendingSale[]) : [];
  } catch {
    return [];
  }
}

/** Gibt false zurück, wenn der Speicher voll oder gesperrt ist (dann darf nichts als "gespeichert" gelten). */
export function saveQueue(kv: KV, queue: PendingSale[]): boolean {
  try {
    if (queue.length === 0) kv.removeItem(QUEUE_KEY);
    else kv.setItem(QUEUE_KEY, JSON.stringify(queue));
    return true;
  } catch {
    return false;
  }
}

export function pendingCount(queue: PendingSale[], shiftId: string): { pending: number; rejected: number } {
  let pending = 0;
  let rejected = 0;
  for (const q of queue) {
    if (q.shift_id !== shiftId) continue;
    if (q.status === "pending") pending++;
    else rejected++;
  }
  return { pending, rejected };
}

/** UTC-Zeit im SQLite-Format, wie sie der Server speichert */
export function sqlNow(d = new Date()): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}
