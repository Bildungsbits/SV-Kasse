// Erzeugt docs/SV-Kasse_Anleitung_Schueler.pdf (eine A4-Seite für das Verkaufsteam).
// Aufruf: npm run docs:pdf
import { writeFileSync } from "node:fs";
import { jsPDF } from "jspdf";

const OUT = new URL("../docs/SV-Kasse_Anleitung_Schueler.pdf", import.meta.url);

const TEAL = [15, 118, 110];
const TEXT = [30, 33, 33];
const GREY = [120, 130, 128];
const AMBER_BG = [254, 243, 199];
const AMBER_TX = [124, 45, 18];
const TEAL_BG = [226, 244, 241];

const doc = new jsPDF({ unit: "pt", format: "a4" });
doc.setProperties({ title: "So verkaufst du mit der SV-Kasse", subject: "Anleitung für das Verkaufsteam", author: "SV-Kasse" });
const W = doc.internal.pageSize.getWidth();
const H = doc.internal.pageSize.getHeight();
const M = 33;
const GAP = 24;
const COLW = (W - 2 * M - GAP) / 2;

const FS = 9; // Fließtext
const LH = 11; // Zeilenabstand
const PARA = 3.4; // Abstand zwischen Absätzen

// ---------- Kopf ----------
const HEAD = 74;
doc.setFillColor(...TEAL).rect(0, 0, W, HEAD, "F");
// Logo: weißes Quadrat mit Registrierkasse
const L = { x: 33, y: 11, s: 52 };
doc.setFillColor(255, 255, 255).roundedRect(L.x, L.y, L.s, L.s, 8, 8, "F");
{
  const k = L.s / 64; // Zeichnung ist auf 64×64 angelegt
  const px = (v) => L.x + v * k;
  const py = (v) => L.y + v * k;
  doc.setFillColor(...TEAL);
  doc.roundedRect(px(19), py(8), 26 * k, 12 * k, 3 * k, 3 * k, "F");
  doc.lines([[34 * k, 0], [6 * k, 17 * k], [-46 * k, 0], [6 * k, -17 * k]], px(15), py(23), [1, 1], "F", true);
  doc.roundedRect(px(8), py(42), 48 * k, 12 * k, 3.5 * k, 3.5 * k, "F");
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(px(23), py(12), 18 * k, 4 * k, 1.5 * k, 1.5 * k, "F");
  for (const [x, y] of [[19, 27], [29, 27], [39, 27], [17.5, 33], [29, 33], [40.5, 33]]) doc.roundedRect(px(x), py(y), 6 * k, 3.5 * k, 1 * k, 1 * k, "F");
  doc.roundedRect(px(25), py(46.5), 14 * k, 3 * k, 1.5 * k, 1.5 * k, "F");
}
doc.setTextColor(255, 255, 255);
doc.setFont("helvetica", "bold").setFontSize(21).text("So verkaufst du mit der SV-Kasse", 105, 33);
doc.setFont("helvetica", "normal").setFontSize(10.5);
doc.text("Anleitung für das Verkaufsteam der SV · HB-BK", 105, 49);
doc.text("sv-kasse.bildungsbits.de", 105, 63);

// ---------- Bausteine ----------
function heading(x, y, n, title, w = COLW) {
  doc.setFillColor(...TEAL).circle(x + 10.5, y + 10.5, 10.5, "F");
  doc.setTextColor(255, 255, 255).setFont("helvetica", "bold").setFontSize(10).text(String(n), x + 10.5, y + 14, { align: "center" });
  doc.setTextColor(...TEAL).setFontSize(13).text(title, x + 28, y + 15);
  doc.setDrawColor(...TEAL).setLineWidth(1.1).line(x, y + 25, x + w, y + 25);
  return y + 25 + 6;
}

/** Aufzählung; gibt die neue y-Position zurück */
function bullets(x, y, items, w = COLW, { color = TEXT, indent = 16 } = {}) {
  doc.setFont("helvetica", "normal").setFontSize(FS).setTextColor(...color);
  for (const item of items) {
    const lines = doc.splitTextToSize(item, w - indent);
    doc.text("•", x + 5, y + 8);
    doc.text(lines, x + indent, y + 8, { lineHeightFactor: LH / FS });
    y += lines.length * LH + PARA;
  }
  return y;
}

function section(x, y, n, title, items) {
  return bullets(x, heading(x, y, n, title), items) + 3;
}

// ---------- Inhalt ----------
const left = M;
const right = M + COLW + GAP;
const TOP = HEAD + 16;

let yl = TOP;
yl = section(left, yl, 1, "Kasse starten", [
  "Öffne auf dem Tablet oder Handy die Seite sv-kasse.bildungsbits.de.",
  "Gib den Kassencode ein, den du bekommen hast, und tippe auf „Kasse starten“. Der Code gilt nur für diese eine Pause.",
  "Oben siehst du: Kassenbestand (soll), Verkäufe, SV-Spenden und den Startbetrag.",
  "Tipp: Lege die Seite vorher auf den Home-Bildschirm und öffne sie einmal mit Internet. Dann startet die Kasse auch ohne Netz.",
]);
yl = section(left, yl, 2, "Verkaufen", [
  "Tippe die Artikel an. Die weiße Zahl an der Kachel zeigt, wie oft er im Warenkorb liegt. Oben rechts steht der Bestand. Orange heißt: fast leer. Grau heißt: ausverkauft.",
  "Mit „–“ und „+“ änderst du die Menge, „Leeren“ löscht den Warenkorb.",
  "Tippe auf „Bezahlen“. Wähle bei „Gegeben (bar)“ den Betrag, den die Kundschaft gibt: „Passend“, eine Schnellwahl (zum Beispiel 5 oder 10 Euro) oder einen anderen Betrag, den du eintippst.",
  "Die Kasse zeigt dir das Rückgeld in großer Schrift. Wenn Geld fehlt, steht dort „Es fehlen …“.",
  "Tippe auf „Verkauf buchen“. Gib das Rückgeld heraus und tippe auf „Nächster Kunde“.",
]);
yl = section(left, yl, 3, "SV-Spende", [
  "Gibt jemand mehr und möchte den Rest spenden, wähle bei „SV-Spende“ eine Schnellwahl (zum Beispiel +0,50 oder +1 Euro), „Rückgeld spenden“ oder gib einen eigenen Betrag ein.",
  "Die Spende wird extra gezählt und erscheint im Bericht getrennt vom Verkauf. Das Rückgeld verringert sich entsprechend.",
]);

let yr = TOP;
yr = section(right, yr, 4, "Fehler korrigieren", [
  "Falsch gebucht? Tippe oben auf „Verkäufe“. Du siehst die letzten Buchungen.",
  "Tippe bei der falschen Buchung auf „Stornieren“, schreibe einen kurzen Grund auf und bestätige. Die Artikel werden wieder in den Bestand gebucht, der Betrag zählt nicht mehr.",
  "Storniere nur, wenn das Geld wirklich zurückgegeben wurde. Stornieren geht nur mit Internet.",
]);
yr = section(right, yr, 5, "Am Pausenende: Kasse abschließen", [
  "Tippe oben auf „Kasse abschließen“. Das geht erst, wenn oben nichts mehr als „wartend“ angezeigt wird.",
  "Zähle das gesamte Bargeld in der Kasse (mit dem Wechselgeld vom Anfang) und gib den Betrag ein.",
  "Die Kasse zeigt die Differenz zum Soll (Startbetrag + Verkäufe + Spenden). Stimmt es nicht ganz, zähle noch einmal nach. Du kannst eine Anmerkung schreiben.",
  "Tippe auf „Kasse endgültig schließen“. Danach sind keine Verkäufe mehr möglich und der Code ist ungültig.",
  "Lade den „PDF-Kassenbericht“ herunter und gib ihn der Lehrkraft, mit Unterschrift beim „Kassiert / gezählt von“.",
]);
yr = section(right, yr, 6, "Gut zu wissen", [
  "Mehrere Geräte können mit demselben Code gleichzeitig verkaufen.",
  "„Gerät abmelden“ beendet nur dieses Gerät. Die Kasse bleibt offen, mit dem Code kommst du wieder hinein.",
]);

// ---------- Ohne Internet (volle Breite) ----------
let y = Math.max(yl, yr) + 2;
const FULL = W - 2 * M;
const offlineLeft = [
  "Einfach weiterverkaufen. Oben steht „Offline“, jeder Verkauf wird auf dem Gerät gespeichert („Verkauf gespeichert“).",
  "Sobald wieder Internet da ist, werden die Verkäufe automatisch gesendet. Oben steht „wartend“, bis alles angekommen ist. „Jetzt senden“ startet es sofort.",
];
const offlineRight = [
  "Ohne Internet gehen „Stornieren“ und „Kasse abschließen“ nicht.",
  "Solange Verkäufe warten: nicht „Gerät abmelden“ tippen und den Browser-Verlauf nicht löschen.",
  "Steht dort „abgelehnt“ (rot), den Verkauf nicht löschen und die Lehrkraft holen. Das Geld ist trotzdem in der Kasse.",
];
const colW = (FULL - 2 * 14 - 16) / 2;
const measure = (items) => {
  doc.setFont("helvetica", "normal").setFontSize(FS);
  return items.reduce((h, t) => h + doc.splitTextToSize(t, colW - 16).length * LH + PARA, 0);
};
const boxH = 14 + 22 + Math.max(measure(offlineLeft), measure(offlineRight)) + 6;
doc.setFillColor(...TEAL_BG).roundedRect(M, y, FULL, boxH, 9, 9, "F");
doc.setDrawColor(...TEAL).setLineWidth(1).roundedRect(M, y, FULL, boxH, 9, 9, "S");
doc.setFont("helvetica", "bold").setFontSize(12).setTextColor(...TEAL).text("Wenn das Internet ausfällt: die Kasse läuft weiter", M + 14, y + 20);
bullets(M + 14, y + 28, offlineLeft, colW);
bullets(M + 14 + colW + 16, y + 28, offlineRight, colW);
y += boxH + 12;

// ---------- Wichtig ----------
const important = [
  "Erst das Geld nehmen, dann „Verkauf buchen“ tippen.",
  "Den Code nicht weitergeben und das Geld nie unbeaufsichtigt lassen.",
  "Den Adminbereich (Artikel, Preise, Projekte) bedienen nur Lehrkräfte.",
  "Es werden keine Namen gespeichert, nur Artikel und Beträge.",
];
const impH = 12 + 17 + important.length * (LH + PARA) + 4;
doc.setFillColor(...AMBER_BG).roundedRect(M, y, FULL, impH, 9, 9, "F");
doc.setFont("helvetica", "bold").setFontSize(11.5).setTextColor(...AMBER_TX).text("Wichtig", M + 14, y + 22);
bullets(M + 14, y + 29, important, FULL - 28, { color: TEXT });
y += impH;

// ---------- Fuß ----------
doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...GREY);
doc.text("SV-Kasse HB-BK · Bei Fragen oder Problemen: Lehrkraft ansprechen", W / 2, H - 28, { align: "center" });

if (y > H - 44) {
  console.error(`Zu lang: Inhalt endet bei ${Math.round(y)} pt, erlaubt sind ${H - 44}. Text kürzen oder Schrift verkleinern.`);
  process.exit(1);
}
writeFileSync(OUT, Buffer.from(doc.output("arraybuffer")));
console.log(`PDF geschrieben, Inhalt endet bei ${Math.round(y)} von ${Math.round(H - 44)} pt`);
