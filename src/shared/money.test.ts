import { describe, expect, it } from "vitest";
import { cartTotal, computePayment, formatEuro, parseEuro } from "./money";

describe("money", () => {
  it("summiert den Warenkorb", () => {
    expect(cartTotal([{ price_cents: 150, qty: 2 }, { price_cents: 50, qty: 1 }])).toBe(350);
  });
  it("berechnet Rückgeld ohne Spende", () => {
    const p = computePayment(150, 200, 0);
    expect(p.ok).toBe(true);
    expect(p.change).toBe(50);
  });
  it("Mehrbetrag als Spende: kein Rückgeld", () => {
    const p = computePayment(150, 200, 50);
    expect(p.ok).toBe(true);
    expect(p.change).toBe(0);
  });
  it("Spende plus Rückgeld", () => {
    expect(computePayment(150, 500, 100)).toMatchObject({ ok: true, change: 250 });
  });
  it("lehnt zu wenig Geld ab", () => {
    expect(computePayment(150, 100, 0).ok).toBe(false);
    expect(computePayment(150, 200, 100).ok).toBe(false);
  });
  it("lehnt Kommazahlen und Negatives ab", () => {
    expect(computePayment(150.5, 200, 0).ok).toBe(false);
    expect(computePayment(150, 200, -10).ok).toBe(false);
  });
  it("formatiert Euro", () => {
    expect(formatEuro(0)).toBe("0,00 €");
    expect(formatEuro(1234567)).toBe("12.345,67 €");
    expect(formatEuro(-50)).toBe("-0,50 €");
  });
  it("parst Euro-Eingaben", () => {
    expect(parseEuro("1,50")).toBe(150);
    expect(parseEuro("2")).toBe(200);
    expect(parseEuro("1.5")).toBe(150);
    expect(parseEuro("abc")).toBeNull();
    expect(parseEuro("1,555")).toBeNull();
  });
});
