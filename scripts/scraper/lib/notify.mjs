// Skickar nya händelser som pushnotiser till besökarna som slagit på dem (Butiker → Notiser på sidan).
// Prenumerationerna och varje besökares urval ligger i api/push.php på webbhotellet. Hämtningen därifrån och
// notiserna signeras med den hemliga VAPID-nyckeln i miljövariabeln VAPID_PRIVATE_KEY (repo-secret).
// Nyckeln får aldrig ligga i config.json eller någon annan fil i repot.
import { vapidKey, jwt, sendPush } from "./webpush.mjs";

const API = process.env.PUSH_API || "https://lootninja.se/api/push.php";
const AUDIENCE = "https://lootninja.se/api/push.php"; // samma som AUDIENCE i api/push.php, även när PUSH_API pekar på en testserver
const KIND = { ny: "Ny produkt", tillbaka: "Tillbaka i lager", prissankt: "Prissänkt", forbestallning: "Förbeställning öppen" };
const MAX_SINGLE = 3; // fler händelser än så till samma person blir en sammanfattning, så att ingen får notisspam
const CONCURRENCY = 8;

const kr = (n) => `${Math.round(n).toLocaleString("sv-SE")} kr`;

// Samma regler som matches() i js/prefs.js. Tom lista betyder "alla".
function matches(e, p) {
  if (e.group && (p.watch || []).includes(e.group)) return true;
  // Tom spellista betyder bara Pokémon (se gamesOf i js/prefs.js).
  if (!(p.games?.length ? p.games : ["pk"]).includes(e.game || "pk")) return false;
  if (p.kinds?.length && !p.kinds.includes(e.kind)) return false;
  if (p.stores?.length && !p.stores.includes(e.store)) return false;
  if (p.types?.length && !p.types.includes(e.type)) return false;
  if (p.sets?.length && !p.sets.includes(e.set)) return false;
  if (p.langs?.length && !p.langs.includes(e.lang)) return false;
  if (p.maxPrice > 0 && e.price > p.maxPrice) return false;
  return true;
}

// Produktens namn är rubriken och bilden visas i notisen (sw.js). Typen står först i texten som ett kort emblem.
const BADGE = { ny: "NY", tillbaka: "TILLBAKA I LAGER", prissankt: "PRISSÄNKT", forbestallning: "FÖRBESTÄLLNING" };
function message(e, storeName) {
  const price = kr(e.price);
  const badge = BADGE[e.kind] || (KIND[e.kind] || e.kind).toUpperCase();
  return { title: e.title, body: `${badge} · ${price}\n${storeName[e.store] || e.store}`, image: e.image || undefined, url: e.url, tag: `${e.product}-${e.kind}` };
}
function summary(list) {
  const counts = Object.entries(list.reduce((a, e) => ((a[e.kind] = (a[e.kind] || 0) + 1), a), {}))
    .map(([k, n]) => `${n} ${(KIND[k] || k).toLowerCase()}`).join(", ");
  return { title: `${list.length} nya händelser i butikerna`, body: `${counts}. Tryck för hela listan.`, url: "https://lootninja.se/butiker.html#events", tag: "summary" };
}

async function api(action, key, body) {
  const token = jwt(key, { aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 });
  const r = await fetch(`${API}?action=${action}`, {
    method: body ? "POST" : "GET",
    headers: { "x-lootninja-auth": token, "user-agent": "PackninjaBot/1.0 (+https://lootninja.se/om.html#bot)", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`push.php ${action} ${r.status}`);
  return r.json();
}

export async function notify(events, storeName) {
  if (!events.length) return;
  if (!process.env.VAPID_PRIVATE_KEY) { console.log("Pushnotiser hoppas över: VAPID_PRIVATE_KEY saknas."); return; }
  // En trasig notistjänst får aldrig stoppa själva bevakningen.
  try {
    const key = vapidKey(process.env.VAPID_PRIVATE_KEY);
    const { subs } = await api("list", key);
    const gone = [];
    let sent = 0, failed = 0, i = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (i < subs.length) {
        const s = subs[i++], mine = events.filter((e) => matches(e, s.prefs || {}));
        if (!mine.length) continue;
        const msgs = mine.length > MAX_SINGLE ? [summary(mine)] : mine.map((e) => message(e, storeName));
        const urgent = mine.some((e) => e.kind === "tillbaka" || e.kind === "forbestallning");
        for (const m of msgs) {
          try {
            if (await sendPush(s, m, key, { urgency: urgent ? "high" : "normal" }) === "gone") { gone.push(s.id); break; }
            sent++;
          } catch (e) { failed++; if (failed <= 3) console.warn(`Pushnotis misslyckades: ${e.message}`); }
        }
      }
    }));
    if (gone.length) await api("prune", key, { ids: gone });
    console.log(`Pushnotiser: ${sent} skickade till ${subs.length} prenumeranter${failed ? `, ${failed} misslyckades` : ""}${gone.length ? `, ${gone.length} borttagna` : ""}.`);
  } catch (e) {
    console.warn(`Pushnotiser misslyckades: ${e.message}`);
  }
}
