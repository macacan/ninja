// Besöksstatistik utan kakor: sidvisningar, klick till butikerna, sökningar, bevakningar och öppnade pack skickas till
// stats.lootninja.se (stats/api.php). Inget sparas i webbläsaren och ingen IP-adress sparas hos oss, se integritet.html.
// Inget skickas om webbläsaren ber om att inte bli spårad (Do Not Track / Global Privacy Control), eller lokalt.
const ENDPOINT = "https://stats.lootninja.se/api.php";

const off = navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.globalPrivacyControl === true
  || location.hostname !== "lootninja.se";

const device = () => {
  const w = Math.min(screen.width, innerWidth);
  return /ipad|tablet/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && w >= 700 && w < 1100) ? "tablet" : w < 700 ? "mobile" : "desktop";
};

// Varifrån besökaren kom, i den här ordningen:
//  1. utm_source i adressen (ChatGPT lägger till ?utm_source=chatgpt.com på sina länkar, kampanjlänkar likaså)
//  2. domänen i referrer, t.ex. google.com eller l.instagram.com ("internal" när man klickat runt på Lootninja)
//  3. appens inbyggda webbläsare, som ofta inte skickar någon referrer (Instagram, Facebook, TikTok, Snapchat …)
//  4. annars "direct" (bokmärke, inskriven adress, eller en app som inte säger något)
const IN_APP = [[/Instagram/, "instagram-app"], [/FBAN|FBAV|FB_IAB/, "facebook-app"], [/musical_ly|BytedanceWebview|TikTok/i, "tiktok-app"],
  [/Snapchat/i, "snapchat-app"], [/Discord/i, "discord-app"], [/LinkedInApp/i, "linkedin-app"], [/Pinterest/i, "pinterest-app"], [/\bLine\//, "line-app"]];
const referrer = () => {
  const utm = new URLSearchParams(location.search).get("utm_source");
  if (utm && /^[\w.-]{1,60}$/.test(utm)) return utm.toLowerCase().replace(/^www\./, "");
  try {
    const h = new URL(document.referrer).hostname.replace(/^www\./, "");
    if (h) return h === location.hostname ? "internal" : h;
  } catch {}
  return IN_APP.find(([re]) => re.test(navigator.userAgent))?.[1] || "direct";
};

let lastSearch = "";
export function track(type, target = null, value = null) {
  if (off) return;
  // Samma sökning två gånger i rad (t.ex. när man bara byter sortering) räknas en gång.
  if (type === "search") { if (!target || target === lastSearch) return; lastSearch = target; }
  const body = JSON.stringify({ type, path: location.pathname, target: target == null ? null : String(target).slice(0, 120), value, referrer: type === "pageview" ? referrer() : null, device: device() });
  try {
    // text/plain gör att webbläsaren inte behöver fråga servern först (ingen CORS-förfrågan).
    if (navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "text/plain" }))) return;
  } catch {}
  fetch(ENDPOINT, { method: "POST", body, keepalive: true, mode: "cors", credentials: "omit", headers: { "content-type": "text/plain" } }).catch(() => {});
}

// "1 299 kr" → 1299
const price = (s) => { const n = parseFloat(String(s || "").replace(/\s| /g, "").replace(",", ".").match(/[\d.]+/)?.[0]); return Number.isFinite(n) ? n : null; };

function storeClick(e) {
  const a = e.target.closest?.("a[href]");
  if (!a) return;
  let host;
  try { host = new URL(a.href).hostname.replace(/^www\./, ""); } catch { return; }
  if (!host || host === location.hostname) return;
  // Butikslänkar har rel="nofollow". Övriga externa länkar (Cardmarket, nyhetskällor, Bulbapedia) räknas per domän.
  if (!/\bnofollow\b/.test(a.rel)) return track("outbound", host);
  // Butikens namn och priset från produktkortet om det finns, annars domänen.
  const card = a.closest(".pcard, .rf, .srow, li, article");
  const store = card?.querySelector(".pstore")?.textContent.split(" · ")[0].trim();
  const amount = price(card?.querySelector(".pprice")?.textContent);
  track("store_click", store || host, amount);
}

function start() {
  if (off) return;
  track("pageview");
  // Kortsökningarna räknas av js/priser.js och js/vardering.js, även när man söker igen utan att ladda om sidan.
  // auxclick fångar mittenklick (ny flik), som inte ger något vanligt klick.
  document.addEventListener("click", storeClick, true);
  document.addEventListener("auxclick", (e) => { if (e.button === 1) storeClick(e); }, true);
  // Produktfiltret på butikssidan: räknas när man slutat skriva en stund.
  let timer, last = "";
  document.addEventListener("input", (e) => {
    if (e.target.id !== "f-q") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const v = e.target.value.trim().toLowerCase();
      if (v.length >= 3 && v !== last) { last = v; track("search", v); }
    }, 1500);
  });
}

start();
