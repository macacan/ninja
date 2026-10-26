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

// Bara domänen man kom från, och bara om den är en annan sida än vår egen.
const referrer = () => {
  try { const h = new URL(document.referrer).hostname.replace(/^www\./, ""); return h && h !== location.hostname ? h : "direct"; }
  catch { return "direct"; }
};

export function track(type, target = null, value = null) {
  if (off) return;
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
  if (!a || !/\bnofollow\b/.test(a.rel)) return; // butikslänkar har rel="nofollow", nyheter och källor har det inte
  let host;
  try { host = new URL(a.href).hostname.replace(/^www\./, ""); } catch { return; }
  if (host === location.hostname) return;
  // Butikens namn och priset från produktkortet om det finns, annars domänen.
  const card = a.closest(".pcard, .rf, .srow, li, article");
  const store = card?.querySelector(".pstore")?.textContent.split(" · ")[0].trim();
  const amount = price(card?.querySelector(".pprice")?.textContent);
  track("store_click", store || host, amount);
}

function start() {
  if (off) return;
  track("pageview");
  // Sökningar: kortsökningen landar på priser.html/vardering.html med ?q=.
  const q = new URLSearchParams(location.search).get("q");
  if (q && /\/(priser|vardering)\.html$/.test(location.pathname)) track("search", q.trim().toLowerCase());
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
