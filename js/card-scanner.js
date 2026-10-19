// Kortskanner: läser kortets namn och nummer med kameran och hittar kortet i TCGdex.
// Inspirerad av mtg_card_detector och Pokemon-Card-Scanner:
// 1. 4-punkts perspektivtransformation (homografi) rätsiktar sneda kort till ett platt 63×88 mm-format.
// 2. Reflexdämpning (glare reduction) i HSV-färgrymden mot blänk från plastfickor och holokort.
// 3. Dubbel-zon-OCR (läser översta namnzonen och nedersta numret i hög kontrast).
// 4. Perceptual dHash (64-bitars skillnadshash) för visuell strukturell fingeravtrycksmatchning.
import { API, esc, getJSON } from "./site.js";
import { loadDataset } from "./card-autocomplete.js";

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const SCAN_INTERVAL = 900; // ms mellan OCR-försök under aktiv kameraström
const CARD_W = 420;
const CARD_H = 587; // Exakt 63:88 mm Pokémon-kortproportioner

// ---------- Textigenkänning (Tesseract) ----------
let workerPromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Kunde inte ladda textläsaren."));
    document.head.append(s);
  });
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (window.Tesseract ? Promise.resolve() : loadScript(TESSERACT))
      .then(() => window.Tesseract.createWorker("eng"))
      .catch((err) => {
        workerPromise = null;
        throw err;
      });
  }
  return workerPromise;
}

// ---------- 1. 4-punkts Perspektivtransformation (Homografi / Deskew) ----------
// Rätsiktar ett godtyckligt fyrsidigt område till en rektangulär fågelperspektiv-bild.
// Inspirerat av Four-Point Transform i OpenCV (pyimagesearch / mtg_card_detector).
export function getProjectiveTransform(srcCorners, dstW, dstH) {
  const [x0, y0] = srcCorners[0]; // Topp-vänster
  const [x1, y1] = srcCorners[1]; // Topp-höger
  const [x2, y2] = srcCorners[2]; // Botten-höger
  const [x3, y3] = srcCorners[3]; // Botten-vänster

  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const sx = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sy = y0 - y1 + y2 - y3;

  let a, b, c, d, e, f, g, h;
  if (Math.abs(sx) < 1e-4 && Math.abs(sy) < 1e-4) {
    // Affin transformation (parallellogram)
    a = x1 - x0; b = x2 - x1; c = x0;
    d = y1 - y0; e = y2 - y1; f = y0;
    g = 0; h = 0;
  } else {
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-7) return null;
    g = (sx * dy2 - sy * dx2) / det;
    h = (dx1 * sy - dy1 * sx) / det;
    a = x1 - x0 + g * x1;
    b = x3 - x0 + h * x3;
    c = x0;
    d = y1 - y0 + g * y1;
    e = y3 - y0 + h * y3;
    f = y0;
  }

  return (u, v) => {
    const s = u / dstW, t = v / dstH;
    const w = g * s + h * t + 1;
    return [(a * s + b * t + c) / w, (d * s + e * t + f) / w];
  };
}

// Skapar en rätad $420 \times 587$ canvas ur en källbild (video/foto) med 4 hörn.
export function unwarpCard(srcImage, corners, dstW = CARD_W, dstH = CARD_H) {
  const map = getProjectiveTransform(corners, dstW, dstH);
  const outCanvas = document.createElement("canvas");
  outCanvas.width = dstW;
  outCanvas.height = dstH;
  const outCtx = outCanvas.getContext("2d", { willReadFrequently: true });

  const sw = srcImage.videoWidth || srcImage.width;
  const sh = srcImage.videoHeight || srcImage.height;
  if (!sw || !sh) return outCanvas;

  if (!map) {
    outCtx.drawImage(srcImage, 0, 0, dstW, dstH);
    return outCanvas;
  }

  // Läs källbildens pixlar
  const srcCv = document.createElement("canvas");
  srcCv.width = sw;
  srcCv.height = sh;
  const srcCtx = srcCv.getContext("2d", { willReadFrequently: true });
  srcCtx.drawImage(srcImage, 0, 0, sw, sh);
  const srcData = srcCtx.getImageData(0, 0, sw, sh).data;

  const outData = outCtx.createImageData(dstW, dstH);
  const outPx = outData.data;

  for (let y = 0; y < dstH; y++) {
    const rowOffset = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      const [sx, sy] = map(x, y);
      const isx = Math.round(sx);
      const isy = Math.round(sy);
      if (isx >= 0 && isx < sw && isy >= 0 && isy < sh) {
        const sidx = (isy * sw + isx) * 4;
        const didx = rowOffset + x * 4;
        outPx[didx] = srcData[sidx];
        outPx[didx + 1] = srcData[sidx + 1];
        outPx[didx + 2] = srcData[sidx + 2];
        outPx[didx + 3] = 255;
      }
    }
  }

  outCtx.putImageData(outData, 0, 0);
  return outCanvas;
}

// ---------- 2. Reflex- och blänkreduktion (mtg_card_detector-stil) ----------
// Filtrerar bort vita mättnadslösa reflexer orsakade av ficklampor, blixt eller taklampor på plastfickor/folie.
export function suppressGlare(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max > 0 ? (max - min) / max : 0;
    // Glare: mycket låg mättnad och hög ljusstyrka
    if (sat < 0.16 && max > 210) {
      const soften = 0.65 + sat * 1.5;
      d[i] = Math.round(r * soften);
      d[i + 1] = Math.round(g * soften);
      d[i + 2] = Math.round(b * soften);
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

// Skapar ett kontrastförstärkt, binärt utsnitt optimerat för Tesseract OCR
function cropEnhanced(src, xRatio, yRatio, wRatio, hRatio, scale = 2) {
  const sx = Math.round(src.width * xRatio);
  const sy = Math.round(src.height * yRatio);
  const sw = Math.round(src.width * wRatio);
  const sh = Math.round(src.height * hRatio);

  const cv = document.createElement("canvas");
  cv.width = Math.round(sw * scale);
  cv.height = Math.round(sh * scale);
  const g = cv.getContext("2d", { willReadFrequently: true });

  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, sx, sy, sw, sh, 0, 0, cv.width, cv.height);

  // Adaptiv binarisering och skärpa för textläsning
  const imgData = g.getImageData(0, 0, cv.width, cv.height);
  const d = imgData.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  }
  const mean = sum / (cv.width * cv.height);

  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    // Sträck ut kontrasten runt medelvärdet
    const val = lum < mean * 0.85 ? 0 : lum > mean * 1.15 ? 255 : Math.round((lum - mean * 0.85) * (255 / (mean * 0.3)));
    d[i] = val;
    d[i + 1] = val;
    d[i + 2] = val;
  }
  g.putImageData(imgData, 0, 0);
  return cv;
}

// ---------- 3. Perceptual dHash (Difference Hash) ----------
// Beräknar en 64-bitars gradienthash ur kortbilden för blixtsnabb visuell matchning utan nätverkslagg.
export function computeDHash(src) {
  const w = 9, h = 8;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const g = cv.getContext("2d", { willReadFrequently: true });
  g.drawImage(src, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i1 = (y * w + x) * 4;
      const i2 = (y * w + x + 1) * 4;
      const l1 = px[i1] * 0.299 + px[i1 + 1] * 0.587 + px[i1 + 2] * 0.114;
      const l2 = px[i2] * 0.299 + px[i2 + 1] * 0.587 + px[i2 + 2] * 0.114;
      if (l1 > l2) hash |= (1n << BigInt(y * 8 + x));
    }
  }
  return hash.toString(16).padStart(16, "0");
}

export function hammingDistance(h1, h2) {
  if (!h1 || !h2) return 64;
  let v = BigInt("0x" + h1) ^ BigInt("0x" + h2);
  let dist = 0;
  while (v > 0n) {
    dist += Number(v & 1n);
    v >>= 1n;
  }
  return dist;
}

// ---------- 4. Kant- och Hörndetektion i Realtid ----------
// Letar efter kortets konturer och 4 hörn med outside-in strålsökning.
// Söker från bildens ytterkanter inåt mot mitten, vilket garanterar att endast
// kortets sanna ytterkanter hittas (utan att luras av illustrationer eller text inuti kortet).
export function detectCardCorners(videoOrImg, fallbackRect) {
  const sw = videoOrImg.videoWidth || videoOrImg.width;
  const sh = videoOrImg.videoHeight || videoOrImg.height;
  if (!sw || !sh) return { corners: fallbackRect, confident: false };

  // Analysera i optimerad upplösning för 60 FPS
  const AW = 240, AH = 320;
  const cv = document.createElement("canvas");
  cv.width = AW; cv.height = AH;
  const g = cv.getContext("2d", { willReadFrequently: true });
  g.drawImage(videoOrImg, 0, 0, AW, AH);
  const data = g.getImageData(0, 0, AW, AH).data;

  // Sampla bakgrundsfärg från de fyra hörnen
  const sample = (x, y) => {
    const i = (y * AW + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const cornersBg = [sample(2, 2), sample(AW - 3, 2), sample(2, AH - 3), sample(AW - 3, AH - 3)];
  const bgR = cornersBg.reduce((s, c) => s + c[0], 0) / 4;
  const bgG = cornersBg.reduce((s, c) => s + c[1], 0) / 4;
  const bgB = cornersBg.reduce((s, c) => s + c[2], 0) / 4;

  const isCard = (x, y) => {
    const i = (y * AW + x) * 4;
    const diff = Math.abs(data[i] - bgR) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bgB);
    return diff > 45;
  };

  const points = [];
  const steps = 28;

  // Strålsökning från vänster och höger inåt
  for (let s = 1; s < steps; s++) {
    const y = Math.round((AH * s) / steps);
    for (let x = 0; x < AW * 0.46; x++) {
      if (isCard(x, y)) { points.push([x, y]); break; }
    }
    for (let x = AW - 1; x > AW * 0.54; x--) {
      if (isCard(x, y)) { points.push([x, y]); break; }
    }
  }

  // Strålsökning från topp och botten inåt
  for (let s = 1; s < steps; s++) {
    const x = Math.round((AW * s) / steps);
    for (let y = 0; y < AH * 0.46; y++) {
      if (isCard(x, y)) { points.push([x, y]); break; }
    }
    for (let y = AH - 1; y > AH * 0.54; y--) {
      if (isCard(x, y)) { points.push([x, y]); break; }
    }
  }

  // Om för få kantpunkter hittas, använd standardramen
  if (points.length < 18) {
    return { corners: fallbackRect, confident: false };
  }

  // 4 hörn via koordinatsummor och differenser (top-left, top-right, bottom-right, bottom-left)
  let tl = points[0], br = points[0], tr = points[0], bl = points[0];
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;

  for (const [x, y] of points) {
    const sum = x + y;
    const diff = y - x;
    if (sum < minSum) { minSum = sum; tl = [x, y]; }
    if (sum > maxSum) { maxSum = sum; br = [x, y]; }
    if (diff < minDiff) { minDiff = diff; tr = [x, y]; }
    if (diff > maxDiff) { maxDiff = diff; bl = [x, y]; }
  }

  // Skala tillbaka hörnen till källbildens fulla upplösning
  const scaleX = sw / AW;
  const scaleY = sh / AH;
  const fullCorners = [
    [tl[0] * scaleX, tl[1] * scaleY],
    [tr[0] * scaleX, tr[1] * scaleY],
    [br[0] * scaleX, br[1] * scaleY],
    [bl[0] * scaleX, bl[1] * scaleY],
  ];

  // Kontrollera att hörnen har rimliga kortproportioner (63:88 = 0.716)
  const topW = Math.hypot(fullCorners[1][0] - fullCorners[0][0], fullCorners[1][1] - fullCorners[0][1]);
  const botW = Math.hypot(fullCorners[2][0] - fullCorners[3][0], fullCorners[2][1] - fullCorners[3][1]);
  const leftH = Math.hypot(fullCorners[3][0] - fullCorners[0][0], fullCorners[3][1] - fullCorners[0][1]);
  const rightH = Math.hypot(fullCorners[2][0] - fullCorners[1][0], fullCorners[2][1] - fullCorners[1][1]);

  const avgW = (topW + botW) / 2;
  const avgH = (leftH + rightH) / 2;
  const ratio = avgW / (avgH || 1);

  const isCardShape = ratio >= 0.55 && ratio <= 0.92 && avgW > sw * 0.22 && avgH > sh * 0.25;
  return {
    corners: isCardShape ? fullCorners : fallbackRect,
    confident: isCardShape,
  };
}

// ---------- 5. Tolka Text och Pokémonnamn ----------
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

function findNumber(text) {
  if (!text) return null;
  const fixed = text
    .replace(/(?<=\d|\/)[oO]|[oO](?=\d|\/)/g, "0")
    .replace(/(?<=\d|\/)[lI|]|[lI|](?=\d|\/)/g, "1")
    .replace(/(\d)\s*\/\s*(\d)/g, "$1/$2");
  const m = fixed.match(/\b([A-Z]{0,2}\d{1,3}[a-z]?)\s*\/\s*([A-Z]{0,2}\d{2,3})\b/);
  return m ? { number: m[1].replace(/^0+(?=\d)/, ""), total: m[2] } : null;
}

// Läser kortet från ett rätat canvas ($420 \times 587$ px)
export async function readCard(canvas) {
  const worker = await getWorker();
  const list = await names();

  // Reflexdämpning på hela kortet
  suppressGlare(canvas);

  // Zon-OCR:
  // Namn överst: x: 4% till 85%, y: 2.5% till 14.5%
  // Bottenlinje (samlarnummer och copyright): x: 3% till 97%, y: 91% till 99%
  // Täcker både moderna kort (nummer nere till vänster) och vintage (nummer nere till höger)
  const topCrop = cropEnhanced(canvas, 0.04, 0.025, 0.82, 0.125, 2.0);
  const botCrop = cropEnhanced(canvas, 0.03, 0.908, 0.94, 0.082, 2.5);

  const [topRes, botRes] = await Promise.all([
    worker.recognize(topCrop),
    worker.recognize(botCrop),
  ]);

  const topLines = topRes.data.text.split("\n").map((l) => l.trim()).filter(Boolean);
  let name = findName(topLines, list);
  let num = findNumber(botRes.data.text) || findNumber(topRes.data.text);

  // Om OCR i zonerna inte räckte: läs hela kortet
  if (!name || !num) {
    const fullRes = await worker.recognize(cropEnhanced(canvas, 0, 0, 1, 1, 1.2));
    const allLines = fullRes.data.text.split("\n").map((l) => l.trim()).filter(Boolean);
    name = name || findName(allLines, list);
    num = num || findNumber(fullRes.data.text);
  }

  const dhash = computeDHash(canvas);
  return {
    name,
    number: num?.number || null,
    total: num?.total || null,
    dhash,
  };
}

// ---------- 6. Filtrera och Matcha mot TCGdex ----------
let setsPromise = null;
const setCounts = () => (setsPromise ||= getJSON(`${API}/sets`).then((sets) => new Map(sets.map((s) => [s.id, s.cardCount || {}]))).catch(() => new Map()));
const setOf = (id) => id.slice(0, id.lastIndexOf("-"));

export async function narrowByTotal(list, total) {
  if (!total || !/^\d+$/.test(total) || list.length < 2) return list;
  const counts = await setCounts();
  const hit = list.filter((c) => {
    const n = counts.get(setOf(c.id));
    return n && (n.official === +total || n.total === +total);
  });
  return hit.length ? hit : list;
}

// ---------- 7. Snabb bildmatchning med dHash ----------
const hashCache = new Map();
function cardHash(card) {
  if (!hashCache.has(card.id)) {
    const load = (ext) => new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          resolve(computeDHash(img));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = `${card.image}/low.${ext}`;
    });
    hashCache.set(card.id, (async () => (await load("webp")) || (await load("png")) || load("jpg"))());
  }
  return hashCache.get(card.id);
}

// Sorterar kandidatkorten efter visuell likhet via dHash
export async function rankByLook(canvas, list, limit = 150) {
  const withImg = list.filter((c) => c.image).slice(0, limit);
  if (!canvas || withImg.length < 2) return { list, sure: list.length === 1 };
  const myHash = computeDHash(canvas);
  const scored = [];

  for (let i = 0; i < withImg.length; i += 12) {
    const hashes = await Promise.all(withImg.slice(i, i + 12).map(cardHash));
    hashes.forEach((h, k) => {
      if (h) scored.push({ card: withImg[i + k], d: hammingDistance(myHash, h) });
    });
  }

  scored.sort((a, b) => a.d - b.d);
  const rest = list.filter((c) => !scored.some((s) => s.card === c));
  // Om bästa träffen har lågt Hamming-avstånd (< 16 bitar) och är tydligt bättre än tvåan
  const sure = scored.length > 1 && scored[0].d <= 15 && scored[0].d < scored[1].d * 0.75;
  return { list: [...scored.map((s) => s.card), ...rest], sure };
}

// ---------- 8. Kamerafönster & Interaktiv HUD ----------
let dialog = null, stream = null, timer = null, animFrame = null, busy = false, onFound = null;
let smoothedCorners = null;
let torchSupported = false, torchActive = false;

function ui() {
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.className = "scan";
  dialog.setAttribute("aria-label", "Skanna kort");
  dialog.innerHTML = `
    <div class="scan-view">
      <video playsinline muted autoplay></video>
      <canvas class="scan-hud" aria-hidden="true"></canvas>
      <div class="scan-frame" aria-hidden="true"><i></i></div>
      <button class="btn icon scan-torch" type="button" aria-label="Tänd ficklampa" hidden>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6l-6 12-2-6-6-2 14-4z"/>
        </svg>
      </button>
      <div class="scan-beam" aria-hidden="true"></div>
      <p class="scan-tip">Håll kortet inom ramen. Kortet rätas upp automatiskt.</p>
    </div>
    <div class="scan-hud-status">
      <div class="scan-status-dot" aria-hidden="true"></div>
      <p class="scan-status" role="status" aria-live="polite">Startar kameran…</p>
    </div>
    <div class="scan-actions">
      <label class="btn small">Välj foto<input type="file" accept="image/*" hidden></label>
      <button class="btn small" type="button" data-close>Stäng</button>
    </div>`;

  document.body.append(dialog);
  dialog.addEventListener("close", stop);
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());

  // Ficklampa
  const torchBtn = dialog.querySelector(".scan-torch");
  torchBtn.addEventListener("click", async () => {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    try {
      torchActive = !torchActive;
      await track.applyConstraints({ advanced: [{ torch: torchActive }] });
      torchBtn.classList.toggle("active", torchActive);
    } catch {}
  });

  // Välj foto från fil
  dialog.querySelector("input[type=file]").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const img = await createImageBitmap(file).catch(() => null);
    if (!img) return status("Bilden gick inte att läsa.");

    // Hitta hörn och rätsikta bilden automatiskt
    const defaultRect = [
      [img.width * 0.1, img.height * 0.1],
      [img.width * 0.9, img.height * 0.1],
      [img.width * 0.9, img.height * 0.9],
      [img.width * 0.1, img.height * 0.9],
    ];
    const { corners } = detectCardCorners(img, defaultRect);
    const unwarped = unwarpCard(img, corners);

    clearInterval(timer);
    cancelAnimationFrame(animFrame);
    await attempt(unwarped, true);
  });

  return dialog;
}

const status = (t) => {
  const el = dialog?.querySelector(".scan-status");
  if (el) el.innerHTML = t;
};

// Hämtar standardkoordinater för sökramen i video-koordinater
function getDefaultFrameCorners() {
  const video = dialog.querySelector("video");
  const frame = dialog.querySelector(".scan-frame i");
  if (!video.videoWidth || !frame) return null;

  const vr = video.getBoundingClientRect();
  const fr = frame.getBoundingClientRect();
  const k = Math.max(vr.width / video.videoWidth, vr.height / video.videoHeight); // object-fit: cover
  const ox = (vr.width - video.videoWidth * k) / 2;
  const oy = (vr.height - video.videoHeight * k) / 2;

  const sx = (fr.left - vr.left - ox) / k;
  const sy = (fr.top - vr.top - oy) / k;
  const sw = fr.width / k;
  const sh = fr.height / k;

  return [
    [sx, sy],
    [sx + sw, sy],
    [sx + sw, sy + sh],
    [sx, sy + sh],
  ];
}

// Ritar den levande HUD-ramen som visar när ett kort detekteras
function renderHud(corners, confident) {
  const video = dialog.querySelector("video");
  const hud = dialog.querySelector(".scan-hud");
  if (!video || !hud || !video.videoWidth) return;

  if (hud.width !== video.clientWidth || hud.height !== video.clientHeight) {
    hud.width = video.clientWidth;
    hud.height = video.clientHeight;
  }

  const ctx = hud.getContext("2d");
  ctx.clearRect(0, 0, hud.width, hud.height);

  if (!corners || !corners.length) return;

  const vr = video.getBoundingClientRect();
  const k = Math.max(vr.width / video.videoWidth, vr.height / video.videoHeight);
  const ox = (vr.width - video.videoWidth * k) / 2;
  const oy = (vr.height - video.videoHeight * k) / 2;

  // Transformera videokoordinater till HUD-skärmkoordinater
  const pts = corners.map(([x, y]) => [x * k + ox, y * k + oy]);

  // Rita dynamisk polygon
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  ctx.lineTo(pts[1][0], pts[1][1]);
  ctx.lineTo(pts[2][0], pts[2][1]);
  ctx.lineTo(pts[3][0], pts[3][1]);
  ctx.closePath();

  if (confident) {
    ctx.strokeStyle = "#10b981"; // Smaragdgrön när kortet är låst
    ctx.lineWidth = 3;
    ctx.shadowColor = "rgba(16, 185, 129, 0.7)";
    ctx.shadowBlur = 10;
    ctx.stroke();

    // Hörnmarkörer
    pts.forEach(([px, py]) => {
      ctx.fillStyle = "#10b981";
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, 2 * Math.PI);
      ctx.fill();
    });
  } else {
    ctx.strokeStyle = "rgba(240, 185, 11, 0.4)"; // Guldton när den söker
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

// HUD-illustrationsloop
function startHudLoop() {
  const video = dialog.querySelector("video");
  const defaultCorners = getDefaultFrameCorners() || [[0, 0], [420, 0], [420, 587], [0, 587]];

  const loop = () => {
    if (!dialog.open || !video || !video.videoWidth) {
      animFrame = requestAnimationFrame(loop);
      return;
    }

    const { corners, confident } = detectCardCorners(video, defaultCorners);

    // Glättad interpolering (Exponential Moving Average) för att förhindra flimmer
    if (!smoothedCorners) {
      smoothedCorners = corners;
    } else {
      const alpha = 0.35;
      smoothedCorners = smoothedCorners.map((pt, i) => [
        pt[0] * (1 - alpha) + corners[i][0] * alpha,
        pt[1] * (1 - alpha) + corners[i][1] * alpha,
      ]);
    }

    renderHud(smoothedCorners, confident);
    animFrame = requestAnimationFrame(loop);
  };

  animFrame = requestAnimationFrame(loop);
}

// Fångar en rätad bild av kortet från kameran
function grabUnwarpedFrame() {
  const video = dialog.querySelector("video");
  if (!video.videoWidth) return null;
  const defaultCorners = getDefaultFrameCorners();
  if (!defaultCorners) return null;

  const { corners } = detectCardCorners(video, defaultCorners);
  return unwarpCard(video, corners, CARD_W, CARD_H);
}

let last = null;
async function attempt(canvas, fromFile = false) {
  if (busy) return;
  busy = true;
  try {
    const r = await readCard(canvas);
    if (!dialog.open) return;
    const seen = [r.name, r.number && `${r.number}/${r.total}`].filter(Boolean).join(" · ");
    const sure = r.name && (r.number || fromFile || last === r.name);
    last = r.name;

    if (sure) {
      status(`Hittade <b>${esc(seen)}</b>!`);
      dialog.querySelector(".scan-hud-status")?.classList.add("success");
      if ("vibrate" in navigator) navigator.vibrate(45);
      stop();
      dialog.close();
      onFound?.({ ...r, canvas });
    } else {
      status(
        seen
          ? `Läser… <b>${esc(seen)}</b>`
          : fromFile
          ? "Hittade inget kortnamn i bilden. Prova ett skarpare foto rakt framifrån."
          : "Letar efter kortets namn och nummer…"
      );
    }
  } catch (err) {
    status(esc(err.message || "Något gick fel. Försök igen."));
  } finally {
    busy = false;
  }
}

function stop() {
  clearInterval(timer);
  timer = null;
  cancelAnimationFrame(animFrame);
  animFrame = null;
  smoothedCorners = null;
  torchActive = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

export async function openScanner(callback) {
  onFound = callback;
  last = null;
  smoothedCorners = null;
  const d = ui();
  d.showModal();
  status("Startar kameran…");
  d.querySelector(".scan-hud-status")?.classList.remove("success");
  getWorker().catch(() => {});

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });

    const video = d.querySelector("video");
    video.srcObject = stream;
    await video.play();

    // Kontrollera om kameran har inbyggd lampa
    const track = stream.getVideoTracks()[0];
    const caps = track?.getCapabilities ? track.getCapabilities() : {};
    torchSupported = !!caps.torch;
    const torchBtn = d.querySelector(".scan-torch");
    if (torchBtn) torchBtn.hidden = !torchSupported;

    status("Håll kortet i ramen…");
    startHudLoop();
    timer = setInterval(() => {
      const cv = grabUnwarpedFrame();
      if (cv) attempt(cv);
    }, SCAN_INTERVAL);
  } catch {
    d.querySelector(".scan-view").classList.add("nocam");
    status("Kameran går inte att använda här. Välj ett foto av kortet i stället.");
  }
}
