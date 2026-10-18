// Prisdiagram för ett kort, i kronor.
// Egen historik (en punkt per dag) från data/card-history/<set>.json, som scripts/update-card-trends.mjs fyller på.
// Så länge historiken är kort fylls början ut med Cardmarkets snitt för 30, 7 och 1 dag (ihåliga punkter).
import { kr } from "./site.js";

const MON = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];
const dayLabel = (iso) => { const d = new Date(`${iso}T12:00:00`); return `${d.getDate()} ${MON[d.getMonth()]}`; };
const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const MONTH_DAYS = 31;
const cache = new Map();

async function cardHistory(setId, cardId) {
  if (!setId) return [];
  if (!cache.has(setId)) {
    cache.set(setId, fetch(`data/card-history/${encodeURIComponent(setId)}.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : { cards: {} })).catch(() => ({ cards: {} })));
  }
  return ((await cache.get(setId)).cards[cardId] || []).map(([date, price, low]) => ({ date, price, low }));
}

function chartPoints(own, cm, eurToSek) {
  const pts = [...own];
  if (pts.length < 14 && eurToSek) {
    const first = pts[0]?.date || "9999";
    for (const [n, v, label] of [[30, cm.avg30, "Snitt 30 dagar"], [7, cm.avg7, "Snitt 7 dagar"], [1, cm.avg1, "Snitt 1 dag"]]) {
      const date = isoDaysAgo(n);
      if (v != null && date < first) pts.push({ date, price: v * eurToSek, est: label });
    }
    const now = cm.trend ?? cm.avg;
    if (!own.length && now != null) pts.push({ date: isoDaysAgo(0), price: now * eurToSek, est: "Trendpris i dag" });
  }
  return pts.sort((a, b) => a.date.localeCompare(b.date));
}

function draw(box, all, days) {
  let pts = all.filter((p) => p.date >= isoDaysAgo(days));
  if (pts.length < 2) pts = all.slice(-2);
  const W = 520, H = 230, L = 64, R = 12, T = 14, B = 30;
  const ys = pts.map((p) => p.price), lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.15 || hi * 0.1 || 1, y0 = Math.max(0, lo - pad), y1 = hi + pad;
  const t0 = Date.parse(pts[0].date), span = Math.max(1, Date.parse(pts.at(-1).date) - t0);
  const X = (p) => L + ((Date.parse(p.date) - t0) / span) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const xy = pts.map((p) => [X(p), Y(p.price)]);
  const f = (n) => n.toFixed(1);
  // Mjuk kurva med styrpunkter på halva avståndet, så att linjen aldrig skjuter över punkterna.
  let line = `M${f(xy[0][0])},${f(xy[0][1])}`;
  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1], [bx, by] = xy[i], mx = (ax + bx) / 2;
    line += ` C${f(mx)},${f(ay)} ${f(mx)},${f(by)} ${f(bx)},${f(by)}`;
  }
  const area = `${line} L${f(xy.at(-1)[0])},${H - B} L${f(xy[0][0])},${H - B} Z`;
  const ticks = [0, 1, 2, 3].map((i) => y0 + ((y1 - y0) * i) / 3);
  const nx = Math.min(6, pts.length);
  const xl = [...new Set(Array.from({ length: nx }, (_, i) => Math.round((i * (pts.length - 1)) / Math.max(1, nx - 1))))].map((i) => pts[i]);
  const first = pts[0].price, last = pts.at(-1).price, pct = first ? Math.round((last / first - 1) * 1000) / 10 : 0;

  box.querySelector(".pc-head").innerHTML = `<span class="pc-now">${kr(last)}</span>
    <span class="chg ${pct >= 0 ? "up" : "down"}">${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toLocaleString("sv-SE")} %</span>
    <span class="muted">Senaste månaden · från ${dayLabel(pts[0].date)}</span>`;
  box.querySelector(".pc-plot").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pris från ${kr(first)} till ${kr(last)}">
    ${ticks.map((v) => `<line class="pc-grid" x1="${L}" x2="${W - R}" y1="${f(Y(v))}" y2="${f(Y(v))}"/><text class="pc-y" x="${L - 8}" y="${f(Y(v) + 4)}">${kr(v)}</text>`).join("")}
    ${xl.map((p, i) => `<text class="pc-x" x="${f(X(p))}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === xl.length - 1 ? "end" : "middle"}">${dayLabel(p.date)}</text>`).join("")}
    <path class="pc-area" d="${area}"/><path class="pc-line" d="${line}"/>
    ${pts.length <= 40 ? pts.map((p, i) => `<circle class="pc-dot${p.est ? " est" : ""}" cx="${f(xy[i][0])}" cy="${f(xy[i][1])}" r="3.5"/>`).join("") : ""}
    <line class="pc-cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
    <circle class="pc-hot" r="5.5" visibility="hidden"/>
    <rect class="pc-hit" x="0" y="0" width="${W}" height="${H}"/>
  </svg><div class="pc-tip" hidden></div>`;

  const svg = box.querySelector("svg"), tip = box.querySelector(".pc-tip");
  const cur = svg.querySelector(".pc-cursor"), hot = svg.querySelector(".pc-hot");
  const show = (e) => {
    const r = svg.getBoundingClientRect(), vx = ((e.clientX - r.left) / r.width) * W;
    let i = 0;
    for (let k = 1; k < xy.length; k++) if (Math.abs(xy[k][0] - vx) < Math.abs(xy[i][0] - vx)) i = k;
    const p = pts[i], [px, py] = xy[i];
    cur.setAttribute("x1", px); cur.setAttribute("x2", px); cur.setAttribute("visibility", "visible");
    hot.setAttribute("cx", px); hot.setAttribute("cy", py); hot.setAttribute("visibility", "visible");
    tip.innerHTML = `<b>${dayLabel(p.date)}</b><span class="pc-tp">${kr(p.price)}</span>${p.low != null ? `<span>Lägsta: ${kr(p.low)}</span>` : ""}${p.est ? `<span class="muted">${p.est}, uppskattat</span>` : ""}`;
    tip.hidden = false;
    const left = (px / W) * r.width, top = (py / H) * r.height;
    tip.style.left = `${Math.min(r.width - tip.offsetWidth - 4, Math.max(4, left > r.width / 2 ? left - tip.offsetWidth - 14 : left + 14))}px`;
    tip.style.top = `${Math.min(r.height - tip.offsetHeight, Math.max(0, top - tip.offsetHeight / 2))}px`;
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; cur.setAttribute("visibility", "hidden"); hot.setAttribute("visibility", "hidden"); });
}

export async function mountChart(box, card, eurToSek) {
  const own = await cardHistory(card.set?.id, card.id);
  const all = chartPoints(own, card.pricing?.cardmarket || {}, eurToSek);
  if (all.length < 2) { box.innerHTML = ""; return; }
  const since = dayLabel(all[0].date);
  box.innerHTML = `<div class="pc-top"><h3>Prishistorik</h3><div class="pc-head"></div></div>
    <div class="pc-plot"></div>
    <p class="pc-note">${own.length < 14
      ? `Prisdata finns från ${since}. Vi sparar ett pris per dag${own[0] ? ` sedan ${dayLabel(own[0].date)}` : ""}, och ihåliga punkter är Cardmarkets snittpriser tills historiken hunnit fyllas på.`
      : "Ett pris per dag (Cardmarkets trendpris), omräknat till kronor."}</p>`;
  draw(box, all, MONTH_DAYS);
}
