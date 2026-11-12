/* Service Worker der SV-Kasse: damit die App auch ohne Internet startet.
 *
 * - Die App-Dateien (HTML, JS, CSS, Icons) werden zwischengespeichert.
 * - Die Datenschnittstelle (/api/*) wird nie zwischengespeichert: Bestand und Geld kommen immer vom Server.
 * - Die Version steckt im Namen des Zwischenspeichers (?b=… beim Registrieren), jede neue Version
 *   der App legt einen frischen Speicher an und räumt die alten weg.
 */
const BUILD = new URL(self.location.href).searchParams.get("b") || "dev";
const CACHE = `svkasse-${BUILD}`;
const SHELL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Startseite laden und alle darin verlinkten Dateien gleich mitspeichern
      const res = await fetch(SHELL, { cache: "reload" });
      if (!res.ok) throw new Error("Startseite nicht ladbar");
      const html = await res.clone().text();
      await cache.put(SHELL, res);
      const urls = [...html.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)].map((m) => m[1]);
      await Promise.all(
        [...new Set(urls)].map(async (u) => {
          try {
            const r = await fetch(u, { cache: "reload" });
            if (r.ok) await cache.put(u, r);
          } catch {
            /* wird beim ersten Aufruf nachgeholt */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) {
        if (k.startsWith("svkasse-") && k !== CACHE) await caches.delete(k);
      }
      await self.clients.claim();
    })(),
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // immer direkt zum Server
  if (url.pathname === "/sw.js") return;

  // Seitenaufruf: Netz zuerst (neue Version), bei Ausfall oder Langsamkeit die gespeicherte Startseite
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await Promise.race([fetch(req), timeout(4000)]);
          if (res.ok) cache.put(SHELL, res.clone());
          return res;
        } catch {
          return (await cache.match(SHELL)) || Response.error();
        }
      })(),
    );
    return;
  }

  // Dateien mit Hash im Namen ändern sich nie: zuerst aus dem Speicher
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  // Übrige Dateien (Icons, Manifest): gespeichert anzeigen, im Hintergrund aktualisieren
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return hit || (await refresh) || Response.error();
    })(),
  );
});
