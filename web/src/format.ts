/** Zeitstempel aus der DB sind UTC ("YYYY-MM-DD HH:MM:SS"). Anzeige in deutscher Ortszeit. */
export function toDate(ts: string): Date {
  return new Date(ts.replace(" ", "T") + "Z");
}
export const fmtTime = (ts: string) => toDate(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
export const fmtDate = (ts: string) => toDate(ts).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
export const fmtDateTime = (ts: string) => `${fmtDate(ts)}, ${fmtTime(ts)}`;

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function download(filename: string, content: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob(["﻿" + content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function csvLine(cells: (string | number)[]): string {
  return cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";");
}
