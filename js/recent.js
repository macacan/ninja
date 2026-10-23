// "Senast sökta/värderade kort": en rad med de kort besökaren nyligen tittat på, med antal sökningar och pris.
// Historiken sparas bara i den egna webbläsaren (localStorage) och lämnar aldrig datorn.
// Är historiken tom visas dagens mest sökta trendkort i stället, så att raden aldrig är tom.
import { esc, kr, ago, getJSON, icon } from "./site.js";

const KEY = "nl:recent-cards";
const MAX = 16;

const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
const write = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch {} };

// Sparar ett kort överst i historiken. c: { id, name, set, localId, total, image, eur }
export function recordCard(c) {
  if (!c?.id) return;
  const list = read();
  const i = list.findIndex((x) => x.id === c.id);
  const prev = i >= 0 ? list.splice(i, 1)[0] : null;
  list.unshift({ id: c.id, name: c.name, set: c.set, localId: c.localId, total: c.total, image: c.image, eur: c.eur ?? null, count: (prev?.count || 0) + 1, t: Date.now() });
  write(list);
  document.dispatchEvent(new CustomEvent("recent-cards-changed"));
}

const eurRate = () => getJSON("https://api.frankfurter.dev/v1/latest?from=EUR&to=SEK").then((r) => r.rates.SEK).catch(() => 11.2);

async function trending() {
  const t = await fetch("data/card-trends.json").then((r) => r.json()).catch(() => null);
  return (t?.top || []).slice(0, 10).map((c) => ({ id: c.id, name: c.name, set: c.set, localId: c.localId, image: c.image, eur: c.eur, change: c.change }));
}

// root: ett tomt element. opts: { eyebrow, title, hint, onPick(id) }
export function mountRecent(root, opts = {}) {
  if (!root) return;
  const render = async () => {
    const mine = read();
    const own = mine.length > 0;
    const [list, rate] = await Promise.all([own ? Promise.resolve(mine) : trending(), eurRate()]);
    if (!list.length) { root.hidden = true; return; }
    root.hidden = false;
    root.className = "recent";
    root.innerHTML = `<header class="recent-head">
        <span class="recent-ic" aria-hidden="true">${icon("search", 22)}</span>
        <div><span class="recent-eyebrow">${esc(own ? opts.eyebrow || "Nyligen kollade" : "Populärt just nu")}</span>
          <h2>${esc(own ? opts.title || "Senast värderade kort" : "Mest sökta trendkort")}</h2></div>
        <p class="recent-hint">${esc(own ? opts.hint || "Dina senaste kort. Sparas bara i den här webbläsaren." : "Tryck på ett kort för att värdera det.")}${own ? ' <button type="button" class="recent-clear">Rensa</button>' : ""}</p>
      </header>
      <div class="recent-row" role="list">${list.map((c, i) => {
        const price = c.eur != null ? kr(c.eur * rate) : "Inget pris";
        const sub = [c.set, c.localId && (c.total ? `${c.localId}/${c.total}` : c.localId)].filter(Boolean).join(" · ");
        const meta = own ? `<b class="rbadge">${c.count} ${c.count === 1 ? "gång" : "gånger"}</b><small>${ago(c.t)}</small>`
          : `<b class="rbadge">#${i + 1}</b>${c.change != null ? `<small class="${c.change >= 0 ? "up" : "down"}">${c.change >= 0 ? "▲" : "▼"} ${String(Math.abs(c.change)).replace(".", ",")} %</small>` : ""}`;
        return `<a class="rcard" role="listitem" href="vardering.html?id=${encodeURIComponent(c.id)}" data-id="${esc(c.id)}">
          <span class="rimg">${c.image ? `<img src="${esc(c.image)}/low.webp" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ""}</span>
          <span class="rbody"><span class="rmeta">${meta}</span><b class="rname">${esc(c.name)}</b><small class="rset">${esc(sub)}</small><span class="rprice">${price}</span></span>
        </a>`;
      }).join("")}</div>`;
  };
  root.addEventListener("click", (e) => {
    if (e.target.closest(".recent-clear")) { write([]); render(); return; }
    const a = e.target.closest(".rcard");
    if (a && opts.onPick) { e.preventDefault(); opts.onPick(a.dataset.id); root.scrollIntoView?.({ block: "nearest" }); }
  });
  document.addEventListener("recent-cards-changed", render);
  render();
}
