// Hämtar butikernas ikoner (apple-touch-icon eller favicon) till img/stores/ och skriver data/store-logos.json.
// Körs för hand när en butik läggs till eller byter logga: node scripts/update-store-logos.mjs [butiks-id …]
// Samma artighet som bevakningen: robots.txt följs, boten säger vem den är och samma butik får aldrig två
// anrop samtidigt. Butiker som förbjuder insamling eller inte är kontrollerade kontaktas inte (se SERVICES).
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { Host, UA } from "./scraper/lib/http.mjs";

const root = new URL("../", import.meta.url);
const OUT = new URL("img/stores/", root);
const MAX_BYTES = 512 * 1024;
const TYPES = { "image/png": "png", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/svg+xml": "svg", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

const { stores } = JSON.parse(await readFile(new URL("scripts/scraper/stores.json", root), "utf8"));
const only = process.argv.slice(2);
const logos = JSON.parse(await readFile(new URL("data/store-logos.json", root), "utf8").catch(() => "{}"));
await mkdir(OUT, { recursive: true });

// Ikonlänkar i sidans <head>, bäst först: apple-touch-icon (stor och fyrkantig), sedan största ikonen, sist /favicon.ico.
function candidates(html, base) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => {
    const attr = (n) => tag.match(new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] || "";
    return { rel: attr("rel").toLowerCase(), href: attr("href"), size: Math.max(0, ...attr("sizes").split(/\s+/).map((s) => parseInt(s, 10) || 0)) };
  }).filter((l) => l.href && /(^|\s)(icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(l.rel));
  const score = (l) => (l.rel.includes("apple-touch-icon") ? 1000 : 0) + (l.size || (/\.svg(\?|$)/i.test(l.href) ? 512 : 16));
  const urls = links.sort((a, b) => score(b) - score(a)).map((l) => new URL(l.href.replace(/&amp;/g, "&"), base).href);
  return [...new Set([...urls, new URL("/favicon.ico", base).href])].filter((u) => /^https?:/.test(u));
}

// Bilden som binärdata. Bara riktiga bildtyper och högst MAX_BYTES.
async function image(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "image/*" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status}`);
  const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = TYPES[type] || (type === "" || type === "application/octet-stream" ? url.match(/\.(png|ico|svg|jpe?g|webp|gif)(\?|$)/i)?.[1].toLowerCase().replace("jpeg", "jpg") : null);
  if (!ext) throw new Error(`inte en bild (${type})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES || buf.length < 64) throw new Error(`fel storlek (${buf.length} byte)`);
  if (ext === "svg" && !/<svg[\s>]/i.test(buf.toString("utf8", 0, 2000))) throw new Error("trasig svg");
  return { buf, ext };
}

// Butiker som inte får bevakas kontaktas aldrig. Deras ikon (och ikonen för butiker där vi inte hittar någon)
// hämtas i stället från publika faviconregister, som redan har sparat den.
const SERVICES = [
  (d) => `https://icons.duckduckgo.com/ip3/${d}.ico`,
  (d) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`,
];
const mayContact = (s) => !["forbjuden", "okand"].includes(s.status);

async function logoFor(store) {
  if (mayContact(store)) {
    try {
      const host = await new Host(store.domain).init();
      const html = await host.get("/");
      for (const url of candidates(html, host.origin)) {
        // Ikoner på butikens egen domän kontrolleras mot robots.txt. CDN-adresser (t.ex. Shopify) är statiska filer.
        if (new URL(url).host === new URL(host.origin).host && !host.allowed(url)) continue;
        try { return await image(url); } catch {}
      }
    } catch {}
  }
  // Registren svarar 404 när de saknar en ikon, så image() kastar och nästa register prövas.
  for (const service of SERVICES) { try { return await image(service(store.domain)); } catch {} }
  throw new Error("ingen ikon hittades");
}

const todo = stores.filter((s) => !only.length || only.includes(s.id));
let ok = 0;
await Promise.all(todo.map(async (s) => {
  try {
    const { buf, ext } = await logoFor(s);
    for (const old of Object.values(TYPES)) if (old !== ext) await rm(new URL(`${s.id}.${old}`, OUT), { force: true });
    await writeFile(new URL(`${s.id}.${ext}`, OUT), buf);
    logos[s.id] = `img/stores/${s.id}.${ext}`;
    ok++;
    console.log(`${s.name}: ${ext}, ${Math.round(buf.length / 1024)} kB`);
  } catch (e) {
    console.log(`${s.name}: ${e.message}`);
  }
}));
// Butiker som tagits bort ur listan tappar sin logga.
for (const id of Object.keys(logos)) if (!stores.some((s) => s.id === id)) delete logos[id];
await writeFile(new URL("data/store-logos.json", root), JSON.stringify(Object.fromEntries(Object.entries(logos).sort()), null, 1) + "\n");
console.log(`\nKlart: ${ok}/${todo.length} loggor.`);
