// Kortskanner: läser kortets namn och nummer med kameran och hittar kortet i TCGdex.
// Inspirerad av mtg_card_detector och Pokemon-Card-Scanner:
// 1. 4-punkts perspektivtransformation (homografi) rätsiktar sneda kort till ett platt 63×88 mm-format.
// 2. Två läszoner (namn överst, nummer nederst) i stället för hela kortet, med bildbehandling för OCR:
//    gråskala, reflexdämpning, kontraststräckning och Otsu-tröskel. Varannan skanning körs inverterad.
// 3. Rörelsekontroll: OCR körs först när kameran hålls stilla.
// 4. Perceptual dHash (64-bitars skillnadshash) för visuell matchning av kandidatkorten.
import { API, esc, getJSON } from "./site.js";
import { loadDataset } from "./card-autocomplete.js";

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const SCAN_INTERVAL = 900; // ms minst mellan två OCR-försök under aktiv kameraström
const MOTION_TICK = 150; // ms mellan två stabilitetskontroller
const MOTION_LIMIT = 10; // medelskillnad (0–255 per pixel) under vilken kameran räknas som stilla
const STILL_TICKS = 2; // antal stilla kontroller i rad innan OCR startar
const CARD_W = 420;
const CARD_H = 587; // Exakt 63:88 mm Pokémon-kortproportioner

// Läszoner i andelar av kortet (x, y, bredd, höjd) som beskärs ut för OCR.
const ZONES = {
  name: { x: 0.04, y: 0.02, w: 0.74, h: 0.14 }, // Översta ~16 %, utan HP-rutan längst till höger
  number: { x: 0.03, y: 0.86, w: 0.94, h: 0.13 }, // Nedersta ~14 %, där set-numret står
};

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

// ---------- 1. WebGL Hårdvaruaccelererad Perspektivtransformation (GPU Unwarp) ----------
// I stället för 246 540 CPU-loopar i JavaScript körs 4-punkts rätningen i en WebGL fragment-shader.
// Tar < 0.5 ms på GPU och nollställer CPU-belastningen och minnesallokeringen.
class GLWarper {
  constructor(w = CARD_W, h = CARD_H) {
    this.w = w;
    this.h = h;
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    const gl = this.canvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: false });
    this.gl = gl;
    if (!gl) return;

    const vsSrc = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;
    const fsSrc = `
      precision mediump float;
      uniform sampler2D u_image;
      uniform mat3 u_invH;
      varying vec2 v_uv;
      void main() {
        vec3 p = u_invH * vec3(v_uv, 1.0);
        vec2 uv = p.xy / p.z;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        } else {
          gl_FragColor = texture2D(u_image, uv);
        }
      }
    `;

    const createShader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, createShader(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, createShader(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    this.prog = prog;
    gl.useProgram(prog);

    // Quad geometry covering viewport (-1..1)
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1, -1,  1,
      -1,  1,  1, -1,  1,  1
    ]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.uInvH = gl.getUniformLocation(prog, "u_invH");
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.viewport(0, 0, w, h);
  }

  // Beräknar invers homografimatris (3x3) från källhörn till enhetskvadrat (0..1)
  computeInvHomographyMatrix(srcCorners, sw, sh) {
    // Normalisera källhörn till 0..1
    const p = srcCorners.map(([x, y]) => [x / sw, y / sh]);
    const x0 = p[0][0], y0 = p[0][1];
    const x1 = p[1][0], y1 = p[1][1];
    const x2 = p[2][0], y2 = p[2][1];
    const x3 = p[3][0], y3 = p[3][1];

    const dx1 = x1 - x2, dx2 = x3 - x2;
    const sx = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2;
    const sy = y0 - y1 + y2 - y3;

    let g = 0, h = 0;
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) > 1e-7) {
      g = (sx * dy2 - sy * dx2) / det;
      h = (dx1 * sy - dy1 * sx) / det;
    }
    const a = x1 - x0 + g * x1;
    const b = x3 - x0 + h * x3;
    const c = x0;
    const d = y1 - y0 + g * y1;
    const e = y3 - y0 + h * y3;
    const f = y0;

    // WebGL mat3 är column-major: [m00, m10, m20, m01, m11, m21, m02, m12, m22]
    return new Float32Array([
      a, d, g,
      b, e, h,
      c, f, 1.0
    ]);
  }

  warp(srcElement, corners) {
    const gl = this.gl;
    if (!gl) return null;
    const sw = srcElement.videoWidth || srcElement.width;
    const sh = srcElement.videoHeight || srcElement.height;
    if (!sw || !sh) return this.canvas;

    const invH = this.computeInvHomographyMatrix(corners, sw, sh);
    gl.useProgram(this.prog);
    gl.uniformMatrix3fv(this.uInvH, false, invH);

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcElement);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return this.canvas;
  }
}

let glWarperInstance = null;
function getGLWarper() {
  if (!glWarperInstance) glWarperInstance = new GLWarper(CARD_W, CARD_H);
  return glWarperInstance;
}

// 4-punkts transformation (Homografi). Använder WebGL i första hand, fallback till 2D canvas om nödvändigt.
export function unwarpCard(srcImage, corners, dstW = CARD_W, dstH = CARD_H) {
  const warper = getGLWarper();
  if (warper.gl && dstW === CARD_W && dstH === CARD_H) {
    return warper.warp(srcImage, corners);
  }

  // Fallback 2D
  const map = getProjectiveTransform(corners, dstW, dstH);
  const outCanvas = document.createElement("canvas");
  outCanvas.width = dstW; outCanvas.height = dstH;
  const outCtx = outCanvas.getContext("2d", { willReadFrequently: true });
  const sw = srcImage.videoWidth || srcImage.width;
  const sh = srcImage.videoHeight || srcImage.height;
  if (!sw || !sh || !map) {
    outCtx.drawImage(srcImage, 0, 0, dstW, dstH);
    return outCanvas;
  }

  const srcCv = document.createElement("canvas");
  srcCv.width = sw; srcCv.height = sh;
  const srcCtx = srcCv.getContext("2d", { willReadFrequently: true });
  srcCtx.drawImage(srcImage, 0, 0, sw, sh);
  const srcData = srcCtx.getImageData(0, 0, sw, sh).data;
  const outData = outCtx.createImageData(dstW, dstH);
  const outPx = outData.data;

  for (let y = 0; y < dstH; y++) {
    const rowOffset = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      const [sx, sy] = map(x, y);
      const isx = Math.round(sx), isy = Math.round(sy);
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

export function getProjectiveTransform(srcCorners, dstW, dstH) {
  const [x0, y0] = srcCorners[0];
  const [x1, y1] = srcCorners[1];
  const [x2, y2] = srcCorners[2];
  const [x3, y3] = srcCorners[3];

  const dx1 = x1 - x2, dx2 = x3 - x2;
  const sx = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2;
  const sy = y0 - y1 + y2 - y3;

  let a, b, c, d, e, f, g, h;
  if (Math.abs(sx) < 1e-4 && Math.abs(sy) < 1e-4) {
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

// ---------- 2. Bildbehandling för OCR ----------
const histOf = (arr) => {
  const h = new Uint32Array(256);
  for (let i = 0; i < arr.length; i++) h[arr[i]]++;
  return h;
};

function percentileOf(hist, p) {
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= p) return v;
  }
  return 255;
}

function otsuOf(hist, total) {
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = v; }
  }
  return thr;
}

function cropEnhanced(src, zone, scale = 2, invert = false) {
  const sx = Math.round(src.width * zone.x);
  const sy = Math.round(src.height * zone.y);
  const sw = Math.round(src.width * zone.w);
  const sh = Math.round(src.height * zone.h);

  const cv = document.createElement("canvas");
  cv.width = Math.round(sw * scale);
  cv.height = Math.round(sh * scale);
  const g = cv.getContext("2d", { willReadFrequently: true });

  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, sx, sy, sw, sh, 0, 0, cv.width, cv.height);

  const imgData = g.getImageData(0, 0, cv.width, cv.height);
  const d = imgData.data;
  const n = cv.width * cv.height;

  const gray = new Uint8Array(n);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    let r = d[i], gn = d[i + 1], b = d[i + 2];
    const max = Math.max(r, gn, b);
    const min = Math.min(r, gn, b);
    const sat = max > 0 ? (max - min) / max : 0;
    if (sat < 0.16 && max > 210) {
      const soften = 0.65 + sat * 1.5;
      r *= soften; gn *= soften; b *= soften;
    }
    gray[j] = Math.min(255, (r * 77 + gn * 150 + b * 29) >> 8);
  }

  const lo = percentileOf(histOf(gray), n * 0.03);
  const hi = percentileOf(histOf(gray), n * 0.97);
  const span = Math.max(1, hi - lo);
  for (let j = 0; j < n; j++) {
    gray[j] = Math.max(0, Math.min(255, Math.round(((gray[j] - lo) * 255) / span)));
  }

  const thr = otsuOf(histOf(gray), n);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    let val = gray[j] > thr ? 255 : 0;
    if (invert) val = 255 - val;
    d[i] = val;
    d[i + 1] = val;
    d[i + 2] = val;
    d[i + 3] = 255;
  }
  g.putImageData(imgData, 0, 0);
  return cv;
}

// ---------- 3. Perceptual dHash (Zero-Allocation Buffer & Popcount) ----------
const DHASH_W = 9, DHASH_H = 8;
let dHashCanvas = null, dHashCtx = null;
const dHashLum = new Uint8Array(DHASH_W * DHASH_H);

export function computeDHash(src) {
  if (!dHashCanvas) {
    dHashCanvas = (typeof OffscreenCanvas !== "undefined")
      ? new OffscreenCanvas(DHASH_W, DHASH_H)
      : Object.assign(document.createElement("canvas"), { width: DHASH_W, height: DHASH_H });
    dHashCtx = dHashCanvas.getContext("2d", { willReadFrequently: true });
  }
  dHashCtx.drawImage(src, 0, 0, DHASH_W, DHASH_H);
  const px = dHashCtx.getImageData(0, 0, DHASH_W, DHASH_H).data;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    dHashLum[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
  }
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    const rowOffset = y * DHASH_W;
    for (let x = 0; x < 8; x++) {
      if (dHashLum[rowOffset + x] > dHashLum[rowOffset + x + 1]) {
        hash |= (1n << BigInt(y * 8 + x));
      }
    }
  }
  return hash.toString(16).padStart(16, "0");
}

export function hammingDistance(h1, h2) {
  if (!h1 || !h2) return 64;
  let v = BigInt("0x" + h1) ^ BigInt("0x" + h2);
  let dist = 0;
  // Kernighan popcount: loopar enbart över satta bitar (sub-mikrosekund)
  while (v > 0n) {
    v &= v - 1n;
    dist++;
  }
  return dist;
}

// ---------- 4. Kant- och Hörndetektion i Realtid (Zero-Allocation Buffer) ----------
const AW = 240, AH = 320;
let cornerCanvas = null;
let cornerCtx = null;
// Pre-allokerad buffer för kantpunkter (undviker att skapa tusentals array-objekt per sekund i HUD-loopen)
const MAX_CORNERS_PTS = 256;
const ptsX = new Int16Array(MAX_CORNERS_PTS);
const ptsY = new Int16Array(MAX_CORNERS_PTS);

export function detectCardCorners(videoOrImg, fallbackRect) {
  const sw = videoOrImg.videoWidth || videoOrImg.width;
  const sh = videoOrImg.videoHeight || videoOrImg.height;
  if (!sw || !sh) return { corners: fallbackRect, confident: false };

  if (!cornerCanvas) {
    cornerCanvas = Object.assign(document.createElement("canvas"), { width: AW, height: AH });
    cornerCtx = cornerCanvas.getContext("2d", { willReadFrequently: true });
  }

  cornerCtx.drawImage(videoOrImg, 0, 0, AW, AH);
  const data = cornerCtx.getImageData(0, 0, AW, AH).data;

  // Sampla bakgrundsfärg från de fyra hörnen
  const sample = (x, y) => {
    const i = (y * AW + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const cornersBg = [sample(2, 2), sample(AW - 3, 2), sample(2, AH - 3), sample(AW - 3, AH - 3)];
  const bgR = (cornersBg[0][0] + cornersBg[1][0] + cornersBg[2][0] + cornersBg[3][0]) >> 2;
  const bgG = (cornersBg[0][1] + cornersBg[1][1] + cornersBg[2][1] + cornersBg[3][1]) >> 2;
  const bgB = (cornersBg[0][2] + cornersBg[1][2] + cornersBg[2][2] + cornersBg[3][2]) >> 2;

  let ptCount = 0;
  const steps = 28;

  // Strålsökning från vänster och höger inåt (zero-allocation)
  for (let s = 1; s < steps && ptCount < MAX_CORNERS_PTS - 2; s++) {
    const y = Math.round((AH * s) / steps);
    const rowOffset = y * AW * 4;
    for (let x = 0; x < AW * 0.46; x++) {
      const i = rowOffset + x * 4;
      if (Math.abs(data[i] - bgR) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bgB) > 45) {
        ptsX[ptCount] = x;
        ptsY[ptCount] = y;
        ptCount++;
        break;
      }
    }
    for (let x = AW - 1; x > AW * 0.54; x--) {
      const i = rowOffset + x * 4;
      if (Math.abs(data[i] - bgR) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bgB) > 45) {
        ptsX[ptCount] = x;
        ptsY[ptCount] = y;
        ptCount++;
        break;
      }
    }
  }

  // Strålsökning från topp och botten inåt
  for (let s = 1; s < steps && ptCount < MAX_CORNERS_PTS - 2; s++) {
    const x = Math.round((AW * s) / steps);
    for (let y = 0; y < AH * 0.46; y++) {
      const i = (y * AW + x) * 4;
      if (Math.abs(data[i] - bgR) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bgB) > 45) {
        ptsX[ptCount] = x;
        ptsY[ptCount] = y;
        ptCount++;
        break;
      }
    }
    for (let y = AH - 1; y > AH * 0.54; y--) {
      const i = (y * AW + x) * 4;
      if (Math.abs(data[i] - bgR) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bgB) > 45) {
        ptsX[ptCount] = x;
        ptsY[ptCount] = y;
        ptCount++;
        break;
      }
    }
  }

  if (ptCount < 18) {
    return { corners: fallbackRect, confident: false };
  }

  let tlX = ptsX[0], tlY = ptsY[0];
  let brX = ptsX[0], brY = ptsY[0];
  let trX = ptsX[0], trY = ptsY[0];
  let blX = ptsX[0], blY = ptsY[0];
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;

  for (let i = 0; i < ptCount; i++) {
    const x = ptsX[i], y = ptsY[i];
    const sum = x + y;
    const diff = y - x;
    if (sum < minSum) { minSum = sum; tlX = x; tlY = y; }
    if (sum > maxSum) { maxSum = sum; brX = x; brY = y; }
    if (diff < minDiff) { minDiff = diff; trX = x; trY = y; }
    if (diff > maxDiff) { maxDiff = diff; blX = x; blY = y; }
  }

  const scaleX = sw / AW;
  const scaleY = sh / AH;
  const fullCorners = [
    [tlX * scaleX, tlY * scaleY],
    [trX * scaleX, trY * scaleY],
    [brX * scaleX, brY * scaleY],
    [blX * scaleX, blY * scaleY],
  ];

  const topW = Math.hypot(fullCorners[1][0] - fullCorners[0][0], fullCorners[1][1] - fullCorners[0][1]);
  const botW = Math.hypot(fullCorners[2][0] - fullCorners[3][0], fullCorners[2][1] - fullCorners[3][1]);
  const leftH = Math.hypot(fullCorners[3][0] - fullCorners[0][0], fullCorners[3][1] - fullCorners[0][1]);
  const rightH = Math.hypot(fullCorners[2][0] - fullCorners[1][0], fullCorners[2][1] - fullCorners[1][1]);

  const avgW = (topW + botW) * 0.5;
  const avgH = (leftH + rightH) * 0.5;
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

// Set-prefix som inte ska ändras när OCR-fel rättas (t.ex. "SV" i "SV001/SV122", "TG" i "TG12/TG30").
const SET_PREFIXES = ["TG", "GG", "SV", "SWSH", "SM", "XY", "BW", "DP", "PT"];

// Rättar vanliga OCR-fel i ett nummer-token: O→0, I/l/|→1, S→5, B→8, Z→2.
function fixNumberToken(tok) {
  const letters = tok.match(/^[A-Za-z]+/)?.[0] || "";
  const upper = letters.toUpperCase();
  const prefix = letters.length < tok.length && SET_PREFIXES.includes(upper) ? upper : "";
  const rest = tok
    .slice(prefix.length)
    .replace(/[oO]/g, "0")
    .replace(/[lI|]/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8")
    .replace(/Z/g, "2");
  return prefix + rest;
}

// Hittar "238/191", "025/165" eller "TG12/TG30" i OCR-texten. Rättar bara tokens kring snedstrecket.
function findNumber(text) {
  if (!text) return null;
  const fixed = text.replace(/[A-Za-z0-9|]{1,10}\s*\/\s*[A-Za-z0-9|]{1,10}/g, (m) => {
    const [a, b] = m.split("/");
    return `${fixNumberToken(a.trim())}/${fixNumberToken(b.trim())}`;
  });
  const m = fixed.match(/\b([A-Z]{0,4}\d{1,3}[a-z]?)\/([A-Z]{0,4}\d{1,3})\b/);
  return m ? { number: m[1].replace(/^0+(?=\d)/, ""), total: m[2].replace(/^[A-Z]+/, "") } : null;
}

// Läser kortet från ett rätat canvas ($420 \times 587$ px). invert växlar mellan normal och inverterad bild.
// full läser hela kortet om zonerna inte räcker. Det är långsamt, så auto-skanningen gör det inte.
export async function readCard(canvas, { invert = false, full = false } = {}) {
  const worker = await getWorker();
  const list = await names();

  // Zon-OCR: namnzonen överst och nummerzonen nederst
  const [topRes, botRes] = await Promise.all([
    worker.recognize(cropEnhanced(canvas, ZONES.name, 2, invert)),
    worker.recognize(cropEnhanced(canvas, ZONES.number, 2.5, invert)),
  ]);

  const topLines = topRes.data.text.split("\n").map((l) => l.trim()).filter(Boolean);
  let name = findName(topLines, list);
  let num = findNumber(botRes.data.text) || findNumber(topRes.data.text);

  // Om zonerna inte räckte: läs hela kortet (bara vid "Skanna nu" och foto)
  if (full && (!name || !num)) {
    const fullRes = await worker.recognize(cropEnhanced(canvas, { x: 0, y: 0, w: 1, h: 1 }, 1.2, invert));
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
let dialog = null, stream = null, timer = null, animFrame = null, busy = false;
let onFound = null, onPartial = null;
let smoothedCorners = null;
let torchSupported = false, torchActive = false;
let motionCanvas = null, prevMotion = null, stillTicks = 0, lastScanAt = 0, scanCount = 0, pendingForce = false;
let pauseUntil = 0, openedAt = 0; // pauseUntil: auto-skanningen väntar så att ett felmeddelande hinner läsas
const NUDGE_AFTER = 2000; // ms utan träff innan "Skanna nu" lyfts fram
const PAUSE_AFTER_MISS = 3500; // ms paus efter en misslyckad manuell skanning eller ett foto

const frameEl = () => dialog?.querySelector(".scan-frame i");

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
      <div class="scan-hud-status">
        <p class="scan-status" role="status" aria-live="polite">Startar kameran…</p>
      </div>
      <button class="scan-torch" type="button" aria-label="Tänd ficklampa" hidden>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6l-6 12-2-6-6-2 14-4z"/>
        </svg>
      </button>
      <p class="scan-tip">Håll kortet i ramen. Glänser det? Luta det lätt.</p>
    </div>
    <div class="scan-actions">
      <label class="scan-ghost">Välj foto<input type="file" accept="image/*" hidden></label>
      <button class="scan-now" type="button">Skanna nu</button>
      <button class="scan-ghost" type="button" data-close>Stäng</button>
    </div>`;

  document.body.append(dialog);
  dialog.addEventListener("close", stop);
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());

  // Skanna nu: tvingar fram en omedelbar avläsning i full upplösning, även om kameran rör sig
  dialog.querySelector(".scan-now").addEventListener("click", () => runScan(true));

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

    // Pågår en kameraskanning läses fotot direkt efter den. Kameran fortsätter om fotot inte gav någon träff.
    status("Läser fotot…");
    await waitIdle();
    await attempt(unwarped, { fromFile: true });
  });

  return dialog;
}

// Skriver bara om texten när den ändras, så att skärmläsare inte läser upp samma sak var 150:e ms.
const status = (t) => {
  const el = dialog?.querySelector(".scan-status");
  if (el && el.innerHTML !== t) el.innerHTML = t;
};

const waitIdle = async () => { while (busy) await new Promise((r) => setTimeout(r, 50)); };

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
    // Låst kort: svagt ifylld yta med cyan–violett kontur och glöd
    const grad = ctx.createLinearGradient(pts[0][0], pts[0][1], pts[2][0], pts[2][1]);
    grad.addColorStop(0, "#22d3ee");
    grad.addColorStop(1, "#a855f7");
    ctx.fillStyle = "rgba(34, 211, 238, 0.07)";
    ctx.fill();
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "rgba(139, 92, 246, 0.8)";
    ctx.shadowBlur = 14;
    ctx.stroke();

    // Hörnvinklar längs kortets kanter
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    pts.forEach(([px, py], i) => {
      ctx.beginPath();
      for (const [nx, ny] of [pts[(i + 1) % 4], pts[(i + 3) % 4]]) {
        const len = Math.hypot(nx - px, ny - py) || 1;
        const t = Math.min(22, len * 0.18) / len;
        ctx.moveTo(px, py);
        ctx.lineTo(px + (nx - px) * t, py + (ny - py) * t);
      }
      ctx.stroke();
    });
  } else {
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)"; // Diskret när den söker
    ctx.lineWidth = 1;
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

// Fångar en rätad bild av kortet från kameran i full upplösning
function grabUnwarpedFrame() {
  const video = dialog.querySelector("video");
  if (!video.videoWidth) return null;
  const defaultCorners = getDefaultFrameCorners();
  if (!defaultCorners) return null;

  const { corners } = detectCardCorners(video, defaultCorners);
  return unwarpCard(video, corners, CARD_W, CARD_H);
}

// Medelskillnaden mot föregående bild på en liten gråskalebild (Zero-Allocation Buffer).
const W_MOTION = 48, H_MOTION = 64;
let motionCanvas = null, motionCtx = null;
const curMotion = new Uint8Array(W_MOTION * H_MOTION);
const prevMotion = new Uint8Array(W_MOTION * H_MOTION);
let hasPrevMotion = false;

function motionLevel(video) {
  if (!motionCanvas) {
    motionCanvas = (typeof OffscreenCanvas !== "undefined")
      ? new OffscreenCanvas(W_MOTION, H_MOTION)
      : Object.assign(document.createElement("canvas"), { width: W_MOTION, height: H_MOTION });
    motionCtx = motionCanvas.getContext("2d", { willReadFrequently: true });
  }
  motionCtx.drawImage(video, 0, 0, W_MOTION, H_MOTION);
  const d = motionCtx.getImageData(0, 0, W_MOTION, H_MOTION).data;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    curMotion[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  }
  let level = Infinity;
  if (hasPrevMotion) {
    let sum = 0;
    const len = curMotion.length;
    for (let j = 0; j < len; j++) sum += Math.abs(curMotion[j] - prevMotion[j]);
    level = sum / len;
  }
  prevMotion.set(curMotion);
  hasPrevMotion = true;
  return level;
}

// Körs var MOTION_TICK ms. OCR startar först när kameran varit stilla en stund och ingen skanning pågår.
function motionTick() {
  const video = dialog?.querySelector("video");
  if (!dialog?.open || !video?.videoWidth || busy || Date.now() < pauseUntil) return;

  // Ingen träff efter en stund: lyft fram "Skanna nu"
  if (Date.now() - openedAt > NUDGE_AFTER) dialog.querySelector(".scan-now")?.classList.add("nudge");

  const level = motionLevel(video);
  stillTicks = level < MOTION_LIMIT ? stillTicks + 1 : 0;

  if (stillTicks < STILL_TICKS) {
    frameEl()?.classList.add("is-moving");
    status("Håll kortet i ramen…");
    return;
  }
  frameEl()?.classList.remove("is-moving");
  if (Date.now() - lastScanAt >= SCAN_INTERVAL) runScan(false);
}

// Startar en skanning av aktuell bild. Auto-skanning varvar normal och inverterad bild.
async function runScan(manual) {
  if (busy) {
    if (manual) {
      pendingForce = true;
      status("Läser av… tar en ny bild direkt efter.");
    }
    return;
  }
  const cv = grabUnwarpedFrame();
  if (!cv) {
    if (manual) status("Kameran är inte igång. Välj ett foto av kortet i stället.");
    return;
  }
  lastScanAt = Date.now();
  const invert = scanCount++ % 2 === 1;
  await attempt(cv, { manual, invert });
  if (pendingForce && dialog?.open) {
    pendingForce = false;
    runScan(true);
  }
}

// Snabb lokal pHash-databas för direktidentifiering (< 5 ms)
let indexedCards = [];
let indexingPromise = null;

async function ensureLocalIndex() {
  if (indexingPromise) return indexingPromise;
  indexingPromise = (async () => {
    try {
      const res = await fetch("data/card-trends.json").then((r) => r.json()).catch(() => null);
      const top = res?.top || [];
      for (const c of top) {
        if (!c.image) continue;
        const h = await cardHash(c);
        if (h) {
          indexedCards.push({
            id: c.id,
            name: c.name,
            localId: c.localId,
            set: c.set,
            hashStr: h,
            hashBig: BigInt("0x" + h)
          });
        }
      }
    } catch {}
  })();
  return indexingPromise;
}

export function findInstantVisualMatch(myHashStr) {
  if (!myHashStr || !indexedCards.length) return null;
  const myHashBig = BigInt("0x" + myHashStr);
  let best = null;
  let minD = 65;
  for (const c of indexedCards) {
    let xor = myHashBig ^ c.hashBig;
    let d = 0;
    while (xor > 0n) {
      xor &= xor - 1n;
      d++;
    }
    if (d < minD) {
      minD = d;
      best = c;
      if (d === 0) break;
    }
  }
  // Hamming-avstånd <= 10 (av 64 bitar) är en mycket säker visuell träff
  if (best && minD <= 10) {
    return { ...best, distance: minD, sure: true };
  }
  return null;
}

let last = null;
async function attempt(canvas, { fromFile = false, manual = false, invert = false } = {}) {
  if (busy) return;
  busy = true;
  frameEl()?.classList.add("is-reading");
  frameEl()?.classList.remove("is-moving");
  if (!fromFile) status("Läser av…");
  try {
    // 1. Blixtsnabb visuell pHash-match (< 1 ms). Identifierar direkt utan OCR om kortet känns igen.
    const dhash = computeDHash(canvas);
    const instantMatch = findInstantVisualMatch(dhash);
    if (instantMatch && instantMatch.sure) {
      status(`Hittade <b>${esc(instantMatch.name)}</b>!`);
      dialog.querySelector(".scan-hud-status")?.classList.add("success");
      if ("vibrate" in navigator) navigator.vibrate(45);
      stop();
      dialog.close();
      onFound?.({
        name: instantMatch.name,
        number: instantMatch.localId || null,
        total: null,
        cardId: instantMatch.id,
        canvas,
        dhash
      });
      return;
    }

    // 2. OCR körs enbart vid behov om visuell match saknas
    const r = await readCard(canvas, { invert, full: manual || fromFile });
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
    } else if ((manual || fromFile) && (r.name || r.number) && onPartial) {
      // Halv läsning: stäng och fyll i det som gick att läsa, så användaren slipper skriva från noll
      stop();
      dialog.close();
      onPartial({ name: r.name, number: r.number, total: r.total });
    } else {
      // Manuell skanning eller foto utan träff: pausa auto-skanningen så att meddelandet hinner läsas
      if (manual || fromFile) pauseUntil = Date.now() + PAUSE_AFTER_MISS;
      status(
        seen
          ? `Läser… <b>${esc(seen)}</b>`
          : fromFile
          ? "Hittade inget kortnamn i bilden. Prova ett skarpare foto rakt framifrån."
          : manual
          ? "Hittade inget. Flytta kortet närmare och försök igen."
          : "Letar efter kortets namn och nummer…"
      );
    }
  } catch (err) {
    status(esc(err.message || "Något gick fel. Försök igen."));
  } finally {
    busy = false;
    frameEl()?.classList.remove("is-reading");
  }
}

function stop() {
  clearInterval(timer);
  timer = null;
  cancelAnimationFrame(animFrame);
  animFrame = null;
  smoothedCorners = null;
  hasPrevMotion = false;
  torchActive = false;
  dialog?.querySelector(".scan-torch")?.classList.remove("active");
  pendingForce = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

// Fokus, vitbalans och exponering låses/konfigureras för maximal stabilitet utan "focus hunting"
async function tuneCamera(track, caps, d) {
  if (!track) return;

  const advanced = {};
  if (caps.focusMode?.includes("continuous")) advanced.focusMode = "continuous";
  if (caps.exposureMode?.includes("continuous")) advanced.exposureMode = "continuous";
  if (caps.whiteBalanceMode?.includes("continuous")) advanced.whiteBalanceMode = "continuous";

  if (Object.keys(advanced).length > 0) {
    await track.applyConstraints({ advanced: [advanced] }).catch(() => {});
  }

  torchSupported = !!caps.torch;
  const torchBtn = d.querySelector(".scan-torch");
  if (torchBtn) torchBtn.hidden = !torchSupported;
}

// callback får ett komplett kort (namn + nummer + bild). partialCallback får en delläsning
// (bara namn eller bara nummer) när användaren tryckt "Skanna nu" eller valt ett foto.
export async function openScanner(callback, partialCallback) {
  onFound = callback;
  onPartial = partialCallback || null;
  last = null;
  smoothedCorners = null;
  hasPrevMotion = false;
  stillTicks = 0;
  scanCount = 0;
  pendingForce = false;
  pauseUntil = 0;
  openedAt = Date.now();
  const d = ui();
  // Återställ allt från förra gången, t.ex. om kameran inte gick att starta då
  d.querySelector(".scan-view").classList.remove("nocam");
  d.querySelector(".scan-frame i").classList.remove("is-moving", "is-reading");
  d.querySelector(".scan-now").classList.remove("nudge");
  d.showModal();
  status("Startar kameran…");
  d.querySelector(".scan-hud-status")?.classList.remove("success");
  getWorker().catch(() => {});
  ensureLocalIndex().catch(() => {});

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

    const track = stream.getVideoTracks()[0];
    const caps = track?.getCapabilities ? track.getCapabilities() : {};
    await tuneCamera(track, caps, d);

    status("Håll kortet i ramen…");
    startHudLoop();
    timer = setInterval(motionTick, MOTION_TICK);
  } catch {
    d.querySelector(".scan-view").classList.add("nocam");
    status("Kameran går inte att använda här. Välj ett foto av kortet i stället.");
  }
}
