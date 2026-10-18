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
const pins = [...document.querySelectorAll(".val-anatomy-front .val-pin")];
const points = new Map([...document.querySelectorAll(".val-anatomy-points li")]
  .map((li) => [li.querySelector(".val-point-badge").textContent.trim(), li]));
let dlg = null;

function popup(n) {
  const li = points.get(n);
  if (!li) return;
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "pin-dlg";
    dlg.innerHTML = '<button type="button" class="cm-close" aria-label="Stäng">✕</button><div class="pin-body"></div>';
    document.body.append(dlg);
    dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest(".cm-close")) dlg.close(); });
  }
  dlg.querySelector(".pin-body").innerHTML = `<span class="val-point-badge">${n}</span>
    <h3>${li.querySelector("strong").innerHTML}</h3><p>${li.querySelector("p").innerHTML}</p>`;
  dlg.showModal();
}

for (const pin of pins) {
  pin.addEventListener("click", () => MOBILE.matches && popup(pin.textContent.trim()));
  pin.addEventListener("keydown", (e) => {
    if (MOBILE.matches && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); popup(pin.textContent.trim()); }
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
  if (!m && dlg?.open) dlg.close();
}
MOBILE.addEventListener("change", sync);
sync();
