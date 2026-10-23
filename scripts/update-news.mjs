// Hämtar nyheter och videor från öppna RSS-flöden och sparar dem i data/news.json.
// Körs schemalagt (se .github/workflows/news.yml) eller manuellt: node scripts/update-news.mjs
// Vi sparar bara rubrik, datum, kort utdrag och länk, och länkar alltid till källan.
import { writeFile, mkdir } from "node:fs/promises";
import { readCapped } from "./scraper/lib/http.mjs";

const UA = "LootninjaNews/1.0 (+https://github.com/; RSS-läsare)";
const OUT = new URL("../data/news.json", import.meta.url);

// Bara artiklar om samlarkort, inte om tv-spelen. "Expansion" ensamt räknas inte, det betyder ofta något annat
// ("Retail Expansion"). Även taggflödena filtreras, eftersom de taggar allt som nämner Pokémon.
const TCG = /\b(tcg|trading cards?|booster|elite trainer|etb|card set|card expansion|prerelease|sealed|card list|pok[eé]mon cards?|promo cards?|set list|psa)\b/i;
// Artiklar som nämner kort men handlar om annat: spelen, anime, rankningar av Pokémon.
const OFF_TOPIC = /\b(strongest|tier list|world record|anime|episode|pok[eé]mon go|eeveelution designs?)\b/i;
// Listor som skrivs om och publiceras igen med nytt datum, till exempel "Top 50+ most expensive". De är guider, inte nyheter.
const EVERGREEN = /^(the )?(top \d+|all pok[eé]mon|best pok[eé]mon)\b/i;
const ARTICLE_FEEDS = [
  { source: "Dexerto", url: "https://www.dexerto.com/feed/category/pokemon/", keep: TCG },
  { source: "Wargamer", url: "https://www.wargamer.com/pokemon-trading-card-game/feed", keep: TCG },
  { source: "Game Rant", url: "https://gamerant.com/feed/tag/pokemon-tcg/", keep: TCG },
  { source: "Siliconera", url: "https://www.siliconera.com/tag/pokemon-tcg/feed/", keep: TCG },
  { source: "Polygon", url: "https://www.polygon.com/rss/pokemon/index.xml", keep: TCG },
  { source: "PokemonBlog", url: "https://www.pokemonblog.com/feed/", keep: /\b(tcg|trading card|pok[eé]mon cards?)\b/i },
];
// TCG Pocket är ett mobilspel. Artiklarna och videorna om det visas, men märks som digitala.
const DIGITAL = /\btcg pocket\b/i;

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
  })).filter((a) => a.title && a.link && feed.keep.test(`${a.title} ${a.summary}`)
    && !OFF_TOPIC.test(a.title) && !EVERGREEN.test(a.title))
    .map((a) => (DIGITAL.test(`${a.title} ${a.summary}`) ? { ...a, digital: true } : a));
}

async function videos(feed) {
  const xml = await fetchText(feed.url);
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: tag(e, "yt:videoId"),
    title: strip(tag(e, "title")),
    date: new Date(tag(e, "published")).toISOString(),
    source: feed.source,
  })).filter((v) => v.id && feed.keep.test(v.title))
    .map((v) => (DIGITAL.test(v.title) ? { ...v, digital: true } : v));
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
// Samma nyhet från flera sajter (den nyaste behålls). Två artiklar inom fyra dagar räknas som samma nyhet om
// rubrikerna delar minst 60 % av orden, eller om rubrik och ingress tillsammans delar minst 45 %.
// Ord jämförs i grundform: "cards" blir "card", och "$2M" och "$2 million" blir båda "2m".
const STOP = new Set(["pokemon", "with", "from", "that", "this", "your", "after", "have", "about", "they", "their", "says", "will", "just", "into", "been", "more", "than"]);
const words = (t) => new Set(t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\$?(\d+(?:\.\d+)?)\s*(m|million)\b/g, "$1m").replace(/\$?(\d+(?:\.\d+)?)\s*(k|thousand)\b/g, "$1k")
  .split(/[^a-z0-9]+/).map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
  .filter((w) => (w.length > 3 || /^\d+[mk]$/.test(w)) && !STOP.has(w)));
const overlap = (a, b) => [...a].filter((x) => b.has(x)).length / Math.max(1, Math.min(a.size, b.size));
const DAYS4 = 4 * 864e5;
// Omskrivna rubriker ("25-Year Player Banned for Life" och "veteran says he was banned for life") delar få ord totalt,
// men de ovanliga orden är desamma. Ett ord är ovanligt om det bara finns i högst tre artiklar i hela listan,
// och tre gemensamma ovanliga ord räcker för att räkna två artiklar som samma nyhet.
function dedupeStories(list) {
  const text = (a) => words(`${a.title} ${a.summary}`);
  const df = new Map();
  for (const a of list) for (const w of text(a)) df.set(w, (df.get(w) || 0) + 1);
  const rareShared = (x, y) => [...x].filter((w) => y.has(w) && df.get(w) <= 3).length;
  const kept = [];
  for (const a of list) {
    const t = words(a.title), all = text(a);
    const dup = kept.some((k) => {
      if (Math.abs(new Date(k.date) - new Date(a.date)) >= DAYS4) return false;
      const kAll = text(k);
      return overlap(t, words(k.title)) >= 0.6 || overlap(all, kAll) >= 0.45 || rareShared(all, kAll) >= 3;
    });
    if (!dup) kept.push(a);
  }
  return kept;
}
const data = {
  updated: new Date().toISOString(),
  articles: dedupeStories(unique((await collect(ARTICLE_FEEDS, articles)).filter((a) => a.date).sort(byDate), (a) => a.link)).slice(0, 40),
  // "[UK] Trailer" och "Trailer" är samma video för olika länder.
  videos: unique((await collect(VIDEO_FEEDS, videos)).sort(byDate), (v) => v.title.toLowerCase().replace(/^\s*\[[^\]]*\]\s*/, "")).slice(0, 12),
};

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(data, null, 1) + "\n");
console.log(`Sparade ${data.articles.length} artiklar och ${data.videos.length} videor.`);
