// Verktyg för AI-agenter i webbläsaren (WebMCP, navigator.modelContext). Bara webbläsare med WebMCP har
// navigator.modelContext, för alla andra gör filen ingenting. Verktygen läser samma data som sidan själv.
import { liveStock, upcomingReleases } from "./site.js";
import { gameSuggestions } from "./game-guess.js";

const GAMES = { pokemon: "Pokémon", op: "One Piece", rb: "Riftbound" };
const fold = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const reply = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const abs = (path) => new URL(path, location.origin + "/").href;

// Pokémon: kort ur TCGdex med Cardmarkets trendpris omräknat till kronor. One Piece och Riftbound: Lootninjas egna kortlistor.
async function cardPrice({ query, game = "pokemon" }) {
  const page = abs(`priser.html?q=${encodeURIComponent(query)}&game=${game}`);
  if (game !== "pokemon") {
    const s = await gameSuggestions(game, query, 8);
    return { game: GAMES[game], page, cards: (s?.pokemon || []).map((c) => ({ name: c.name, info: c.sub })) };
  }
  const [list, rate] = await Promise.all([
    fetch(`https://api.tcgdex.net/v2/en/cards?name=${encodeURIComponent(query)}`).then((r) => r.json()),
    fetch("https://api.frankfurter.dev/v1/latest?from=EUR&to=SEK").then((r) => r.json()).then((d) => d.rates.SEK).catch(() => 11.2),
  ]);
  const cards = await Promise.all((list || []).slice(0, 8).map(async (c) => {
    const full = await fetch(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(c.id)}`).then((r) => r.json()).catch(() => null);
    const eur = full?.pricing?.cardmarket?.trend ?? full?.pricing?.cardmarket?.avg ?? null;
    return { name: c.name, id: c.id, set: full?.set?.name || null, number: c.localId, priceSek: eur == null ? null : Math.round(eur * rate) };
  }));
  return { game: GAMES.pokemon, page, source: "Cardmarket trendpris via TCGdex, omräknat till SEK", cards };
}

async function searchProducts({ query = "", game, inStockOnly = true, limit = 15 }) {
  const [p, s] = await liveStock();
  const names = Object.fromEntries((s.stores || []).map((x) => [x.id, x.name]));
  const words = fold(query).split(/\s+/).filter(Boolean);
  const hits = (p.products || [])
    .filter((x) => (!game || (x.game || "pokemon").replace(/^pk$/, "pokemon") === game)
      && (!inStockOnly || x.available || x.preorder)
      && words.every((w) => fold(x.title).includes(w)))
    .sort((a, b) => !!b.available - !!a.available || a.price - b.price)
    .slice(0, Math.min(limit, 50));
  return { count: hits.length, products: hits.map((x) => ({
    title: x.title, store: names[x.store] || x.store, priceSek: x.price,
    status: x.available ? "i lager" : x.preorder ? "förbeställning" : "slut", url: x.url,
  })) };
}

async function releases({ game, limit = 10 }) {
  const list = (await upcomingReleases()).filter((r) => !game || (r.game || "pokemon") === game).slice(0, Math.min(limit, 40));
  return { releases: list.map((r) => ({ name: r.name, date: r.date, game: GAMES[r.game || "pokemon"], type: r.type, language: r.language, note: r.note || undefined })) };
}

const gameParam = { type: "string", enum: Object.keys(GAMES), description: "pokemon (Pokémon TCG), op (One Piece Card Game) eller rb (Riftbound)" };
const TOOLS = [
  { name: "card_price", description: "Ungefärligt värde i kronor för ett samlarkort (Pokémon, One Piece eller Riftbound) efter kortnamn.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Kortnamn, t.ex. Charizard, Luffy eller Jinx" }, game: gameParam }, required: ["query"] },
    execute: cardPrice },
  { name: "search_products", description: "Söker förseglade produkter (booster boxar, Elite Trainer Boxes, booster packs) i svenska butiker, med pris och lagerstatus.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Sökord i produktnamnet, t.ex. 'Ascended Heroes booster box'" }, game: gameParam,
      inStockOnly: { type: "boolean", description: "Bara produkter i lager eller som går att förbeställa (standard: true)" },
      limit: { type: "integer", minimum: 1, maximum: 50 } } },
    execute: searchProducts },
  { name: "upcoming_releases", description: "Kommande släpp av set och produkter, närmast först.",
    inputSchema: { type: "object", properties: { game: gameParam, limit: { type: "integer", minimum: 1, maximum: 40 } } },
    execute: releases },
];

const mc = navigator.modelContext;
if (mc?.registerTool) {
  for (const t of TOOLS) {
    try {
      mc.registerTool({ ...t, annotations: { readOnlyHint: true }, execute: async (args = {}) => reply(await t.execute(args)) });
    } catch { /* redan registrerat eller ett äldre API */ }
  }
}
