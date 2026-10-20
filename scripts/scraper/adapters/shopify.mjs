// Shopify-butiker publicerar sin katalog som JSON på /products.json (samma data som visas i butiken).
// Jättebutiker (över maxPages × 250 produkter) läses i stället via sina Pokémon-kollektioner.
import { generic } from "./generic.mjs";

// Kollektioner som bara innehåller sådant vi ändå inte bevakar: graderat, lösa kort, figurer, tillbehör.
const SKIP_COLLECTION = /slab|psa|grad|single|lösa|losa|plush|gosedjur|figur|sleeve|binder|pärm|parm|playmat|tillbeh|accessor|mystery/i;

function toItem(host, p) {
  const variants = p.variants || [];
  const avail = variants.filter((v) => v.available);
  const pick = (avail.length ? avail : variants).reduce((a, v) => (!a || +v.price < +a.price ? v : a), null);
  if (!pick) return null;
  return {
    pid: String(p.id),
    title: p.title,
    url: `${host.origin}/products/${p.handle}`,
    price: +pick.price,
    currency: "SEK",
    available: avail.length > 0,
    preorder: /förbeställ|pre-?order|preorder/i.test(`${p.title} ${(p.tags || []).join(" ")}`),
    image: p.images?.[0]?.src || null,
  };
}

// Läser alla sidor av en products.json-lista. full = sista sidan var full, dvs. det kan finnas fler.
async function readList(host, path, maxPages, seen, items) {
  let page = 1, products = [];
  for (; page <= maxPages; page++) {
    ({ products = [] } = await host.get(`${path}?limit=250&page=${page}`, { type: "json" }));
    for (const p of products) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const it = toItem(host, p);
      if (it) items.push(it);
    }
    if (products.length < 250) break;
  }
  return { full: page > maxPages && products.length === 250 };
}

async function pokemonCollections(host) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const { collections = [] } = await host.get(`/collections.json?limit=250&page=${page}`, { type: "json" });
    all.push(...collections);
    if (collections.length < 250) break;
  }
  return all.filter((c) => /pok[eé]mon/i.test(`${c.handle} ${c.title}`) && !SKIP_COLLECTION.test(c.handle) && c.products_count !== 0
    && host.allowed(`/collections/${c.handle}/products.json?limit=250&page=1`));
}

export async function shopify(host, ctx) {
  if (!host.allowed("/products.json?limit=250&page=1")) return generic(host, ctx);
  const items = [], seen = new Set();
  // Jättebutik sedan tidigare: läs bara Pokémon-kollektionerna.
  if (ctx.state?.collections) {
    const cols = await pokemonCollections(host).catch(() => []);
    if (cols.length) {
      for (const c of cols) await readList(host, `/collections/${c.handle}/products.json`, ctx.maxPages, seen, items);
      return items;
    }
    delete ctx.state.collections; // inga kollektioner längre: läs hela katalogen som vanligt
  }
  try {
    const { full } = await readList(host, "/products.json", ctx.maxPages, seen, items);
    // Hela katalogen gick inte att läsa till slut: byt till kollektionerna från och med nästa varv,
    // och läs dem redan nu så att inget fattas den här gången heller.
    if (full && ctx.state) {
      const cols = await pokemonCollections(host).catch(() => []);
      if (cols.length) {
        ctx.state.collections = true;
        for (const c of cols) await readList(host, `/collections/${c.handle}/products.json`, ctx.maxPages, seen, items);
      }
    }
  } catch (e) {
    // Vissa butiker stänger flödet (401/403/404). Då läser vi produktsidorna via sitemapen i stället.
    if (!items.length && [401, 403, 404].includes(e.status)) return generic(host, ctx);
    throw e;
  }
  return items;
}
