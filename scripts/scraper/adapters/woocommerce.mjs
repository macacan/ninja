// WooCommerce har ett publikt Store API för butikens egen frontend: /wp-json/wc/store/v1/products.
import { generic } from "./generic.mjs";

export async function woocommerce(host, ctx) {
  const API = "/wp-json/wc/store/v1/products";
  if (!host.allowed(`${API}?per_page=100&page=1`)) return generic(host, ctx);
  const items = [];
  try {
    // Butikens Pokémon-, One Piece- och Riftbound-kategorier om de finns. Annars sök på "pokemon", "one piece" och "riftbound", vilket
    // missar t.ex. japanska produkter som bara heter "Triplet Beat (SV1a)".
    let filters = ["&search=pokemon", "&search=riftbound", "&search=one+piece"];
    try {
      const cats = await host.get(`${API}/categories?per_page=100`, { type: "json" });
      const ids = (Array.isArray(cats) ? cats : []).filter((c) => /pok[eé]mon|riftbound|one[- ]piece/i.test(`${c.name} ${c.slug}`)).map((c) => c.id);
      if (ids.length) filters = [`&category=${ids.join(",")}`];
    } catch {}
    const seen = new Set();
    for (const filter of filters) for (let page = 1; page <= ctx.maxPages; page++) {
      const path = `${API}?per_page=100&page=${page}${filter}`;
      const list = await host.get(path, { type: "json" });
      for (const p of list) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const minor = p.prices?.currency_minor_unit ?? 2;
        items.push({
          pid: String(p.id),
          // HTML-tecken i namnet: &amp;, &#038; (&), &#8211; (–), &#8217; (’) osv.
          title: p.name?.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
          url: p.permalink,
          price: Number(p.prices?.price) / 10 ** minor,
          currency: p.prices?.currency_code || "SEK",
          available: !!p.is_in_stock,
          preorder: !!p.is_on_backorder || /förbeställ|pre-?order/i.test(p.name || ""),
          image: p.images?.[0]?.src || null,
          // Språket står ofta bara i kategorier, taggar eller adress.
          hint: [p.slug, ...(p.categories || []).map((c) => `${c.name} ${c.slug}`), ...(p.tags || []).map((t) => `${t.name} ${t.slug}`)].filter(Boolean).join(" | "),
        });
      }
      if (list.length < 100) break;
    }
  } catch (e) {
    // Vissa butiker stänger av Store API. Då läser vi produktsidorna i stället.
    if (e.status === 404 || e.status === 401 || e.status === 403) return generic(host, ctx);
    throw e;
  }
  return items;
}
