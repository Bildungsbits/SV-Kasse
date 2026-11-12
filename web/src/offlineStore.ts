import { type KV, type PendingSale, loadQueue, saveQueue } from "../../src/shared/offline";
import type { CashierState } from "./types";

/** localStorage kann gesperrt sein (privater Modus) oder voll laufen: dann einfach ohne Speicher weiterarbeiten */
const kv: KV = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* egal */
    }
  },
};

const STATE_KEY = "svkasse.state.v1";

export const readQueue = (): PendingSale[] => loadQueue(kv);
export const writeQueue = (q: PendingSale[]): boolean => saveQueue(kv, q);

export function readCachedState(): CashierState | null {
  try {
    const v = JSON.parse(kv.getItem(STATE_KEY) ?? "null");
    return v && v.shift && v.articles ? (v as CashierState) : null;
  } catch {
    return null;
  }
}
export function writeCachedState(s: CashierState) {
  try {
    kv.setItem(STATE_KEY, JSON.stringify(s));
  } catch {
    /* Speicher voll: Offline-Start nicht möglich, Betrieb läuft trotzdem */
  }
}
export function clearCachedState() {
  kv.removeItem(STATE_KEY);
}
export const hasCachedState = () => readCachedState() !== null;

/** Zufällige Verkaufs-ID (UUID v4); funktioniert auch, wenn crypto.randomUUID fehlt */
export function newSaleId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
