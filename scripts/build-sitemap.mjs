// Bygger sitemap.xml med lastmod för varje sida. Körs med: node scripts/build-sitemap.mjs [--ping]
// En sida får dagens datum när dess HTML eller datafilerna den visar har ändrats sedan sidan senast fick ett datum.
// Fingeravtrycken sparas i scripts/sitemap-state.json och skrivs högst en gång per dag och sida, så att
// bevakningens täta commits inte ändrar sitemapen hela tiden.
// --ping: skickar sidorna som fick nytt datum till IndexNow (Bing, DuckDuckGo, Yandex m.fl.). Google har ingen
// ping längre, utan läser sitemapen själv när den är inskickad i Search Console.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const SITE = "https://lootninja.se";
// Nyckeln är publik med flit: IndexNow kontrollerar att samma nyckel ligger i /<nyckel>.txt på sidan.
const INDEXNOW_KEY = "b8d9e432225c36038641009f3d2fd24e";
const ROOT = new URL("../", import.meta.url);
const STATE = new URL("scripts/sitemap-state.json", ROOT);
const OUT = new URL("sitemap.xml", ROOT);

// Sidans adress (efter SITE/) och filerna som avgör när innehållet ändrats.
const PAGES = [
  ["", ["index.html", "data/products.json", "data/news.json", "data/release-calendar.json"]],
  ["butiker.html", ["butiker.html", "data/products.json"]],
  ["priser.html", ["priser.html", "data/card-trends.json"]],
  ["slapp.html", ["slapp.html", "data/release-calendar.json"]],
  ["vardering.html", ["vardering.html"]],
  ["nyheter.html", ["nyheter.html", "data/news.json"]],
  ["om.html", ["om.html"]],
  ["villkor.html", ["villkor.html"]],
  ["integritet.html", ["integritet.html"]],
];

const today = new Date().toISOString().slice(0, 10);
const fingerprint = async (files) => {
  const h = createHash("sha256");
  for (const f of files) h.update(f).update(await readFile(new URL(f, ROOT)).catch(() => ""));
  return h.digest("hex").slice(0, 16);
};

const state = JSON.parse(await readFile(STATE, "utf8").catch(() => "{}"));
const changed = [];
for (const [path, files] of PAGES) {
  if (state[path]?.lastmod === today) continue; // redan daterad i dag
  const hash = await fingerprint(files);
  if (state[path]?.hash === hash) continue;
  state[path] = { hash, lastmod: today };
  changed.push(`${SITE}/${path}`);
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map(([path]) => `  <url>
    <loc>${SITE}/${path}</loc>
    <lastmod>${state[path].lastmod}</lastmod>
  </url>`).join("\n")}
</urlset>
`;
await writeFile(OUT, xml);
await writeFile(STATE, JSON.stringify(Object.fromEntries(PAGES.map(([p]) => [p, state[p]])), null, 1) + "\n");
console.log(changed.length ? `Nytt datum för ${changed.length} sidor: ${changed.join(" ")}` : "Sitemapen är oförändrad.");

if (process.argv.includes("--ping") && changed.length) {
  const r = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: new URL(SITE).host, key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList: changed }),
    signal: AbortSignal.timeout(20000),
  });
  // 200 och 202 betyder mottaget. 403 betyder oftast att nyckelfilen inte ligger ute på sidan än.
  console.log(`IndexNow svarade ${r.status}`);
  if (!r.ok) process.exitCode = 1;
}
