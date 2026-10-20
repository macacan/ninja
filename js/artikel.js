// En nyhet på Packninja. Bara det källan själv delar i sitt öppna RSS-flöde visas: rubrik, ingress och bild.
// Själva artikeltexten är källans och läses hos dem, så den kopieras aldrig hit.
import { $, esc, fmt, ago, news, articleId, articleCard, safeUrl } from "./site.js";

const id = new URLSearchParams(location.search).get("id");
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

try {
  const d = await news();
  const i = d.articles.findIndex((a) => articleId(a.link) === id);
  const a = d.articles[i];
  if (!a) {
    $("#article").innerHTML = `<div class="msg">Artikeln finns inte längre i vårt nyhetsflöde. Nyheter ligger kvar i några veckor. <a href="nyheter.html">Till alla nyheter</a>.</div>`;
  } else {
    document.title = `${a.title} – Packninja`;
    const site = host(a.link);
    $("#article").innerHTML = `
      <div class="article-main">
        <span class="article-src"><b>${esc(a.source)}</b>${site ? ` · ${esc(site)}` : ""} · ${fmt(a.date)} <span class="muted">(${ago(a.date)})</span></span>
        <h1>${esc(a.title)}</h1>
        ${a.summary ? `<p class="article-lead">${esc(a.summary)}</p>` : ""}
        <a class="btn primary article-cta" href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener">Läs hela artikeln hos ${esc(a.source)} ↗</a>
        <p class="article-note">Texten och bilden tillhör <a href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener">${esc(a.source)}</a>. Packninja visar bara rubriken, ingressen och bilden som ${esc(a.source)} själv delar i sitt öppna nyhetsflöde. Hela artikeln läser du hos dem.</p>
      </div>
      ${a.image ? `<figure class="article-img"><img src="${esc(a.image)}" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"><figcaption>Bild: ${esc(a.source)}</figcaption></figure>` : ""}`;
  }
  // Fler nyheter: först från samma källa, sedan de senaste.
  const others = d.articles.filter((x, k) => k !== i);
  const related = [...others.filter((x) => a && x.source === a.source).slice(0, 2), ...others].filter((x, k, arr) => arr.indexOf(x) === k).slice(0, 3);
  $("#related").innerHTML = related.map(articleCard).join("");
} catch {
  $("#article").innerHTML = '<div class="msg">Nyheterna kunde inte laddas.</div>';
}
