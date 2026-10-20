// Packninjas butiksbevakning, en körning över alla butiker (passar schemalagda jobb som GitHub Actions).
//   node scripts/scraper/run.mjs                 alla butiker med tillåten status
//   node scripts/scraper/run.mjs --only=swepoke  bara vissa butiker (kommaseparerat id)
//   SCRAPE_STATUSES=tillstand node ...           bara butiker som gett skriftligt tillstånd
// För löpande bevakning var tionde minut, använd daemon.mjs i stället.
import { createEngine } from "./lib/engine.mjs";

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const CONCURRENCY = 4;

const engine = await createEngine();
const queue = engine.allowed.filter((s) => !only || only.includes(s.id));
const events = [];
let ok = 0, total = 0;

// Några butiker parallellt, men aldrig mer än en förfrågan åt gången per butik (det sköter Host).
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const store = queue.shift();
    const res = await engine.scrape(store);
    events.push(...engine.apply(store, res));
    total++;
    if (res.ok) { ok++; console.log(`✓ ${store.name}: ${res.products.length} produkter (${res.requests} anrop, ${Math.round(res.ms / 1000)} s)`); }
    else console.warn(`✗ ${store.name}: ${res.error}`);
  }
}));

const count = await engine.save();
await engine.notify(events);
console.log(`\nKlart: ${count} produkter, ${events.length} nya händelser, ${ok}/${total} butiker ok.`);
