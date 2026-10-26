// Besöksstatistik utan kakor: sidvisningar, klick till butikerna, sökningar, bevakningar och öppnade pack skickas till
// stats.lootninja.se (stats/api.php). Ingen IP-adress sparas hos oss, se integritet.html.
// Skriptet läser ingenting om enheten (skärm, pekskärm, webbläsare): enhetstyp och app avgör servern från det som
// webbläsaren ändå skickar med varje anrop. Inget skickas om besökaren stängt av statistiken på integritetssidan,
// om webbläsaren ber om att inte bli spårad (Do Not Track / Global Privacy Control), eller lokalt.
const ENDPOINT = "https://stats.lootninja.se/api.php";
const OPT_OUT = "nl:no-stats";

export const statsOptedOut = () => { try { return localStorage.getItem(OPT_OUT) === "1"; } catch { return false; } };
const privacyOff = () => statsOptedOut() || navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.globalPrivacyControl === true
  || location.hostname !== "lootninja.se";
let off = privacyOff();
// Besökarens eget val på integritetssidan. Sparas i webbläsaren tills man ändrar det eller rensar webbplatsdata.
export function setStatsOptOut(out) {
  try { if (out) localStorage.setItem(OPT_OUT, "1"); else localStorage.removeItem(OPT_OUT); } catch {}
  off = privacyOff();
}

// Varifrån besökaren kom, i den här ordningen:
//  1. utm_source i adressen (ChatGPT lägger till ?utm_source=chatgpt.com på sina länkar, kampanjlänkar likaså)
//  2. domänen i referrer, t.ex. google.com eller l.instagram.com ("internal" när man klickat runt på Lootninja)
//  3. annars "direct". Kommer besöket från en app (Instagram, TikTok …) som inte skickar någon referrer, ser servern det.
const referrer = () => {
  const utm = new URLSearchParams(location.search).get("utm_source");
  if (utm && /^[\w.-]{1,60}$/.test(utm)) return utm.toLowerCase().replace(/^www\./, "");
  try {
    const h = new URL(document.referrer).hostname.replace(/^www\./, "");
    if (h) return h === location.hostname ? "internal" : h;
  } catch {}
  return "direct";
};

let lastSearch = "";
export function track(type, target = null, value = null) {
  if (off) return;
  // Samma sökning två gånger i rad (t.ex. när man bara byter sortering) räknas en gång.
  if (type === "search") { if (!target || target === lastSearch) return; lastSearch = target; }
  const body = JSON.stringify({ type, path: location.pathname, target: target == null ? null : String(target).slice(0, 120), value, referrer: type === "pageview" ? referrer() : null });
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
