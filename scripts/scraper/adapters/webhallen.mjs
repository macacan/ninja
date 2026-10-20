// Webhallen bygger sidorna med JavaScript, så HTML:en saknar produktdata. Vi läser i stället butikens öppna
// API för kategorisidan "Pokémonkort TCG" (category i stores.json), som robots.txt tillåter. Det ger namn,
// pris, lager och släppdatum för 24 produkter per anrop, så hela kategorin (cirka 55 produkter) tar tre anrop.
// Bara den kategorin bevakas: gosedjur, spel och tillbehör i resten av butiken kommer aldrig med.
const PER_PAGE = 24;

// Webhallens egen adressform: /se/product/{id}-{namn med bindestreck}. Butiken hittar produkten på id:t.
const slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function webhallen(host, ctx) {
  if (!ctx.category) throw new Error("category saknas i stores.json");
  const s = ctx.state;
  // Första läsningen med kategori-API:et är tyst: produkterna har funnits i butiken länge och ska inte larmas
  // som nya (se quiet i engine.mjs). Därefter är en okänd produkt i kategorin en ny produkt.
  const first = !s.catalog;
  const items = [];
  let total = Infinity, read = 0;
  for (let page = 1; page <= ctx.maxPages && read < total; page++) {
    const j = await host.get(`/api/productdiscovery/category/${ctx.category}?page=${page}&touchpoint=DESKTOP&totalProductCountSet=false`, { type: "json" });
    const list = j.products || [];
    if (Number.isFinite(j.totalProductCount)) total = j.totalProductCount;
    read += list.length;
    for (const p of list) {
      if (!p?.id || !p.name || !p.price?.price) continue;
      const release = (p.release?.timestamp || 0) * 1000;
      items.push({
        pid: String(p.id),
        title: p.name,
        url: `${host.origin}/se/product/${p.id}-${slug(p.name)}`,
        price: Number(p.price.price),
        currency: p.price.currency || "SEK",
        available: (p.stock?.web || 0) > 0,
        preorder: release > Date.now(),
        image: p.image ? new URL(p.image, host.origin).href : null,
        isNew: !first,
      });
    }
    if (list.length < PER_PAGE) break;
  }
  if (!items.length) throw new Error("kategorin gav inga produkter");
  // Minnet från den gamla sitemap-läsningen behövs inte längre.
  delete s.known; delete s.knownAt; delete s.pages; delete s.fresh;
  s.catalog = true;
  if (first) items.quiet = true;
  return items;
}
