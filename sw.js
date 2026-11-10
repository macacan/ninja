// Lootninjas service worker: tar emot pushnotiser och visar dem, även när sidan är stängd (se js/push.js och
// scripts/scraper/lib/notify.mjs). Den cachar inga sidor, så sidan hämtas alltid färsk från nätet. Den enda posten i
// cachen är märket "nl-flags" som js/tracker.js lägger dit när besöksstatistiken är på.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Visade och tryckta notiser räknas i besöksstatistiken (stats.lootninja.se), bara för riktiga notiser från
// bevakningen (de har "stat" med typ, butik och pris). Välkomst- och testnotiser räknas inte. Inget skickas förrän
// sidan har lämnat märket att statistiken är på (js/tracker.js), och aldrig utanför lootninja.se.
const STATS = "https://stats.lootninja.se/api.php";
async function stat(type, s) {
  try {
    if (!s || self.location.hostname !== "lootninja.se") return;
    if (!(await (await caches.open("nl-flags")).match("/stats-on"))) return;
    const target = [s.k, s.s].filter(Boolean).join(" · ").slice(0, 120);
    await fetch(STATS, {
      method: "POST", mode: "cors", credentials: "omit", keepalive: true, headers: { "content-type": "text/plain" },
      body: JSON.stringify({ type, path: "/notis", target: target || null, value: Number.isFinite(s.p) ? s.p : null }),
    });
  } catch {}
}

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() || "" }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || "Lootninja", {
      body: d.body || "",
      // Produktbilden som ikon (liten bild bredvid texten) och som stor bild när notisen fälls ut (Android, Windows).
      // iPhone visar alltid appikonen och ignorerar bilderna.
      icon: d.image || "/img/icon-192.png?v=4",
      image: d.image || undefined,
      // Statusfältet på Android visar bara formen (vitt på genomskinligt), så badgen är LOOT NINJA-texten i vitt (scripts/build-badge.mjs).
      badge: "/img/badge-96.png?v=2",
      tag: d.tag || undefined,
      data: { url: d.url || "/butiker.html", stat: d.stat || null },
    }),
    stat("push_shown", d.stat),
  ]));
});

// Ett tryck på notisen öppnar produkten hos butiken, eller butikslistan. Bara http(s)-länkar.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  let url;
  try { url = new URL(e.notification.data?.url || "/", self.location.origin); } catch { return; }
  if (!/^https?:$/.test(url.protocol)) return;
  // Fönstret öppnas först, så att räkningen aldrig fördröjer det.
  e.waitUntil(Promise.all([self.clients.openWindow(url.href), stat("push_click", e.notification.data?.stat)]));
});
