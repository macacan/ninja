import { $, esc, fmt, ago, news, articleCard } from "./site.js";

const PER_PAGE = 12;

// Ämnen att filtrera på. En artikel kan höra till flera. Matchas mot rubrik och ingress.
// TCG Pocket-artiklar (digital) hamnar bara under Digitalt.
const TOPICS = [
  { id: "", label: "Alla" },
  { id: "set", label: "Nya set och släpp", test: (a) => !a.digital && /\b(set|sets|expansion|release[sd]?|reveal(ed|s)?|booster|elite trainer|etb|prerelease|card list)\b/i.test(text(a)) },
  { id: "priser", label: "Priser och fynd", test: (a) => !a.digital && /(\$\d|\bprices?\b|\bworth\b|\bsold\b|\bsells?\b|\bauction|\bexpensive\b|\bmillion\b|\bpsa\b|\bresell|\bdeal\b|\bcheap|\bmsrp\b|\bscalp)/i.test(text(a)) },
  { id: "turneringar", label: "Turneringar", test: (a) => !a.digital && /\b(championships?|regionals?|tournaments?|competitive|worlds|judge|banned|players?)\b/i.test(text(a)) },
  { id: "digitalt", label: "Digitalt", test: (a) => a.digital },
];
const text = (a) => `${a.title} ${a.summary || ""}`;

const video = (v) => `<article class="video">
  <div class="frame">
    <button data-id="${esc(v.id)}" aria-label="Spela ${esc(v.title)}">
      <img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" alt="" loading="lazy">
      <span class="play" aria-hidden="true">▶</span>
    </button>
  </div>
  <div class="body"><span class="src">${esc(v.source)} · ${fmt(v.date)}${v.digital ? ' <span class="tag-digital">Digitalt</span>' : ""}</span><h3>${esc(v.title)}</h3></div>
</article>`;

let all = [], articles = [];
const pageCount = () => Math.max(1, Math.ceil(articles.length / PER_PAGE));

// Ämne och sidnummer i adressen (?amne=priser&sida=2), så att bakåtknappen och länkar fungerar.
const params = () => new URLSearchParams(location.search);
const topic = () => TOPICS.find((t) => t.id === params().get("amne")) || TOPICS[0];
function currentPage() {
  const n = parseInt(params().get("sida"), 10);
  return Math.min(pageCount(), Math.max(1, Number.isFinite(n) ? n : 1));
}
const url = (t, p) => { const q = new URLSearchParams(); if (t) q.set("amne", t); if (p > 1) q.set("sida", p); const s = q.toString(); return s ? `?${s}` : location.pathname; };

function renderTabs() {
  const cur = topic();
  $("#news-tabs").innerHTML = TOPICS.map((t) => {
    const n = t.test ? all.filter(t.test).length : all.length;
    if (t.test && !n) return ""; // tomma ämnen visas inte
    return `<a class="news-tab" href="${url(t.id, 1)}" data-topic="${t.id}"${t === cur ? ' aria-current="true"' : ""}>${esc(t.label)} <span>${n}</span></a>`;
  }).join("");
}

function renderArticles(scroll = false) {
  const t = topic();
  articles = t.test ? all.filter(t.test) : all;
  renderTabs();
  const page = currentPage(), n = pageCount();
  const list = articles.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  $("#articles").innerHTML = list.map(articleCard).join("") || '<div class="msg">Inga artiklar just nu.</div>';
  const link = (p, label, cls = "") => `<a class="pg${cls}" href="${url(t.id, p)}" data-page="${p}"${p === page ? ' aria-current="page"' : ""}>${label}</a>`;
  $("#pager").innerHTML = n < 2 ? "" : [
    page > 1 ? link(page - 1, "‹ Föregående", " pg-step") : '<span class="pg pg-step" aria-disabled="true">‹ Föregående</span>',
    ...Array.from({ length: n }, (_, i) => link(i + 1, i + 1)),
    page < n ? link(page + 1, "Nästa ›", " pg-step") : '<span class="pg pg-step" aria-disabled="true">Nästa ›</span>',
  ].join("");
  if (scroll) $("#news-tabs").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("#pager").addEventListener("click", (e) => {
  const a = e.target.closest("[data-page]");
  if (!a) return;
  e.preventDefault();
  history.pushState(null, "", url(topic().id, +a.dataset.page));
  renderArticles(true);
});
$("#news-tabs").addEventListener("click", (e) => {
  const a = e.target.closest("[data-topic]");
  if (!a) return;
  e.preventDefault();
  history.pushState(null, "", url(a.dataset.topic, 1));
  renderArticles();
});
addEventListener("popstate", () => renderArticles());

try {
  const d = await news();
  all = d.articles;
  if (d.updated) $("#news-updated").textContent = `Uppdaterad ${ago(d.updated)}`;
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
