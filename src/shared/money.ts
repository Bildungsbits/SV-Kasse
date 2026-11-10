/** Geldlogik (alle Beträge in Cent). Wird von Worker, Frontend und Tests genutzt. */

export interface CartLine {
  price_cents: number;
  qty: number;
}

export function cartTotal(lines: CartLine[]): number {
  return lines.reduce((s, l) => s + l.price_cents * l.qty, 0);
}

export interface Payment {
  ok: boolean;
  error?: string;
  total: number;
  donation: number;
  paid: number;
  change: number;
}

/**
 * paid: gegebener Betrag. donation: SV-Spende (Mehrbetrag, der nicht zurückgegeben wird).
 * Rückgeld = paid - total - donation.
 */
export function computePayment(total: number, paid: number, donation: number): Payment {
  const base = { total, donation, paid, change: paid - total - donation };
  if (![total, paid, donation].every(Number.isInteger)) return { ...base, ok: false, error: "Ungültiger Betrag" };
  if (total < 0 || paid < 0 || donation < 0) return { ...base, ok: false, error: "Negative Beträge sind nicht erlaubt" };
  if (base.change < 0) return { ...base, ok: false, error: "Gegebener Betrag reicht nicht" };
  return { ...base, ok: true };
}

export function formatEuro(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${euros},${(abs % 100).toString().padStart(2, "0")} €`;
}

/** "1,50" / "1.5" / "2" -> 150 / 150 / 200; null bei ungültiger Eingabe */
export function parseEuro(input: string): number | null {
  const s = input.trim().replace(/\s|€/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
