// Kortskanner: läser kortets namn och nummer med kameran och hittar kortet i TCGdex.
// Allt körs i webbläsaren med Tesseract (textigenkänning). Ingen AI-tjänst och ingen nyckel.
import { API, esc, getJSON } from "./site.js";
import { loadDataset } from "./card-autocomplete.js";

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const SCAN_EVERY = 1200; // ms mellan försöken medan kameran är på

// ---------- Textigenkänning ----------
let workerPromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("Kunde inte ladda textläsaren."));
    document.head.append(s);
  });
}
function getWorker() {
  if (!workerPromise) {
    workerPromise = (window.Tesseract ? Promise.resolve() : loadScript(TESSERACT))
      .then(() => window.Tesseract.createWorker("eng"))
      .catch((err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

// Klipper ut en del av kortet (andelar av bredd och höjd) och förstorar den, så att liten text blir läsbar.
function crop(src, x, y, w, h, scale) {
  const sw = src.width * w, sh = src.height * h;
  const cv = document.createElement("canvas");
  cv.width = Math.round(sw * scale); cv.height = Math.round(sh * scale);
  const g = cv.getContext("2d");
  g.filter = "grayscale(1) contrast(1.4)";
  g.drawImage(src, src.width * x, src.height * y, sw, sh, 0, 0, cv.width, cv.height);
  return cv;
}

// ---------- Tolka texten ----------
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
function editDist(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

let nameIndex = null;
async function names() {
  if (!nameIndex) {
    const data = await loadDataset().catch(() => null);
    nameIndex = (data?.pokemon || []).map((p) => ({ name: p.name, key: norm(p.name) })).filter((p) => p.key.length >= 3);
  }
  return nameIndex;
}

// Letar efter ett Pokémonnamn bland orden, ett eller två ord i taget ("Mr. Mime", "Iron Valiant").
// Rader högre upp på kortet vinner, eftersom namnet står överst.
function findName(lines, list) {
  let best = null;
  lines.forEach((line, row) => {
    const words = line.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      for (const n of [1, 2]) {
        if (i + n > words.length) continue;
        const key = norm(words.slice(i, i + n).join(" "));
        if (key.length < 3) continue;
        const tol = key.length >= 10 ? 2 : key.length >= 5 ? 1 : 0;
        for (const p of list) {
          if (Math.abs(p.key.length - key.length) > tol) continue;
          const dist = p.key === key ? 0 : editDist(p.key, key);
          if (dist > tol) continue;
          const score = row * 3 + dist * 2 - p.key.length * 0.1;
          if (!best || score < best.score) best = { name: p.name, score };
        }
      }
    }
  });
  return best?.name || null;
}

// Kortnummer som "4/102", "025/198" eller "TG05/TG30". Vanliga lästfel (O→0, l→1) rättas först.
function findNumber(text) {
  const fixed = text.replace(/(?<=\d|\/)[oO]|[oO](?=\d|\/)/g, "0").replace(/(?<=\d|\/)[lI|]|[lI|](?=\d|\/)/g, "1");
  const m = fixed.match(/\b([A-Z]{0,2}\d{1,3}[a-z]?)\s*\/\s*([A-Z]{0,2}\d{2,3})\b/);
  return m ? { number: m[1].replace(/^0+(?=\d)/, ""), total: m[2] } : null;
}

export async function readCard(canvas) {
  const worker = await getWorker();
  const list = await names();
  // Namnet står i översta delen, numret i nedersta. Små utsnitt läses snabbare och säkrare än hela kortet.
  const top = await worker.recognize(crop(canvas, 0, 0, 1, 0.16, 1000 / canvas.width));
  const bottom = await worker.recognize(crop(canvas, 0, 0.84, 1, 0.16, 1600 / canvas.width));
  const lines = top.data.text.split("\n").map((l) => l.trim()).filter(Boolean);
  let name = findName(lines, list);
  let num = findNumber(bottom.data.text) || findNumber(top.data.text);
  // Foto med bakgrund runt kortet: läs hela bilden om utsnitten inte räckte.
  if (!name || !num) {
    const all = await worker.recognize(crop(canvas, 0, 0, 1, 1, Math.min(2, 1400 / canvas.width)));
    const allLines = all.data.text.split("\n").map((l) => l.trim()).filter(Boolean);
    name = name || findName(allLines, list);
    num = num || findNumber(all.data.text);
  }
  return { name, number: num?.number || null, total: num?.total || null };
}

// ---------- Matcha mot TCGdex ----------
let setsPromise = null;
const setCounts = () => (setsPromise ||= getJSON(`${API}/sets`).then((sets) => new Map(sets.map((s) => [s.id, s.cardCount || {}]))).catch(() => new Map()));
const setOf = (id) => id.slice(0, id.lastIndexOf("-"));

// Behåller kort vars set har lika många kort som siffran efter snedstrecket, t.ex. 102 i "4/102".
export async function narrowByTotal(list, total) {
  if (!total || !/^\d+$/.test(total) || list.length < 2) return list;
  const counts = await setCounts();
  const hit = list.filter((c) => { const n = counts.get(setOf(c.id)); return n && (n.official === +total || n.total === +total); });
  return hit.length ? hit : list;
}

// ---------- Jämför bilder ----------
// När numret inte går att läsa (t.ex. liten vit text på fullbildskort) väljs det kort vars bild liknar fotot mest.
// Varje bild krymps till 16 × 22 rutor, och färgerna normaliseras så att ljus och vitbalans spelar mindre roll.
const SIG_W = 16, SIG_H = 22;
function signature(src) {
  const cv = document.createElement("canvas");
  cv.width = SIG_W; cv.height = SIG_H;
  const g = cv.getContext("2d", { willReadFrequently: true });
  const w = src.width, h = src.height;
  g.drawImage(src, w * 0.05, h * 0.04, w * 0.9, h * 0.92, 0, 0, SIG_W, SIG_H); // kanterna skiljer sig mest mellan foto och skanning
  const px = g.getImageData(0, 0, SIG_W, SIG_H).data, out = new Float32Array(SIG_W * SIG_H * 3);
  for (let c = 0; c < 3; c++) {
    let sum = 0, sq = 0;
    for (let i = 0; i < SIG_W * SIG_H; i++) { const v = px[i * 4 + c]; sum += v; sq += v * v; }
    const n = SIG_W * SIG_H, mean = sum / n, sd = Math.sqrt(sq / n - mean * mean) || 1;
    for (let i = 0; i < n; i++) out[i * 3 + c] = (px[i * 4 + c] - mean) / sd;
  }
  return out;
}
const distance = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) ** 2; return d / a.length; };

const sigCache = new Map();
function cardSignature(card) {
  if (!sigCache.has(card.id)) {
    // TCGdex skickar ibland ett trasigt CORS-huvud för en bild. Ett annat format av samma bild fungerar då.
    const load = (ext) => new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { try { resolve(signature(img)); } catch { resolve(null); } };
      img.onerror = () => resolve(null);
      img.src = `${card.image}/low.${ext}`;
    });
    sigCache.set(card.id, (async () => (await load("webp")) || (await load("png")) || load("jpg"))());
  }
  return sigCache.get(card.id);
}

// Sorterar korten efter hur lika de är fotot. sure: bästa träffen är tydligt bättre än tvåan.
export async function rankByLook(canvas, list, limit = 150) {
  const withImg = list.filter((c) => c.image).slice(0, limit);
  if (!canvas || withImg.length < 2) return { list, sure: list.length === 1 };
  const mine = signature(canvas);
  const scored = [];
  for (let i = 0; i < withImg.length; i += 12) { // tolv bilder åt gången
    const sigs = await Promise.all(withImg.slice(i, i + 12).map(cardSignature));
    sigs.forEach((s, k) => { if (s) scored.push({ card: withImg[i + k], d: distance(mine, s) }); });
  }
  scored.sort((a, b) => a.d - b.d);
  const rest = list.filter((c) => !scored.some((s) => s.card === c));
  const sure = scored.length > 1 && scored[0].d < 0.8 && scored[0].d < scored[1].d * 0.7;
  return { list: [...scored.map((s) => s.card), ...rest], sure };
}

// ---------- Kamerafönstret ----------
let dialog = null, stream = null, timer = null, busy = false, onFound = null;

function ui() {
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.className = "scan";
  dialog.setAttribute("aria-label", "Skanna kort");
  dialog.innerHTML = `<div class="scan-view">
      <video playsinline muted autoplay></video>
      <div class="scan-frame" aria-hidden="true"><i></i></div>
      <p class="scan-tip">Håll kortet inom ramen, rakt framifrån och utan reflexer.</p>
    </div>
    <p class="scan-status" role="status" aria-live="polite">Startar kameran…</p>
    <div class="scan-actions">
      <label class="btn small">Välj foto<input type="file" accept="image/*" hidden></label>
      <button class="btn small" type="button" data-close>Stäng</button>
    </div>`;
  document.body.append(dialog);
  dialog.addEventListener("close", stop);
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  dialog.querySelector("input[type=file]").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const img = await createImageBitmap(file).catch(() => null);
    if (!img) return status("Bilden gick inte att läsa.");
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    cv.getContext("2d").drawImage(img, 0, 0);
    clearInterval(timer);
    await attempt(trimBackground(cv), true);
  });
  return dialog;
}
const status = (t) => { dialog.querySelector(".scan-status").innerHTML = t; };

// Valt foto: klipper bort en jämn bakgrund (bord, matta) runt kortet, så att bara kortet jämförs och läses.
function trimBackground(src) {
  const s = Math.min(1, 400 / Math.max(src.width, src.height));
  const w = Math.round(src.width * s), h = Math.round(src.height * s);
  const g = Object.assign(document.createElement("canvas"), { width: w, height: h }).getContext("2d", { willReadFrequently: true });
  g.drawImage(src, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const at = (x, y) => (y * w + x) * 4;
  const bg = [0, 1, 2].map((c) => (px[at(2, 2) + c] + px[at(w - 3, 2) + c] + px[at(2, h - 3) + c] + px[at(w - 3, h - 3) + c]) / 4);
  const differs = (i) => Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) > 90;
  const rowHit = (y) => { let n = 0; for (let x = 0; x < w; x++) n += differs(at(x, y)); return n > w * 0.25; };
  const colHit = (x) => { let n = 0; for (let y = 0; y < h; y++) n += differs(at(x, y)); return n > h * 0.25; };
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  while (top < bottom && !rowHit(top)) top++;
  while (bottom > top && !rowHit(bottom)) bottom--;
  while (left < right && !colHit(left)) left++;
  while (right > left && !colHit(right)) right--;
  const cw = (right - left + 1) / s, ch = (bottom - top + 1) / s;
  // Ingen tydlig kortform hittad: använd hela bilden.
  if (cw < src.width * 0.3 || ch < src.height * 0.3 || Math.abs(cw / ch - 63 / 88) > 0.15) return src;
  const out = Object.assign(document.createElement("canvas"), { width: Math.round(cw), height: Math.round(ch) });
  out.getContext("2d").drawImage(src, left / s, top / s, cw, ch, 0, 0, out.width, out.height);
  return out;
}

// Tar den del av videobilden som syns innanför ramen.
function grabFrame() {
  const video = dialog.querySelector("video"), frame = dialog.querySelector(".scan-frame i");
  if (!video.videoWidth) return null;
  const vr = video.getBoundingClientRect(), fr = frame.getBoundingClientRect();
  const k = Math.max(vr.width / video.videoWidth, vr.height / video.videoHeight); // object-fit: cover
  const ox = (vr.width - video.videoWidth * k) / 2, oy = (vr.height - video.videoHeight * k) / 2;
  const sx = (fr.left - vr.left - ox) / k, sy = (fr.top - vr.top - oy) / k, sw = fr.width / k, sh = fr.height / k;
  const cv = document.createElement("canvas");
  cv.width = Math.round(sw); cv.height = Math.round(sh);
  cv.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  return cv;
}

let last = null;
async function attempt(canvas, fromFile = false) {
  if (busy) return;
  busy = true;
  try {
    const r = await readCard(canvas);
    if (!dialog.open) return;
    const seen = [r.name, r.number && `${r.number}/${r.total}`].filter(Boolean).join(" · ");
    // Kameran: kräv namn och nummer, eller samma namn två gånger i rad, så att en suddig bild inte avgör.
    const sure = r.name && (r.number || fromFile || last === r.name);
    last = r.name;
    if (sure) {
      status(`Hittade <b>${esc(seen)}</b>`);
      stop();
      dialog.close();
      onFound?.({ ...r, canvas });
    } else {
      status(seen ? `Läser… <b>${esc(seen)}</b>` : fromFile ? "Hittade inget kortnamn i bilden. Prova ett skarpare foto rakt framifrån." : "Letar efter kortets namn och nummer…");
    }
  } catch (err) {
    status(esc(err.message || "Något gick fel. Försök igen."));
  } finally {
    busy = false;
  }
}

function stop() {
  clearInterval(timer); timer = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

export async function openScanner(callback) {
  onFound = callback; last = null;
  ui().showModal();
  status("Startar kameran…");
  getWorker().catch(() => {}); // börja ladda textläsaren direkt
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    const video = dialog.querySelector("video");
    video.srcObject = stream;
    await video.play();
    status("Letar efter kortets namn och nummer…");
    timer = setInterval(() => { const cv = grabFrame(); if (cv) attempt(cv); }, SCAN_EVERY);
  } catch {
    dialog.querySelector(".scan-view").classList.add("nocam");
    status("Kameran går inte att använda här. Välj ett foto av kortet i stället.");
  }
}
