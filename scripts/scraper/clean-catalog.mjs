// Rensa och omklassificera hela produktkatalogen i data/products.json
import fs from "node:fs";
import { classify } from "./lib/classify.mjs";

const state = JSON.parse(fs.readFileSync("scripts/scraper/state.json", "utf8"));
const data = JSON.parse(fs.readFileSync("data/products.json", "utf8"));
const products = data.products || [];

console.log(`Befintliga produkter: ${products.length}`);

const cleaned = [];
let droppedNotSealed = 0;
let droppedFloor = 0;
let reclassified = 0;

for (const p of products) {
  const c = classify(p.title, state.sets.names, state.sets.series);
  if (!c) {
    droppedNotSealed++;
    continue;
  }
  // Prisgolv för stora förseglade produkter
  if (c.type === "Booster Box" && p.price < 250) {
    droppedFloor++;
    continue;
  }
  if (c.type === "Elite Trainer Box" && p.price < 200) {
    droppedFloor++;
    continue;
  }
  if (c.type === "Ultra-Premium Collection" && p.price < 500) {
    droppedFloor++;
    continue;
  }
  if (c.type !== p.type) {
    reclassified++;
  }
  // Titeln säger inget om språket: behåll det som bevakningen hittade i taggar eller adress.
  const keepLang = c.langGuess && p.lang && !p.langGuess;
  const { langGuess, ...rest } = p;
  cleaned.push({
    ...rest,
    type: c.type,
    lang: keepLang ? p.lang : c.lang,
    set: c.set,
    ...(c.langGuess && !keepLang ? { langGuess: true } : {}),
  });
}

data.products = cleaned;
data.updated = Date.now();
fs.writeFileSync("data/products.json", JSON.stringify(data, null, 2));

console.log(`Rensning klar:`);
console.log(`- Borttagna tillbehör, singlar och live-öppningar: ${droppedNotSealed}`);
console.log(`- Borttagna pga orimligt lågt prisgolv: ${droppedFloor}`);
console.log(`- Ändrad produkttyp (t.ex. Mini Tin Display -> Tin): ${reclassified}`);
console.log(`- Kvarvarande aktiva produkter i katalogen: ${cleaned.length}`);
