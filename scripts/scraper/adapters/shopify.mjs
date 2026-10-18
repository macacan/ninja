// Shopify-butiker publicerar sin katalog som JSON på /products.json (samma data som visas i butiken).
import { generic } from "./generic.mjs";

export async function shopify(host, ctx) {
  if (!host.allowed("/products.json?limit=250&page=1")) return generic(host, ctx);
  const items = [];
  for (let page = 1; page <= ctx.maxPages; page++) {
    let products;
    try {
      ({ products = [] } = await host.get(`/products.json?limit=250&page=${page}`, { type: "json" }));
    } catch (e) {
      // Vissa butiker stänger flödet (401/403/404). Då läser vi produktsidorna via sitemapen i stället.
      if (page === 1 && [401, 403, 404].includes(e.status)) return generic(host, ctx);
      throw e;
    }
    for (const p of products) {
      const variants = p.variants || [];
      const avail = variants.filter((v) => v.available);
      const pick = (avail.length ? avail : variants).reduce((a, v) => (!a || +v.price < +a.price ? v : a), null);
      if (!pick) continue;
      items.push({
        pid: String(p.id),
        title: p.title,
        url: `${host.origin}/products/${p.handle}`,
        price: +pick.price,
        currency: "SEK",
        available: avail.length > 0,
        preorder: /förbeställ|pre-?order|preorder/i.test(`${p.title} ${(p.tags || []).join(" ")}`),
        image: p.images?.[0]?.src || null,
      });
    }
    if (products.length < 250) break;
  }
  return items;
}
