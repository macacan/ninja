// Visar ett säkert identifierat kort med marknadsvärde. Ju mer kortet är värt, desto finare animation.
import { esc, kr, cardImg } from "./site.js";

// Nivåerna börjar vid det lägsta beloppet. Under 100 kr visas kortet utan pengaeffekter.
const TIERS = [
  { min: 10000, name: "legendary", coins: 160, rays: true, confetti: true, shake: true },
  { min: 5000, name: "epic", coins: 100, rays: true, confetti: true },
  { min: 1000, name: "gold", coins: 60, sparkle: true },
  { min: 500, name: "rare", coins: 30, sheen: true },
  { min: 100, name: "good", coins: 12 },
];
const tierOf = (v) => TIERS.find((t) => v >= t.min) || null;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const rnd = (a, b) => a + Math.random() * (b - a);

let dlg = null;
function ensure() {
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.className = "scan rv-dlg";
  dlg.setAttribute("aria-label", "Kortet är identifierat");
  dlg.innerHTML = `
    <div class="rv-stage">
      <div class="rv-fx" aria-hidden="true"></div>
      <div class="rv-card"><img alt="" referrerpolicy="no-referrer"></div>
      <div class="rv-info">
        <p class="rv-kicker">Säker träff</p>
        <h2 class="rv-name"></h2>
        <p class="muted rv-set"></p>
        <p class="rv-value" aria-live="polite"></p>
      </div>
      <div class="rv-actions">
        <button type="button" class="scan-ghost" data-close>Stäng</button>
        <button type="button" class="scan-now rv-grade">Gradera</button>
      </div>
    </div>`;
  document.body.append(dlg);
  dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  return dlg;
}

// Pengaregn av mynt, plus strålar och konfetti för de högsta nivåerna.
function burst(fx, tier) {
  fx.innerHTML = "";
  if (!tier || reduceMotion) return;
  for (let i = 0; i < tier.coins; i++) {
    const c = document.createElement("span");
    c.className = "rv-coin";
    c.style.cssText = `left:${rnd(0, 100)}%;--d:${rnd(0, 1.2).toFixed(2)}s;--t:${rnd(1.8, 3).toFixed(2)}s;--s:${rnd(14, 26).toFixed(0)}px`;
    fx.append(c);
  }
  if (tier.rays) {
    const r = document.createElement("span");
    r.className = "rv-rays";
    fx.append(r);
  }
  if (tier.confetti) {
    const colors = ["#f0b90b", "#22d3ee", "#a855f7", "#ffffff", "#10b981"];
    for (let i = 0; i < 90; i++) {
      const c = document.createElement("span");
      c.className = "rv-conf";
      c.style.cssText = `left:${rnd(0, 100)}%;--d:${rnd(0, 0.8).toFixed(2)}s;--t:${rnd(2.2, 3.6).toFixed(2)}s;--x:${rnd(-120, 120).toFixed(0)}px;--r:${rnd(-540, 540).toFixed(0)}deg;background:${colors[i % colors.length]}`;
      fx.append(c);
    }
  }
  if (tier.sparkle) {
    for (let i = 0; i < 14; i++) {
      const s = document.createElement("span");
      s.className = "rv-spark";
      s.style.cssText = `left:${rnd(5, 95)}%;top:${rnd(5, 95)}%;--d:${rnd(0, 2).toFixed(2)}s`;
      fx.append(s);
    }
  }
}

// Räknar upp värdet från noll, så att summan växer fram.
function countUp(el, to) {
  if (reduceMotion || !to) { el.textContent = kr(to); return; }
  const start = performance.now(), dur = 1100;
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = kr(to * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// card: kortet från TCGdex. sek: marknadsvärdet i kronor, eller null. onGrade körs när man trycker Gradera.
export function showReveal({ card, sek, onGrade }) {
  const d = ensure();
  const tier = sek != null ? tierOf(sek) : null;
  const img = cardImg(card, "high") || "img/kortbaksida.webp";

  d.className = `scan rv-dlg${tier ? ` rv-${tier.name}` : ""}`;
  const stage = d.querySelector(".rv-stage");
  stage.classList.remove("rv-in");
  void stage.offsetWidth; // startar om kortets inflygning
  stage.classList.add("rv-in");

  const cardImgEl = d.querySelector(".rv-card img");
  cardImgEl.src = img;
  cardImgEl.alt = card.name;
  d.querySelector(".rv-name").textContent = card.name;
  d.querySelector(".rv-set").textContent = `${card.set?.name || ""} · #${card.localId || ""}`;

  const value = d.querySelector(".rv-value");
  if (sek != null) {
    value.innerHTML = `<b></b><small>Cardmarkets trendpris i nyskick</small>`;
    countUp(value.querySelector("b"), sek);
  } else {
    value.innerHTML = `<small>Cardmarket har inget pris för kortet än.</small>`;
  }

  burst(d.querySelector(".rv-fx"), tier);
  d.querySelector(".rv-grade").onclick = () => { d.close(); onGrade?.(); };
  d.showModal();
}
