// Prisfönster för ett kort: prishistorik, Cardmarket- och TCGplayer-priser samt värde per skick och betyg.
// Öppnas ovanpå den förstorade kortvyn, utan att lämna sidan.
import { API, esc, kr, getJSON } from "./site.js";
import { mountChart } from "./pricechart.js";
import { CONDITIONS, gradeMult } from "./valuation.js";

let dlg = null, token = 0;

function dialog() {
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.className = "card-modal price-modal";
  dlg.setAttribute("aria-label", "Pris och värdering");
  dlg.innerHTML = `<button type="button" class="cm-close" aria-label="Stäng">✕</button><div class="pm-body"></div>`;
  document.body.append(dlg);
  dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest(".cm-close")) dlg.close(); });
  return dlg;
}

async function getRates() {
  try {
    const [eur, usd] = await Promise.all(["EUR", "USD"].map((c) => getJSON(`https://api.frankfurter.dev/v1/latest?from=${c}&to=SEK`)));
    return { EUR: eur.rates.SEK, USD: usd.rates.SEK };
  } catch { return { EUR: null, USD: null }; }
}

export async function openCardPrice(id) {
  const d = dialog(), body = d.querySelector(".pm-body"), my = ++token;
  body.innerHTML = '<div class="cm-load">Hämtar priser…</div>';
  if (!d.open) d.showModal();
  const [card, rates] = await Promise.all([getJSON(`${API}/cards/${encodeURIComponent(id)}`).catch(() => null), getRates()]);
  const rate = rates.EUR;
  if (my !== token) return;
  if (!card) { body.innerHTML = '<div class="msg">Priset kunde inte hämtas just nu.</div>'; return; }
  const cm = card.pricing?.cardmarket || {}, tp = card.pricing?.tcgplayer || {};
  const sek = (v, cur = "EUR") => (v == null || !rates[cur] ? "–" : kr(v * rates[cur]));
  const row = (label, v, cur) => (v == null ? "" : `<tr><th>${label}</th><td>${sek(v, cur)}</td></tr>`);
  const tpRows = Object.entries(tp).filter(([, v]) => v && typeof v === "object" && v.marketPrice != null)
    .map(([k, v]) => row({ normal: "Vanlig", holofoil: "Holo", reverseHolofoil: "Reverse holo", "1stEditionHolofoil": "1st edition holo" }[k] || k, v.marketPrice, "USD")).join("");
  const eur = cm.trend ?? cm.avg ?? cm["trend-holo"] ?? null;
  const base = eur != null && rate ? eur * rate : null;
  const round = (n) => Math.round(n / 10) * 10 || Math.round(n);
  const values = base == null ? "" : `<h3>Värde per skick</h3>
    <table class="cm-table">${CONDITIONS.map(([n, , m]) => `<tr><th>${esc(n)}</th><td>ca ${kr(round(base * m))}</td></tr>`).join("")}</table>
    <h3>Graderat (riktvärden)</h3>
    <table class="cm-table">${[10, 9, 8].map((g) => `<tr><th>Betyg ${g}</th><td>ca ${kr(round(base * gradeMult(g)))}</td></tr>`).join("")}</table>
    <p class="muted">Grova tumregler utgående från nyskickspriset. Graderade priser skiljer mycket mellan kort.</p>`;
  body.innerHTML = `<div class="pm-head">
      ${card.image ? `<img class="pm-img" src="${esc(card.image)}/low.webp" alt="" referrerpolicy="no-referrer">` : ""}
      <div><h2>${esc(card.name)}</h2><p class="muted">${esc(card.set?.name || "")} · #${esc(card.localId || "")}${card.rarity && card.rarity !== "None" ? ` · ${esc(card.rarity)}` : ""}</p>
      <div class="cm-price">${base != null ? kr(base) : "Inget pris ännu"}</div>
      <p class="muted">Cardmarkets trendpris i kronor. Vägledande, uppdateras dagligen.</p></div></div>
    <div class="pchart"></div>
    ${cm.trend != null || cm.avg != null ? `<h3>Cardmarket (Europa)</h3><table class="cm-table">${row("Trend", cm.trend, "EUR")}${row("Snitt", cm.avg, "EUR")}${row("Lägsta", cm.low, "EUR")}${row("Snitt 1 dag", cm.avg1, "EUR")}${row("Snitt 7 dagar", cm.avg7, "EUR")}${row("Snitt 30 dagar", cm.avg30, "EUR")}${row("Trend holo", cm["trend-holo"] || null, "EUR")}</table>` : ""}
    ${values}
    ${tpRows ? `<h3>TCGplayer (USA)</h3><table class="cm-table">${tpRows}</table>` : ""}`;
  mountChart(body.querySelector(".pchart"), card, rate).catch(() => {});
}
