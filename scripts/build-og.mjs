// Bygger delningsbilden img/og-lootninja.jpg (1200×630) som syns när man delar en länk i t.ex. WhatsApp och Messenger.
//   node scripts/build-og.mjs   (kräver Chrome och npm i --no-save sharp)
// Bilden ritas som en HTML-sida med sajtens typsnitt och loggan (img/logo.png, se build-logo.mjs), fotograferas
// med Chrome utan fönster och sparas som JPG. Byt loggan eller texten här och kör skriptet igen.
import sharp from "sharp";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const CHROME = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && fs.existsSync(p));
if (!CHROME) throw new Error("Hittar ingen Chrome. Ange sökvägen med CHROME=...");

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${url("fonts/fonts.css")}">
<style>
  *{margin:0;box-sizing:border-box}
  html,body{width:1200px;height:630px;overflow:hidden}
  body{position:relative;font-family:Inter,sans-serif;color:#fff;background:#3a7bd5 url("${url("img/pokemon-nature-day.jpg")}") center/cover}
  /* Mörkare till vänster, så att texten syns mot himlen och träden. */
  body::before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(10,18,40,.72) 0%,rgba(10,18,40,.5) 45%,rgba(10,18,40,0) 75%)}
  .c{position:absolute;left:72px;top:64px;width:900px}
  .logo{display:block;height:190px;width:auto;filter:drop-shadow(0 6px 14px rgba(0,0,0,.45))}
  h1{margin-top:38px;font-weight:700;font-size:44px;line-height:1.15;text-shadow:0 2px 10px rgba(0,0,0,.5)}
  .chips{display:flex;gap:14px;margin-top:28px}
  .chips span{background:#f2b632;color:#1b1b2f;font-weight:700;font-size:24px;padding:9px 18px;border-radius:999px}
  .url{margin-top:30px;font-weight:600;font-size:26px;opacity:.95;text-shadow:0 2px 8px rgba(0,0,0,.5)}
</style></head><body><div class="c">
  <img class="logo" src="${url("img/logo.png")}" alt="">
  <h1>Pokémon, One Piece och Riftbound<br>i lager i 70+ svenska butiker</h1>
  <div class="chips"><span>Butikslager</span><span>Släppkalender</span><span>Kortpriser i kr</span></div>
  <div class="url">lootninja.se</div>
</div></body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "og-"));
const page = path.join(tmp, "og.html"), shot = path.join(tmp, "og.png");
fs.writeFileSync(page, html);
execFileSync(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
  "--force-device-scale-factor=1", "--window-size=1200,630", "--virtual-time-budget=3000",
  `--screenshot=${shot}`, pathToFileURL(page).href,
], { stdio: "ignore" });
await sharp(shot).resize(1200, 630).jpeg({ quality: 86, mozjpeg: true }).toFile(path.join(ROOT, "img/og-lootninja.jpg"));
fs.rmSync(tmp, { recursive: true, force: true });
console.log("img/og-lootninja.jpg klar");
