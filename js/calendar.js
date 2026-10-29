// Månadskalender för släppsidan. Vet inget om släppen själva: den får händelser per datum och
// säger till (onDay) när någon trycker på en dag.
import { $, esc } from "./site.js";

export const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

// Färgen visar spelet: Pokémon (pk), One Piece (op) eller Riftbound (rb).
export const dot = (it) => `<i class="lg g-${it.game || "pk"}"></i>`;
const chip = (it) => `<li class="ev ${it.kind === "set" ? "ev-set" : "ev-drop"} g-${it.game || "pk"}" title="${esc(it.title)}">
  ${it.logo || it.setLogo ? `<img class="ev-logo" src="${esc(it.logo || it.setLogo)}" alt="" loading="lazy">` : ""}
  <span>${esc(it.title)}</span></li>`;

// events: Map "ÅÅÅÅ-MM-DD" → [{ kind: "drop" | "set", game: "pk" | "op" | "rb", title, sub, logo, setLogo }]
export function mountCalendar(events, onDay) {
  const now = new Date();
  const todayKey = dayKey(now.getFullYear(), now.getMonth(), now.getDate());
  let view = { y: now.getFullYear(), m: now.getMonth() };
  // Startmånad från adressen (#2026-11), så att en månad går att länka till.
  const fromHash = location.hash.match(/^#(\d{4})-(\d{2})$/);
  if (fromHash) view = { y: +fromHash[1], m: +fromHash[2] - 1 };

  function render() {
    const { y, m } = view;
    $("#cal-title").textContent = `${MONTHS[m][0].toUpperCase()}${MONTHS[m].slice(1, 3)} ${y}`;
    // Veckan börjar på måndag.
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    const cells = Math.ceil((lead + new Date(y, m + 1, 0).getDate()) / 7) * 7;
    let html = "";
    for (let i = 0; i < cells; i++) {
      const d = new Date(y, m, i - lead + 1);
      const k = dayKey(d.getFullYear(), d.getMonth(), d.getDate());
      const items = events.get(k) || [];
      const cls = ["day", d.getMonth() === m ? "" : "out", k === todayKey ? "today" : "", items.length ? "has" : "", i % 7 > 4 ? "weekend" : ""].filter(Boolean).join(" ");
      const today = k === todayKey;
      html += `<div class="${cls}" role="gridcell"${items.length ? ` tabindex="0" data-day="${k}"` : ""} aria-label="${d.getDate()} ${MONTHS[d.getMonth()]}${today ? ", i dag" : ""}${items.length ? `, ${items.length} släpp` : ""}">
        <span class="num">${d.getDate()}</span>${today ? '<img class="today-ninja" src="logo.svg" alt="" aria-hidden="true">' : ""}
        ${items.length ? `<ul class="evs">${items.map(chip).join("")}</ul><span class="dots" aria-hidden="true">${items.map(dot).join("")}</span>` : ""}
      </div>`;
    }
    $("#days").innerHTML = html;

    // Listan under rutnätet (syns på mobilen, där rutorna är för små för text).
    const keys = [...events.keys()].filter((k) => k.startsWith(`${y}-${pad(m + 1)}`)).sort();
    $("#agenda").innerHTML = keys.length ? keys.map((k) => {
      const d = new Date(`${k}T12:00:00`);
      return `<li><button type="button" class="ag${k < todayKey ? " past" : ""}" data-day="${k}">
        <span class="ag-date"><b>${d.getDate()}</b><span>${MONTHS[d.getMonth()].slice(0, 3)}</span></span>
        <span class="ag-list">${events.get(k).map((it) => `<span>${dot(it)}<b>${esc(it.title)}</b>${it.sub ? ` · ${esc(it.sub)}` : ""}</span>`).join("")}</span>
      </button></li>`;
    }).join("") : `<li class="msg">Inga släpp inlagda i ${MONTHS[m]}.</li>`;
    history.replaceState(null, "", `#${y}-${pad(m + 1)}`);
  }

  function step(n) {
    const d = new Date(view.y, view.m + n, 1);
    view = { y: d.getFullYear(), m: d.getMonth() };
    render();
  }
  $("#prev").addEventListener("click", () => step(-1));
  $("#next").addEventListener("click", () => step(1));
  $("#today").addEventListener("click", () => { view = { y: now.getFullYear(), m: now.getMonth() }; render(); });
  // Hoppar till månaden med det första släppet från och med i dag, så att kommande släpp går att hitta.
  // Dagen blinkar till, så att det syns var släppet ligger även när det redan är rätt månad.
  const nextKey = [...events.keys()].filter((k) => k >= todayKey).sort()[0];
  $("#jump").disabled = !nextKey;
  $("#jump").addEventListener("click", () => {
    if (!nextKey) return;
    view = { y: +nextKey.slice(0, 4), m: +nextKey.slice(5, 7) - 1 };
    render();
    const cell = $(`#days [data-day="${nextKey}"]`);
    cell?.classList.add("jumped");
    cell?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setTimeout(() => cell?.classList.remove("jumped"), 1600);
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input,select,textarea,dialog")) return;
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });
  const open = (e) => { const day = e.target.closest("[data-day]"); if (day) onDay(day.dataset.day); };
  $("#days").addEventListener("click", open);
  $("#days").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); } });
  $("#agenda").addEventListener("click", open);
  render();
  // Släppsidans spelfilter byter händelser och ritar om samma månad.
  return render;
}
