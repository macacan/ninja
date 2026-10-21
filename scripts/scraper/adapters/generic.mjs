// För plattformar utan öppet produktflöde: hitta produktsidor via butikens sitemap (eller via en
// kategorisida, se listingUrls) och läs schema.org/Product-data (JSON-LD) som butiken lägger ut för sökmotorer.
import { looksPokemonTitle } from "../lib/classify.mjs";

// Bild kan vara en adress, en lista eller ett schema.org-ImageObject (url/contentUrl). Görs alltid till en hel adress.
function imageUrl(v, base) {
  const first = [].concat(v || [])[0];
  const raw = typeof first === "string" ? first : first?.url || first?.contentUrl || first?.thumbnailUrl || null;
  if (!raw || typeof raw !== "string") return null;
  try { return new URL(raw.trim(), base).href; } catch { return null; }
}
const ogImage = (html) => html.match(/<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)/i)?.[1] || null;

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

// Språkversioner av samma sida (/da/produkt/x, /en/produkt/x, /en-gb/…) är samma produkt.
// Finns versionen utan språkprefix behålls bara den, annars den första språkversionen vi ser.
const LOCALE = /^\/([a-z]{2}(?:[-_][a-z]{2})?)(?=\/)/i;
export function dropLocaleCopies(urls) {
  const key = (u) => { try { const x = new URL(u); return x.host + x.pathname.replace(LOCALE, "").replace(/\/$/, ""); } catch { return u; } };
  const path = (u) => { try { return new URL(u).pathname; } catch { return ""; } };
  const best = new Map();
  for (const u of urls) {
    const k = key(u), plain = !LOCALE.test(path(u));
    if (!best.has(k) || (plain && LOCALE.test(path(best.get(k))))) best.set(k, u);
  }
  const keep = new Set(best.values());
  return urls.filter((u) => keep.has(u));
}

async function sitemapUrls(host, ctx) {
  const queue = host.robots.sitemaps.length ? [...host.robots.sitemaps] : [`${host.origin}/sitemap.xml`];
  const seen = new Set(), pages = [];
  let firstError = null;
  while (queue.length && seen.size < 15) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    let xml;
    try { xml = await host.get(sm); } catch (e) { if (e.blocked) throw e; firstError ||= e; continue; }
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[\s*)?([^<\s\]]+)\s*(?:\]\]>\s*)?<\/loc>/g)].map((m) => decode(m[1]));
    if (/<sitemapindex/i.test(xml)) {
      // Produktsitemaps först, sidor och bloggar sist.
      queue.push(...locs.sort((a, b) => /product/i.test(b) - /product/i.test(a)));
    } else {
      pages.push(...locs);
    }
  }
  // Ingen sitemap gick att läsa: visa felet i stället för att rapportera en tom butik som lyckad.
  if (!pages.length && firstError) throw firstError;
  // Stora butiker: bara URL:er som nämner Pokémon. Små butiker: allt, och titeln avgör sedan.
  const allowed = dropLocaleCopies([...new Set(pages)]).filter((u) => host.allowed(u));
  const slug = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/[-_/]+/g, " "); } catch { return u; } };
  const poke = allowed.filter((u) => looksPokemonTitle(slug(u), ctx.setNames, { strict: true }));
  return allowed.length > ctx.maxSitemapUrls ? poke : allowed;
}

// Bara sökvägen i adressen, inte domänen: en butik som heter något med "japan" säljer inte bara japanskt.
const pathOf = (u) => { try { return decodeURIComponent(new URL(u).pathname); } catch { return ""; } };

// Microdata (itemprop="price" osv.), som bl.a. Quickbutik använder.
function parseMicrodata(html, url) {
  const prop = (name) => {
    const m = html.match(new RegExp(`itemprop=["']${name}["'][^>]*?(?:content|href)=["']([^"']*)`, "i"))
      || html.match(new RegExp(`(?:content|href)=["']([^"']*)["'][^>]*itemprop=["']${name}["']`, "i"));
    return m ? decode(m[1]) : null;
  };
  const price = prop("price");
  if (price == null) return null;
  const title = prop("name") || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "").trim()
    || html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i)?.[1];
  const availability = prop("availability") || "";
  return {
    title: decode(title || ""), url, price: Number(String(price).replace(/\s/g, "").replace(",", ".")),
    currency: prop("priceCurrency") || "SEK",
    available: /InStock|LimitedAvailability|OnlineOnly/i.test(availability),
    preorder: /PreOrder|PreSale|BackOrder/i.test(availability),
    image: imageUrl(prop("image"), url) || imageUrl(ogImage(html), url),
    hint: pathOf(url),
  };
}

function* walk(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
  yield node;
  for (const k of ["@graph", "mainEntity", "itemListElement", "item"]) if (node[k]) yield* walk(node[k]);
}

export function parseProductPage(html, url) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    for (const n of walk(data)) {
      const t = [].concat(n["@type"] || []);
      if (!t.includes("Product")) continue;
      const offers = [].concat(n.offers || []).flatMap((o) => (o["@type"] === "AggregateOffer" && o.offers ? [].concat(o.offers) : [o]));
      const o = offers.find((x) => /InStock/i.test(x.availability || "")) || offers[0];
      if (!o) continue;
      const availability = String(o.availability || "");
      return {
        title: decode(String(n.name || "")),
        url: n.url || url,
        price: Number(o.price ?? o.lowPrice),
        currency: o.priceCurrency || "SEK",
        available: /InStock|LimitedAvailability|OnlineOnly/i.test(availability),
        preorder: /PreOrder|PreSale|BackOrder/i.test(availability),
        image: imageUrl(n.image, url) || imageUrl(ogImage(html), url),
        // Adress och kategori, för språket när titeln inte säger något.
        hint: [pathOf(url), pathOf(n.url), [].concat(n.category || []).join(" ")].filter(Boolean).join(" | "),
      };
    }
  }
  const micro = parseMicrodata(html, url);
  if (micro) return micro;
  // Reserv: Open Graph-taggar för produkter.
  const meta = (p) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)`, "i"))?.[1];
  const price = meta("product:price:amount") || meta("og:price:amount");
  if (!price) return null;
  return {
    title: decode(meta("og:title") || ""), url, price: Number(price.replace(",", ".")),
    currency: meta("product:price:currency") || "SEK",
    available: !/out ?of ?stock|oos|slut/i.test(meta("product:availability") || meta("og:availability") || "instock"),
    preorder: /preorder|pre-order/i.test(meta("product:availability") || ""),
    image: imageUrl(meta("og:image"), url),
    hint: pathOf(url),
  };
}

const WEEK = 7 * 864e5;
const POKE = /pok[eé]mon/i;

// Butiker utan sitemap: produktlänkar från en kategorisida, sida för sida.
// listing = { path: "/kategori/pokemon?page={n}", link: "^/produkt/", pages: 10 } i stores.json.
async function listingUrls(host, listing) {
  const re = new RegExp(listing.link);
  const urls = [];
  for (let n = 1; n <= (listing.pages || 10); n++) {
    const path = listing.path.replace("{n}", n);
    let html;
    try { html = await host.get(path); } catch (e) { if (n === 1) throw e; break; }
    const found = [...html.matchAll(/href=["']([^"'#]+)["']/g)].map((m) => decode(m[1]))
      .filter((h) => re.test(h)).map((h) => { try { return new URL(h, host.origin).href; } catch { return null; } })
      .filter((u) => u && host.allowed(u));
    const fresh = found.filter((u) => !urls.includes(u));
    // Inga produktlänkar alls på första sidan: butiken har bytt utseende eller visar oss en annan sida.
    if (!fresh.length && n === 1) throw new Error(`kategorisidan ${path} har inga produktlänkar (${html.length} tecken)`);
    if (!fresh.length) break; // sidan visade inget nytt: slut på listan
    urls.push(...new Set(fresh));
    if (!listing.path.includes("{n}")) break;
  }
  return urls;
}

export async function generic(host, ctx) {
  // Sitemapen ändras sällan. I bevakningsläget läses den om högst var 30:e minut (sitemapMaxAge).
  const s = ctx.state;
  const reuse = s.known && s.knownAt && Date.now() - s.knownAt < (ctx.sitemapMaxAge || 0);
  const urls = dropLocaleCopies(reuse ? s.known
    : ctx.listing ? await listingUrls(host, ctx.listing)
    : await sitemapUrls(host, { maxSitemapUrls: 3000, ...ctx }));
  if (!urls.length) throw new Error(ctx.listing ? "kategorisidan gav inga produkter" : "sitemapen gav inga produktsidor");
  if (!reuse) {
    // En produkt räknas som ny i butiken bara om dess URL inte fanns i sitemapen förra gången.
    // De nya URL:erna sparas tills vi hunnit läsa dem, även om det dröjer några varv.
    if (s.known) { const before = new Set(s.known); s.fresh = [...new Set([...(s.fresh || []), ...urls.filter((u) => !before.has(u))])]; }
    s.known = urls;
    s.knownAt = Date.now();
  }
  const fresh = new Set(s.fresh || []);
  // Minne per sida: när den lästes och om den var en Pokémon-produkt ("p") eller inte ("x").
  const seen = ctx.state.pages ||= {};
  for (const [u, v] of Object.entries(seen)) if (typeof v === "number") seen[u] = { t: v, k: "p" };
  const now = Date.now();
  // Turordning: olästa Pokémon-URL:er, olästa övriga, kända produkter (äldst först). Sidor som inte var
  // Pokémon-produkter läses om tidigast efter en vecka (eller direkt när klassningen ändrats, se engine.mjs).
  const rank = (u) => {
    if (fresh.has(u)) return -1; // nya produkter i sitemapen läses allra först
    const s = seen[u];
    if (!s) return POKE.test(decodeURIComponent(u)) ? 0 : 1;
    if (s.k === "x") return now - s.t > WEEK ? 3 : Infinity;
    return 2;
  };
  const byRank = (a, b) => rank(a) - rank(b) || (seen[a]?.t || 0) - (seen[b]?.t || 0);
  const main = urls.filter((u) => rank(u) <= 2).sort(byRank);
  const recheck = urls.filter((u) => rank(u) === 3).sort(byRank);
  // Upp till 40 % av varvet går till att läsa om avvisade sidor, så att de inte trängs undan av kända
  // produkter för alltid. Räcker inte den ena listan fylls varvet på från den andra.
  const share = Math.min(recheck.length, Math.ceil(ctx.pagesPerRun * 0.4));
  const take = Math.min(main.length, ctx.pagesPerRun - share);
  const batch = [...main.slice(0, take), ...recheck.slice(0, ctx.pagesPerRun - take)];
  const items = [];
  let stopped = false;
  for (const u of batch) {
    let p;
    // readProduct: butiker vars sidor byggs med JavaScript läser produkten från butikens eget API i stället.
    try { p = ctx.readProduct ? await ctx.readProduct(host, u) : parseProductPage(await host.get(u), u); }
    catch (e) {
      if (e.robots) continue;
      if (e.status === 404 || e.status === 410) { delete seen[u]; continue; }
      // Botskydd, eller fel innan vi läst något alls: hela kontrollen räknas som misslyckad.
      if (e.blocked || !items.length) throw e;
      // Annars (nätfel, 5xx, 429) avbryts varvet men det vi redan läst sparas. Resten läses nästa varv.
      stopped = true;
      break;
    }
    const ok = p && p.title && Number.isFinite(p.price) && looksPokemonTitle(p.title, ctx.setNames);
    // En känd produktsida som plötsligt saknar produktdata (tillfälligt fel hos butiken) parkeras inte en vecka
    // direkt: den läses om nästa varv och räknas som avvisad först efter tre missar i rad.
    const miss = !p && seen[u]?.k === "p" ? (seen[u].miss || 0) + 1 : 0;
    seen[u] = miss && miss < 3 ? { t: Date.now(), k: "p", miss } : { t: Date.now(), k: ok ? "p" : "x" };
    if (ok) items.push({ pid: u, ...p, isNew: fresh.has(u) });
    if (fresh.has(u)) s.fresh = (s.fresh || []).filter((x) => x !== u);
  }
  // Produkter vi inte hann läsa om den här gången behåller sitt senaste kända läge.
  return Object.assign(items, { partial: stopped || urls.length > batch.length, known: new Set(urls) });
}
