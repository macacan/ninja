// Löpande butiksbevakning: varje butik har en egen klocka.
//   node scripts/scraper/daemon.mjs
// Vanliga butiker kollas var tionde minut. Butiker som ber oss ta det lugnare (Crawl-delay i robots.txt,
// eller svar 429/503) kollas var tjugonde minut. Butiker som inte svarar försöker vi igen efter tio minuter.
// Mellan 01 och 07 (svensk tid) kollas varje butik högst en gång i timmen.
// Processen ska köras hela tiden, t.ex. på en server eller med Windows Schemaläggaren vid inloggning.
// DAEMON_MINUTES=340 avslutar snyggt efter så många minuter (används av GitHub Actions, där ett jobb får köra högst sex timmar).
import { createEngine } from "./lib/engine.mjs";

const engine = await createEngine();
const MIN = 60e3;
// DAEMON_INTERVAL och DAEMON_PAGES styr takten utan att ändra config.json (används av GitHub Actions).
const BASE = (Number(process.env.DAEMON_INTERVAL) || engine.cfg.intervalMinutes || 10) * MIN;
const CALM = Math.max(BASE, (engine.cfg.calmIntervalMinutes ?? 20) * MIN);
// Nattvila: butikerna fyller sällan på mitt i natten, så då räcker en kontroll i timmen.
const NIGHT = { from: engine.cfg.nightFrom ?? 1, to: engine.cfg.nightTo ?? 7, interval: (engine.cfg.nightIntervalMinutes ?? 60) * MIN };
const PAGES = Number(process.env.DAEMON_PAGES) || 8;
const RETRY = 10 * MIN;
const BLOCKED = 6 * 60 * MIN; // botskydd: försök igen om sex timmar, aldrig oftare
const CONCURRENCY = engine.cfg.concurrency ?? 10;
const SAVE_EVERY = 20e3;
const SITEMAP_MAX_AGE = 30 * MIN;

const stores = engine.allowed;
// Sprid starten så att inte alla butiker kollas samma sekund.
const next = new Map(stores.map((s, i) => [s.id, Date.now() + i * 1500]));
const running = new Set();
let dirty = false, stopping = false;

const jitter = () => Math.round((Math.random() - 0.5) * 20e3); // ±10 s, så att varven inte låser sig i takt
const clock = () => new Date().toLocaleTimeString("sv-SE");

// Om nu är natt: hur länge till nästa nattkontroll, men aldrig förbi morgonen (då går vanlig takt igång).
function nightWait(now = new Date()) {
  const [h, m] = now.toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour12: false }).split(":").map(Number);
  if (h < NIGHT.from || h >= NIGHT.to) return 0;
  return Math.min(NIGHT.interval, ((NIGHT.to - h) * 60 - m) * MIN);
}

async function check(store) {
  running.add(store.id);
  try {
    // Sitemap-butiker läser några få produktsidor per varv i stället för 25 åt gången.
    const res = await engine.scrape(store, { pagesPerRun: PAGES, sitemapMaxAge: SITEMAP_MAX_AGE });
    const calm = res.ok && res.delay > 3000;
    const interval = Math.max(nightWait(), res.blocked ? BLOCKED : !res.ok ? Math.max(RETRY, res.retryAfter * 1000) : calm ? CALM : BASE);
    const found = engine.apply(store, res, { interval: Math.round(interval / MIN) });
    dirty = true;
    next.set(store.id, Date.now() + interval + jitter());
    if (found.length) {
      console.log(`${clock()} ${store.name}: ${found.map((e) => `${e.kind} "${e.title}"`).join(", ")}`);
      await engine.notify(found);
    } else if (!res.ok) {
      console.warn(`${clock()} ✗ ${store.name}: ${res.error}`);
    }
  } finally {
    running.delete(store.id);
  }
}

function tick() {
  if (stopping) return;
  const now = Date.now();
  const due = stores.filter((s) => !running.has(s.id) && next.get(s.id) <= now).sort((a, b) => next.get(a.id) - next.get(b.id));
  for (const s of due.slice(0, Math.max(0, CONCURRENCY - running.size))) check(s);
}

async function flush() {
  if (!dirty) return;
  dirty = false;
  try { await engine.save(); } catch (e) { dirty = true; console.warn(`Kunde inte spara: ${e.message}`); }
}

// Avsluta snyggt: vänta in pågående kontroller och spara.
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log("\nAvslutar, sparar senaste läget…");
  const t0 = Date.now();
  while (running.size && Date.now() - t0 < 60e3) await new Promise((r) => setTimeout(r, 500));
  dirty = true;
  await flush();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(`${clock()} Bevakar ${stores.length} butiker. Var ${BASE / MIN}:e minut som standard, var ${CALM / MIN}:e minut för butiker som vill ta det lugnare, högst en gång per ${NIGHT.interval / MIN} min kl. ${NIGHT.from}–${NIGHT.to}. Ctrl+C avslutar.`);
setInterval(tick, 1000);
setInterval(flush, SAVE_EVERY);
const LIMIT = Number(process.env.DAEMON_MINUTES) || 0;
if (LIMIT > 0) setTimeout(stop, LIMIT * MIN);
tick();
