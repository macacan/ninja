// Webhallen bygger produktsidorna med JavaScript, så HTML:en saknar produktdata. Sidan hämtar i stället
// produkten från butikens öppna API (/api/product/{id}), som robots.txt tillåter. Produktadresserna
// kommer från sitemapen som för andra butiker, och generic sköter turordningen.
import { generic } from "./generic.mjs";

async function readProduct(host, url) {
  const id = new URL(url).pathname.match(/\/product\/(\d+)/)?.[1];
  if (!id) return null;
  const { product: p } = await host.get(`/api/product/${id}`, { type: "json" });
  if (!p?.name || !p.price?.price) return null;
  const release = (p.release?.timestamp || 0) * 1000;
  return {
    title: p.name,
    url,
    price: Number(p.price.price),
    currency: p.price.currency || "SEK",
    available: (p.stock?.web || 0) > 0,
    preorder: release > Date.now(),
    image: p.images?.[0]?.large ? new URL(p.images[0].large, host.origin).href : null,
  };
}

export const webhallen = (host, ctx) => generic(host, { ...ctx, readProduct });
