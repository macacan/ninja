// WooCommerce har ett publikt Store API för butikens egen frontend: /wp-json/wc/store/v1/products.
import { generic } from "./generic.mjs";

export async function woocommerce(host, ctx) {
  const path = (page) => `/wp-json/wc/store/v1/products?per_page=100&page=${page}&search=pokemon`;
  if (!host.allowed(path(1))) return generic(host, ctx);
  const items = [];
  try {
    for (let page = 1; page <= ctx.maxPages; page++) {
      const list = await host.get(path(page), { type: "json" });
      for (const p of list) {
        const minor = p.prices?.currency_minor_unit ?? 2;
        items.push({
          pid: String(p.id),
          title: p.name?.replace(/&#8211;/g, "–").replace(/&amp;/g, "&"),
          url: p.permalink,
          price: Number(p.prices?.price) / 10 ** minor,
          currency: p.prices?.currency_code || "SEK",
          available: !!p.is_in_stock,
          preorder: !!p.is_on_backorder || /förbeställ|pre-?order/i.test(p.name || ""),
          image: p.images?.[0]?.src || null,
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
