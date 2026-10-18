// Genererar data/pokemon-names.json med alla 1025 officiella Pokémon och populära kortvarianter.
import { writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = resolve(__dirname, "../data/pokemon-names.json");

const ICONIC_BOOSTS = {
  charizard: 1000,
  pikachu: 1000,
  mewtwo: 950,
  umbreon: 950,
  gengar: 920,
  rayquaza: 910,
  lugia: 900,
  eevee: 900,
  lucario: 880,
  giratina: 870,
  arceus: 870,
  blastoise: 860,
  venusaur: 860,
  mew: 860,
  greninja: 860,
  mimikyu: 850,
  dragonite: 850,
  snorlax: 830,
  gyarados: 830,
  tyranitar: 830,
  gardevoir: 830,
  garchomp: 830,
  sylveon: 820,
  espeon: 820,
  vaporeon: 810,
  jolteon: 810,
  flareon: 810,
  suicune: 800,
  raikou: 800,
  entei: 800,
  zapdos: 800,
  articuno: 800,
  moltres: 800,
  dialga: 800,
  palkia: 800,
  darkrai: 800,
  celebi: 800,
  jirachi: 800,
  deoxys: 800,
  charmander: 780,
  charmeleon: 750,
  squirtle: 760,
  wartortle: 730,
  bulbasaur: 760,
  ivysaur: 730,
  chansey: 600,
  chandelure: 580,
  charcadet: 570,
};

const SPECIAL_NAMES = {
  "nidoran-f": "Nidoran♀",
  "nidoran-m": "Nidoran♂",
  "mr-mime": "Mr. Mime",
  "mime-jr": "Mime Jr.",
  "mr-rime": "Mr. Rime",
  "ho-oh": "Ho-Oh",
  "porygon-z": "Porygon-Z",
  "type-null": "Type: Null",
  "jangmo-o": "Jangmo-o",
  "hakamo-o": "Hakamo-o",
  "kommo-o": "Kommo-o",
  "farfetchd": "Farfetch'd",
  "sirfetchd": "Sirfetch'd",
  "flabebe": "Flabébé",
  "wo-chien": "Wo-Chien",
  "chien-pao": "Chien-Pao",
  "ting-lu": "Ting-Lu",
  "chi-yu": "Chi-Yu",
};

function formatName(slug) {
  if (SPECIAL_NAMES[slug]) return SPECIAL_NAMES[slug];
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function run() {
  console.log("Hämtar Pokémon och kortnamn...");
  const [speciesRes, cardsRes] = await Promise.all([
    fetch("https://pokeapi.co/api/v2/pokemon-species?limit=1100").then((r) => r.json()),
    fetch("https://api.tcgdex.net/v2/en/cards").then((r) => r.json()).catch(() => []),
  ]);

  const pokemon = speciesRes.results.map((p, idx) => {
    const id = idx + 1;
    const name = formatName(p.name);
    const boost = ICONIC_BOOSTS[p.name.toLowerCase()] || Math.max(10, 500 - Math.floor(id / 3));
    return { id, name, score: boost };
  });

  const cardCounts = new Map();
  for (const c of cardsRes) {
    if (!c.name) continue;
    const n = c.name.trim();
    if (!n) continue;
    if (/^(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy|Double Colorless) Energy$/i.test(n)) continue;
    cardCounts.set(n, (cardCounts.get(n) || 0) + 1);
  }

  // Sortera de mest populära kortnamnen
  const popularCards = [...cardCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 1500)
    .map(([name, count]) => ({ name, count }));

  const out = {
    updated: Date.now(),
    pokemon,
    popularCards,
  };

  writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`Klart! Sparade ${pokemon.length} Pokémon och ${popularCards.length} kort till ${OUT_FILE}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
