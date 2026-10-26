// Lootninjas service worker: tar emot pushnotiser och visar dem, även när sidan är stängd (se js/push.js och
// scripts/scraper/lib/notify.mjs). Den cachar ingenting, så sidan hämtas alltid färsk från nätet.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() || "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Lootninja", {
    body: d.body || "",
    icon: "/img/icon-192.png?v=2",
    badge: "/img/favicon-48.png?v=2",
    tag: d.tag || undefined,
    data: { url: d.url || "/butiker.html" },
  }));
});

// Ett tryck på notisen öppnar produkten hos butiken, eller butikslistan. Bara http(s)-länkar.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  let url;
  try { url = new URL(e.notification.data?.url || "/", self.location.origin); } catch { return; }
  if (!/^https?:$/.test(url.protocol)) return;
  e.waitUntil(self.clients.openWindow(url.href));
});
