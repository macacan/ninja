import { $, esc, fmt, ago, news, articleCard } from "./site.js";

const PER_PAGE = 6;

const video = (v) => `<article class="video">
  <div class="frame">
    <button data-id="${esc(v.id)}" aria-label="Spela ${esc(v.title)}">
      <img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" alt="" loading="lazy">
      <span class="play" aria-hidden="true">▶</span>
    </button>
  </div>
  <div class="body"><span class="src">${esc(v.source)} · ${fmt(v.date)}</span><h3>${esc(v.title)}</h3></div>
</article>`;

let articles = [];
const pageCount = () => Math.max(1, Math.ceil(articles.length / PER_PAGE));

// Sidnummer i adressen (?sida=2), så att bakåtknappen och länkar fungerar.
function currentPage() {
  const n = parseInt(new URLSearchParams(location.search).get("sida"), 10);
  return Math.min(pageCount(), Math.max(1, Number.isFinite(n) ? n : 1));
}

function renderArticles(scroll = false) {
  const page = currentPage(), n = pageCount();
  const list = articles.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  $("#articles").innerHTML = list.map(articleCard).join("") || '<div class="msg">Inga artiklar just nu.</div>';
  const link = (p, label, cls = "") => `<a class="pg${cls}" href="?sida=${p}" data-page="${p}"${p === page ? ' aria-current="page"' : ""}>${label}</a>`;
  $("#pager").innerHTML = n < 2 ? "" : [
    page > 1 ? link(page - 1, "‹ Föregående", " pg-step") : '<span class="pg pg-step" aria-disabled="true">‹ Föregående</span>',
    ...Array.from({ length: n }, (_, i) => link(i + 1, i + 1)),
    page < n ? link(page + 1, "Nästa ›", " pg-step") : '<span class="pg pg-step" aria-disabled="true">Nästa ›</span>',
  ].join("");
  if (scroll) $("#articles").closest(".wrap").querySelector(".section").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("#pager").addEventListener("click", (e) => {
  const a = e.target.closest("[data-page]");
  if (!a) return;
  e.preventDefault();
  history.pushState(null, "", `?sida=${a.dataset.page}`);
  renderArticles(true);
});
addEventListener("popstate", () => renderArticles());

try {
  const d = await news();
  articles = d.articles;
  renderArticles();
  $("#videos").innerHTML = d.videos.map(video).join("") || '<div class="msg">Inga videor just nu.</div>';
} catch {
  $("#articles").innerHTML = '<div class="msg">Nyheterna kunde inte laddas.</div>';
}

// Ladda YouTube först vid klick, så att inget skickas till Google innan besökaren valt det.
$("#videos").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]");
  if (!b) return;
  b.parentElement.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(b.dataset.id)}?autoplay=1"
    title="YouTube-video" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
});
