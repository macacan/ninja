// Mobilanpassningar på värderingssidan: stegen som dragspel och kortöversikten med tryckbara punkter.
// Allt gäller bara på smal skärm, på desktop är sidan oförändrad.
const MOBILE = matchMedia("(max-width: 640px)");

// ---------- Stegen: bara rubrikerna syns, texten öppnas vid tryck ----------
const cards = [...document.querySelectorAll(".val-how-card")];
function toggle(card, open = !card.classList.contains("open")) {
  card.classList.toggle("open", open);
  card.querySelector("h3").setAttribute("aria-expanded", open);
}
for (const card of cards) {
  const h = card.querySelector("h3");
  h.addEventListener("click", () => MOBILE.matches && toggle(card));
  h.addEventListener("keydown", (e) => {
    if (MOBILE.matches && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(card); }
  });
}

// ---------- Kortöversikten: tryck på en del av kortet för förklaringen ----------
const pins = [...document.querySelectorAll(".val-anatomy-visual .val-pin")];
const points = new Map([...document.querySelectorAll(".val-anatomy-points li")]
  .map((li) => [li.querySelector(".val-point-badge").textContent.trim(), li]));
const visual = document.querySelector(".val-anatomy-visual");
let bubble = null, openPin = null;

function closeBubble() {
  bubble?.remove(); bubble = null;
  openPin?.classList.remove("on"); openPin = null;
}

// Pratbubbla som växer fram från punkten: under punkten om den sitter högt upp, annars ovanför.
function popup(pin) {
  if (openPin === pin) return closeBubble();
  const li = points.get(pin.textContent.trim());
  if (!li) return;
  closeBubble();
  openPin = pin; pin.classList.add("on");
  bubble = document.createElement("div");
  bubble.className = "pin-bubble";
  bubble.setAttribute("role", "status");
  bubble.innerHTML = `<strong>${li.querySelector("strong").innerHTML}</strong><p>${li.querySelector("p").innerHTML}</p>`;
  visual.append(bubble);
  const v = visual.getBoundingClientRect(), p = pin.getBoundingClientRect();
  const px = p.left + p.width / 2 - v.left, py = p.top + p.height / 2 - v.top;
  const w = Math.min(270, v.width - 8);
  bubble.style.width = w + "px";
  const left = Math.max(4, Math.min(px - w / 2, v.width - w - 4));
  const below = py < v.height / 2;
  bubble.classList.toggle("below", below);
  bubble.style.left = left + "px";
  bubble.style.setProperty("--ax", Math.max(14, Math.min(px - left, w - 14)) + "px");
  if (below) bubble.style.top = py + p.height / 2 + 10 + "px";
  else bubble.style.bottom = v.height - py + p.height / 2 + 10 + "px";
  bubble.style.transformOrigin = (px - left) + "px " + (below ? "0" : "100%");
}

document.addEventListener("click", (e) => { if (bubble && !e.target.closest(".val-pin, .pin-bubble")) closeBubble(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeBubble(); });

for (const pin of pins) {
  pin.addEventListener("click", () => MOBILE.matches && popup(pin));
  pin.addEventListener("keydown", (e) => {
    if (MOBILE.matches && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); popup(pin); }
  });
}

// Tillgänglighetsattribut bara när de gäller.
function sync() {
  const m = MOBILE.matches;
  for (const card of cards) {
    const h = card.querySelector("h3");
    if (m) { h.setAttribute("role", "button"); h.tabIndex = 0; h.setAttribute("aria-expanded", card.classList.contains("open")); }
    else { h.removeAttribute("role"); h.removeAttribute("tabindex"); h.removeAttribute("aria-expanded"); }
  }
  for (const pin of pins) {
    if (m) { pin.setAttribute("role", "button"); pin.tabIndex = 0; pin.setAttribute("aria-label", `Visa: ${points.get(pin.textContent.trim())?.querySelector("strong").textContent || ""}`); }
    else { pin.removeAttribute("role"); pin.removeAttribute("tabindex"); pin.removeAttribute("aria-label"); }
  }
  if (!m) closeBubble();
}
MOBILE.addEventListener("change", sync);
sync();
