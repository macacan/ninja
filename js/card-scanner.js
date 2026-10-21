// Kortskanner: läser kortets namn och nummer med kameran och hittar kortet i TCGdex.
// Inspirerad av mtg_card_detector och Pokemon-Card-Scanner:
// 1. Kortets kanter letas nära ramen på skärmen och 4-punkts perspektivtransformation (homografi) rätsiktar
//    sneda kort till ett platt 63×88 mm-format.
// 2. Små läszoner där texten alltid sitter: namnet uppe till vänster och kortnumret nere till vänster
//    (2020 och framåt) eller nere till höger (äldre kort). Bildbehandling för OCR: gråskala, reflexdämpning,
//    brusutjämning och lokal tröskel, för både mörk och ljus text. Namn och nummer läses av var sin
//    Tesseract-worker parallellt. Numret måste ha en total som är en känd setstorlek, t.ex. 132 i "013/132".
// 3. Rörelsekontroll: OCR körs först när kameran hålls stilla.
// 4. Perceptual dHash (64-bitars skillnadshash) för visuell matchning av kandidatkorten.
// 5. Hittas inte kortet nära ramen letas dess fyra hörn i hela bilden (kanter + Hough-linjer, scan/quad.js).
// 6. Bildavtryck av konstverket (scan/fingerprint.js) jämförs med ett färdigt index över alla kort (samma som KortKoll).
//    Pekar bilden och det lästa numret ut samma kort är skanningen klar, utan att vänta på namnet.
import { API, esc, getJSON } from "./site.js";
import { loadDataset } from "./card-autocomplete.js";
import "./scan/quad.js"; // sätter self.Quad
import "./scan/fingerprint.js"; // sätter self.Fingerprint

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const SCAN_INTERVAL = 250; // ms minst mellan två OCR-försök under aktiv kameraström
const MOTION_TICK = 150; // ms mellan två stabilitetskontroller
const MOTION_LIMIT = 10; // medelskillnad (0–255 per pixel) under vilken kameran räknas som stilla
const STILL_TICKS = 2; // antal stilla kontroller i rad innan OCR startar
// 63:88 mm. Så stort att kortnumret (ca 1,5 % av kortets höjd) behåller kamerans skärpa. Rätningen sker på GPU:n
// och bara läszonerna läses ut, så storleken kostar nästan inget.
const CARD_W = 900;
const CARD_H = 1257;

// Läszoner i andelar av kortet (x, y, bredd, höjd) som beskärs ut för OCR.
const ZONES = {
  name: { x: 0.03, y: 0.02, w: 0.72, h: 0.11 }, // Namnraden, utan HP-rutan. Gamla kort har "Evolves from" ovanför.
  numLeft: { x: 0.02, y: 0.925, w: 0.4, h: 0.055 }, // "013/132" på kort från 2020 och framåt
  numRight: { x: 0.62, y: 0.945, w: 0.37, h: 0.05 }, // "4/102" på äldre kort
};

// ---------- Textigenkänning (Tesseract) ----------
// Varsin worker för namn och nummer, så att de läses samtidigt och var och en bara letar efter sina tecken.
const OCR_PARAMS = {
  name: { tessedit_pageseg_mode: "11" },
  number: { tessedit_pageseg_mode: "11", tessedit_char_whitelist: "0123456789/" },
};
let scriptPromise = null;
const workers = {};
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Kunde inte ladda textläsaren."));
    document.head.append(s);
  });
}

function getWorker(kind) {
  if (!workers[kind]) {
    scriptPromise ||= window.Tesseract ? Promise.resolve() : loadScript(TESSERACT).catch((err) => { scriptPromise = null; throw err; });
    workers[kind] = scriptPromise
      .then(() => window.Tesseract.createWorker("eng"))
      .then(async (w) => { await w.setParameters(OCR_PARAMS[kind]); return w; })
      .catch((err) => {
        delete workers[kind];
        throw err;
      });
  }
  return workers[kind];
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
// Lokal tröskel (medelvärde i ett fönster runt varje pixel) i stället för en tröskel för hela zonen. Kortens
// botten blandar gul ram, ljusa fält och mörka partier, och en gemensam tröskel suddar då ut siffrorna.
// Zonen ger två svartvita bilder: mörk text på ljus botten och ljus text på mörk botten (t.ex. full art),
// båda med svart text på vitt, så att Tesseract kan läsa den som finns.
const INK_DIFF = 12; // hur mycket mörkare (eller ljusare) än omgivningen en pixel måste vara för att räknas som text

function zoneMaps(src, zone, scale) {
  const cv = document.createElement("canvas");
  const w = (cv.width = Math.round(src.width * zone.w * scale));
  const h = (cv.height = Math.round(src.height * zone.h * scale));
  const g = cv.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, src.width * zone.x, src.height * zone.y, src.width * zone.w, src.height * zone.h, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;

  // Gråskala med dämpade reflexer (nästan vita, omättade pixlar från blänk i plastfickan)
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    let r = d[i], gn = d[i + 1], b = d[i + 2];
    const max = Math.max(r, gn, b), min = Math.min(r, gn, b);
    const sat = max > 0 ? (max - min) / max : 0;
    if (sat < 0.16 && max > 210) {
      const soften = 0.65 + sat * 1.5;
      r *= soften; gn *= soften; b *= soften;
    }
    gray[j] = Math.min(255, (r * 77 + gn * 150 + b * 29) >> 8);
  }

  // Lätt utjämning (lådfilter) mot kamerabrus, annars blir bruset prickar som stör textläsningen
  const raw = new Uint8Array(gray);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0, cnt = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          acc += raw[yy * w + xx];
          cnt++;
        }
      }
      gray[y * w + x] = acc / cnt;
    }
  }

  // Summerad-area-tabell, så att medelvärdet i varje fönster tar konstant tid
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row;
    }
  }

  // Fönstret är ungefär två teckenhöjder brett
  const rad = Math.max(6, Math.round(h * 0.3));
  const maps = { dark: new ImageData(w, h), light: new ImageData(w, h) };
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1);
      const mean = (sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0]) / ((y1 - y0) * (x1 - x0));
      const v = gray[y * w + x], i = (y * w + x) * 4;
      const dark = v < mean - INK_DIFF ? 0 : 255;
      const light = v > mean + INK_DIFF ? 0 : 255;
      maps.dark.data[i] = maps.dark.data[i + 1] = maps.dark.data[i + 2] = dark;
      maps.light.data[i] = maps.light.data[i + 1] = maps.light.data[i + 2] = light;
      maps.dark.data[i + 3] = maps.light.data[i + 3] = 255;
    }
  }

  const toCanvas = (img) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").putImageData(img, 0, 0);
    return c;
  };
  return [toCanvas(maps.dark), toCanvas(maps.light)];
}

// Lägger zonerna under varandra med vit marginal, så att båda nummerplatserna läses i en och samma OCR-körning.
function stack(canvases, gap = 24) {
  const cv = document.createElement("canvas");
  cv.width = Math.max(...canvases.map((c) => c.width)) + gap * 2;
  cv.height = canvases.reduce((h, c) => h + c.height + gap, gap);
  const g = cv.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, cv.width, cv.height);
  let y = gap;
  for (const c of canvases) { g.drawImage(c, gap, y); y += c.height + gap; }
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

// ---------- 4. Kant- och hörndetektion i realtid ----------
// Kortet hålls i ramen på skärmen, så varje kant letas bara i ett band kring ramens motsvarande kant.
// Längs varje kant tas ett antal tvärsnitt, och i varje tvärsnitt väljs den yttersta tydliga ljusövergången
// (kortets ytterkant, inte kanten mellan ram och bild). Punkterna anpassas till en rät linje där avvikande punkter
// (fingrar, reflexer) sorteras bort, och hörnen blir linjernas skärningspunkter. Bakgrundens färg spelar ingen
// roll, så ett mönstrat bord eller ojämnt ljus stör inte.
const AW = 240; // analysbildens bredd, höjden följer bildens proportioner
const SIDE_SAMPLES = 24; // tvärsnitt per kant
const MIN_EDGE = 36; // minsta ljusskillnad (summa av tre pixlar) för att räknas som en kant
let cornerCanvas = null, cornerCtx = null, cornerGray = null;

function fitLine(pts) {
  // pos = a + b·t med minsta kvadrat, två varv: andra varvet utan punkter som avviker mer än 2 px
  let use = pts;
  let a = 0, b = 0;
  for (let pass = 0; pass < 2; pass++) {
    if (use.length < 4) return null;
    let st = 0, sp = 0, stt = 0, stp = 0;
    for (const [t, p] of use) { st += t; sp += p; stt += t * t; stp += t * p; }
    const n = use.length, den = n * stt - st * st;
    if (!den) return null;
    b = (n * stp - st * sp) / den;
    a = (sp - b * st) / n;
    use = pts.filter(([t, p]) => Math.abs(a + b * t - p) <= 2);
  }
  return { a, b, inliers: use.length };
}

export function detectCardCorners(videoOrImg, guide, band = 0.12) {
  const sw = videoOrImg.videoWidth || videoOrImg.width;
  const sh = videoOrImg.videoHeight || videoOrImg.height;
  if (!sw || !sh || !guide) return { corners: guide, confident: false };

  const ah = Math.round((AW * sh) / sw);
  if (!cornerCanvas || cornerCanvas.height !== ah) {
    cornerCanvas = Object.assign(document.createElement("canvas"), { width: AW, height: ah });
    cornerCtx = cornerCanvas.getContext("2d", { willReadFrequently: true });
    cornerGray = new Uint8Array(AW * ah);
  }
  cornerCtx.drawImage(videoOrImg, 0, 0, AW, ah);
  const px = cornerCtx.getImageData(0, 0, AW, ah).data;
  for (let i = 0, j = 0; j < cornerGray.length; i += 4, j++) cornerGray[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
  const at = (x, y) => cornerGray[y * AW + x];

  const k = AW / sw;
  const xs = guide.map(([x]) => x * k), ys = guide.map(([, y]) => y * k);
  const gx0 = Math.min(...xs), gx1 = Math.max(...xs), gy0 = Math.min(...ys), gy1 = Math.max(...ys);
  const gw = gx1 - gx0, gh = gy1 - gy0;
  const reach = Math.max(4, Math.round(band * Math.min(gw, gh)));

  // En kant: horizontal = topp/botten (söker i y), outward = -1 när utsidan ligger mot lägre koordinater
  const side = (horizontal, edge, outward) => {
    const pts = [];
    const [t0, t1] = horizontal ? [gx0 + gw * 0.15, gx1 - gw * 0.15] : [gy0 + gh * 0.15, gy1 - gh * 0.15];
    const lim = horizontal ? ah : AW;
    for (let s = 0; s < SIDE_SAMPLES; s++) {
      const t = Math.round(t0 + ((t1 - t0) * s) / (SIDE_SAMPLES - 1));
      const from = Math.round(edge + outward * reach), to = Math.round(edge - outward * reach);
      const grad = [];
      let max = 0;
      for (let p = from; p !== to; p -= outward) {
        if (p < 2 || p >= lim - 2 || t < 1 || t >= (horizontal ? AW : ah) - 1) { grad.push(0); continue; }
        let gsum = 0;
        for (let q = -1; q <= 1; q++) {
          gsum += horizontal ? at(t + q, p + 1) - at(t + q, p - 1) : at(p + 1, t + q) - at(p - 1, t + q);
        }
        const v = Math.abs(gsum);
        grad.push(v);
        if (v > max) max = v;
      }
      if (max < MIN_EDGE) continue;
      // Yttersta övergången som är nästan lika tydlig som den starkaste
      const idx = grad.findIndex((v) => v >= max * 0.6);
      pts.push([t, from - outward * idx]);
    }
    const line = fitLine(pts);
    return line && line.inliers >= SIDE_SAMPLES * 0.5 ? line : null;
  };

  const top = side(true, gy0, -1), bottom = side(true, gy1, 1);
  const left = side(false, gx0, -1), right = side(false, gx1, 1);
  if (!top || !bottom || !left || !right) return { corners: guide, confident: false };

  // Skärning mellan y = a + b·x (topp/botten) och x = c + d·y (vänster/höger)
  const cross = (h, v) => {
    const x = (v.a + v.b * h.a) / (1 - v.b * h.b);
    return [x / k, (h.a + h.b * x) / k];
  };
  const corners = [cross(top, left), cross(top, right), cross(bottom, right), cross(bottom, left)];

  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const avgW = (dist(corners[0], corners[1]) + dist(corners[3], corners[2])) / 2;
  const avgH = (dist(corners[0], corners[3]) + dist(corners[1], corners[2])) / 2;
  const ratio = avgW / (avgH || 1);
  const confident = ratio > 0.62 && ratio < 0.82 && corners.every(([x, y]) => x > -sw * 0.05 && x < sw * 1.05 && y > -sh * 0.05 && y < sh * 1.05);
  return { corners: confident ? corners : guide, confident };
}

// ---------- 4b. Kortets hörn i hela bilden ----------
// Kanter (Sobel) och raka linjer (Hough) i en liten kopia av bilden. Fyrhörningen måste ha kortets proportioner och
// tydlig kant runt om. Klarar kort som ligger snett, långt bort eller utanför ramen. Hörnen i källans koordinater, eller null.
let quadCanvas = null, quadCtx = null;
export function findCardQuad(src) {
  const Q = self.Quad;
  const sw = src?.videoWidth || src?.width, sh = src?.videoHeight || src?.height;
  if (!Q || !sw || !sh) return null;
  const k = 360 / Math.max(sw, sh), w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  if (!quadCanvas || quadCanvas.width !== w || quadCanvas.height !== h) {
    quadCanvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
    quadCtx = quadCanvas.getContext("2d", { willReadFrequently: true });
  }
  quadCtx.drawImage(src, 0, 0, w, h);
  const q = Q.find(quadCtx.getImageData(0, 0, w, h).data, w, h);
  return q ? q.pts.map(([x, y]) => [x / k, y / k]) : null;
}

// ---------- 4c. Bildavtryck mot alla kort ----------
// Indexet (ca 23 000 kort, 240 byte per kort) byggs varje månad i KortKoll-projektet och hämtas en gång.
const ART_BASES = ["https://cdn.jsdelivr.net/gh/macacan/Pokescan@main/www/", "https://raw.githubusercontent.com/macacan/Pokescan/main/www/"];
let artPromise = null, artFailedAt = 0;
export function loadArtIndex() {
  if (!artPromise && Date.now() - artFailedAt < 60e3) return Promise.resolve(null); // misslyckades nyss: försök inte vid varje bild
  artPromise ||= (async () => {
    for (const base of ART_BASES) {
      try {
        const [j, b] = await Promise.all([
          fetch(base + "hashes.json").then((r) => (r.ok ? r.json() : Promise.reject())),
          fetch(base + "hashes.bin").then((r) => (r.ok ? r.arrayBuffer() : Promise.reject())),
        ]);
        const db = new Int8Array(b);
        if (db.length === j.n * j.len) return { ids: j.ids, db, n: j.n, idx: new Map(j.ids.map((id, i) => [id, i])) };
      } catch {}
    }
    artPromise = null;
    artFailedAt = Date.now();
    return null;
  })();
  return artPromise;
}

// Avtryck av kortbilden för 25 små förskjutningar, så att en lite snett beskuren bild ändå matchar.
function artQueries(card) {
  const FP = self.Fingerprint;
  let c = card;
  while (c.width > FP.CW * 2) {
    const t = Object.assign(document.createElement("canvas"), { width: c.width >> 1, height: c.height >> 1 });
    const g = t.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(c, 0, 0, t.width, t.height);
    c = t;
  }
  const f = Object.assign(document.createElement("canvas"), { width: FP.CW, height: FP.CH });
  const fg = f.getContext("2d", { willReadFrequently: true });
  fg.imageSmoothingQuality = "high";
  fg.drawImage(c, 0, 0, FP.CW, FP.CH);
  const d = fg.getImageData(0, 0, FP.CW, FP.CH).data, out = [];
  for (const dy of [-0.06, -0.03, 0, 0.03, 0.06]) for (const dx of [-0.06, -0.03, 0, 0.03, 0.06]) out.push(FP.vector(FP.describe(d, FP.CW, FP.CH, 4, dx, dy)));
  return out;
}

// De k kort i hela indexet som liknar bilden mest: [{ id, s }], s = likhet (korrelation, 1 = identisk)
export async function artMatch(card, k = 30) {
  const a = await loadArtIndex();
  if (!a || !self.Fingerprint || !card) return [];
  const FP = self.Fingerprint, best = new Map(), qs = artQueries(card);
  for (const q of [12, 7, 17, 11, 13].map((i) => qs[i])) for (const t of FP.match(a.db, a.n, q, k)) best.set(t.i, Math.max(best.get(t.i) ?? -1, t.s));
  return [...best].map(([i, s]) => ({ id: a.ids[i], s })).sort((x, y) => y.s - x.s).slice(0, k);
}

// Likhet mot just de här korten, { id: s }. Kort som saknas i indexet (t.ex. japanska) är inte med.
async function artSims(card, ids) {
  const a = await loadArtIndex();
  if (!a || !self.Fingerprint || !card) return {};
  const FP = self.Fingerprint, qs = artQueries(card), out = {};
  for (const id of ids) {
    const i = a.idx.get(id);
    if (i == null) continue;
    let best = -1;
    for (const q of qs) {
      let sc = 0;
      for (let k = 0, o = i * FP.LEN; k < FP.LEN; k++) sc += a.db[o + k] * q[k];
      best = Math.max(best, sc / (127 * 127));
    }
    out[id] = best;
  }
  return out;
}

const numKey = (n) => String(n ?? "").trim().replace(/^0+(?=\d)/, "").toLowerCase();
const localOf = (id) => id.slice(id.lastIndexOf("-") + 1);
// Väger ihop bildträffarna och det lästa numret. Kort-id när numret pekar ut ett av korten som liknar bilden, annars null.
async function byNumber(art, r) {
  if (!art.length || !r?.number) return null;
  {
    const counts = r.total ? await setCounts() : null;
    const totalOk = (id) => { const c = counts?.get(setOf(id)); return !c || !r.total || c.official === +r.total || c.total === +r.total; };
    // Numret (och setstorleken) pekar ut ett av korten som liknar bilden
    const hits = art.filter((x) => numKey(localOf(x.id)) === numKey(r.number) && totalOk(x.id) && x.s >= 0.55);
    if (hits.length === 1 || (hits.length > 1 && hits[0].s - hits[1].s >= 0.08)) return hits[0].id;
  }
  return null;
}
// Alla kort i indexet med numret och setstorleken, sorterade efter likhet med bilden. Ett av dem måste likna bilden
// rimligt (0,5) och, om flera finns, vara klart mer likt än tvåan.
async function byNumberThenLook(canvas, r) {
  const [a, counts] = await Promise.all([loadArtIndex(), setCounts()]);
  if (!a || !counts.size) return null;
  const ids = a.ids.filter((id) => {
    if (numKey(localOf(id)) !== numKey(r.number)) return false;
    const c = counts.get(setOf(id));
    return c && (c.official === +r.total || c.total === +r.total);
  });
  if (!ids.length || ids.length > 12) return null;
  const sims = await artSims(canvas, ids);
  const ranked = ids.filter((id) => sims[id] != null).sort((x, y) => sims[y] - sims[x]);
  const s0 = sims[ranked[0]] ?? -1, s1 = ranked[1] ? sims[ranked[1]] : -1;
  return s0 >= 0.5 && s0 - s1 >= 0.08 ? ranked[0] : null;
}
// Bildträff som är tydlig på egen hand: hög likhet och långt före tvåan
const byLook = (art, s, gap) => (art[0] && art[0].s >= s && art[0].s - (art[1]?.s ?? 0) >= gap ? art[0].id : null);

// Nummerraden läst på fler sätt (smalare och högre zon, större förstoring). Används när första läsningen inte
// stämmer med bilden. ok() avgör om ett nummer duger, och då slutar vi läsa.
const EXTRA_NUM_ZONES = [
  // Gråskala med förstärkt kontrast, utan tröskel: klarar ljus text på mörka kort som tröskeln suddar ut
  [{ x: 0, y: 0.9, w: 0.5, h: 0.1 }, 0],
  [{ x: 0, y: 0.95, w: 0.5, h: 0.05 }, 0],
  [{ x: 0.02, y: 0.94, w: 0.4, h: 0.045 }, 2.2],
  [{ x: 0.02, y: 0.9, w: 0.45, h: 0.09 }, 2.2],
  [ZONES.numLeft, 2.2],
  [{ x: 0.02, y: 0.9, w: 0.45, h: 0.09 }, 1.4],
  [ZONES.numRight, 2.2],
  [{ x: 0, y: 0.84, w: 0.55, h: 0.16 }, 1.4], // brett band: numret hittas även när kortets nederkant ligger lite fel
];
// Zonen i gråskala, utsträckt så att mörkaste och ljusaste delen blir svart och vit. Text ungefär 110 px hög.
function plainZone(src, zone, outH = 110) {
  const sw = src.width * zone.w, sh = src.height * zone.h, k = outH / sh;
  const cv = Object.assign(document.createElement("canvas"), { width: Math.round(sw * k), height: outH });
  const g = cv.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(src, src.width * zone.x, src.height * zone.y, sw, sh, 0, 0, cv.width, cv.height);
  const img = g.getImageData(0, 0, cv.width, cv.height), d = img.data, hist = new Uint32Array(256), n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < n * 0.02) lo++;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) < n * 0.02) hi--;
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8) - lo) * 255) / span));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return cv;
}
async function rereadNumber(canvas, ok, zones = EXTRA_NUM_ZONES.length) {
  const [worker, sizes] = await Promise.all([getWorker("number"), setSizes()]);
  for (const [zone, scale] of EXTRA_NUM_ZONES.slice(0, zones)) {
    for (const map of scale ? zoneMaps(canvas, zone, scale) : [plainZone(canvas, zone)]) {
      const num = findNumber((await worker.recognize(map)).data.text, sizes);
      if (num && (await ok(num))) return num;
    }
  }
  return null;
}

// Hittar kortet i ett rätat canvas: först bilden, sedan text. Returnerar avläsningen plus cardId om kortet är säkert.
async function identify(canvas, { full = false } = {}) {
  const art = await artMatch(canvas).catch(() => []);
  // Så tydlig bildträff att textläsningen inte behövs
  const quick = byLook(art, 0.9, 0.12);
  if (quick) return { name: null, number: localOf(quick), total: null, numberSure: true, cardId: quick, art };
  const r = await readCard(canvas, { full });
  let cardId = await byNumber(art, r);
  // Numret saknas eller stämmer inte med något kort som liknar bilden (t.ex. 109 läst som 105): läs nummerraden igen
  // Saknas numret helt sparas första säkra läsningen, så att sökningen på nummer fungerar även om bilden inte känns igen.
  if (!cardId && (!r.number || (art.length && art[0].s >= 0.55))) {
    let firstSure = null;
    // Automatisk skanning (flera gånger i sekunden): bara de tre bästa varianterna, så att nästa bild inte får vänta
    const num = await rereadNumber(canvas, async (n) => {
      if (await byNumber(art, n)) return true;
      if (n.sure && !firstSure) firstSure = n;
      return false;
    }, full ? undefined : 3);
    if (num) { cardId = await byNumber(art, num); Object.assign(r, { number: num.number, total: num.total, numberSure: true }); }
    else if (firstSure && !r.number) Object.assign(r, { number: firstSure.number, total: firstSure.total, numberSure: true });
  }
  // Nummer och setstorlek lästa: jämför bilden med just de kort som har det numret (t.ex. 109/182 finns i flera set)
  if (!cardId && r.number && r.total) cardId = await byNumberThenLook(canvas, r);
  // Sist: en bildträff som är klart bättre än alla andra kort räcker
  cardId ||= byLook(art, 0.85, 0.08) || byLook(art, 0.72, 0.15);
  return { ...r, cardId, art };
}

const fallbackRect = (w, h) => [[w * 0.1, h * 0.1], [w * 0.9, h * 0.1], [w * 0.9, h * 0.9], [w * 0.1, h * 0.9]];
// Ett foto eller en bild: hitta kortet, räta ut det och identifiera det.
export async function scanImage(img, { full = true } = {}) {
  const corners = findCardQuad(img) || detectCardCorners(img, fallbackRect(img.width, img.height), 0.35).corners;
  const warped = unwarpCard(img, corners);
  const canvas = Object.assign(document.createElement("canvas"), { width: warped.width, height: warped.height });
  canvas.getContext("2d").drawImage(warped, 0, 0);
  return { ...(await identify(canvas, { full })), canvas };
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

// lines är [{ text, h }] där h är radens höjd i pixlar. Kortnamnet är den största texten i zonen, så en hög rad
// vinner över t.ex. "Evolves from Charmeleon" ovanför namnet på gamla kort.
function findName(lines, list) {
  let best = null;
  lines.forEach(({ text, h }) => {
    // "Evolves from Charmeleon" och "Put Charizard on the Stage 1 card" står ovanför namnet på äldre kort
    const clean = text.replace(/evolves\s*from\s*\S+/gi, " ").replace(/put\s+\S+\s+on\b.*/gi, " ");
    const words = clean.split(/\s+/).filter(Boolean);
    for (const w of words) {
      // Namnet sitter ofta ihop med skräp från symboler intill, t.ex. "PikachU(Zg)" eller "UmbreonViaye"
      const key = norm(w);
      for (const p of list) {
        if (p.key.length < 5 || key.length <= p.key.length || !key.startsWith(p.key)) continue;
        const score = 6 - h - p.key.length * 0.1;
        if (!best || score < best.score) best = { name: p.name, score };
      }
    }
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
          const score = dist * 12 - h - p.key.length * 0.1;
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
// sizes är alla kända setstorlekar: totalen efter snedstrecket måste vara en av dem, annars är det skräp.
// Snedstrecket läses ofta som 7 eller 1 eller faller bort ("2157203", "006 165"). Då delas siffrorna där
// totalen blir en känd setstorlek, och svaret får sure: false eftersom det är en gissning.
function findNumber(text, sizes) {
  if (!text) return null;
  const fixed = text.replace(/[A-Za-z0-9|]{1,10}\s*\/\s*[A-Za-z0-9|]{1,10}/g, (m) => {
    const [a, b] = m.split("/");
    return `${fixNumberToken(a.trim())}/${fixNumberToken(b.trim())}`;
  });
  // Hemliga kort går över totalen, i t.ex. Paldean Fates ända till 245/91
  const plausible = (a, b) => b.length >= 2 && +a > 0 && +a <= Math.max(+b * 3, +b + 160) && (!sizes?.size || sizes.has(+b));
  const result = (a, b, sure) => ({ number: a.replace(/^[A-Z]+/, "").replace(/^0+(?=\d)/, ""), total: b, sure });

  for (const m of fixed.matchAll(/(?<![A-Z\d])([A-Z]{0,4}\d{1,3}[a-z]?)\s*\/\s*[A-Z]{0,4}(\d{2,3})(?!\d)/g)) {
    if (plausible(m[1].replace(/\D/g, ""), m[2])) return result(m[1], m[2], true);
  }

  let best = null;
  for (const line of fixed.split("\n")) {
    for (const run of line.replace(/\s+/g, "").match(/\d{3,8}/g) || []) {
      for (let start = 0; start <= run.length - 3; start++) {
        for (let i = 1; i <= 3; i++) {
          for (const sep of [1, 0]) {
            if (sep && !"71".includes(run[start + i])) continue;
            for (const len of [3, 2]) {
              const end = start + i + sep + len;
              if (end > run.length) continue;
              const a = run.slice(start, start + i), b = run.slice(start + i + sep, end);
              if (!plausible(a, b)) continue;
              // Moderna kort fyller ut numret till totalens längd (006/165), och ett utläst snedstreck väger tungt.
              // Siffror före eller efter är troligen skräp och drar ner.
              const score = sep * 2 + (a.length === b.length ? 2 : 0) - start - (run.length - end);
              if (!best || score > best.score) best = { ...result(a, b, false), score };
            }
          }
        }
      }
    }
  }
  return best && { number: best.number, total: best.total, sure: false };
}

// Rader ur ett Tesseract-svar med höjd. Saknas radinfo används texten med samma höjd på alla rader.
const linesOf = (res) => (res.data.lines?.length
  ? res.data.lines.map((l) => ({ text: l.text.trim(), h: l.bbox.y1 - l.bbox.y0 }))
  : res.data.text.split("\n").map((t) => ({ text: t.trim(), h: 0 }))).filter((l) => l.text);

// Mörk och ljus text staplade i en körning. För namnet läser Tesseract det bättre än var för sig.
async function readName(worker, canvas, list) {
  return findName(linesOf(await worker.recognize(stack(zoneMaps(canvas, ZONES.name, 0.7)))), list);
}

// Nere till vänster först (kort från 2020 och framåt), sedan nere till höger. Ett säkert nummer avbryter direkt,
// så ett vanligt modernt kort klarar sig på en enda OCR-körning. Varje bild läses för sig: staplade blir de sämre.
async function readNumber(worker, canvas, sizes) {
  let guess = null;
  for (const zone of [ZONES.numLeft, ZONES.numRight]) {
    for (const map of zoneMaps(canvas, zone, 1.4)) {
      const num = findNumber((await worker.recognize(map)).data.text, sizes);
      if (num?.sure) return num;
      guess ||= num;
    }
  }
  return guess;
}

// Läser kortet från ett rätat canvas (CARD_W × CARD_H px).
// full läser hela kortet om zonerna inte räcker. Det är långsamt, så auto-skanningen gör det inte.
export async function readCard(canvas, { full = false } = {}) {
  const [nameWorker, numWorker, list, sizes] = await Promise.all([getWorker("name"), getWorker("number"), names(), setSizes()]);

  // Namn och nummer läses samtidigt i var sin worker
  let [name, num] = await Promise.all([readName(nameWorker, canvas, list), readNumber(numWorker, canvas, sizes)]);

  // Om zonerna inte räckte: läs hela kortet (bara vid "Skanna nu" och foto)
  if (full && (!name || !num)) {
    const fullRes = await nameWorker.recognize(zoneMaps(canvas, { x: 0, y: 0, w: 1, h: 1 }, 0.7)[0]);
    name = name || findName(linesOf(fullRes), list);
    num = num || findNumber(fullRes.data.text, sizes);
  }

  const dhash = computeDHash(canvas);
  return {
    name,
    number: num?.number || null,
    total: num?.total || null,
    numberSure: !!num?.sure,
    dhash,
  };
}

// ---------- 6. Filtrera och Matcha mot TCGdex ----------
let setsPromise = null;
const setCounts = () => (setsPromise ||= getJSON(`${API}/sets`).then((sets) => new Map(sets.map((s) => [s.id, s.cardCount || {}]))).catch(() => new Map()));
// Alla setstorlekar som finns, för att känna igen totalen i "013/132". Tom om TCGdex inte svarar.
let sizesPromise = null;
const setSizes = () => (sizesPromise ||= setCounts().then((m) => new Set([...m.values()].flatMap((c) => [c.official, c.total]).filter(Boolean))));
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
  // Bildavtrycken i indexet: snabbare och säkrare än att ladda ner varje kandidats bild
  if (canvas && list.length > 1) {
    const sims = await artSims(canvas, list.map((c) => c.id)).catch(() => ({}));
    const known = list.filter((c) => sims[c.id] != null).sort((x, y) => sims[y.id] - sims[x.id]);
    if (known.length >= 2) {
      const s0 = sims[known[0].id], s1 = sims[known[1].id];
      return { list: [...known, ...list.filter((c) => sims[c.id] == null)], sure: s0 >= 0.5 && s0 - s1 >= 0.08 };
    }
  }
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
let stillTicks = 0, lastScanAt = 0;
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
      <div class="scan-freeze" aria-hidden="true" hidden>
        <canvas></canvas>
        <i class="holo-sheen"></i><i class="holo-grid"></i><i class="holo-beam"></i>
        <svg class="holo-quad" preserveAspectRatio="none"><polygon /></svg>
      </div>
    </div>
    <div class="scan-actions">
      <label class="scan-ghost scan-live">Välj foto<input type="file" accept="image/*" hidden></label>
      <button class="scan-now scan-live" type="button">Skanna nu</button>
      <button class="scan-ghost scan-live" type="button" data-close>Stäng</button>
      <button class="scan-ghost scan-frozen-btn" type="button" data-cancel>Avbryt</button>
      <button class="scan-now scan-frozen-btn" type="button" data-retry>Försök igen</button>
    </div>`;

  document.body.append(dialog);
  dialog.addEventListener("close", stop);
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());

  // Skanna nu: bilden fryses och söks igenom noggrant tills kortet hittas, eller tills man trycker Avbryt / Försök igen
  dialog.querySelector(".scan-now").addEventListener("click", () => runScan(true));
  dialog.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-retry]").addEventListener("click", unfreeze);

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
    // Fotot visas fryst med samma holografiska sökning som när man tar en bild
    frozenScan(freeze(img), { fromFile: true });
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
    if (!dialog.open || !video || !video.videoWidth || frozen) {
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

  // Kortet nära ramen först (snabbt), annars kortets hörn var som helst i bilden
  const near = detectCardCorners(video, defaultCorners);
  const corners = near.confident ? near.corners : findCardQuad(video) || near.corners;
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
  if (!dialog?.open || !video?.videoWidth || busy || frozen || Date.now() < pauseUntil) return;

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

// Startar en skanning av aktuell bild.
async function runScan(manual) {
  if (manual) {
    const video = dialog.querySelector("video");
    if (!stream || !video?.videoWidth) return status("Kameran är inte igång. Välj ett foto av kortet i stället.");
    frozenScan(freeze(video), { fromFile: false });
    return;
  }
  if (busy || frozen) return;
  const cv = grabUnwarpedFrame();
  if (!cv) {
    if (manual) status("Kameran är inte igång. Välj ett foto av kortet i stället.");
    return;
  }
  lastScanAt = Date.now();
  await attempt(cv, { manual });
}

// ---------- 9. Fryst bild med holografisk sökning ----------
// "Skanna nu" (och ett valt foto) fryser bilden. Den söks igenom med alla metoder: kortets hörn på flera sätt,
// bildindexet och alla varianter av nummerraden. Sökningen pågår tills kortet hittas eller man trycker
// Avbryt (stänger) eller Försök igen (tillbaka till kameran).
let frozen = false, scanToken = 0, holoTimer = null;
const HOLO_MSGS = ["Jämför med 23 000 kort…", "Läser kortnumret…", "Kollar setet…", "Letar efter kortets kanter…", "Matchar konstverket…", "Läser namnet…"];

// Visar en stillbild av källan (video eller foto) och returnerar den som canvas att söka i
function freeze(src) {
  const box = dialog.querySelector(".scan-freeze"), cv = box.querySelector("canvas");
  cv.width = src.videoWidth || src.width;
  cv.height = src.videoHeight || src.height;
  cv.getContext("2d").drawImage(src, 0, 0, cv.width, cv.height);
  // Foton visas hela (contain), kamerabilden som videon (cover), så att kortet står där man såg det
  cv.style.objectFit = src.videoWidth ? "cover" : "contain";
  box.hidden = false;
  box.querySelector(".holo-quad").classList.remove("on");
  dialog.classList.remove("found", "missed");
  dialog.classList.add("frozen");
  frozen = true;
  dialog.querySelector(".scan-hud")?.getContext("2d").clearRect(0, 0, 9999, 9999);
  if ("vibrate" in navigator) navigator.vibrate(20);
  let i = 0;
  clearInterval(holoTimer);
  status(HOLO_MSGS[0]);
  holoTimer = setInterval(() => status(HOLO_MSGS[++i % HOLO_MSGS.length]), 1300);
  return cv;
}

// Tillbaka till levande kamera. En pågående sökning får inte längre visa något resultat.
function unfreeze() {
  scanToken++;
  frozen = false;
  clearInterval(holoTimer);
  dialog.classList.remove("frozen", "found", "missed");
  dialog.querySelector(".scan-freeze").hidden = true;
  stillTicks = 0;
  pauseUntil = 0;
  last = lastNum = null;
  status(stream ? "Håll kortet i ramen…" : "Välj ett foto av kortet.");
}

// Kortets kontur på den frusna bilden (i bildens koordinater), som en glödande ram
function showQuad(cv, corners) {
  const svg = dialog.querySelector(".holo-quad");
  const box = svg.parentElement.getBoundingClientRect();
  const cover = cv.style.objectFit === "cover";
  const k = (cover ? Math.max : Math.min)(box.width / cv.width, box.height / cv.height);
  const ox = (box.width - cv.width * k) / 2, oy = (box.height - cv.height * k) / 2;
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  svg.querySelector("polygon").setAttribute("points", corners.map(([x, y]) => `${(x * k + ox).toFixed(1)},${(y * k + oy).toFixed(1)}`).join(" "));
  svg.classList.add("on");
}

async function frozenScan(snap, { fromFile }) {
  const token = ++scanToken;
  await waitIdle(); // en automatisk avläsning kan pågå, textläsarna delas
  if (token !== scanToken || !dialog.open) return;
  busy = true;
  const alive = () => token === scanToken && dialog.open;
  try {
    // Kortets hörn på flera sätt: nära ramen, var som helst i bilden, och till sist ramen själv
    const guide = fromFile ? fallbackRect(snap.width, snap.height) : getDefaultFrameCorners();
    const near = fromFile ? detectCardCorners(snap, guide, 0.35) : detectCardCorners(snap, guide);
    const quad = findCardQuad(snap);
    const tries = [near.confident && near.corners, quad, !near.confident && near.corners].filter(Boolean);
    // Först snabbt med varje uppsättning hörn, sedan grundligt (hela kortet och alla nummervarianter) med den bästa
    let best = null;
    const run = async (corners, full) => {
      showQuad(snap, corners);
      const warped = unwarpCard(snap, corners);
      const canvas = Object.assign(document.createElement("canvas"), { width: warped.width, height: warped.height });
      canvas.getContext("2d").drawImage(warped, 0, 0);
      const r = await identify(canvas, { full });
      const score = (r.number && r.numberSure ? 2 : 0) + (r.number && r.total ? 1 : 0) + (r.name ? 1 : 0);
      if (!best || score > best.score) best = { r: { ...r, canvas }, score, corners };
      return r;
    };
    for (const corners of tries) {
      const r = await run(corners, false);
      if (!alive()) return;
      if (r.cardId) return done({ ...r, canvas: best.r.canvas });
    }
    if (best.score < 3) {
      status("Söker noggrannare…");
      const r = await run(best.corners, true);
      if (!alive()) return;
      if (r.cardId) return done({ ...r, canvas: best.r.canvas });
    }
    // Inget säkert kort, men ett läst nummer: sök på det som förut (en stillbild kan inte läsas två gånger)
    if (best.r.number) return done(best.r);
    // Bara ett namn: fyll i sökrutan i stället för att påstå att kortet är hittat
    if (best.r.name && onPartial) {
      stop();
      dialog.close();
      onPartial({ name: best.r.name, number: null, total: null });
      return;
    }
    clearInterval(holoTimer);
    dialog.classList.add("missed");
    status("Hittade inget kort. Tryck <b>Försök igen</b> och håll kortet stilla i ramen.");
  } catch (err) {
    if (!alive()) return;
    clearInterval(holoTimer);
    dialog.classList.add("missed");
    status(esc(err.message || "Något gick fel. Försök igen."));
  } finally {
    busy = false;
  }

  function done(r) {
    clearInterval(holoTimer);
    dialog.classList.add("found");
    const label = r.cardId ? r.name || "kortet" : [r.name, r.number && (r.total ? `${r.number}/${r.total}` : r.number)].filter(Boolean).join(" · ");
    status(`Hittade <b>${esc(label)}</b>!`);
    if ("vibrate" in navigator) navigator.vibrate(45);
    // Låt "hittad"-blixten synas en kort stund innan resultatet öppnas
    setTimeout(() => {
      if (!alive()) return;
      stop();
      dialog.close();
      if (r.cardId || r.number || r.name) onFound?.({ name: r.name, number: r.number, total: r.total, cardId: r.cardId, canvas: r.canvas, dhash: r.dhash });
    }, 650);
  }
}

let last = null, lastNum = null;
async function attempt(canvas, { fromFile = false, manual = false } = {}) {
  if (busy) return;
  busy = true;
  frameEl()?.classList.add("is-reading");
  frameEl()?.classList.remove("is-moving");
  if (!fromFile) status("Läser av…");
  try {
    // 1. Bilden mot alla kort, sedan texten. Pekar de ut samma kort (eller är bildträffen mycket tydlig) är vi klara.
    const r = await identify(canvas, { full: manual || fromFile });
    if (!dialog.open) return;
    if (r.cardId) {
      status(`Hittade <b>${esc(r.name || "kortet")}</b>!`);
      dialog.querySelector(".scan-hud-status")?.classList.add("success");
      if ("vibrate" in navigator) navigator.vibrate(45);
      stop();
      dialog.close();
      onFound?.({ name: r.name, number: r.number, total: r.total, cardId: r.cardId, canvas, dhash: r.dhash });
      return;
    }

    // 2. Annars som förut: namn och nummer söks i TCGdex
    const numKey = r.number && `${r.number}/${r.total}`;
    // Ett nummer räknas om det lästes med snedstreck, eller likadant två gånger i rad
    const numOk = numKey && (r.numberSure || lastNum === numKey);
    if (!numOk) Object.assign(r, { number: null, total: null });
    const seen = [r.name, r.number && numKey].filter(Boolean).join(" · ");
    // Namn och nummer tillsammans räcker direkt. Bara nummer eller bara namn måste läsas likadant två gånger i rad,
    // eftersom en enstaka felläsning annars ger fel kort.
    const sure = (numOk && (r.name || lastNum === numKey || fromFile)) || (r.name && (fromFile || last === r.name));
    last = r.name;
    lastNum = numKey;

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
  frozen = false;
  scanToken++;
  clearInterval(holoTimer);
  dialog?.classList.remove("frozen", "found", "missed");
  const fz = dialog?.querySelector(".scan-freeze");
  if (fz) fz.hidden = true;
  clearInterval(timer);
  timer = null;
  cancelAnimationFrame(animFrame);
  animFrame = null;
  smoothedCorners = null;
  hasPrevMotion = false;
  torchActive = false;
  dialog?.querySelector(".scan-torch")?.classList.remove("active");
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
  lastNum = null;
  smoothedCorners = null;
  hasPrevMotion = false;
  stillTicks = 0;
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
  // Värm upp båda textläsarna och setstorlekarna medan kameran startar
  getWorker("name").catch(() => {});
  getWorker("number").catch(() => {});
  setSizes().catch(() => {});
  loadArtIndex().catch(() => {});

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
