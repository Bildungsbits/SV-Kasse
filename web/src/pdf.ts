import { formatEuro } from "../../src/shared/money";
import { fmtDate, fmtDateTime, fmtTime } from "./format";
import type { Report, Stats } from "./types";

const TEAL: [number, number, number] = [15, 118, 110];

async function newDoc(title: string, settings: { sv_name: string; school_name: string }) {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  doc.setFillColor(...TEAL);
  doc.rect(0, 0, 210, 26, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(title, 14, 12);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text([settings.sv_name, settings.school_name].filter(Boolean).join(" · "), 14, 19);
  doc.setTextColor(30, 30, 30);
  return { doc, autoTable };
}

function footer(doc: import("jspdf").jsPDF) {
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text(`Erstellt am ${fmtDateTime(new Date().toISOString().replace("T", " ").slice(0, 19))} · Seite ${i} von ${n}`, 14, 290);
  }
}

const lastY = (doc: import("jspdf").jsPDF) => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
const fileSafe = (s: string) => s.replace(/[^a-zA-Z0-9äöüÄÖÜß_-]+/g, "_");

/** PDF-Kassenbericht für eine Schicht */
export async function shiftReportPdf(r: Report) {
  const { doc, autoTable } = await newDoc(`Kassenbericht: ${r.shift.name}`, r.settings);
  const s = r.shift;
  const t = r.totals;

  autoTable(doc, {
    startY: 32,
    theme: "plain",
    styles: { fontSize: 10, cellPadding: 1.2 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 45 } },
    body: [
      ["Datum", fmtDate(s.opened_at ?? s.created_at)],
      ["Geöffnet", s.opened_at ? fmtDateTime(s.opened_at) : "–"],
      ["Geschlossen", s.closed_at ? fmtDateTime(s.closed_at) : "noch offen"],
      ["Startbetrag (Wechselgeld)", formatEuro(s.starting_cents)],
    ],
  });

  autoTable(doc, {
    startY: lastY(doc) + 4,
    head: [["Kassenabrechnung", "Betrag"]],
    headStyles: { fillColor: TEAL },
    styles: { fontSize: 10 },
    columnStyles: { 1: { halign: "right" } },
    body: [
      ["Verkaufserlöse", formatEuro(t.revenue)],
      ["SV-Spenden (Mehrbeträge)", formatEuro(t.donations)],
      ["Startbetrag", formatEuro(s.starting_cents)],
      [{ content: "Erwarteter Kassenbestand", styles: { fontStyle: "bold" } }, { content: formatEuro(t.expected), styles: { fontStyle: "bold" } }],
      ["Gezählter Kassenbestand", s.counted_cents == null ? "–" : formatEuro(s.counted_cents)],
      [
        { content: "Differenz", styles: { fontStyle: "bold" } },
        { content: t.difference == null ? "–" : `${t.difference > 0 ? "+" : ""}${formatEuro(t.difference)}`, styles: { fontStyle: "bold" } },
      ],
      ["Anzahl Verkäufe (storniert)", `${t.sales_count} (${t.voided_count})`],
    ],
  });
  if (s.note) {
    doc.setFontSize(10);
    doc.text(`Anmerkung: ${s.note}`, 14, lastY(doc) + 7);
  }

  autoTable(doc, {
    startY: lastY(doc) + (s.note ? 12 : 6),
    head: [["Artikel", "Einzelpreis", "Menge", "Umsatz"]],
    headStyles: { fillColor: TEAL },
    styles: { fontSize: 10 },
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" } },
    body: r.items.length
      ? r.items.map((i) => [i.name, formatEuro(i.unit_price_cents), String(i.qty), formatEuro(i.revenue)])
      : [[{ content: "Keine Verkäufe", colSpan: 4, styles: { halign: "center" } }]],
  });

  // Unterschriften
  const y = Math.min(lastY(doc) + 24, 270);
  doc.setDrawColor(120, 120, 120);
  doc.line(14, y, 84, y);
  doc.line(120, y, 190, y);
  doc.setFontSize(9);
  doc.text("Kassiert / gezählt von", 14, y + 5);
  doc.text("Geprüft (Lehrkraft)", 120, y + 5);

  // Anhang: Einzelbuchungen
  doc.addPage();
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("Anhang: Einzelbuchungen", 14, 16);
  doc.setFont("helvetica", "normal");
  autoTable(doc, {
    startY: 20,
    head: [["Zeit", "Artikel", "Summe", "Spende", "Gegeben", "Rückgeld", "Status"]],
    headStyles: { fillColor: TEAL },
    styles: { fontSize: 8.5 },
    columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
    body: r.sales.map((x) => [
      fmtTime(x.created_at),
      x.items.map((i) => `${i.qty}× ${i.name}`).join(", "),
      formatEuro(x.total_cents),
      x.donation_cents ? formatEuro(x.donation_cents) : "",
      formatEuro(x.paid_cents),
      formatEuro(x.change_cents),
      x.voided_at ? `storniert: ${x.void_reason ?? ""}` : "",
    ]),
    didParseCell: (d) => {
      if (d.section === "body" && r.sales[d.row.index]?.voided_at) d.cell.styles.textColor = [150, 150, 150];
    },
  });
  footer(doc);
  doc.save(`Kassenbericht_${fileSafe(s.name)}_${(s.opened_at ?? s.created_at).slice(0, 10)}.pdf`);
}

/** PDF-Gesamtbericht für einen Zeitraum */
export async function rangeReportPdf(st: Stats, from: string, to: string) {
  const { doc, autoTable } = await newDoc("Gesamtbericht SV-Kasse", st.settings);
  const label = from || to ? `Zeitraum: ${from || "Beginn"} bis ${to || "heute"}` : "Zeitraum: gesamt";
  doc.setFontSize(10);
  doc.text(label, 14, 33);

  autoTable(doc, {
    startY: 37,
    head: [["Gesamt", "Betrag"]],
    headStyles: { fillColor: TEAL },
    columnStyles: { 1: { halign: "right" } },
    body: [
      ["Verkaufserlöse", formatEuro(st.totals.revenue)],
      ["SV-Spenden", formatEuro(st.totals.donations)],
      [{ content: "Summe", styles: { fontStyle: "bold" } }, { content: formatEuro(st.totals.revenue + st.totals.donations), styles: { fontStyle: "bold" } }],
      ["Anzahl Verkäufe", String(st.totals.sales_count)],
    ],
  });
  autoTable(doc, {
    startY: lastY(doc) + 6,
    head: [["Schicht", "Datum", "Start", "Erlös", "Spenden", "Gezählt"]],
    headStyles: { fillColor: TEAL },
    styles: { fontSize: 9 },
    columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
    body: st.shifts.length
      ? st.shifts.map((x) => [x.name, fmtDate(x.created_at), formatEuro(x.starting_cents), formatEuro(x.revenue), formatEuro(x.donations), x.counted_cents == null ? "–" : formatEuro(x.counted_cents)])
      : [[{ content: "Keine Schichten", colSpan: 6, styles: { halign: "center" } }]],
  });
  autoTable(doc, {
    startY: lastY(doc) + 6,
    head: [["Artikel", "Menge", "Umsatz"]],
    headStyles: { fillColor: TEAL },
    styles: { fontSize: 9 },
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
    body: st.byArticle.map((a) => [a.name, String(a.qty), formatEuro(a.revenue)]),
  });
  footer(doc);
  doc.save(`Gesamtbericht_${from || "alle"}_${to || "heute"}.pdf`);
}
