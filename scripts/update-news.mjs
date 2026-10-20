// Hämtar nyheter och videor från öppna RSS-flöden och sparar dem i data/news.json.
// Körs schemalagt (se .github/workflows/news.yml) eller manuellt: node scripts/update-news.mjs
// Vi sparar bara rubrik, datum, kort utdrag och länk, och länkar alltid till källan.
import { writeFile, mkdir } from "node:fs/promises";
import { readCapped } from "./scraper/lib/http.mjs";

const UA = "PackninjaNews/1.0 (+https://github.com/; RSS-läsare)";
const OUT = new URL("../data/news.json", import.meta.url);

// Bara artiklar om samlarkort, inte om tv-spelen.
const TCG = /\b(tcg|trading card|booster|elite trainer|etb|card set|expansion|prerelease|sealed|card list|pok[eé]mon cards?|promo card|set list)\b/i;
const ARTICLE_FEEDS = [
  { source: "Dexerto", url: "https://www.dexerto.com/feed/category/pokemon/", keep: TCG },
  { source: "Wargamer", url: "https://www.wargamer.com/pokemon-trading-card-game/feed", keep: TCG },
  { source: "Game Rant", url: "https://gamerant.com/feed/tag/pokemon-tcg/", keep: /./ },
  { source: "Siliconera", url: "https://www.siliconera.com/tag/pokemon-tcg/feed/", keep: /./ },
  { source: "Polygon", url: "https://www.polygon.com/rss/pokemon/index.xml", keep: TCG },
  { source: "PokemonBlog", url: "https://www.pokemonblog.com/feed/", keep: /\b(tcg|trading card|pok[eé]mon cards?)\b/i },
];

const VIDEO_FEEDS = [
  { source: "Pokémon (officiell)", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCFctpiB_Hnlk3ejWfHqSm6Q", keep: /\b(tcg|trading card)\b/i },
  { source: "Play! Pokémon (officiell)", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCimuIKQp7_Wlk9lcoSgtaFA", keep: /\btcg\b/i },
];

const decode = (s = "") => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const tag = (xml, name) => decode((xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || "").trim();
const strip = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const iso = (s) => { const d = new Date(s); return isNaN(d) ? null : d.toISOString(); };
const excerpt = (text, n = 180) => (text.length > n ? text.slice(0, text.lastIndexOf(" ", n)) + "…" : text);

// Miniatyrbilden som flödet själv bjuder på (media:thumbnail eller enclosure), i mindre storlek.
function thumb(item) {
  const url = decode((item.match(/<media:thumbnail[^>]+url="([^"]+)"/)
    || item.match(/<media:content[^>]+url="([^"]+)"[^>]*(?:medium="image"|type="image)/)
    || item.match(/<enclosure[^>]+url="([^"]+)"[^>]+type="image/)
    || item.match(/<img[^>]+src=["']([^"']+)/) || [])[1] || "");
  return url ? url.replace(/([?&])width=\d+/, "$1width=480") : null;
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return readCapped(r, 10 * 1024 * 1024);
}
// Bara vanliga webbadresser från flödena sparas, aldrig "javascript:" eller liknande.
const webUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };

async function articles(feed) {
  const xml = await fetchText(feed.url);
  // RSS (<item>) och Atom (<entry> med <link href> och <published>, t.ex. Polygon).
  return [...xml.matchAll(/<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/g)].map(([, it]) => ({
    title: strip(tag(it, "title")),
    link: webUrl(tag(it, "link") || decode((it.match(/<link[^>]+href="([^"]+)"/) || [])[1] || "")),
    date: iso(tag(it, "pubDate") || tag(it, "published") || tag(it, "updated")),
    summary: excerpt(strip(tag(it, "description") || tag(it, "summary") || tag(it, "content"))),
    image: webUrl(thumb(it)),
    source: feed.source,
  })).filter((a) => a.title && a.link && feed.keep.test(`${a.title} ${a.summary}`));
}

async function videos(feed) {
  const xml = await fetchText(feed.url);
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: tag(e, "yt:videoId"),
    title: strip(tag(e, "title")),
    date: new Date(tag(e, "published")).toISOString(),
    source: feed.source,
  })).filter((v) => v.id && feed.keep.test(v.title));
}

// Ett trasigt flöde ska inte stoppa de andra.
async function collect(feeds, fn) {
  const res = await Promise.allSettled(feeds.map(fn));
  res.forEach((r, i) => { if (r.status === "rejected") console.warn(`Hoppar över ${feeds[i].source}: ${r.reason.message}`); });
  return res.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

const byDate = (a, b) => b.date.localeCompare(a.date);
// Samma sändning läggs ofta upp på flera officiella kanaler; behåll den första.
const unique = (list, key) => { const seen = new Set(); return list.filter((x) => !seen.has(key(x)) && seen.add(key(x))); };
// Samma nyhet från flera sajter: rubriker som delar minst 60 % av orden räknas som dubbletter (den nyaste behålls).
const words = (t) => new Set(t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !["pokemon", "with", "from", "that", "this", "your"].includes(w)));
function dedupeStories(list) {
  const kept = [];
  for (const a of list) {
    const w = words(a.title);
    const dup = kept.some((k) => { const kw = words(k.title); const same = [...w].filter((x) => kw.has(x)).length; return same / Math.max(1, Math.min(w.size, kw.size)) >= 0.6; });
    if (!dup) kept.push(a);
  }
  return kept;
}
const data = {
  updated: new Date().toISOString(),
  articles: dedupeStories(unique((await collect(ARTICLE_FEEDS, articles)).filter((a) => a.date).sort(byDate), (a) => a.link)).slice(0, 40),
  videos: unique((await collect(VIDEO_FEEDS, videos)).sort(byDate), (v) => v.title.toLowerCase()).slice(0, 12),
};

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(data, null, 1) + "\n");
console.log(`Sparade ${data.articles.length} artiklar och ${data.videos.length} videor.`);
