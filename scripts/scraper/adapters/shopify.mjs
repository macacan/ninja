// Shopify-butiker publicerar sin katalog som JSON på /products.json (samma data som visas i butiken).
// Jättebutiker (över maxPages × 250 produkter) läses i stället via sina Pokémon- och Riftbound-kollektioner.
import { generic } from "./generic.mjs";

// Butiker med Shopify Markets visar priset i besökarens valuta. GitHub Actions kör från USA och fick
// därför dollarpriser som sparades som kronor (1999 kr blev 207). Vi ber alltid uttryckligen om svenska priser.
const SEK = "&currency=SEK&country=SE";

// Kollektioner som bara innehåller sådant vi ändå inte bevakar: graderat, lösa kort, figurer, tillbehör.
const SKIP_COLLECTION = /slab|psa|grad|single|lösa|losa|plush|gosedjur|figur|sleeve|binder|pärm|parm|playmat|tillbeh|accessor|mystery/i;

function toItem(host, p, ctx) {
  const variants = p.variants || [];
  const avail = variants.filter((v) => v.available);
  const pick = (avail.length ? avail : variants).reduce((a, v) => (!a || +v.price < +a.price ? v : a), null);
  if (!pick) return null;
  const multi = variants.length > 1 && pick.title && pick.title.toLowerCase() !== "default title";
  const title = multi ? `${p.title} (${pick.title})` : p.title;
  const baseUrl = ctx.productUrl ? ctx.productUrl(p.handle) : `${host.origin}/products/${p.handle}`;
  const url = variants.length > 1 && pick.id ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}variant=${pick.id}` : baseUrl;
  return {
    pid: String(p.id),
    title,
    url,
    price: +pick.price,
    currency: "SEK",
    available: avail.length > 0,
    preorder: /förbeställ|pre-?order|preorder/i.test(`${title} ${(p.tags || []).join(" ")}`),
    image: pick.featured_image?.src || p.images?.[0]?.src || null,
    // Språket står ofta bara i taggar, produkttyp eller adress ("japanese", "pokemon-kinesiska").
    hint: [p.handle, p.product_type, ...[].concat(p.tags || [])].filter(Boolean).join(" | "),
  };
}

// Läser alla sidor av en products.json-lista. full = sista sidan var full, dvs. det kan finnas fler.
async function readList(host, path, ctx, seen, items) {
  let page = 1, products = [];
  for (; page <= ctx.maxPages; page++) {
    ({ products = [] } = await host.get(`${path}?limit=250&page=${page}${SEK}`, { type: "json" }));
    for (const p of products) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const it = toItem(host, p, ctx);
      if (it) items.push(it);
    }
    if (products.length < 250) break;
  }
  return { full: page > ctx.maxPages && products.length === 250 };
}

async function pokemonCollections(host) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const { collections = [] } = await host.get(`/collections.json?limit=250&page=${page}`, { type: "json" });
    all.push(...collections);
    if (collections.length < 250) break;
  }
  return all.filter((c) => /pok[eé]mon|riftbound/i.test(`${c.handle} ${c.title}`) && !SKIP_COLLECTION.test(c.handle) && c.products_count !== 0
    && host.allowed(`/collections/${c.handle}/products.json?limit=250&page=1${SEK}`));
}

export async function shopify(host, ctx) {
  if (!host.allowed(`/products.json?limit=250&page=1${SEK}`)) return generic(host, ctx);
  const items = [], seen = new Set();
  // Jättebutik sedan tidigare: läs bara Pokémon-kollektionerna.
  if (ctx.state?.collections) {
    const cols = await pokemonCollections(host).catch(() => []);
    if (cols.length) {
      for (const c of cols) await readList(host, `/collections/${c.handle}/products.json`, ctx, seen, items);
      return items;
    }
    delete ctx.state.collections; // inga kollektioner längre: läs hela katalogen som vanligt
  }
  try {
    const { full } = await readList(host, "/products.json", ctx, seen, items);
    // Hela katalogen gick inte att läsa till slut: byt till kollektionerna från och med nästa varv,
    // och läs dem redan nu så att inget fattas den här gången heller.
    if (full && ctx.state) {
      const cols = await pokemonCollections(host).catch(() => []);
      if (cols.length) {
        ctx.state.collections = true;
        for (const c of cols) await readList(host, `/collections/${c.handle}/products.json`, ctx, seen, items);
      }
    }
  } catch (e) {
    // Vissa butiker stänger flödet (401/403/404). Då läser vi produktsidorna via sitemapen i stället.
    if (!items.length && [401, 403, 404].includes(e.status)) return generic(host, ctx);
    throw e;
  }
  return items;
}
