# SV-Kasse HB-BK: Anleitung

Kassensystem für die Schülervertretung. Läuft auf Cloudflare (Worker + D1-Datenbank).

## So wird verkauft (Alltag)

1. **Admin** (`/#/admin`) → Reiter *Schichten* → *+ Neue Schicht*: Name der Pause (z. B. „1. große Pause“) und Startbetrag (Wechselgeld) eingeben. Der **Code** wird angezeigt.
2. Das Verkaufsteam gibt den Kassencode am Verkaufsgerät auf der Startseite ein → die Kasse ist aktiv.
3. Verkaufen: Artikel antippen → *Bezahlen* → Betrag wählen, optional **SV-Spende** (Mehrbetrag) → *Verkauf buchen*.
4. Fehler? *Verkäufe* → *Stornieren* (mit Grund; der Bestand wird zurückgebucht).
5. Pausenende: *Kasse abschließen* → Bargeld zählen → die Differenz zum Soll wird angezeigt → **PDF-Kassenbericht** herunterladen. Danach ist der Code ungültig.

### Wenn das Internet ausfällt

Die Kasse arbeitet weiter. Oben erscheint „Offline“, Verkäufe werden auf dem Gerät gespeichert und gehen automatisch an den Server, sobald wieder Verbindung besteht („Jetzt senden“ geht auch von Hand). Wichtig:

- Das Gerät muss die Kasse **einmal mit Internet geöffnet** haben (am besten auf den Home-Bildschirm legen). Dann startet sie auch ohne Netz.
- **Stornieren** und **Kasse abschließen** gehen nur mit Verbindung. Der Abschluss ist gesperrt, bis alle wartenden Verkäufe übertragen sind.
- Verkäufe, die der Server ablehnt (z. B. weil die Kasse inzwischen geschlossen wurde), bleiben rot markiert unter „Ansehen“ sichtbar. Das Geld dafür ist in der Kasse: der Aufsicht melden.
- Ware, die offline mehrfach verkauft wurde, kann den Bestand auf 0 setzen. Der Verkauf wird trotzdem gebucht.
- Nicht „Gerät abmelden“ drücken, solange Verkäufe warten.

Artikel, Preise und Bestand pflegt ihr im Admin unter *Artikel* und *Bestand*. Auswertungen (Tage, Artikel, Zeitraum) mit PDF- und CSV-Export gibt es unter *Auswertung*.

## Einmalige Einrichtung auf Cloudflare

Voraussetzung: Node.js und Wrangler sind installiert (`node -v`, `wrangler --version`) und ihr habt einen Cloudflare-Account.

Im Projektordner:

```bash
npm install
wrangler login
wrangler d1 create sv-kasse
```

Trage die ausgegebene `database_id` in `wrangler.jsonc` ein (ersetzt `00000000-…`). Dann:

```bash
npm run db:migrate:remote
wrangler secret put ADMIN_PASSWORD
wrangler secret put SESSION_SECRET
npm run deploy
```

- `ADMIN_PASSWORD`: euer Start-Passwort für den Adminbereich (später im Admin unter *Einstellungen* änderbar).
- `SESSION_SECRET`: lange Zufallszeichenfolge, erzeugen mit `openssl rand -base64 32`.

Nach dem Deploy nennt Wrangler die Adresse (`https://sv-kasse.<euer-konto>.workers.dev`). Auf Tablets zum Home-Bildschirm hinzufügen, dann startet sie wie eine App.

**Wichtig:** Das Passwort `admin123` aus `.dev.vars` ist nur für lokale Tests und gilt nicht auf Cloudflare.

## Lokal testen

```bash
npm run db:migrate:local
npm run build
npm run dev:api
```

Dann `http://localhost:8787` öffnen. Lokales Test-Passwort: siehe `.dev.vars`.

Nach Code-Änderungen am Frontend: `npm run build` erneut ausführen. Alternativ in einem zweiten Terminal `npm run dev:web` (mit Live-Reload, Adresse `http://localhost:5173`).

## Nach einem Neuaufsetzen des Macs

Node.js (nodejs.org) und `npm install -g wrangler` installieren, im Projektordner `npm install` ausführen. Daten liegen in Cloudflare und gehen nicht verloren.

## Hinweise

- Es werden keine Namen von Schülerinnen und Schülern gespeichert, nur Artikel und Beträge.
- Alle Beträge werden intern in Cent gerechnet (keine Rundungsfehler).
- Nach 10 falschen Code- oder Passworteingaben innerhalb von 10 Minuten wird die Anmeldung für diese Verbindung vorübergehend gesperrt.
- Abgeschlossene Schichten und Verkäufe bleiben für die Berichte erhalten. Artikel mit Verkäufen werden beim Entfernen nur deaktiviert.
- Zeiten werden in deutscher Ortszeit angezeigt.
