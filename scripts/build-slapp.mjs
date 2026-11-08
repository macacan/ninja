// Skriver kommande släpp direkt i slapp.html, så att sökmotorer och AI-sök ser datumen utan att köra JavaScript.
// Körs med: node scripts/build-slapp.mjs. Läser data/release-calendar.json och data/set-pages.json.
// Listan står mellan <!--släpp--> och <!--/släpp--> i #rel-list och har samma markup som js/slapp.js, som byter ut
// den mot den levande listan (med butiksstatus och filter) när sidan laddats. Titeln och beskrivningen får årtal
// och nästa släpp, så att sökresultatet säger vad som kommer.
import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const at = (p) => new URL(p, ROOT);
const readJSON = async (p, fallback) => JSON.parse(await readFile(at(p), "utf8").catch(() => "null")) ?? fallback;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Samma ord som js/releases.js och js/calendar.js.
const MON = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];
const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
const LANG = { en: "Engelska", ja: "Japanska", ko: "Koreanska", zh: "Kinesiska", fr: "Franska" };
const GAMES = { pk: "Pokémon", op: "One Piece", rb: "Riftbound" };
const ymd = (s) => s.split("-").map(Number);
const short = (s) => { const [, m, d] = ymd(s); return `${d} ${MON[m - 1]}`; };
const long = (s) => { const [y, m, d] = ymd(s); return `${d} ${MONTHS[m - 1]} ${y}`; };
const monthTitle = (s) => { const [y, m] = ymd(s); return `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${y}`; };
const waveText = (w, r) => (w.products.length === 1 && w.products[0] === r.set ? "Fristående produkt"
  : w.products.length ? w.products.join(" · ") : r.auto && r.waves.length === 1 ? "Setet släpps" : "Produkter inte klara än");
const dateBox = (s) => {
  if (!s) return '<span class="datebox  tbd"><b>?</b><span>datum</span></span>';
  const [, m, d] = ymd(s);
  return `<span class="datebox "><b>${d}</b><span>${MON[m - 1]}</span></span>`;
};

// Dagens datum i Sverige, så att ett släpp i dag räknas som kommande även om bygget körs efter midnatt UTC.
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
const { releases = [] } = await readJSON("data/release-calendar.json", {});
const pages = (await readJSON("data/set-pages.json", {})).releases || {};
const gameOf = (r) => r.game || "pk";

// En rad per omgång och en för förreleasen, som i js/slapp.js.
const rows = [];
for (const r of releases) {
  (r.waves || []).forEach((w, wi) => rows.push({ r, w, wi, date: w.date }));
  if (r.prerelease) rows.push({ r, date: r.prerelease.from, to: r.prerelease.to, pre: true });
}
const next = rows.filter((x) => (x.to || x.date) >= today)
  .sort((a, b) => a.date.localeCompare(b.date) || !!b.pre - !!a.pre || (a.wi ?? 0) - (b.wi ?? 0));
const announced = releases.filter((r) => !(r.waves || []).length);

// Länken går till setets sida (allt om setet) i stället för dialogen, som kräver JavaScript.
const action = (r) => (pages[r.id] ? `<a class="btn small" href="${esc(pages[r.id])}">Visa</a>` : "");
function rowHTML(x) {
  const { r } = x;
  const tags = [r.game ? GAMES[r.game] : "", r.language !== "en" ? LANG[r.language] : "", x.w?.preliminary || r.preliminary ? "Preliminärt" : ""].filter(Boolean);
  const what = x.pre ? `Förrelease i spelbutiker ${short(x.date)}–${short(x.to)}` : waveText(x.w, r);
  return `<li class="rel-row${x.pre ? " is-pre" : ""}">
    ${dateBox(x.date)}
    <div class="rr-main">
      <div class="rr-title"><b>${esc(r.set)}</b>${tags.map((t) => `<span class="rr-tag">${esc(t)}</span>`).join("")}</div>
      <p class="rr-prod"><time datetime="${x.date}">${esc(long(x.date))}</time>: ${esc(what)}</p>
    </div>
    <div class="rr-side">${action(r)}</div>
  </li>`;
}
const months = new Map();
for (const x of next) { const k = x.date.slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(x); }
const list = [...months].map(([k, xs]) => `<h3 class="rel-month">${esc(monthTitle(`${k}-01`))}</h3>
      <ul class="rel-rows">${xs.map(rowHTML).join("")}</ul>`).join("")
  + (announced.length ? `<h3 class="rel-month">Datum inte klart</h3><ul class="rel-rows">${announced.map((r) => `<li class="rel-row">${dateBox(null)}
      <div class="rr-main"><div class="rr-title"><b>${esc(r.set)}</b><span class="rr-tag">${esc(LANG[r.language] || "")}</span></div><p class="rr-prod">Annonserat</p></div>
      <div class="rr-side">${action(r)}</div></li>`).join("")}</ul>` : "")
  || '<p class="rel-empty">Inga kommande släpp inlagda just nu.</p>';

// Titel och beskrivning: årtalet och nästa nya set (inte en senare omgång av ett redan släppt set).
const year = today.slice(0, 4);
const firstNew = next.find((x) => !x.pre && x.wi === 0);
const title = `Släppkalender ${year} – Pokémon, One Piece och Riftbound | Lootninja`;
const nextText = firstNew ? `Nästa nya set: ${firstNew.r.set}${firstNew.r.game ? ` (${GAMES[firstNew.r.game]})` : ""} ${long(firstNew.date)}. ` : "";
let desc = `${nextText}Alla kommande släpp för Pokémon, One Piece och Riftbound med datum, produkter och svenska butiker.`;
if (desc.length > 160) desc = `${nextText}Alla kommande släpp med datum och produkter.`;

const file = at("slapp.html");
const old = await readFile(file, "utf8");
let html = old
  .replace(/<div class="rel-list" id="rel-list">(?:<!--släpp-->[\s\S]*?<!--\/släpp-->)?<\/div>/, `<div class="rel-list" id="rel-list"><!--släpp-->${list}<!--/släpp--></div>`)
  .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
  .replace(/(<meta property="og:title" content=")[^"]*/, `$1${esc(title)}`)
  .replace(/(<meta name="description" content=")[^"]*/, `$1${esc(desc)}`)
  .replace(/(<meta property="og:description" content=")[^"]*/, `$1${esc(desc)}`);
if (!html.includes("<!--släpp-->")) throw new Error("Hittade inte #rel-list i slapp.html");
if (html !== old) await writeFile(file, html);
console.log(`slapp.html: ${next.length} kommande rader, ${announced.length} utan datum${html === old ? " (oförändrad)" : ""}.`);
