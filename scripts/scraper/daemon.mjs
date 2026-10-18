// Löpande butiksbevakning: varje butik har en egen klocka.
//   node scripts/scraper/daemon.mjs
// Vanliga butiker kollas varannan minut. Butiker som ber oss ta det lugnare (Crawl-delay i robots.txt,
// eller svar 429/503) kollas var femte minut. Butiker som inte svarar försöker vi igen efter tio minuter.
// Processen ska köras hela tiden, t.ex. på en server eller med Windows Schemaläggaren vid inloggning.
import { createEngine } from "./lib/engine.mjs";

const engine = await createEngine();
const MIN = 60e3;
const BASE = (engine.cfg.intervalMinutes ?? 2) * MIN;
const CALM = (engine.cfg.calmIntervalMinutes ?? 5) * MIN;
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

async function check(store) {
  running.add(store.id);
  try {
    // Sitemap-butiker läser några få produktsidor per varv i stället för 25 åt gången.
    const res = await engine.scrape(store, { pagesPerRun: 8, sitemapMaxAge: SITEMAP_MAX_AGE });
    const calm = res.ok && res.delay > 3000;
    const interval = res.blocked ? BLOCKED : !res.ok ? Math.max(RETRY, res.retryAfter * 1000) : calm ? CALM : BASE;
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

console.log(`${clock()} Bevakar ${stores.length} butiker. Varannan minut som standard, var ${CALM / MIN}:e minut för butiker som vill ta det lugnare. Ctrl+C avslutar.`);
setInterval(tick, 1000);
setInterval(flush, SAVE_EVERY);
tick();
