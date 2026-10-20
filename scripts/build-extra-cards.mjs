// Mappar och sparar extra kortbilder som TCGdex saknar till data/card-images.json.
// Bilderna kommer från Scrydex, som tillåter att kortbilderna används (scrydex.com/docs, "Images").
//   node scripts/build-extra-cards.mjs
// Har du en kortlista från Scrydex API (data/me55c-cards.json, [{ id, images: { small, large } }]) används
// adresserna i den, som Scrydex rekommenderar. Annars byggs adresserna från kortets Scrydex-id.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const scrydexImages = (id) => ({ small: `https://images.scrydex.com/pokemon/${id}/small`, large: `https://images.scrydex.com/pokemon/${id}/large` });
const me55c = existsSync("data/me55c-cards.json") ? JSON.parse(readFileSync("data/me55c-cards.json", "utf8")) : null;
const lookup = (id) => (Array.isArray(me55c) ? me55c.find((m) => m.id === id) : null) || { id, images: scrydexImages(id) };

const nameMap = {
  "Charizard": "me55c-4",
  "Delcatty": "me55c-5",
  "Metagross": "me55c-11",
  "Genesect EX": "me55c-11g",
  "Misty": "me55c-18",
  "Dark Tyranitar": "me55c-19",
  "Sneasel": "me55c-25",
  "Pikachu & Zekrom GX": "me55c-33",
  "Greninja BREAK": "me55c-41",
  "Uxie": "me55c-43",
  "Crobat G": "me55c-47",
  "Raikou": "me55c-50",
  "Buzzwole GX": "me55c-57",
  "Pikachu": "me55c-58",
  "Erika's Jigglypuff": "me55c-69",
  "Rayquaza EX": "me55c-85",
  "Solgaleo GX": "me55c-89",
  "Gengar": "me55c-94",
  "Darkrai & Cresselia LEGEND_top": "me55c-99",
  "Darkrai & Cresselia LEGEND_bot": "me55c-100",
  "N": "me55c-101",
  "Palkia": "me55c-106p",
  "M Gardevoir EX": "me55c-106m",
  "Shining Celebi": "me55c-106",
  "Scizor ex": "me55c-108",
  "Mew VMAX": "me55c-114",
  "Arceus VSTAR": "me55c-123",
  "Zacian V": "me55c-138",
  "Lugia": "me55c-149",
  "Magikarp": "me55c-203"
};

const tcgdex = await fetch("https://api.tcgdex.net/v2/en/sets/30th-c").then(r => r.json());

const cardImages = {};
try {
  Object.assign(cardImages, JSON.parse(readFileSync("data/card-images.json", "utf8")));
} catch {}

for (const c of tcgdex.cards) {
  let key = c.name;
  if (c.id === "30th-c-019") key = "Darkrai & Cresselia LEGEND_top";
  if (c.id === "30th-c-020") key = "Darkrai & Cresselia LEGEND_bot";
  const pkmId = nameMap[key];
  if (!pkmId) { console.warn(`Ingen Scrydex-bild för ${c.id} ${c.name}`); continue; }
  const found = lookup(pkmId);
  cardImages[c.id] = { low: found.images.small, high: found.images.large };
}

// Mew RGB Rare cards from 30th Celebration
cardImages["30th-R"] = { low: "https://images.scrydex.com/pokemon/me55-R/small", high: "https://images.scrydex.com/pokemon/me55-R/large" };
cardImages["30th-G"] = { low: "https://images.scrydex.com/pokemon/me55-G/small", high: "https://images.scrydex.com/pokemon/me55-G/large" };
cardImages["30th-B"] = { low: "https://images.scrydex.com/pokemon/me55-B/small", high: "https://images.scrydex.com/pokemon/me55-B/large" };

console.log("Total mapped cards in card-images.json:", Object.keys(cardImages).length);
writeFileSync("data/card-images.json", JSON.stringify(cardImages, null, 2));
console.log("data/card-images.json updated successfully!");
