// Kortskanner: läser kortets namn och nummer med kameran och hittar kortet i TCGdex.
// Inspirerad av mtg_card_detector och Pokemon-Card-Scanner:
// 1. Kortets kanter letas nära ramen på skärmen och 4-punkts perspektivtransformation (homografi) rätsiktar
//    sneda kort till ett platt 63×88 mm-format.
// 2. Små läszoner där texten alltid sitter: namnet uppe till vänster och kortnumret nere till vänster
//    (2020 och framåt) eller nere till höger (äldre kort). Bildbehandling för OCR: gråskala, reflexdämpning,
//    brusutjämning och lokal tröskel, för både mörk och ljus text. Namn och nummer läses av var sin
//    Tesseract-worker parallellt. Numret måste ha en total som är en känd setstorlek, t.ex. 132 i "013/132".
// 3. Rörelsekontroll: läsningen startar först när kameran hålls stilla.
// 4. Perceptual dHash (64-bitars skillnadshash) för visuell matchning av kandidatkorten.
// 5. Hittas inte kortet nära ramen letas dess fyra hörn i hela bilden (kanter + Hough-linjer, scan/quad.js).
// 6. Bildavtryck av konstverket (scan/fingerprint.js) jämförs med ett färdigt index över alla kort (data/hashes.*).
//    Pekar bilden och det lästa numret ut samma kort är skanningen klar, utan att vänta på namnet.
// 7. Automatisk skanning går i två spår: bildjämförelsen på varje bild och textläsningen i bakgrunden, se attempt.
import { API, cardImg, esc, getJSON, kr } from "./site.js";
import { loadDataset } from "./card-autocomplete.js";
import { signaturePairs, isSignature } from "./signature.js?v=20261107a";
import "./scan/quad.js?v=20261103a"; // sätter self.Quad
import "./scan/fingerprint.js?v=20261106b"; // sätter self.Fingerprint (med FP.BOX per spel)
import { coinMuted, hasTierSound, playCoin, playTier, setCoinMuted, unlockCoin } from "./scan/coin.js?v=20261106a";

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
// SRI: webbläsaren vägrar köra filen om CDN:et skulle leverera något annat än exakt version 5.1.1.
// Byts versionen ovan måste hashen räknas om (openssl dgst -sha384 -binary fil | base64).
const TESSERACT_SRI = "sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F";
const SCAN_INTERVAL = 250; // ms minst mellan två OCR-försök under aktiv kameraström
const BLIND_INTERVAL = 1000; // ms mellan två försök när ramen inte ser något kort
const MOTION_TICK = 100; // ms mellan två stabilitetskontroller
const MOTION_LIMIT = 10; // medelskillnad (0–255 per pixel) under vilken kameran räknas som stilla
const MOTION_SEEN = 22; // när ramen ser kortet: en hand darrar alltid lite, och bildjämförelsen tål det
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
  // Riftbound: "OGN • 135/298" i den svarta kanten, som kan hamna ända nere vid kortets kant när hörnen är ungefärliga
  numRb: { x: 0.02, y: 0.925, w: 0.45, h: 0.075 },
  // Riftbound-battlefield vridet till liggande (se turnCanvas): numret står nere till vänster
  numBf: { x: 0.01, y: 0.92, w: 0.3, h: 0.08 },
};

// ---------- Textigenkänning (Tesseract) ----------
// Varsin worker för namn och nummer, så att de läses samtidigt och var och en bara letar efter sina tecken.
const OCR_PARAMS = {
  name: { tessedit_pageseg_mode: "11" },
  number: { tessedit_pageseg_mode: "11", tessedit_char_whitelist: "0123456789/" },
  // One Piece-nummer, t.ex. "EB05-014", "OP14-047", "P-061"
  opnum: { tessedit_pageseg_mode: "11", tessedit_char_whitelist: "ABEOPRST0123456789-" },
};
// En andra nummerläsare, så att flera varianter av nummerraden kan läsas samtidigt (Riftbound)
OCR_PARAMS.number2 = OCR_PARAMS.number;
// Setkod och nummer i samma läsning ("JTG EN 084/159"), på kort från 2023 och framåt
// En enda rad med siffror: numret i en smal zon
OCR_PARAMS.line = { tessedit_pageseg_mode: "7", tessedit_char_whitelist: "0123456789/" };
OCR_PARAMS.code = { tessedit_pageseg_mode: "11", tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/" };
const numberWorker = (i) => getWorker(i % 2 ? "number2" : "number");
let scriptPromise = null;
const workers = {};
function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    if (integrity) { s.integrity = integrity; s.crossOrigin = "anonymous"; }
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Kunde inte ladda textläsaren."));
    document.head.append(s);
  });
}

function getWorker(kind) {
  if (!workers[kind]) {
    scriptPromise ||= window.Tesseract ? Promise.resolve() : loadScript(TESSERACT, TESSERACT_SRI).catch((err) => { scriptPromise = null; throw err; });
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
// Textläsarna tar tiotals megabyte var. När skannern varit stängd en stund stängs de, så att sidan inte bär på dem
// resten av besöket. Nästa gång skannern öppnas startas de om (språkfilen ligger kvar i webbläsarens lager).
const WORKER_REST = 120e3; // ms från att skannern stängts
let restTimer = null;
function restWorkers() {
  clearTimeout(restTimer);
  restTimer = setTimeout(() => {
    if (dialog?.open) return; // öppnad igen: nästa stängning startar en ny väntan
    if (busy || reading) return restWorkers(); // en läsning pågår än
    for (const kind of Object.keys(workers)) {
      const w = workers[kind];
      delete workers[kind];
      w.then((x) => x.terminate()).catch(() => {});
    }
  }, WORKER_REST);
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
    // highp där det finns: med mediump (16 bitar på många telefoner) räcker inte upplösningen i texturkoordinaten till en
    // 1920 px bred bild, och den lilla nummerraden blir då suddig eller hackig.
    const fsSrc = `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif
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
    // Gick shadern inte att bygga ger GPU:n bara svarta bilder: då används 2D-rätningen i stället
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this.gl = null; return; }
    // Telefonen kan ta tillbaka GPU-minnet (t.ex. när fliken legat i bakgrunden). En ny rätare byggs då vid nästa bild.
    this.canvas.addEventListener("webglcontextlost", () => { if (glWarperInstance === this) glWarperInstance = null; });
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
const EVEN_SIDES = 0.84; // kortaste av två motstående sidor, som andel av den längsta
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

// Fingrar utanför kortet ger starkare och yttre övergångar än kortets kant på en del av tvärsnitten, och då stämmer ingen
// rät linje genom de yttersta punkterna. Varje tvärsnitt har därför upp till tre kandidater, och linjen som flest tvärsnitt
// stöder vinner. Är flera nästan lika starka (kortets kant och ramen innanför) vinner den yttersta.
function strongestLine(peaks, outward) {
  const usable = peaks.filter((p) => p.length), third = Math.max(1, Math.floor(usable.length / 3));
  const lines = [];
  for (const pa of usable.slice(0, third)) for (const a of pa) for (const pb of usable.slice(-third)) for (const b of pb) {
    if (a[0] === b[0]) continue;
    const slope = (b[1] - a[1]) / (b[0] - a[0]);
    if (Math.abs(slope) > 0.15) continue;
    const pts = [];
    for (const list of usable) {
      let near = null, d = 1.6;
      for (const c of list) { const e = Math.abs(a[1] + slope * (c[0] - a[0]) - c[1]); if (e < d) { d = e; near = c; } }
      if (near) pts.push(near);
    }
    if (pts.length >= SIDE_SAMPLES * 0.5) lines.push({ pts, out: (outward * pts.reduce((s, p) => s + p[1], 0)) / pts.length });
  }
  if (!lines.length) return null;
  const most = Math.max(...lines.map((l) => l.pts.length));
  const best = lines.filter((l) => l.pts.length >= most * 0.6).sort((x, y) => y.out - x.out)[0];
  const line = fitLine(best.pts);
  return line && line.inliers >= SIDE_SAMPLES * 0.5 ? line : null;
}

// band kan vara en lista: varje bredd provas i tur och ordning på samma gråskalebild, och den första som ger ett kort
// vinner. Ett kort i toploader eller plastficka sticker ut utanför ramen, och fångas då av det bredare bandet.
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
  for (const b of [].concat(band)) {
    const found = cornersInBand(Math.max(4, Math.round(b * Math.min(gw, gh))));
    if (found.confident) return found;
  }
  return { corners: guide, confident: false };

  function cornersInBand(reach) {
    // En kant: horizontal = topp/botten (söker i y), outward = -1 när utsidan ligger mot lägre koordinater
    const side = (horizontal, edge, outward) => {
      const pts = [], peaks = [];
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
        // De tre starkaste topparna i tvärsnittet, för strongestLine
        const tops = [];
        for (let i = 1; i < grad.length - 1; i++) if (grad[i] >= max * 0.45 && grad[i] >= grad[i - 1] && grad[i] >= grad[i + 1]) tops.push(i);
        peaks.push(tops.sort((x, y) => grad[y] - grad[x]).slice(0, 3).map((i) => [t, from - outward * i]));
      }
      const line = fitLine(pts);
      return line && line.inliers >= SIDE_SAMPLES * 0.5 ? line : strongestLine(peaks, outward);
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
    // Motstående sidor ska vara ungefär lika långa. Ett kort som lutar 30 grader skiljer omkring 15 %, och mer än så
    // betyder att en av linjerna är något annat än kortets kant (ramen runt bilden, ett finger, en skugga).
    const even = (a, b) => Math.min(a, b) >= Math.max(a, b) * EVEN_SIDES;
    const shaped = even(dist(corners[0], corners[1]), dist(corners[3], corners[2])) && even(dist(corners[0], corners[3]), dist(corners[1], corners[2]));
    const confident = shaped && ratio > 0.62 && ratio < 0.82 && corners.every(([x, y]) => x > -sw * 0.05 && x < sw * 1.05 && y > -sh * 0.05 && y < sh * 1.05);
    return { corners: confident ? corners : guide, confident };
  }
}

// ---------- 4b. Kortets hörn i hela bilden ----------
// Kanter (Sobel) och raka linjer (Hough) i en liten kopia av bilden. Fyrhörningen måste ha kortets proportioner och
// tydlig kant runt om. Klarar kort som ligger snett, långt bort eller utanför ramen. Hörnen i källans koordinater, eller null.
let quadCanvas = null, quadCtx = null;
function quadSearch(src, loose) {
  const Q = self.Quad;
  const sw = src?.videoWidth || src?.width, sh = src?.videoHeight || src?.height;
  if (!Q || !sw || !sh) return null;
  const k = 360 / Math.max(sw, sh), w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  if (!quadCanvas || quadCanvas.width !== w || quadCanvas.height !== h) {
    quadCanvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
    quadCtx = quadCanvas.getContext("2d", { willReadFrequently: true });
  }
  quadCtx.drawImage(src, 0, 0, w, h);
  const r = Q.find(quadCtx.getImageData(0, 0, w, h).data, w, h, loose);
  const scale = (q) => q.pts.map(([x, y]) => [x / k, y / k]);
  return loose ? r.map(scale) : r && scale(r);
}
export const findCardQuad = (src) => quadSearch(src, 0);
// Upp till n troliga fyrhörningar med friare proportioner, bästa först (se loose i scan/quad.js)
export const findCardQuads = (src, n = 4) => quadSearch(src, n) || [];

// ---------- 4c. Bildavtryck mot alla kort ----------
// Ett index per spel, 240 byte per kort. Pokémon (ca 21 000 kort, utan de digitala TCG Pocket-korten) i data/, byggt
// av scripts/build-card-index.mjs. Riftbound (ca 1 500 bilder) i data/rb/, byggt av scripts/build-rb-card-index.mjs. One Piece (ca 4 400 bilder) i
// data/op/, byggt av scripts/build-op-card-index.mjs. Alla byggs varje månad.
const ART_BASES = { pokemon: "data/", rb: "data/rb/", op: "data/op/" };
const artPromises = {}, artFailedAt = {};
// Avtrycken sparas på telefonen, under hashes.json:s version v. Servern svarar inte 304 på .bin-filer, så utan det laddas
// alla tre (6,5 MB) ner varje gång skannern öppnas, och första kortet får vänta på dem. Nästa månads index har ett nytt v.
const ART_CACHE = "nl-scan-index";
async function artBytes(base, j) {
  // document.baseURI, inte location.href: hashes.json hämtas relativt sidans <base>, och .bin-filen måste följa med dit
  const url = new URL(`${base}hashes.bin?v=${j.v}`, document.baseURI).href, size = j.n * j.len;
  const cache = j.v ? await globalThis.caches?.open(ART_CACHE).catch(() => null) : null;
  const saved = await cache?.match(url).catch(() => null);
  if (saved) {
    const b = await saved.arrayBuffer();
    if (b.byteLength === size) return b;
  }
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(r.status);
  const copy = r.clone(), b = await r.arrayBuffer();
  if (cache && b.byteLength === size) {
    cache.put(url, copy).then(() => cache.keys()).then((keys) => {
      for (const k of keys) if (k.url !== url && k.url.split("?")[0] === url.split("?")[0]) cache.delete(k);
    }).catch(() => {});
  }
  return b;
}
export function loadArtIndex(game = "pokemon") {
  if (!artPromises[game] && Date.now() - (artFailedAt[game] || 0) < 60e3) return Promise.resolve(null); // misslyckades nyss: försök inte vid varje bild
  artPromises[game] ||= (async () => {
    try {
      const base = ART_BASES[game];
      const j = await fetch(base + "hashes.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : Promise.reject()));
      const db = new Int8Array(await artBytes(base, j));
      // Ett kort kan finnas flera gånger (liggande battlefields, vridna åt båda hållen). idx pekar på det första.
      if (db.length === j.n * j.len) return { ids: j.ids, names: j.names, db, n: j.n, idx: new Map(j.ids.map((id, i) => [id, i]).reverse()) };
    } catch {}
    artPromises[game] = null;
    artFailedAt[game] = Date.now();
    return null;
  })();
  return artPromises[game];
}

// Sökningen görs i en egen tråd (scan/art-worker.js), så att kameran inte hackar medan 21 000 kort jämförs. Går tråden
// inte att starta görs samma sökning på sidan.
let artThread = null, artThreadDead = !window.Worker, artJobNo = 0;
const artJobs = new Map(), artThreadHas = new Set();
function dropThread() {
  artThreadDead = true;
  artThread?.terminate();
  artThread = null;
  for (const done of artJobs.values()) done(null);
  artJobs.clear();
}
function getThread() {
  if (!artThread && !artThreadDead) {
    try {
      artThread = new Worker(new URL("./scan/art-worker.js?v=20261106b", import.meta.url));
      artThread.onmessage = ({ data }) => {
        const done = artJobs.get(data.id);
        artJobs.delete(data.id);
        done?.(data.failed ? null : data.hits);
      };
      artThread.onerror = dropThread;
    } catch { artThreadDead = true; }
  }
  return artThread;
}
async function artSearch(a, game, d, k, quick) {
  const t = getThread();
  if (t) {
    if (!artThreadHas.has(game)) { artThreadHas.add(game); t.postMessage({ load: game, db: a.db, n: a.n }); }
    const hits = await new Promise((done) => {
      const id = ++artJobNo;
      artJobs.set(id, done);
      t.postMessage({ id, game, d, k, quick });
    });
    if (hits) return hits;
  }
  return self.Fingerprint.search(a.db, a.n, d, game, k, quick);
}

// Den del av canvas som FRAMES[f] pekar ut, i samma storlek som canvas (så att läszonerna stämmer)
function frameCrop(canvas, f) {
  const { u0, u1, v0, v1 } = self.Fingerprint.FRAMES[f];
  const c = Object.assign(document.createElement("canvas"), { width: canvas.width, height: canvas.height });
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(canvas, canvas.width * u0, canvas.height * v0, canvas.width * (u1 - u0), canvas.height * (v1 - v0), 0, 0, c.width, c.height);
  return c;
}
// Kortet i den del av bilden där bildjämförelsen hittade det (art.frame), annars canvas som den är
const artCanvas = (canvas, art) => (art?.frame ? frameCrop(canvas, art.frame) : canvas);

// Kortbilden nerskalad till avtryckets storlek (FP.CW × FP.CH), RGBA
let lastPixels = null; // valvet jämför samma bild med tre index
function fpPixels(card) {
  if (lastPixels?.card === card) return lastPixels.d;
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
  const d = fg.getImageData(0, 0, FP.CW, FP.CH).data;
  lastPixels = { card, d };
  return d;
}
// De k kort i hela indexet som liknar bilden mest: [{ id, s }], s = likhet (korrelation, 1 = identisk).
// Samma kort kan ligga flera gånger i indexet (battlefields) och räknas då med sin bästa likhet.
// art.frame är läget i FP.FRAMES där det bästa kortet hittades. quick: se FP.search. För en omrätning (t.ex. kortet inuti
// en ficka), där bilden redan är beskuren rätt eller inte alls: en sökning i stället för tretton.
export async function artMatch(card, k = 30, game = "pokemon", quick = false) {
  const a = await loadArtIndex(game);
  if (!a || !self.Fingerprint || !card) return [];
  const best = new Map();
  for (const { i, s, frame } of await artSearch(a, game, fpPixels(card), k, quick)) {
    const id = a.ids[i], old = best.get(id);
    if (!old || s > old.s) best.set(id, { id, s, frame });
  }
  const out = [...best.values()].sort((x, y) => y.s - x.s).slice(0, k);
  out.frame = out[0]?.frame || 0;
  return out;
}

// Likhet mot just de här korten, { id: s }. Kort som saknas i indexet (t.ex. japanska) är inte med.
async function artSims(card, ids, game = "pokemon") {
  const a = await loadArtIndex(game);
  if (!a || !self.Fingerprint || !card) return {};
  const FP = self.Fingerprint, d = fpPixels(card), qs = FP.FRAMES.flatMap((_, f) => FP.queries(d, game, f)), out = {};
  for (const id of ids) {
    const first = a.idx.get(id);
    if (first == null) continue;
    let best = -1;
    // Alla platser kortet har i indexet (liggande kort finns två gånger, direkt efter varandra)
    for (let i = first; i < a.n && a.ids[i] === id; i++) {
      for (const q of qs) {
        let sc = 0;
        for (let k = 0, o = i * FP.LEN; k < FP.LEN; k++) sc += a.db[o + k] * q[k];
        best = Math.max(best, sc / (127 * 127));
      }
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
    const hits = art.filter((x) => numKey(localOf(x.id)) === numKey(r.number) && totalOk(x.id) && x.s >= LIKE);
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
  return s0 >= LIKE && s0 - s1 >= 0.08 ? ranked[0] : null;
}
// Likhet (s) med rätt kort på foton: oftast 0,7-0,9. CLEAR: så tydligt att inget mer behövs. LIKE: rimligt likt, när numret
// eller namnet också pekar ut kortet. RETRY: under det provas omrätningar (ficka, Riftbounds svarta kant).
const CLEAR = 0.7, CLEAR_GAP = 0.16, LIKE = 0.42, RETRY = 0.62;
// Bildträff som är tydlig på egen hand: hög likhet och långt före tvåan
const byLook = (art, s, gap) => (art[0] && art[0].s >= s && art[0].s - (art[1]?.s ?? 0) >= gap ? art[0].id : null);
// Bildträffen som räcker utan text. En vanlig tom ram liknar ett kort högst ungefär 0,55 med försprång 0,12, men ett randigt
// mönster kan nå 0,74 med försprång 0,16 mot ett kort med mönster. Rätt kort ligger kring 0,8 även med reflexer. Utan kortets kanter (framed
// falskt) krävs därför både högre likhet och större försprång, och flera bilder (se confirmed).
const lookEnough = (art, framed = true) => (framed ? byLook(art, 0.58, 0.12) : byLook(art, 0.68, 0.2));
// Korten nära toppen när alla är samma kort (key = namnet) i olika utgåvor och det närmaste andra kortet ligger klart
// under, annars null
function sameCard(art, key) {
  if (!art[0] || art[0].s < RETRY) return null;
  const k0 = key(art[0].id), near = art.filter((x) => x.s >= art[0].s - 0.06);
  if (near.length < 2 || !k0 || !near.every((x) => key(x.id) === k0)) return null;
  const other = art.find((x) => key(x.id) !== k0);
  return other && art[0].s - other.s < 0.1 ? null : near.map((x) => x.id);
}

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

// ---------- 4d. Riftbound ----------
// Korten i data/rb/cards.json. Numret står nere till vänster ("RAD • 001/167 • EN"), där skannern redan läser.
// Flera kort kan dela bild (omtryck), och indexet har bara en av dem, så numret jämförs mot alla kort med samma bild.
let rbPromise = null;
const rbNum = (no) => { const [a, b] = String(no || "").split("/"); return { n: numKey((a || "").replace(/\*/g, "")), t: (b || "").trim() }; };
function rbData() {
  rbPromise ||= fetch("data/rb/cards.json").then((r) => r.json()).then(({ cards }) => {
    const byId = new Map(cards.map((c) => [c.id, c]));
    const byImage = new Map();
    for (const c of cards) if (c.image) (byImage.get(c.image) || byImage.set(c.image, []).get(c.image)).push(c);
    // Korten som delar bild med ett kort (inklusive kortet självt)
    const siblings = (id) => byImage.get(byId.get(id)?.image) || [byId.get(id)].filter(Boolean);
    const sizes = new Set(cards.map((c) => +rbNum(c.no).t).filter(Boolean));
    return { cards, byId, siblings, sizes, sigPairs: signaturePairs(cards) };
  }).catch((e) => { rbPromise = null; throw e; });
  return rbPromise;
}
// Numret kommer från kortet när det inte lästes (kortet hittades på bilden), så att det syns i snabbskanningens lista
const rbResult = (rb, id, r = {}) => {
  const c = rb.byId.get(id), [n, t] = id ? String(c?.no || "").split("/") : [];
  return { game: "rb", name: c?.name || null, number: r.number ?? n ?? null, total: r.total ?? t ?? null, numberSure: !!r.numberSure, cardId: id };
};

// Riftbound-kort har en svart kant utanför den färgade ramen. Mot en mörk bakgrund hittar kantsökningen ofta ramen i
// stället för kortets ytterkant, och då hamnar numret (som står i den svarta kanten) utanför bilden. Kortets riktiga
// hörn räknas då ut från ramens: ramen sitter ungefär 6 % in från sidorna, 4,5 % från toppen och 9 % från botten.
const RB_FRAME = { u0: -0.06, u1: 1.06, v0: -0.045, v1: 1.09 };
// Hörnen för en del av fyrhörningen c, i andelar av den (u åt sidan, v nedåt). Andelar utanför 0..1 ger en större.
function subQuad(c, { u0, u1, v0, v1 }) {
  const at = (u, v) => [0, 1].map((k) => (1 - u) * (1 - v) * c[0][k] + u * (1 - v) * c[1][k] + u * v * c[2][k] + (1 - u) * v * c[3][k]);
  return [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
}
const outsideFrame = (c) => subQuad(c, RB_FRAME);
// Kort i plastficka eller toploader: kantsökningen hittar fickans kant, och då blir kortet beskuret för stort.
// Kortets troliga läge inuti: penny sleeve (66×91 mm), toploader (76×101 mm) med kortet nere och i mitten.
const SLEEVES = [
  { u0: 0.023, u1: 0.977, v0: 0.017, v1: 0.983 },
  { u0: 0.087, u1: 0.913, v0: 0.134, v1: 1 },
  { u0: 0.087, u1: 0.913, v0: 0.067, v1: 0.933 },
];
// Den rätning (som hörnen hittades, eller kortet inuti en ficka) vars bild liknar ett kort i indexet mest. En ficka
// väljs bara när bilden då blir en tydlig träff, så att ett blänk inte får en felaktig beskärning att vinna.
async function sleeveBest(canvas, source, art) {
  if (!source?.corners || (art[0]?.s ?? 0) >= CLEAR) return { canvas, art };
  let best = { canvas, art };
  for (const corners of altCorners(source)) {
    const alt = copyCanvas(unwarpCard(source.src, corners));
    const altArt = await artMatch(alt, 30, "pokemon", true).catch(() => []);
    if ((altArt[0]?.s ?? -1) >= RETRY && altArt[0].s > (best.art[0]?.s ?? -1) + 0.03) best = { canvas: alt, art: altArt };
  }
  return best;
}
// Hörnen att prova utöver de hittade: kortet inuti en ficka, och ramen på skärmen när hörnsökningen i hela bilden valde
// något annat (en plastficka eller hand kan ge en fel fyrhörning, medan kortet hålls i ramen).
const altCorners = (source) => [...SLEEVES.map((s) => subQuad(source.corners, s)), ...(source.guide ? [source.guide] : [])];
const copyCanvas = (src) => {
  const c = Object.assign(document.createElement("canvas"), { width: src.width, height: src.height });
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
};
// Bilden vriden ett kvarts varv, medurs (dir = 1) eller moturs (-1)
function turnCanvas(src, dir) {
  const c = Object.assign(document.createElement("canvas"), { width: src.height, height: src.width });
  const g = c.getContext("2d");
  g.translate(c.width / 2, c.height / 2);
  g.rotate((dir * Math.PI) / 2);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}
// Battlefields är liggande och hålls på högkant. Ramen ligger då längre in på långsidorna (där numret står i den svarta
// kanten) och nästan ute vid kortets kant upptill och nertill.
const BF_FRAME = { u0: -0.09, u1: 1.09, v0: -0.01, v1: 1.01 };
// Den lösa kantsökningens fyrhörningar kan vara kortets kant eller ramen på ett vanligt kort eller ett battlefield
const LOOSE_FRAMES = [
  { u0: 0, u1: 1, v0: 0, v1: 1 }, RB_FRAME, BF_FRAME,
  { u0: -0.06, u1: 1.06, v0: 0, v1: 1 }, { u0: -0.12, u1: 1.12, v0: -0.03, v1: 1.03 }, { u0: -0.09, u1: 1.09, v0: -0.045, v1: 1.045 },
];
// Svart kort mot mörk bakgrund (t.ex. ett battlefield på en musmatta): ytterkanten syns inte, så rätningen blir fel eller
// hittas inte alls. Alla troliga fyrhörningar i hela bilden vidgas ut till kortets kant på några sätt, och den rätning
// som liknar ett kort mest vinner. Ett par dussin bildjämförelser, så bara vid manuell skanning och foton.
async function rbLoose(src) {
  let best = null;
  for (const q of findCardQuads(src)) {
    for (const f of LOOSE_FRAMES) {
      const c = copyCanvas(unwarpCard(src, subQuad(q, f)));
      const a = await artMatch(c, 30, "rb").catch(() => []);
      if ((a[0]?.s ?? -1) > (best?.art[0]?.s ?? -1)) best = { canvas: c, art: a };
    }
  }
  return best;
}
// Den rätning (som hörnen hittades, utanför ramen eller kortet inuti en ficka) vars bild liknar ett Riftbound-kort mest.
// alt är tvåan av de två första, så att numret kan läsas där om det hamnade utanför den bästa (numret sitter i den
// svarta kanten, som ramrätningen skär bort). source = { src, corners }: bilden kortet rätades från, så att den kan
// rätas om. Utan den används canvas som den är. full: manuell skanning, då provas även den lösa sökningen (rbLoose).
// source.guess: hörnen är bara en gissning. art: bildträffarna för canvas, om de redan är sökta.
async function rbBestCanvas(canvas, source, full = false, art = null) {
  art ||= await artMatch(canvas, 30, "rb").catch(() => []);
  let best = { canvas, art };
  // Liknar bilden inget Riftbound-kort alls (t.ex. ett Pokémonkort i Pokémonskannern) är det ingen idé att räta om.
  // I Riftbound-skannern provas omrätningarna ändå, eftersom en ficka kan göra den första bilden oigenkännlig.
  if (source?.corners && (art[0]?.s ?? 0) < CLEAR && (art[0]?.s ?? 0) >= (scanGame !== "pokemon" ? 0.25 : 0.4)) {
    for (const f of [RB_FRAME, BF_FRAME]) {
      const c = copyCanvas(unwarpCard(source.src, subQuad(source.corners, f)));
      const a = await artMatch(c, 30, "rb").catch(() => []);
      if ((a[0]?.s ?? -1) > (best.art[0]?.s ?? -1)) best = { canvas: c, art: a, alt: best.canvas };
      else best.alt ||= c;
    }
    if ((best.art[0]?.s ?? 0) < RETRY) {
      for (const corners of altCorners(source)) {
        const c = copyCanvas(unwarpCard(source.src, corners));
        const a = await artMatch(c, 30, "rb").catch(() => []);
        if ((a[0]?.s ?? -1) >= 0.6 && a[0].s > (best.art[0]?.s ?? -1) + 0.03) best = { canvas: c, art: a, alt: best.canvas };
      }
    }
  }
  // Var hörnen bara gissade (source.guess: ingen kant hittades, rätningen är ramen på skärmen) vinner den lösa
  // sökningen även när likheten är ungefär densamma, eftersom en gissad rätning kan likna fel kort av en slump
  if (full && scanGame !== "pokemon" && source?.src && (best.art[0]?.s ?? 0) < RETRY) {
    const loose = await rbLoose(source.src);
    if (loose && (loose.art[0]?.s ?? -1) > (best.art[0]?.s ?? -1) + (source.guess ? -0.05 : 0.02)) best = { ...loose, alt: best.canvas };
  }
  return best;
}

// Riftbound: bilden först, sedan numret. Samma trösklar som för Pokémon.
// round: automatisk skanning, där varje bild bara läser en zon (nästa bild tar nästa zon).
async function identifyRb(canvas, { full = false, art, alt, round = null, framed = true } = {}) {
  const rb = await rbData();
  art ||= await artMatch(canvas, 30, "rb").catch(() => []);
  const whole = canvas;
  canvas = artCanvas(canvas, art); // numret läses där kortet sitter, inte i fickans kant
  const quick = byLook(art, CLEAR, CLEAR_GAP);
  if (quick) return { ...rbResult(rb, quick), art };
  // Samma kort i flera utgåvor med samma bild (runorna finns i ett dussin set): bilden kan inte skilja dem åt, så det
  // blir aldrig en tydlig etta. Pekar alla nära toppen ut samma namn räcker det. Numret väljer utgåvan om det går att
  // läsa på första försöket, annars blir det vanliga utgåvan.
  const same = sameCard(art, (id) => rb.byId.get(id)?.name);
  if (same) {
    const text = (await (await numberWorker(0)).recognize(zoneMaps(canvas, ZONES.numRb, 1.4)[0])).data.text.replace(/[*✱★]/g, "");
    const n = findNumber(text, rb.sizes);
    const byNo = n && same.find((id) => { const k = rbNum(rb.byId.get(id)?.no); return k.n === numKey(n.number) && (!n.total || k.t === n.total); });
    const id = byNo || same.find((id) => !rb.byId.get(id)?.variant) || same[0];
    return { ...rbResult(rb, id, byNo ? { number: n.number, total: n.total, numberSure: !!n.sure } : {}), art };
  }
  // Kortet med numret bland de som liknar bilden, inklusive omtryck med samma bild
  const byNum = (num) => {
    const hits = [];
    for (const x of art) {
      if (x.s < LIKE) continue;
      const c = rb.siblings(x.id).find((c) => { const k = rbNum(c.no); return k.n === numKey(num.number) && (!num.total || k.t === num.total); });
      if (c) hits.push({ id: c.id, s: x.s });
    }
    return hits.length === 1 || (hits.length > 1 && hits[0].s - hits[1].s >= 0.08) ? hits[0].id : null;
  };
  let num = null, cardId = null;
  // Läser bilderna samtidigt med två läsare. Sant när numret pekar ut ett av korten som liknar bilden.
  const read = async (maps) => {
    // Signaturkort har en stjärna i numret ("191*/166"). Den tas bort, så att numret läses som 191/166.
    const texts = await Promise.all(maps.map(async (map, j) => (await (await numberWorker(j)).recognize(map)).data.text.replace(/[*✱★]/g, "")));
    for (const text of texts) {
      const n = findNumber(text, rb.sizes);
      if (!n) continue;
      num ||= n;
      if ((cardId = byNum(n))) { num = n; return true; }
    }
    return false;
  };
  // Varje zon ger några bilder (mörk och ljus text). Första zonen läses även i den andra rätningen, där numret finns
  // kvar om den bästa rätningen skar bort kortets svarta kant.
  const all = [[ZONES.numRb, 1.4], ...EXTRA_NUM_ZONES.slice(0, full ? undefined : 3)];
  const zones = round == null ? all : [all[round % all.length]];
  for (const [i, [zone, scale]] of zones.entries()) {
    const maps = (i === 0 && alt ? [canvas, alt] : [canvas]).flatMap((cv) => (scale ? zoneMaps(cv, zone, scale) : [plainZone(cv, zone)]));
    if (await read(maps)) break;
    // Automatisk skanning: gick numret inte att läsa första gången men bilden är tydlig nog att räcka på egen
    // hand, väljs bildträffen direkt i stället för att prova fler varianter (som annars tar flera sekunder)
    const enough = lookEnough(art, framed);
    if (!full && !num && enough) break;
    // Varken numret eller bilden räcker (blänk, finger, ficka): namnet går fortare än resten av nummervarianterna
    if ((round == null ? i === 0 : round % 2 === 1) && !enough && (cardId = await byName("rb", whole, round).catch(() => null))) { num = null; break; }
  }
  // Ett battlefield som hålls på högkant har numret längs långsidan. Kortet vrids åt båda hållen och numret läses nere
  // till vänster. En säker läsning här går före en osäker från de vanliga zonerna, som då läste något annat.
  if (!cardId && (round == null || round % 2 === 0) && (full || art.slice(0, 5).some((x) => rb.byId.get(x.id)?.type === "Battlefield"))) {
    const before = num;
    num = null;
    for (const dir of [1, -1]) {
      const cv = turnCanvas(canvas, dir);
      if (await read([...zoneMaps(cv, ZONES.numBf, 1.4), plainZone(cv, ZONES.numBf)])) break;
    }
    if (before && !num?.sure) num = before;
  }
  // Nummer och setstorlek lästa men bilden pekar inte ut kortet: jämför bilden med just korten som har det numret
  if (!cardId && num?.total) {
    const ids = rb.cards.filter((c) => { const k = rbNum(c.no); return k.n === numKey(num.number) && k.t === num.total; }).map((c) => c.id);
    if (ids.length && ids.length <= 12) {
      // Indexet har en av korten med samma bild, så likheten hämtas för alla och kortet får den bästa
      const sims = await artSims(canvas, [...new Set(ids.flatMap((id) => rb.siblings(id).map((c) => c.id)))], "rb");
      const ranked = ids.map((id) => ({ id, s: Math.max(-1, ...rb.siblings(id).map((c) => sims[c.id] ?? -1)) })).sort((a, b) => b.s - a.s);
      if (ranked[0]?.s >= LIKE && ranked[0].s - (ranked[1]?.s ?? -1) >= 0.08) cardId = ranked[0].id;
      // Bilden skiljer inte vanliga kortet från t.ex. dess Oversized-version (blänk över bilden): ett säkert nummer
      // med bara ett vanligt kort räcker då
      const plain = ids.filter((id) => !rb.byId.get(id)?.variant);
      if (!cardId && num.sure && plain.length === 1) cardId = plain[0];
    }
  }
  cardId ||= lookEnough(art, framed);
  return { ...rbResult(rb, cardId, { number: num?.number, total: num?.total, numberSure: !!num?.sure }), art };
}

// ---------- One Piece ----------
// Kortet känns igen på bilden. Varianterna (parallel, manga, alternativ bild) har egna bilder i indexet.
// Ett nytt kort har först TCGplayers id ("EB-05/tcg723376") och byter id när optcgapi lägger in det, men bildindexet
// byggs bara en gång i månaden. Kartan har därför även det gamla id:t (från TCGplayers produkt-id, c.tcg eller numret
// i bildlänken) för samma kort. cards: varje kort en gång.
let opPromise = null;
const tcgOld = (c) => {
  const p = c?.tcg || c?.image?.match(/tcgplayer-cdn\.tcgplayer\.com\/product\/(\d+)_/)?.[1];
  return p ? `${c.set}/tcg${p}` : null;
};
function opData() {
  opPromise ||= fetch("data/op/cards.json").then((r) => r.json()).then(({ cards }) => {
    const map = new Map(cards.map((c) => [c.id, c]));
    for (const c of cards) {
      const old = tcgOld(c);
      if (old && !map.has(old)) map.set(old, c);
    }
    map.cards = cards;
    return map;
  }).catch((e) => { opPromise = null; throw e; });
  return opPromise;
}
// Den rätning (som hörnen hittades, eller kortet inuti en ficka) vars bild liknar ett One Piece-kort mest.
// art: bildträffarna för canvas, om de redan är sökta.
async function opBestCanvas(canvas, source, art = null) {
  let best = { canvas, art: art || (await artMatch(canvas, 30, "op").catch(() => [])) };
  if (!source?.corners || (best.art[0]?.s ?? 0) >= CLEAR) return best;
  for (const corners of altCorners(source)) {
    const c = copyCanvas(unwarpCard(source.src, corners));
    const a = await artMatch(c, 30, "op").catch(() => []);
    if ((a[0]?.s ?? -1) >= 0.6 && a[0].s > (best.art[0]?.s ?? -1) + 0.03) best = { canvas: c, art: a };
  }
  return best;
}
const opResult = (cards, id, art) => {
  const c = id && cards.get(id);
  return { game: "op", name: c?.name || null, number: c?.no || null, total: null, numberSure: !!c, cardId: c?.id || id || null, art };
};
// canvas: den rätade bilden, så att namnet kan läsas när bilden inte räcker
async function identifyOp(art, canvas, round = null, framed = true) {
  const cards = await opData();
  let id = lookEnough(art, framed);
  // En parallel med samma bild som vanliga kortet skiljs inte åt på bilden. Är alla nästan lika lika bilder samma
  // kortnummer räcker den bästa: rätt kort, möjligen fel utgåva.
  if (!id && art[0]?.s >= RETRY) {
    const no = cards.get(art[0].id)?.no;
    if (no && art.filter((x) => x.s >= art[0].s - 0.08).every((x) => cards.get(x.id)?.no === no)) id = art[0].id;
  }
  if (!id && canvas) id = await byName("op", canvas, round).catch(() => null);
  return opResult(cards, id, art);
}

// ---------- Namnet på Riftbound- och One Piece-kort ----------
// Blänk, holo och fingrar kan förstöra bildjämförelsen, men namnet är stor text som brukar synas ändå. Namnet ger en
// handfull kort, och bilden väljer bland dem. Hela nedre delen av kortet läses i en körning: där står namnet på båda
// spelen (Riftbound mitt på, One Piece nertill), och zonen tål att kortet är rätat lite fel, t.ex. i en toploader.
// Battlefields (liggande) läses inte.
const NAME_ZONE = { x: 0, y: 0.4, w: 1, h: 0.6 };
const nameLists = {};
async function nameList(game) {
  nameLists[game] ||= (async () => {
    const cards = game === "rb" ? (await rbData()).cards : (await opData()).cards;
    const byName = new Map();
    for (const c of cards) if (c.name && c.type !== "Battlefield") (byName.get(c.name) || byName.set(c.name, []).get(c.name)).push(c.id);
    return [...byName].map(([name, ids]) => ({ name, ids, key: norm(name), wc: name.split(/\s+/).length })).filter((p) => p.key.length >= 4);
  })().catch((e) => { nameLists[game] = null; throw e; });
  return nameLists[game];
}
// Raderna i namnzonen, [{ text, h, conf, box }] (box i canvasens koordinater). Samma bild läses bara en gång, så att
// båda spelen kan leta i samma läsning.
let lastNames = null;
async function nameLines(canvas) {
  if (lastNames?.canvas !== canvas) {
    const worker = await getWorker("name");
    const maps = zoneMaps(canvas, NAME_ZONE, 0.6), mh = maps[0].height, k = 0.6;
    const res = await worker.recognize(stack(maps));
    // Radens ruta i canvasens koordinater: stack() lägger bilderna under varandra med 24 px marginal
    const box = ({ x0, y0, x1, y1 }) => {
      const off = y0 >= mh + 48 ? mh + 48 : 24;
      return { x0: (x0 - 24) / k + canvas.width * NAME_ZONE.x, x1: (x1 - 24) / k + canvas.width * NAME_ZONE.x,
        y0: (y0 - off) / k + canvas.height * NAME_ZONE.y, y1: (y1 - off) / k + canvas.height * NAME_ZONE.y };
    };
    const lines = (res.data.lines || []).map((l) => ({ text: l.text.trim(), h: l.bbox.y1 - l.bbox.y0, conf: l.confidence, box: box(l.bbox) }))
      .filter((l) => /[a-z]{3}/i.test(l.text));
    lastNames = { canvas, lines };
  }
  return lastNames.lines;
}
// Kortnamnet i OCR-raderna: { p, line } eller null. Orden jämförs med varje namn med lika många ord, och små läsfel
// tillåts i långa namn. Ett avhugget namn ("3anner of Cong" när blänket tar resten) räknas om början stämmer, men bara
// på en säker rad. Namnet är den största texten: rader som är klart lägre än de högsta (effekttexten, som kan nämna
// andra kort, t.ex. "[Megalo]") räknas inte.
function matchName(lines, list) {
  const hs = lines.map((l) => l.h).sort((a, b) => b - a), ref = hs[Math.min(2, hs.length - 1)] || 1, maxH = hs[0] || 1;
  let best = null;
  for (const line of lines) {
    const { text, h, conf } = line;
    if (h < ref * 0.6) continue;
    const words = text.split(/\s+/).filter(Boolean);
    for (const p of list) {
      const tol = p.key.length >= 10 ? 2 : p.key.length >= 6 ? 1 : 0;
      for (let i = 0; i + p.wc <= words.length; i++) {
        const key = norm(words.slice(i, i + p.wc).join(" "));
        if (key.length < 4 || key.length > p.key.length + tol) continue;
        let dist = Math.abs(key.length - p.key.length) <= tol ? (key === p.key ? 0 : editDist(key, p.key)) : Infinity;
        let partial = false;
        if (dist > tol && key.length >= 8 && conf >= 80 && key.length < p.key.length) {
          dist = editDist(key, p.key.slice(0, key.length));
          partial = true;
        }
        if (dist > tol) continue;
        const score = dist + (partial ? 1 : 0) - p.key.length * 0.05 - (1.5 * h) / maxH;
        if (!best || score < best.score) best = { p, line, score };
      }
    }
  }
  return best;
}
// One Piece-numret ("EB05-014") står nere till höger, ungefär i höjd med raden under namnet. Ett band över hela
// bredden under namnet läses (så att det fungerar även när kortet är rätat lite fel och numret inte står där det
// borde), på några sätt tills ett nummer är tydligt. nos: numren som kortet kan ha (korten med namnet). Läsfel som
// S/5 och O/0 tål jämförelsen, eftersom den bara väljer bland de numren. Numret, eller null.
const opKey = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/S/g, "5").replace(/[IL]/g, "1");
const OP_NUM_BANDS = [[-0.5, 2.2, 1.6, true], [-0.5, 2.2, 1.6, false], [-0.3, 1.6, 2, true], [-0.3, 1.6, 2, false]];
async function opNumberNear(canvas, line, nos, round = null) {
  const nh = Math.max(4, line.box.y1 - line.box.y0), worker = await getWorker("opnum"), keys = [...new Set(nos)].map((no) => [no, opKey(no)]);
  const texts = [];
  // Närmaste numret i läsningarna hittills (kortaste avståndet mot en ungefär lika lång bit av texten)
  const pick = () => {
    const ranked = keys.map(([no, k]) => {
      let d = Infinity;
      for (const t of texts) for (let n = k.length - 1; n <= k.length + 1; n++) for (let i = 0; i + n <= t.length; i++) d = Math.min(d, editDist(k, t.slice(i, i + n)));
      return { no, d };
    }).sort((a, b) => a.d - b.d);
    return ranked[0] && ranked[0].d <= 2 && (ranked[1]?.d ?? 99) >= ranked[0].d + 2 ? ranked[0].no : null;
  };
  for (const [a, b, scale, plain] of round == null ? OP_NUM_BANDS : [OP_NUM_BANDS[round % OP_NUM_BANDS.length]]) {
    const y0 = Math.max(0, line.box.y1 + a * nh), y1 = Math.min(canvas.height, line.box.y1 + b * nh);
    if (y1 - y0 < 4) return null;
    const zone = { x: 0, y: y0 / canvas.height, w: 1, h: (y1 - y0) / canvas.height };
    for (const map of plain ? [plainZone(canvas, zone, Math.round((y1 - y0) * scale))] : zoneMaps(canvas, zone, scale)) {
      texts.push(...(await worker.recognize(map)).data.text.split(/\s*\n\s*|\s{2,}/).map(opKey).filter(Boolean));
    }
    const no = pick();
    if (no) return no;
  }
  return null;
}
// Kort-id utifrån namnet och bilden, eller null. Bilden måste peka ut kortet bland korten med namnet (det finns t.ex.
// ett tjugotal Shirahoshi), annars blir det inget kort hellre än fel kort. One Piece: numret läses först och väljer ut
// korten med det numret, och bilden väljer sedan variant.
async function byName(game, canvas, round = null) {
  const [list, lines] = await Promise.all([nameList(game), nameLines(canvas)]);
  const hit = matchName(lines, list);
  if (!hit) return null;
  // Riftbound: indexet har ett av korten som delar bild, så likheten hämtas för alla och kortet får den bästa
  const rb = game === "rb" ? await rbData() : null, op = rb ? null : await opData();
  const card = (id) => (rb ? rb.byId.get(id) : op.get(id));
  let ids = hit.p.ids;
  if (op && new Set(ids.map((id) => card(id)?.no)).size > 1) {
    const no = await opNumberNear(canvas, hit.line, ids.map((id) => card(id)?.no).filter(Boolean), round).catch(() => null);
    if (no) ids = ids.filter((id) => card(id)?.no === no);
  }
  // One Piece: kortet kan ligga i bildindexet under sitt gamla id (se opData)
  const group = (id) => (rb ? rb.siblings(id).map((c) => c.id) : [id, tcgOld(op.get(id))].filter(Boolean));
  const sims = await artSims(canvas, [...new Set(ids.flatMap(group))], game);
  const ranked = ids.map((id) => ({ id, s: Math.max(-1, ...group(id).map((g) => sims[g] ?? -1)) })).sort((a, b) => b.s - a.s);
  if (!ranked[0] || ranked[0].s < 0.2) return null;
  const top = ranked[0], no = card(top.id)?.no, others = ranked.filter((x) => card(x.id)?.no !== no);
  const near = ranked.filter((x) => x.s >= top.s - 0.04 && card(x.id)?.no === no).map((x) => x.id);
  // Alla kvar har samma nummer (omtryck, eller varianter som bilden väljer bland): den bästa, eller den vanliga om
  // flera är lika lika (Riftbound: omtryck med samma bild)
  if (!others.length) return rb ? near.find((id) => !card(id)?.variant) || top.id : top.id;
  // Annars måste bilden vara tydlig och klart före kort med andra nummer
  if (top.s >= LIKE && top.s - others[0].s >= 0.06) return top.id;
  // Riftbounds runor: alla utgåvor av en runa är i praktiken samma kort, så namnet räcker
  if (rb && ids.every((id) => card(id)?.type === "Rune")) return ids.find((id) => !card(id)?.variant) || top.id;
  // Riftbound: samma kort finns ofta med samma bild under olika nummer (runorna, omtryck), och då skiljer bilden dem
  // inte åt. Liknar bilden kortet tydligt blir det den vanliga utgåvan bland de nästan lika lika.
  if (rb && top.s >= 0.38) {
    const same = ranked.filter((x) => x.s >= top.s - 0.06).map((x) => x.id);
    return same.find((id) => !card(id)?.variant) || top.id;
  }
  return null;
}

// Vilket spel skannern letar efter: "pokemon" (värderingen, som också känner igen tydliga Riftbound- och One Piece-kort),
// "rb", "op" eller "vault" (Mitt valv: Pokémon, One Piece och Riftbound, utan att man väljer spel).
let scanGame = "pokemon";

// Hittar kortet i ett rätat canvas: först bilden, sedan text. Returnerar avläsningen plus cardId om kortet är säkert.
// source = { src, corners } (bilden och hörnen kortet rätades från) gör att ett Riftbound-kort kan rätas om, se rbBestCanvas.
export async function identify(canvas, { full = false, source } = {}) {
  // Den rätade bilden kan vara GPU-rätningens delade canvas, som en omrätning skriver över
  if (source) canvas = copyCanvas(canvas);
  if (scanGame === "rb") {
    const rb = await rbBestCanvas(canvas, source, full);
    return identifyRb(rb.canvas, { full, art: rb.art, alt: rb.alt });
  }
  if (scanGame === "op") {
    const op = await opBestCanvas(canvas, source);
    return identifyOp(op.art, op.canvas);
  }
  // Alla tre spelen jämförs först med samma bild, utan omrätningar. Omrätningarna (ficka, Riftbounds svarta kant) ger ett
  // spel flera chanser att likna bilden, så att det spelet annars kunde vinna över ett Pokémonkort med blänk.
  const [pk, op0, rb0] = await Promise.all([artMatch(canvas), artMatch(canvas, 30, "op"), artMatch(canvas, 30, "rb")].map((p) => p.catch(() => [])));
  const pkTop = pk[0]?.s ?? 0, opTop0 = op0[0]?.s ?? 0, rbTop0 = rb0[0]?.s ?? 0;
  // Mitt valv: det spel vars bästa bild liknar mest får läsa kortet. Liknar bilden ett Pokémonkort mest läses kortet som
  // i Pokémonskannern, utan One Piece- och Riftbound-omrätningarna. Bara när det var jämnt och Pokémon inte hittade
  // kortet får de andra spelen försöka: där ger en tydlig One Piece-träff svaret direkt, så att Riftbounds långsammare
  // omrätningar inte körs i onödan, och hittar det spel som liknar mest inget kort får det andra läsa namnet (när bilden
  // är förstörd av blänk kan fel spel ha liknat mest). Sist Pokémon, om det var jämnt och inte provats.
  if (scanGame === "vault") {
    const other = Math.max(opTop0, rbTop0), close = Math.abs(pkTop - other) < 0.05;
    let pkR = null;
    if (pkTop > other) {
      pkR = await identifyPokemon(canvas, source, pk, full);
      if (pkR.cardId || !close) return pkR;
    }
    const op = await opBestCanvas(canvas, source, op0);
    const opTop = op.art[0]?.s ?? 0;
    if (opTop >= rbTop0 && lookEnough(op.art)) return identifyOp(op.art);
    const rb = await rbBestCanvas(canvas, source, full, rb0);
    let r;
    if (opTop > (rb.art[0]?.s ?? 0)) {
      r = await identifyOp(op.art, op.canvas);
      if (r.cardId) return r;
      const id = await byName("rb", rb.canvas).catch(() => null);
      if (id) return { ...rbResult(await rbData(), id), art: rb.art };
    } else {
      r = await identifyRb(rb.canvas, { full, art: rb.art, alt: rb.alt });
      if (r.cardId) return r;
      const id = await byName("op", op.canvas).catch(() => null);
      if (id) return opResult(await opData(), id, op.art);
    }
    if (!pkR && close) pkR = await identifyPokemon(canvas, source, pk, full);
    return pkR?.cardId || pkR?.number ? pkR : r;
  }
  // Riftbound-omrätningarna bara när bilden liknar ett Riftbound-kort ungefär lika mycket som ett Pokémonkort
  const rb = rbTop0 >= pkTop - 0.05 ? await rbBestCanvas(canvas, source, false, rb0) : { canvas, art: rb0 };
  // Ett Riftbound- eller One Piece-kort i Pokémonskannern: bara när bilden tydligt liknar ett sådant kort mer än något Pokémonkort
  const rbQuick = byLook(rb.art, CLEAR, CLEAR_GAP);
  if (rbQuick && rb.art[0].s > pkTop + 0.05) return identifyRb(rb.canvas, { full, art: rb.art, alt: rb.alt });
  if (byLook(op0, CLEAR, CLEAR_GAP) && opTop0 > pkTop + 0.05) return identifyOp(op0);
  return identifyPokemon(canvas, source, pk, full);
}

// Ett Pokémonkort: art är bildträffarna bland Pokémonkorten
async function identifyPokemon(canvas, source, art, full) {
  // Kortet kan ligga i en plastficka: då läses både bild och nummer från den rätning som liknar ett kort mest
  ({ canvas, art } = await sleeveBest(canvas, source, art));
  const whole = canvas;
  canvas = artCanvas(canvas, art);
  // Så tydlig bildträff att textläsningen inte behövs
  const quick = byLook(art, CLEAR, CLEAR_GAP);
  if (quick) return { name: await pokemonName(quick), number: localOf(quick), total: null, numberSure: true, cardId: quick, art };
  // Automatisk skanning med en bildträff som räcker på egen hand: textläsningen skulle ändå inte ändra svaret
  const enough = !full && lookEnough(art);
  if (enough) return { name: await pokemonName(enough), number: localOf(enough), total: null, numberSure: true, cardId: enough, art };
  const r = await readCard(canvas, { full });
  let cardId = await byNumber(art, r);
  // Numret saknas eller stämmer inte med något kort som liknar bilden (t.ex. 109 läst som 105): läs nummerraden igen
  // Saknas numret helt sparas första säkra läsningen, så att sökningen på nummer fungerar även om bilden inte känns igen.
  if (!cardId && (!r.number || (art.length && art[0].s >= LIKE))) {
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
  // Samma konstverk i flera utgåvor, eller ett nummer som inte gick att läsa i de vanliga zonerna: setstorleken, numret i
  // den smala zonen och setkoden väljer bland korten som liknar bilden, som i den automatiska skanningen (readPokemon)
  if (!cardId && art[0]?.s >= LIKE) {
    cardId = await byTotal(art, r.total).catch(() => null);
    for (let i = 0; !cardId && i < (full ? LINE_READS.length : 2); i++) cardId = await byLine(canvas, art, i).catch(() => null);
    for (let i = 0; !cardId && i < (full ? CODE_ZONES.length : 1); i++) cardId = await byCode(canvas, art, i).catch(() => null);
    if (cardId) Object.assign(r, { name: (await pokemonName(cardId)) || r.name, number: localOf(cardId), total: null, numberSure: true });
  }
  // Basic Energy utan läsbart nummer: typen avgörs av färgen, som i den automatiska skanningen (energyCard). Utgåvan blir
  // den som liknar bilden mest, så det görs bara i den grundliga läsningen, när alla sätt att läsa numret är provade.
  if (!cardId && full) {
    const energy = await energyCard({ game: "pokemon", art, canvas: whole }, !source?.guess).catch(() => null);
    if (energy) { cardId = energy.id; Object.assign(r, { name: energy.name, number: localOf(energy.id), total: null, numberSure: true }); }
  }
  // Sist: en bildträff som är klart bättre än alla andra kort räcker
  cardId ||= lookEnough(art);
  return { ...r, cardId, art };
}

// Kortets namn ur bildindexet, utan nätet. null om indexet inte har namnen.
const pokemonName = async (id) => { const a = await loadArtIndex(); return a?.names?.[a.idx.get(id)] || null; };

const fallbackRect = (w, h) => [[w * 0.1, h * 0.1], [w * 0.9, h * 0.1], [w * 0.9, h * 0.9], [w * 0.1, h * 0.9]];
// Ett foto eller en bild: hitta kortet, räta ut det och identifiera det.
// game väljer spel för just den här bilden (annars det som skannern öppnades med).
export async function scanImage(img, { full = true, game } = {}) {
  const quad = findCardQuad(img), near = quad ? null : detectCardCorners(img, fallbackRect(img.width, img.height), 0.35);
  const corners = quad || near.corners;
  const warped = unwarpCard(img, corners);
  const canvas = Object.assign(document.createElement("canvas"), { width: warped.width, height: warped.height });
  canvas.getContext("2d").drawImage(warped, 0, 0);
  const before = scanGame;
  if (game) scanGame = game;
  const source = { src: img, corners, guess: !quad && !near.confident };
  try { return { ...(await identify(canvas, { full, source })), canvas, corners }; } finally { scanGame = before; }
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
  // Punkten före numret läses ibland som en siffra ("OGN • 135/298" blir "0135/298"). Fyra siffror före ett
  // tresiffrigt total är inget kortnummer, så den första stryks.
  for (const m of fixed.matchAll(/(?<![A-Z\d])\d(\d{3}[a-z]?)\s*\/\s*(\d{3})(?!\d)/g)) {
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
      return { list: [...known, ...list.filter((c) => sims[c.id] == null)], sure: s0 >= LIKE && s0 - s1 >= 0.08 };
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
let onFound = null, onPartial = null, onHit = null, onPreview = null;
let autoOpen = false; // träffen öppnas direkt (onFound) i stället för att ligga kvar i hörnet
let openMode = false; // Kortpriser: träffen öppnas direkt, om man inte valt Snabb skanning
let onLookup = null; // Kortpriser: slår upp träffens namn, bild och pris till bilden i hörnet, utan att lägga in kortet
// Snabb skanning: träffen läggs i hörnet som i valvet och man skannar vidare. Ett tryck på bilden öppnar kortet.
const QUICK_KEY = "nl:scan-quick";
const quickOn = () => { try { return localStorage.getItem(QUICK_KEY) === "1"; } catch { return false; } };
// Animationerna för kortens värdenivåer (strålar, jackpot och popp-upp) går att stänga av, i valvet och Kortpriser
const FX_KEY = "nl:scan-fx-off";
const fxOff = () => { try { return localStorage.getItem(FX_KEY) === "1"; } catch { return false; } };
let torchSupported = false, torchActive = false;
let stillTicks = 0, lastScanAt = 0;
let pauseUntil = 0, openedAt = 0; // pauseUntil: auto-skanningen väntar så att ett felmeddelande hinner läsas
const NUDGE_AFTER = 2000; // ms utan träff innan "Värdera manuellt" lyfts fram
const PAUSE_AFTER_MISS = 3500; // ms paus efter en misslyckad manuell skanning eller ett foto
// Läsningar utan träff i rad. Efter MISS_TIP byts tipset under ramen mot råd om plastficka och reflexer i TIP_SHOW ms.
// Hittas fortfarande inget kort kommer rådet tillbaka tidigast TIP_AGAIN ms efter att det försvann.
const MISS_TIP = 5, TIP_SHOW = 4000, TIP_AGAIN = 20000;
let misses = 0, tipText = "", tipTimer = null, tipAgainAt = 0;
function plainTip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  const tip = dialog?.querySelector(".scan-tip");
  if (!tip?.classList.contains("warn")) return;
  tip.textContent = tipText;
  tip.classList.remove("warn");
}
function missed() {
  if (++misses < MISS_TIP || tipTimer || Date.now() < tipAgainAt) return;
  const tip = dialog.querySelector(".scan-tip");
  tip.textContent = "Svårt att läsa? Skanna kortet utan sleeve eller toploader, undvik reflexer från lampor och håll det plant.";
  tip.classList.add("warn");
  tipTimer = setTimeout(() => { plainTip(); tipAgainAt = Date.now() + TIP_AGAIN; }, TIP_SHOW);
}
function hitTip() {
  plainTip();
  misses = 0;
}

const frameEl = () => dialog?.querySelector(".scan-frame i");

function paintSound() {
  const btn = dialog.querySelector(".scan-sound"), off = coinMuted();
  btn.setAttribute("aria-pressed", String(off));
  btn.setAttribute("aria-label", off ? "Slå på ljudet" : "Stäng av ljudet");
  btn.title = off ? "Ljud av" : "Ljud på";
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 9h4l5-4v14l-5-4H4z"/>${off
    ? '<path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'
    : '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'}</svg>`;
}

function paintFx() {
  const btn = dialog.querySelector(".scan-fx"), off = fxOff();
  btn.setAttribute("aria-pressed", String(off));
  btn.setAttribute("aria-label", off ? "Slå på animationerna" : "Stäng av animationerna");
  btn.title = off ? "Animationer av" : "Animationer på";
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2.5l2.4 6.1 6.1 2.4-6.1 2.4L12 19.5l-2.4-6.1L3.5 11l6.1-2.4z"/>${off
    ? '<path d="M3 21L21 3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' : ""}</svg>`;
}

function ui() {
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.className = "scan";
  dialog.setAttribute("aria-label", "Skanna kort");
  dialog.innerHTML = `
    <div class="scan-top">
      <div class="scan-tools">
        <button class="scan-quick" type="button" aria-pressed="false" hidden>Snabb skanning</button>
        <button class="scan-fx" type="button" hidden></button>
        <button class="scan-sound" type="button" hidden></button>
        <button class="scan-torch" type="button" aria-label="Blixt" aria-pressed="false" hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>
          </svg>
          <span>Av</span>
        </button>
      </div>
    </div>
    <div class="scan-view">
      <video playsinline muted autoplay></video>
      <canvas class="scan-hud" aria-hidden="true"></canvas>
      <div class="scan-frame" aria-hidden="true"><i></i></div>
      <div class="scan-hud-status">
        <p class="scan-status" role="status" aria-live="polite">Startar kameran…</p>
      </div>
      <button class="scan-peek" type="button" hidden><img alt=""><em class="scan-price" hidden></em><span></span></button>
      <p class="scan-tip">Håll kortet i ramen. Glänser det? Luta det lätt.</p>
      <div class="scan-freeze" aria-hidden="true" hidden>
        <canvas></canvas>
        <i class="holo-sheen"></i><i class="holo-grid"></i><i class="holo-beam"></i>
        <svg class="holo-quad" preserveAspectRatio="none"><polygon /></svg>
      </div>
      <form class="scan-manual" hidden>
        <div class="scan-manual-row">
          <input type="search" placeholder="Skriv kortets namn eller nummer" aria-label="Kortets namn eller nummer" autocomplete="off" enterkeyhint="search">
          <button class="scan-ghost" type="button" data-manual-close aria-label="Tillbaka till kameran">✕</button>
        </div>
        <ul class="scan-manual-list"></ul>
        <p class="scan-manual-hint"></p>
      </form>
      <form class="scan-number" hidden>
        <div class="scan-number-head">
          <b>Skriv numret nere på kortet</b>
          <button class="scan-ghost" type="button" data-number-close aria-label="Tillbaka till kameran">✕</button>
        </div>
        <input type="text" inputmode="none" maxlength="7" placeholder="116/132" aria-label="Kortets nummer, till exempel 116/132" autocomplete="off" enterkeyhint="done">
        <div class="scan-number-keys">${[..."123456789/0"].map((k) => `<button type="button" data-key="${k}">${k}</button>`).join("")}<button type="button" data-key="back" aria-label="Radera">⌫</button></div>
        <p role="status"></p>
        <button class="scan-now" type="submit">Ta kortet</button>
      </form>
      <div class="scan-twins" hidden><b>Vilken utgåva?</b><div></div><button class="scan-twins-none" type="button">Ingen av dem</button></div>
      <div class="scan-confirm" hidden>
        <img alt="">
        <b></b>
        <small></small>
        <em></em>
        <p role="status"></p>
        <div>
          <button class="scan-ghost" type="button" data-confirm-no></button>
          <button class="scan-now" type="button" data-confirm-yes></button>
        </div>
      </div>
    </div>
    <div class="scan-actions">
      <label class="scan-ghost scan-live">Välj foto<input type="file" accept="image/*" hidden></label>
      <button class="scan-now scan-live" type="button" data-manual>Värdera manuellt</button>
      <button class="scan-ghost scan-live" type="button" data-close>Stäng</button>
      <button class="scan-ghost scan-frozen-btn" type="button" data-cancel>Avbryt</button>
      <button class="scan-now scan-frozen-btn" type="button" data-retry>Försök igen</button>
    </div>
    <p class="scan-app" hidden>Skannar du ofta? <a href="butiker.html#installera">Installera Lootninja som app</a>, så öppnas skannern i helskärm utan webbläsarens fält.</p>`;

  document.body.append(dialog);
  dialog.addEventListener("close", () => { stop(); hideConfirm(); closeManual(); restWorkers(); });
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  // Esc stänger först sökrutan för manuell värdering. Från förhandsvisningen går den tillbaka till valvet, som Nej.
  dialog.addEventListener("cancel", (e) => {
    if (manualOpen && !confirmItem) { e.preventDefault(); closeManual(); }
  });
  dialog.querySelector("[data-confirm-no]").addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-confirm-yes]").addEventListener("click", confirmYes);

  // Värdera manuellt: skriv in kortet i stället för att skanna det
  dialog.querySelector("[data-manual]").addEventListener("click", () => (twinSeen ? openNumber() : openManual()));
  dialog.querySelector("[data-manual-close]").addEventListener("click", closeManual);
  // Numret för hand: egna knappar, eftersom telefonernas sifferskärm saknar snedstreck
  const numberForm = dialog.querySelector(".scan-number"), numberInput = numberForm.querySelector("input");
  const setNumber = (v) => { numberInput.value = cleanNumber(v); numberForm.querySelector("p").textContent = ""; };
  numberInput.addEventListener("input", () => setNumber(numberInput.value));
  numberForm.querySelector(".scan-number-keys").addEventListener("click", (e) => {
    const k = e.target.closest("[data-key]")?.dataset.key;
    if (k) setNumber(k === "back" ? numberInput.value.slice(0, -1) : numberInput.value + k);
  });
  numberForm.querySelector("[data-number-close]").addEventListener("click", closeManual);
  numberForm.addEventListener("submit", (e) => { e.preventDefault(); pickNumber(); });
  const manual = dialog.querySelector(".scan-manual");
  manual.querySelector("input").addEventListener("input", renderManual);
  manual.addEventListener("submit", (e) => { e.preventDefault(); pickManual(0); });
  manual.querySelector(".scan-manual-list").addEventListener("click", (e) => {
    const li = e.target.closest("[data-i]");
    if (li) pickManual(+li.dataset.i);
  });
  dialog.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-retry]").addEventListener("click", unfreeze);
  dialog.querySelector(".scan-peek").addEventListener("click", openPeek);
  dialog.querySelector(".scan-twins").addEventListener("click", (e) => {
    const b = e.target.closest("[data-twin]");
    if (b) pickTwin(twinCards[+b.dataset.twin]);
    else if (e.target.closest(".scan-twins-none")) { newCard(); status("Håll kortet i ramen…"); }
  });

  // Ficklampa
  const torchBtn = dialog.querySelector(".scan-torch");
  torchBtn.addEventListener("click", async () => {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchActive }] });
      setTorch(!torchActive);
    } catch {
      // Kameran sa att den har lampa men vägrade tända den
      if (!torchActive) torchBtn.hidden = true;
    }
  });

  // Snabb skanning i Kortpriser
  dialog.querySelector(".scan-quick").addEventListener("click", (e) => {
    const on = !quickOn();
    try { localStorage.setItem(QUICK_KEY, on ? "1" : "0"); } catch {}
    autoOpen = !on;
    e.currentTarget.setAttribute("aria-pressed", String(on));
  });

  // Animationerna för värdenivåerna
  dialog.querySelector(".scan-fx").addEventListener("click", () => {
    const off = !fxOff();
    try { localStorage.setItem(FX_KEY, off ? "1" : "0"); } catch {}
    if (off) closeReveal?.();
    paintFx();
  });

  // Myntljudet i valvet
  dialog.querySelector(".scan-sound").addEventListener("click", () => {
    setCoinMuted(!coinMuted());
    unlockCoin();
    paintSound();
  });

  // Välj foto från fil
  dialog.querySelector("input[type=file]").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const img = await createImageBitmap(file).catch(() => null);
    if (!img) return status("Bilden gick inte att läsa.");
    // Fotot visas fryst med samma holografiska sökning som när man tar en bild
    const snap = freeze(img);
    img.close?.(); // fotot är kopierat till den frysta bilden: släpp originalet ur minnet
    frozenScan(snap, { fromFile: true });
  });

  return dialog;
}

// Skriver bara om texten när den ändras, så att skärmläsare inte läser upp samma sak var 150:e ms.
const status = (t) => {
  const el = dialog?.querySelector(".scan-status");
  if (el && el.innerHTML !== t) el.innerHTML = t;
};

const waitIdle = async () => { while (busy || reading) await new Promise((r) => setTimeout(r, 50)); };

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

// Ritar den levande ramen kring kortet. glow (0–1) tonar från sökande (streckad, vit) till låst (grön).
// Ingen shadowBlur: den kostar mycket per bildruta på telefoner. Glöden är en bredare, genomskinlig linje under.
let hudCtx = null;
function renderHud(corners, glow) {
  const video = dialog.querySelector("video");
  const hud = dialog.querySelector(".scan-hud");
  if (!video || !hud || !video.videoWidth) return;

  if (hud.width !== video.clientWidth || hud.height !== video.clientHeight) {
    hud.width = video.clientWidth;
    hud.height = video.clientHeight;
  }
  const ctx = (hudCtx ||= hud.getContext("2d"));
  ctx.clearRect(0, 0, hud.width, hud.height);
  if (!corners || !corners.length) return;

  // Videokoordinater till skärmkoordinater (videon visas med object-fit: cover)
  const vw = video.clientWidth, vh = video.clientHeight;
  const k = Math.max(vw / video.videoWidth, vh / video.videoHeight);
  const ox = (vw - video.videoWidth * k) / 2, oy = (vh - video.videoHeight * k) / 2;
  const pts = corners.map(([x, y]) => [x * k + ox, y * k + oy]);
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  };

  path();
  if (glow < 0.04) {
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  ctx.setLineDash([]);
  ctx.lineJoin = "round";
  ctx.fillStyle = `rgba(74, 222, 128, ${0.1 * glow})`;
  ctx.fill();
  ctx.strokeStyle = `rgba(74, 222, 128, ${0.28 * glow})`;
  ctx.lineWidth = 8;
  ctx.stroke();
  ctx.strokeStyle = `rgba(134, 239, 172, ${glow})`;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Hörnvinklar längs kortets kanter
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.strokeStyle = `rgba(74, 222, 128, ${glow})`;
  ctx.beginPath();
  pts.forEach(([px, py], i) => {
    for (const [nx, ny] of [pts[(i + 1) % 4], pts[(i + 3) % 4]]) {
      const len = Math.hypot(nx - px, ny - py) || 1;
      const t = Math.min(24, len * 0.18) / len;
      ctx.moveTo(px, py);
      ctx.lineTo(px + (nx - px) * t, py + (ny - py) * t);
    }
  });
  ctx.stroke();
}

// Kantsökningen körs några gånger i sekunden, ritningen varje bildruta. Ramen glider mjukt mot senaste läget,
// blir grön efter LOCK_ON träffar i rad och släpper efter LOCK_OFF missar i rad, så att den inte blinkar av och på.
// Bredare sökband som andra försök fångar kort i toploader och plastficka, som sticker ut utanför ramen.
const DETECT_EVERY = 70; // ms mellan två kantsökningar
const LOCK_ON = 2, LOCK_OFF = 4;
const LIVE_BANDS = [0.12, 0.22];
let lock = null; // { on, hits, misses, target, shown, glow }
let lastSeen = null; // senaste säkra hörn { corners, at }, som skanningen använder i stället för att söka igen

function startHudLoop() {
  const video = dialog.querySelector("video");
  const guide = getDefaultFrameCorners() || [[0, 0], [420, 0], [420, 587], [0, 587]];
  lock = { on: false, hits: 0, misses: 0, target: guide, shown: null, glow: 0 };
  let lastDetect = 0, lastFrame = performance.now();

  const loop = (now) => {
    animFrame = requestAnimationFrame(loop);
    const dt = Math.min(100, now - lastFrame);
    lastFrame = now;
    if (!dialog.open || !video.videoWidth || frozen || closeReveal) return; // kortsökningen vilar medan ett kort visas stort

    if (now - lastDetect >= DETECT_EVERY) {
      lastDetect = now;
      const { corners, confident } = detectCardCorners(video, guide, LIVE_BANDS);
      if (confident) {
        lock.hits++;
        lock.misses = 0;
        lastSeen = { corners, at: Date.now() };
        if (lock.hits >= LOCK_ON) { lock.on = true; lock.target = corners; }
      } else {
        lock.hits = 0;
        // Kortet har lämnat ramen: i snabbskanningen får samma kort räknas igen
        if (++lock.misses >= LOCK_OFF && lock.on) { lock.on = false; lock.target = guide; skipKey = null; lastHit = null; if (!twinOpen) newCard(); }
      }
    }

    // Mjuk rörelse som inte beror på bildfrekvensen: ungefär 60 ms att komma två tredjedelar av vägen
    const a = 1 - Math.exp(-dt / 60);
    lock.shown = lock.shown ? lock.shown.map((p, i) => [p[0] + (lock.target[i][0] - p[0]) * a, p[1] + (lock.target[i][1] - p[1]) * a]) : lock.target;
    lock.glow += ((lock.on ? 1 : 0) - lock.glow) * (1 - Math.exp(-dt / 90));
    renderHud(lock.shown, lock.glow);
  };
  animFrame = requestAnimationFrame(loop);
}

// Fångar en rätad bild av kortet från kameran i full upplösning. Hörnen sparas i lastGrab.
let lastGrab = null;
function grabUnwarpedFrame() {
  const video = dialog.querySelector("video");
  if (!video.videoWidth) return null;
  const defaultCorners = getDefaultFrameCorners();
  if (!defaultCorners) return null;

  // Ramens senaste säkra hörn om de är färska, annars kortet nära ramen och sist kortets hörn var som helst i bilden
  const fresh = lastSeen && Date.now() - lastSeen.at < 250 && lastSeen.corners;
  const near = fresh ? null : detectCardCorners(video, defaultCorners, LIVE_BANDS);
  const corners = fresh || (near.confident ? near.corners : findCardQuad(video) || near.corners);
  // framed: kortets kanter syns i ramen (annars kan det vara bakgrunden som läses). En fyrhörning någon annanstans i bilden
  // räknas inte: en toploaders kant är också en fyrhörning, och då godkändes fel kort.
  lastGrab = { src: video, corners, framed: !!fresh || near.confident, guide: corners === defaultCorners || corners === near?.corners ? null : defaultCorners };
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
  // Valet av utgåva ligger kvar tills man svarar, så kameran får röra sig utan att något nytt läses under tiden
  if (!dialog?.open || !video?.videoWidth || frozen || manualOpen || twinOpen || closeReveal) return;
  // Under en läsning (och pausen efter en träff) tas stickprovet ändå, så att nästa jämförelse gäller bilden nyss och
  // inte en bild från innan läsningen. Annars räknades en hand som håller kortet som rörelse efter varje läsning.
  if (busy || Date.now() < pauseUntil) { motionLevel(video); return; }

  // Ingen träff efter en stund: lyft fram "Värdera manuellt"
  if (Date.now() - openedAt > NUDGE_AFTER) dialog.querySelector(".scan-now")?.classList.add("nudge");

  const level = motionLevel(video);
  const seen = lastSeen && Date.now() - lastSeen.at < 400;
  stillTicks = level < (seen ? MOTION_SEEN : MOTION_LIMIT) ? stillTicks + 1 : 0;

  if (stillTicks < STILL_TICKS) {
    frameEl()?.classList.add("is-moving");
    status("Håll kortet i ramen…");
    return;
  }
  frameEl()?.classList.remove("is-moving");
  // Läs bara när ramen ser ett kort, så att en tom ram inte håller läsarna upptagna när nästa kort kommer.
  // Kort vars kanter inte syns (t.ex. mot en likfärgad bakgrund) får ändå ett försök med jämna mellanrum.
  // Ett kort som väntar på att bekräftas läses om direkt.
  if (Date.now() - lastScanAt >= (seen || cand ? SCAN_INTERVAL : BLIND_INTERVAL)) runScan(false);
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
  await attempt(cv, lastGrab);
}

// ---------- 9. Fryst bild med holografisk sökning ----------
// "Skanna nu" (och ett valt foto) fryser bilden. Den söks igenom med alla metoder: kortets hörn på flera sätt,
// bildindexet och alla varianter av nummerraden. Sökningen pågår tills kortet hittas eller man trycker
// Avbryt (stänger) eller Försök igen (tillbaka till kameran).
let frozen = false, scanToken = 0, holoTimer = null;
const MAX_PHOTO = 2560; // längsta sidan på en fryst bild, i pixlar
const HOLO_MSGS = {
  pokemon: ["Jämför med 21 000 kort…", "Läser kortnumret…", "Kollar setet…", "Letar efter kortets kanter…", "Matchar konstverket…", "Läser namnet…"],
  rb: ["Jämför med 1 800 Riftbound-kort…", "Läser kortnumret…", "Kollar setet…", "Letar efter kortets kanter…", "Matchar konstverket…"],
  op: ["Jämför med 4 400 One Piece-kort…", "Letar efter kortets kanter…", "Matchar konstverket…", "Kollar varianterna…"],
  vault: ["Jämför med 27 000 Pokémon-, One Piece- och Riftbound-kort…", "Läser namnet…", "Letar efter kortets kanter…", "Matchar konstverket…", "Läser kortnumret…"],
};

// Visar en stillbild av källan (video eller foto) och returnerar den som canvas att söka i
function freeze(src) {
  const box = dialog.querySelector(".scan-freeze"), cv = box.querySelector("canvas");
  // Stora foton krymps: en iPhone-bild på 24 megapixel är större än vad en canvas rymmer i Safari (ca 16,7) och blir
  // då helt tom, och GPU:ns texturer tar ofta högst 4096 px. Kortet behåller ändå mer än rätningens 900 px.
  const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height, k = Math.min(1, MAX_PHOTO / Math.max(sw, sh));
  cv.width = Math.round(sw * k);
  cv.height = Math.round(sh * k);
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
  const msgs = HOLO_MSGS[scanGame];
  status(msgs[0]);
  holoTimer = setInterval(() => status(msgs[++i % msgs.length]), 1300);
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
  newCard();
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
      const r = await identify(canvas, { full, source: { src: snap, corners, guess: corners !== quad && !near.confident } });
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
    missed();
    status("Hittade inget kort. Tryck <b>Försök igen</b> och håll kortet stilla i ramen.");
  } catch (err) {
    if (!alive()) return;
    clearInterval(holoTimer);
    dialog.classList.add("missed");
    missed();
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
      unfreeze();
      if (r.cardId || r.number || r.name) setPeek({ ...r, picked: true }, r.canvas);
    }, 650);
  }
}

let last = null, lastNum = null;
// ---------- Automatisk skanning ----------
// Två spår, så att en svår bild aldrig håller upp nästa bild. Varje bild jämförs med korten (attempt), vilket går fort.
// Räcker inte bilden läses texten i bakgrunden (readBehind), en liten del per bild, medan bildjämförelsen fortsätter på
// nya bilder. Då byts ett suddigt ögonblick snabbt mot ett skarpt, och varje läsning görs på en färsk bild.
//
// En tydlig bildträff (SURE_LOOK eller mer, långt före tvåan) godkänns direkt. En svagare träff
// godkänns först när samma kort setts CONFIRM_FRAMED gånger, eller CONFIRM_BLIND gånger när ramen inte såg kortets kanter,
// så att en suddig bakgrund inte tas för ett kort. Bara bilden behöver bekräfta: kortet måste finnas bland de tre som
// liknar nästa bild mest. Räkningen börjar om när ett annat kort läses eller kortet lämnar ramen.
// cand: kortet som väntar på att bekräftas, och hur många gånger det setts.
const CONFIRM_FRAMED = 2, CONFIRM_BLIND = 3, SURE_LOOK = CLEAR;
// Röstning: bild för bild skiftar blänket, men det rätta kortet ligger kvar. Är kortet i medeltal klart före de andra i
// minst VOTE_MIN av de senaste VOTE_FRAMES bilderna räcker ett mindre försprång än för en enstaka bild. Bara bilder där ramen
// ser kortets kanter räknas, annars kan en stilla bakgrund rösta fram ett kort.
const VOTE_FRAMES = 4, VOTE_MIN = 3, VOTE_LOOK = 0.5, VOTE_GAP = 0.09, BLIND_VOTE_LOOK = 0.5, BLIND_VOTE_GAP = 0.1;
const STRIPED = /^hgss\d-(ONE|TWO|THREE|FOUR)$/; // Alph Lithograph: rader av tecken, som liknar ränder
let cand = null, trail = [], frameNo = 0;
let reading = false, readRound = 0, cardEpoch = 0; // cardEpoch: byts när kortet byts, så att en sen läsning inte räknas
let twin = null; // namnet när bilden pekar ut flera utgåvor av samma Pokémonkort
let twinSeen = null; // { name, art }: utgåvorna som numret väljer bland. Knappen blir då "Ange numret manuellt".
function setTwinSeen(seen) {
  twinSeen = seen;
  const btn = dialog?.querySelector("[data-manual]");
  if (btn) btn.textContent = seen ? "Ange numret manuellt" : "Värdera manuellt";
}
function newCard() {
  hideTwins();
  cand = null;
  trail = [];
  readRound = 0;
  twin = null;
  setTwinSeen(null);
  cardEpoch++;
  last = lastNum = null;
}
function confirmed(r, framed) {
  const id = r.cardId, top = r.art?.[0], gap = (top?.s ?? 0) - (r.art?.[1]?.s ?? 0);
  if (top?.id === id && (framed ? top.s >= SURE_LOOK && gap >= CLEAR_GAP : top.s >= 0.8 && gap >= 0.25)) { cand = null; return true; }
  if (cand?.id !== id) cand = { id, n: 0 };
  if (++cand.n < (framed ? CONFIRM_FRAMED : CONFIRM_BLIND)) return false;
  cand = null;
  return true;
}
// Bilden som visas och läses: kortet där bildjämförelsen hittade det, med rätningen som liknade ett kort mest.
// turn: varannan bild får tvåan chansen när två spel är jämna (blänk kan få fel spel att likna mest).
async function lookFrame(canvas, source, turn = 0) {
  canvas = copyCanvas(canvas); // GPU-rätningens canvas skrivs över av nästa bild
  if (scanGame === "rb") return { game: "rb", ...(await rbBestCanvas(canvas, source)) };
  if (scanGame === "op") return { game: "op", ...(await opBestCanvas(canvas, source)) };
  const top = (a) => a[0]?.s ?? 0, none = () => [];
  // De små indexen först: en tydlig One Piece- eller Riftbound-träff behöver inte jämföras med 21 000 Pokémonkort
  const [rb0, op0] = await Promise.all([artMatch(canvas, 30, "rb").catch(none), artMatch(canvas, 30, "op").catch(none)]);
  if (scanGame === "vault") {
    if (top(op0) >= top(rb0) && byLook(op0, CLEAR, CLEAR_GAP)) return { game: "op", canvas, art: op0 };
    if (top(rb0) > top(op0) && byLook(rb0, CLEAR, CLEAR_GAP)) return { game: "rb", canvas, art: rb0 };
  }
  const pk = await artMatch(canvas).catch(none);
  if (scanGame === "pokemon") {
    // Ett Riftbound- eller One Piece-kort i Pokémonskannern: bara när bilden tydligt liknar ett sådant kort mer än något Pokémonkort
    if (byLook(rb0, CLEAR, CLEAR_GAP) && top(rb0) > top(pk) + 0.05) return { game: "rb", canvas, art: rb0 };
    if (byLook(op0, CLEAR, CLEAR_GAP) && top(op0) > top(pk) + 0.05) return { game: "op", canvas, art: op0 };
    return { game: "pokemon", ...(await sleeveBest(canvas, source, pk)) };
  }
  const ranked = [["pokemon", pk], ["op", op0], ["rb", rb0]].sort((a, b) => top(b[1]) - top(a[1]));
  const [game, art] = top(ranked[0][1]) - top(ranked[1][1]) < 0.05 && turn % 2 ? ranked[1] : ranked[0];
  if (game === "rb") return { game, ...(await rbBestCanvas(canvas, source, false, art)) };
  if (game === "op") return { game, ...(await opBestCanvas(canvas, source, art)) };
  return { game, ...(await sleeveBest(canvas, source, art)) };
}
// Kortet som bilden pekar ut på egen hand, eller null
async function lookId({ game, art }, framed) {
  const id = lookEnough(art, framed);
  if (!framed && STRIPED.test(id)) return null; // Ränder i bakgrunden liknar Alph Lithograph: utan kortets kanter räknas det inte
  if (id || game !== "op" || !(art[0]?.s >= RETRY)) return id;
  // En parallel med samma bild som vanliga kortet: alla nästan lika lika har samma kortnummer
  const cards = await opData(), no = cards.get(art[0].id)?.no;
  return no && art.filter((x) => x.s >= art[0].s - 0.08).every((x) => cards.get(x.id)?.no === no) ? art[0].id : null;
}
function voted({ game, art }) {
  const id = art[0]?.id, seen = trail.filter((t) => t.game === game && t.scores.has(id));
  if (!id || seen.length < VOTE_MIN) return null;
  const mean = (frames) => {
    let look = 0, gap = 0;
    for (const { scores } of frames) {
      const s = scores.get(id);
      look += s;
      gap += s - Math.max(-1, ...[...scores].filter(([x]) => x !== id).map(([, v]) => v));
    }
    return [look / frames.length, gap / frames.length];
  };
  const framed = seen.filter((t) => t.framed);
  if (framed.length >= VOTE_MIN) {
    const [look, gap] = mean(framed);
    return look >= VOTE_LOOK && gap >= VOTE_GAP ? id : null;
  }
  // Fingrar kan dölja kortets kanter, och foil och full art drar ner likheten. Samma kort i topp i flera bilder med tydligt
  // försprång räcker ändå, men bara om kortet självt inte är ett mönster som en randig bakgrund kan likna.
  if (seen.length < trail.length || STRIPED.test(id)) return null;
  const [look, gap] = mean(seen);
  return look >= BLIND_VOTE_LOOK && gap >= BLIND_VOTE_GAP ? id : null;
}
// Basic Energy: korten har nästan samma form, så bildavtrycket skiljer dem dåligt åt. Färg och symbol gör det i stället. Lampor
// drar bilden åt gult, så det ljusaste på kortet (det vita skenet och gnistorna runt symbolen) används som vit referens. Bakgrunden
// runt symbolen mäts sedan, och bara den mättade halvan av pixlarna räknas, så att gnistor och vita sken inte drar ner färgen.
// Ljusheten räknas mot den vita referensen, så att den inte beror på rummet. { h: nyans 0-360, s: mättnad 0-1, v: bakgrundens
// ljushet, dark: hur stor del av symbolen som är mörk }
function cardTone(canvas) {
  const FP = self.Fingerprint, d = fpPixels(canvas), W = FP.CW, H = FP.CH, all = [], symbol = [];
  for (let y = Math.round(H * 0.2); y < H * 0.88; y++) for (let x = Math.round(W * 0.08); x < W * 0.92; x++) {
    const mid = Math.hypot((x / W - 0.5) * 0.72, y / H - 0.54), i = (y * W + x) * 4;
    // Symbolen mäts generöst: hittas en inre kant på kortet hamnar den högre upp i bilden
    if (Math.hypot((x / W - 0.5) * 0.72, y / H - 0.5) < 0.15) symbol.push((d[i] + d[i + 1] + d[i + 2]) / 3);
    if (mid >= 0.2) all.push([d[i], d[i + 1], d[i + 2]]);
  }
  const bright = [...all].sort((a, b) => b[0] + b[1] + b[2] - a[0] - a[1] - a[2]).slice(0, Math.ceil(all.length * 0.06));
  const mean = (list, k) => list.reduce((t, p) => t + p[k], 0) / (list.length || 1);
  const R = mean(bright, 0) || 1, G = mean(bright, 1) || 1, B = mean(bright, 2) || 1, gray = (R + G + B) / 3;
  const limit = (k) => Math.min(1.35, Math.max(0.75, k)), kr = limit(gray / R), kg = limit(gray / G), kb = limit(gray / B);
  const px = all.map(([r, g, b]) => {
    const p = [r * kr, g * kg, b * kb], mx = Math.max(...p);
    return [...p, mx ? (mx - Math.min(...p)) / mx : 0];
  }).sort((a, b) => b[3] - a[3]);
  const top = px.slice(0, px.length >> 1), r = mean(top, 0), g = mean(top, 1), b = mean(top, 2);
  const mx = Math.max(r, g, b), c = mx - Math.min(r, g, b);
  const h = !c ? 0 : mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
  symbol.sort((a, b) => a - b);
  const n = symbol.length, half = (symbol[Math.floor(n * 0.03)] + symbol[Math.floor(n * 0.97)]) / 2;
  return { h: h * 60, s: mx ? c / mx : 0, v: mx / gray, dark: symbol.filter((x) => x < half).length / (n || 1) };
}
// Typen ur färgen. Water och Darkness har samma nyans men Darkness är mörkare. Metal och Darkness går inte att skilja på färgen
// i ett foto, men Darkness har en stor mörk fläck i symbolen där Metal har en liten triangel. Gränserna kommer från bilderna på
// alla utgåvor av energikorten och från foton på riktiga kort.
const DARK_SYMBOL = 0.44;
function energyType({ h, s, v, dark }) {
  if (h >= 250 && h < 320 && s >= 0.15) return "Psychic";
  if (s < 0.25 || (h >= 165 && h < 250 && v < 0.72)) return dark >= DARK_SYMBOL ? "Darkness" : "Metal";
  if (h >= 165 && h < 250) return "Water";
  if (h >= 320 && h < 350) return "Fairy";
  if (h >= 350 || h < 20) return v >= 0.75 ? "Fire" : "Fighting";
  if (h < 42) return v >= 0.93 ? "Fire" : "Fighting";
  return h < 62 ? "Lightning" : "Grass";
}
// Energikortet som bilden visar, med typen ur färgen. Kortet nära toppen om typen finns där, annars första kortet av typen.
async function energyCard(look, framed) {
  const a = await loadArtIndex(), top = look.art[0];
  if (look.game !== "pokemon" || !a?.names || !(top?.s >= 0.55)) return null;
  if (top.s - (look.art[1]?.s ?? 0) >= CLEAR_GAP) return null; // Bilden säger tydligt vilket kort det är: äldre energikort har egna motiv
  const named = (id) => a.names[a.idx.get(id)]?.replace(/^Basic /, ""), energy = (x) => BASIC_ENERGY.test(named(x.id) || "");
  if (!energy(top)) return null;
  // Tomma, släta ytor liknar energikort: utan funna kanter krävs mer, och en ljus grå yta är inget kort
  if (!framed && (top.s < 0.7 || !look.art.slice(0, 3).every(energy))) return null;
  const tone = cardTone(artCanvas(look.canvas, look.art));
  if (tone.s < 0.25 && tone.v >= 0.8) return null;
  const want = `${energyType(tone)} Energy`;
  const id = look.art.find((x) => named(x.id) === want)?.id || a.ids.find((x) => x.startsWith("sve-") && named(x) === want) || a.ids.find((x) => named(x) === want);
  return id ? { id, name: want } : null;
}
// Utgåvorna som en remsa i skannern, med bild och pris. Ett tryck lägger in kortet, och skannern fortsätter.
const TWIN_ROUNDS = 3; // omgångar textläsning innan man får välja själv
const BASIC_ENERGY = /^(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy) Energy$/;
let twinOpen = false, twinCards = [];
function hideTwins() {
  twinOpen = false;
  const el = dialog?.querySelector(".scan-twins");
  if (el) el.hidden = true;
}
async function showTwins({ art }) {
  if (twinOpen) return;
  twinOpen = true;
  const near = art.filter((x) => x.s >= art[0].s - 0.06).slice(0, 4), epoch = cardEpoch;
  const cards = await Promise.all(near.map((x) => getJSON(`${API}/cards/${encodeURIComponent(x.id)}`).catch(() => null)));
  const prices = await Promise.all(near.map((x) => (onPreview ? Promise.resolve(onPreview({ game: "pokemon", cardId: x.id })).catch(() => null) : null)));
  if (!twinOpen || epoch !== cardEpoch) return;
  twinCards = cards.filter(Boolean);
  if (!twinCards.length) return hideTwins(); // inget att välja mellan: skanningen fortsätter
  const el = dialog.querySelector(".scan-twins");
  el.querySelector("b").textContent = "Vilken utgåva?";
  el.querySelector("div").innerHTML = cards.map((c, i) => (c ? `<button type="button" data-twin="${twinCards.indexOf(c)}">${c.image ? `<img src="${esc(c.image)}/low.webp" alt="">` : ""}<b>${esc(c.set?.name || "")}</b><small>#${esc(c.localId)}${prices[i]?.sek != null ? ` · ${esc(kr(prices[i].sek))}` : ""}</small></button>` : "")).join("");
  el.hidden = false;
}
function pickTwin(c) {
  skipKey = null;
  if (c.sigOf) return setPeek({ ...c.sigOf, picked: true }, c.canvas); // Riftbound: vanligt eller signerat (askSignature)
  setPeek({ game: "pokemon", cardId: c.id, name: c.name, number: c.localId, total: null, picked: true, image: c.image ? `${c.image}/low.webp` : null }, null);
}
// Samma konstverk i flera utgåvor (ungefär vart tionde Pokémonkort): bilden kan inte skilja dem åt, det gör bara numret.
// Namnet när alla kort nära toppen heter likadant, annars null.
async function twinName({ game, art }) {
  if (game !== "pokemon" || !(art[0]?.s >= 0.55)) return null;
  const near = art.filter((x) => x.s >= art[0].s - 0.04);
  if (near.length < 2) return null;
  // Basic Energy heter olika i olika set ("Darkness Energy", "Basic Darkness Energy")
  const names = (await Promise.all(near.map((x) => pokemonName(x.id)))).map((n) => n?.replace(/^Basic /, ""));
  return names[0] && names.every((n) => n === names[0]) ? names[0] : null;
}
// Träffen som kort, med namn och nummer ur kortdatan
async function hitOf({ game, art }, id) {
  if (game === "rb") return { ...rbResult(await rbData(), id), art };
  if (game === "op") return opResult(await opData(), id, art);
  return { name: await pokemonName(id), number: localOf(id), total: null, numberSure: true, cardId: id, art };
}
// Kortet som bilden räcker till, eller null. Väntar kortet på att bekräftas räcker det att det finns kvar bland de tre som
// liknar bilden mest. En röst över flera bilder är redan bekräftad.
async function lookHit(look, framed) {
  const id = await lookId(look, framed);
  if (id && confirmed({ cardId: id, art: look.art }, framed)) return hitOf(look, id);
  if (id && cand) cand.look = true;
  // Utan kortets kanter måste kortet ligga kvar långt före tvåan i varje bild, annars kan en stilla bakgrund samla
  // bekräftelser. Läsningar av texten räknas för sig: de är bevis även när bilden är dålig.
  const [a0, a1] = look.art;
  if (!framed && !id && cand?.look && (a0?.id !== cand.id || a0.s - (a1?.s ?? 0) < 0.2)) cand = null;
  const waiting = framed && !id && cand && look.art.slice(0, 3).find((x) => x.id === cand.id && x.s >= LIKE);
  if (waiting && confirmed({ cardId: waiting.id, art: look.art }, framed)) return hitOf(look, waiting.id);
  const vote = voted(look);
  return vote ? hitOf(look, vote) : null;
}
// Setkoden nere till vänster pekar ut setet, och då räcker det att numret ungefär stämmer: "PFL 007/094" är Oddish 001/094.
// Med bilden som stöd skiljer det också kort med samma konstverk i olika set. data/set-codes.json: kod till set, bara set
// där koden står tryckt på korten. Kort-id, eller null.
let codesPromise = null;
const setCodes = () => (codesPromise ||= fetch("data/set-codes.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
// Den sista zonen är hög: med en ungefärlig rätning (ramen på skärmen) kan raden ligga en bit upp
const CODE_ZONES = [[{ x: 0, y: 0.925, w: 0.5, h: 0.065 }, 110], [{ x: 0.02, y: 0.94, w: 0.42, h: 0.04 }, 90], [{ x: 0, y: 0.9, w: 0.5, h: 0.09 }, 140], [{ x: 0, y: 0.84, w: 0.55, h: 0.14 }, 200]];
async function byCode(canvas, art, round) {
  const [worker, codes, a] = await Promise.all([getWorker("code"), setCodes(), loadArtIndex()]);
  const [zone, h] = CODE_ZONES[round % CODE_ZONES.length];
  const text = (await worker.recognize(plainZone(canvas, zone, h))).data.text.toUpperCase();
  const code = Object.keys(codes).find((c) => text.includes(c));
  if (!a || !art[0]) return null;
  // Numret ur samma läsning, med bokstäver tillåtna går det ibland bättre
  const num = findNumber(text, await setSizes());
  const hit = num && ((await byNumber(art, num)) || (await byTotal(art, num.total)));
  if (hit) return hit;
  if (!code) return null;
  const set = codes[code];
  // Bilden pekar ut flera utgåvor: koden väljer
  const near = art.filter((x) => x.s >= art[0].s - 0.06 && x.s >= LIKE && setOf(x.id) === set);
  if (near.length === 1) return near[0].id;
  // Annars korten i setet med ungefär det numret, och bilden väljer
  const digits = text.slice(text.indexOf(code) + code.length).replace(/[^0-9]/g, "").slice(0, 3);
  if (digits.length < 3) return null;
  const close = (id) => { const k = localOf(id).padStart(3, "0"); return k.length === 3 && [...k].filter((d, i) => d !== digits[i]).length <= 1; };
  const ids = a.ids.filter((id) => setOf(id) === set && close(id));
  if (!ids.length || ids.length > 12) return null;
  const sims = await artSims(canvas, ids), ranked = ids.filter((id) => sims[id] != null).sort((x, y) => sims[y] - sims[x]);
  const s0 = sims[ranked[0]] ?? -1, s1 = ranked[1] ? sims[ranked[1]] : -1;
  return s0 >= LIKE && s0 - s1 >= 0.08 ? ranked[0] : null;
}
// Numret på kort från 2023 och framåt står litet och kursivt, ofta vitt på silverfolie. En smal zon runt just numret går att
// läsa, en bredare gör det inte. Bilden provas i olika storlek, omvänd (ljus text) och lite förskjuten, en variant per omgång.
const LINE_ZONE = { x: 0.14, y: 0.945, w: 0.24, h: 0.035 };
const LINE_NEAR = 0.15; // så mycket sämre än det bästa kortet får ett kort likna bilden och ändå väljas på numret
const LINE_READS = [[132, false, 0], [132, true, 0], [220, false, 0], [220, true, 0], [132, false, -0.012], [132, true, 0.012], [220, false, 0.012], [220, true, -0.012]];
function lineImage(canvas, [height, invert, shift]) {
  const c = plainZone(canvas, { ...LINE_ZONE, y: LINE_ZONE.y + shift }, height);
  if (invert) {
    const g = c.getContext("2d");
    g.globalCompositeOperation = "difference";
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
  }
  return c;
}
// Kortet vars nummer närmast stämmer med läsningen, bland korten som liknar bilden. Skannern vet vilka nummer korten har, så
// läsfel tål jämförelsen: 1 läst som 7 och snedstrecket läst som 7 eller 1 ("1137132" är 113/132). Kortet måste vara klart
// närmare än övriga. Kort-id, eller null.
async function byLine(canvas, art, round) {
  // Bara kort som liknar bilden ungefär lika mycket som det bästa: ett felläst nummer får inte välja ett helt annat kort
  const near = art.filter((x) => x.s >= LIKE && x.s >= art[0].s - LINE_NEAR && /^\d+$/.test(localOf(x.id))).slice(0, 12);
  if (!near.length) return null;
  const [worker, counts] = await Promise.all([getWorker("line"), setCounts()]);
  const text = (await worker.recognize(lineImage(canvas, LINE_READS[round % LINE_READS.length]))).data.text.replace(/[^0-9/]/g, "");
  if (text.replace(/\D/g, "").length < 5) return null;
  const distance = (want) => {
    let best = Infinity;
    for (let n = want.length - 1; n <= want.length + 1; n++) for (let i = 0; i + n <= text.length; i++) best = Math.min(best, editDist(want, text.slice(i, i + n)));
    return best;
  };
  const ranked = near.map((x) => {
    const total = String(counts.get(setOf(x.id))?.official ?? ""), no = localOf(x.id).padStart(total.length, "0");
    // Korta nummer ("7/20") kan se ut att stämma med vad som helst
    return { id: x.id, d: total && no.length + total.length >= 5 ? Math.min(...["/", "7", "1", ""].map((sep) => distance(no + sep + total))) : Infinity };
  }).sort((a, b) => a.d - b.d);
  return ranked[0].d <= 2 && (ranked[1]?.d ?? 99) >= ranked[0].d + 2 ? ranked[0].id : null;
}
// Flera utgåvor med samma konstverk: setstorleken läses ofta rätt även när numret inte gör det ("13/132" för 113/132).
// Stämmer den med exakt en av utgåvorna nära toppen är det den. Kort-id, eller null.
async function byTotal(art, total) {
  if (!total || !art[0] || art[0].s < 0.5) return null;
  const counts = await setCounts();
  const hits = art.filter((x) => { const c = counts.get(setOf(x.id)); return x.s >= art[0].s - 0.06 && x.s >= LIKE && c && (c.official === +total || c.total === +total); });
  return hits.length === 1 ? hits[0].id : null;
}
// Namnet går ofta att läsa när bilden är förstörd av blänk eller en ficka. Bland korten med namnet väljer bilden, och den
// måste vara klart före de andra, annars blir det inget kort. Kort-id, eller null.
async function byPokemonName(canvas, name) {
  const a = await loadArtIndex();
  if (!a?.names || !name) return null;
  const ids = a.ids.filter((_, i) => a.names[i] === name || a.names[i].startsWith(name + " "));
  if (!ids.length || ids.length > 60) return null;
  const sims = await artSims(canvas, ids), ranked = ids.filter((id) => sims[id] != null).sort((x, y) => sims[y] - sims[x]);
  const s0 = sims[ranked[0]] ?? -1, s1 = ranked[1] ? sims[ranked[1]] : -1;
  return s0 >= 0.35 && s0 - s1 >= 0.08 ? ranked[0] : null;
}
const NUM_ROUNDS = [[ZONES.numLeft, 1.4], [ZONES.numRight, 1.4], ...EXTRA_NUM_ZONES.slice(0, 4)];
// En del av nummerraden, och namnet var tredje gång. Numret måste peka ut ett kort som liknar bilden.
async function readPokemon(canvas, art, round) {
  const [zone, scale] = NUM_ROUNDS[round % NUM_ROUNDS.length];
  const [numWorker, nameWorker, list, sizes] = await Promise.all([getWorker("number"), getWorker("name"), names(), setSizes()]);
  const readNum = async () => {
    let guess = null;
    for (const map of scale ? zoneMaps(canvas, zone, scale) : [plainZone(canvas, zone)]) {
      const num = findNumber((await numWorker.recognize(map)).data.text, sizes);
      if (num?.sure) return num;
      guess ||= num;
    }
    return guess;
  };
  const [num, name] = await Promise.all([readNum(), round % 3 === 0 ? readName(nameWorker, canvas, list) : null]);
  const r = { name, number: num?.number || null, total: num?.total || null, numberSure: !!num?.sure, dhash: computeDHash(canvas) };
  let cardId = await byNumber(art, r);
  if (!cardId && r.number && r.total) cardId = await byNumberThenLook(canvas, r);
  const coded = !cardId && ((await byLine(canvas, art, round).catch(() => null)) || (await byTotal(art, r.total).catch(() => null)) || (round % 2 ? await byCode(canvas, art, round).catch(() => null) : null));
  const named = !cardId && !coded && (await byPokemonName(canvas, r.name).catch(() => null));
  cardId ||= coded || named;
  if (coded || named) Object.assign(r, { number: localOf(cardId), total: null, numberSure: true });
  return { ...r, name: (coded || named ? null : r.name) || (cardId && (await pokemonName(cardId))), cardId, coded: !!(coded || named), art };
}
// En omgång textläsning på bilden look. Är två spel jämna läses spelet som bilden just nu liknar mest.
async function readLook({ game, art, canvas, alt }, round, framed) {
  if (game === "rb") return identifyRb(canvas, { art, alt, round, framed });
  if (game === "op") return identifyOp(art, artCanvas(canvas, art), round, framed);
  return readPokemon(artCanvas(canvas, art), art, round);
}
async function readBehind(look, framed) {
  reading = true;
  const epoch = cardEpoch;
  try {
    const r = await readLook(look, readRound++, framed);
    if (dialog?.open && !frozen && !manualOpen && !twinOpen && epoch === cardEpoch) await settle(r, artCanvas(look.canvas, look.art), framed);
  } catch (err) {
    status(esc(err.message || "Något gick fel. Försök igen."));
  } finally {
    reading = false;
  }
}
// Svaret från en textläsning
async function settle(r, canvas, framed) {
  if (r.cardId) {
    // Numret eller setkoden och bilden pekar ut samma kort: två oberoende bevis, så det behöver inte bekräftas
    const proven = r.coded || (r.number && r.total && r.numberSure && r.art?.some((x) => x.id === r.cardId));
    if (proven || confirmed(r, framed)) return setPeek(r, canvas);
    return status("Håll kortet stilla i ramen…");
  }
  // Annars som förut: namn och nummer söks i TCGdex
  const numKey = r.number && `${r.number}/${r.total}`;
  // Ett nummer räknas om det lästes med snedstreck, eller likadant två gånger i rad
  const numOk = numKey && (r.numberSure || lastNum === numKey);
  if (!numOk) Object.assign(r, { number: null, total: null });
  const seen = [r.name, r.number && numKey].filter(Boolean).join(" · ");
  // Namn och nummer tillsammans räcker direkt. Bara nummer eller bara namn måste läsas likadant två gånger i rad,
  // eftersom en enstaka felläsning annars ger fel kort.
  const sure = (numOk && (r.name || lastNum === numKey)) || (r.name && last === r.name);
  last = r.name;
  lastNum = numKey;
  if (sure) return setPeek({ game: "pokemon", ...r }, canvas);
  missed();
  if (!twinOpen) status(seen ? `Läser… <b>${esc(seen)}</b>` : "Letar efter kortets namn och nummer…");
}
async function attempt(canvas, source) {
  if (busy) return;
  busy = true;
  frameEl()?.classList.add("is-reading");
  frameEl()?.classList.remove("is-moving");
  try {
    let look = await lookFrame(canvas, source, ++frameNo), framed = !!source?.framed;
    // Hörnen kan vara helt fel: kanterna syntes inte (fingrar kan dölja dem), eller så hittades en inre kant på kortet. Kortet
    // hålls ändå i ramen, så ramen provas också när bilden inte räcker.
    if (source?.guide && (look.art[0]?.s ?? 0) < RETRY && !(await lookId(look, framed))) {
      const lead = (l) => (l.art[0]?.s ?? 0) * 2 - (l.art[1]?.s ?? 0);
      const guided = await lookFrame(unwarpCard(source.src, source.guide), { src: source.src, corners: source.guide }, frameNo);
      if (lead(guided) > lead(look)) { look = guided; framed = false; }
    }
    if (!dialog.open || frozen) return;
    // Ett nytt One Piece-kort kan ligga i indexet under sitt gamla id (se opData). Bilden och texten måste räkna samma kort.
    if (look.game === "op") {
      const cards = await opData(), frame = look.art.frame;
      look.art = look.art.map((x) => ({ ...x, id: cards.get(x.id)?.id || x.id }));
      look.art.frame = frame;
    }
    // Basic Energy: typen avgörs av färgen, och utgåvorna är i praktiken samma kort med samma värde
    const energy = await energyCard(look, framed);
    if (energy) {
      if (lastHit?.name === energy.name) { lastHit.seen = Date.now(); return status("Byt till nästa kort…"); }
      if (!confirmed({ cardId: `energy:${energy.name}`, art: look.art }, framed)) return status("Håll kortet stilla i ramen…");
      return setPeek({ name: energy.name, number: localOf(energy.id), total: null, numberSure: true, cardId: energy.id, art: [{ id: energy.id, s: 1 }] }, artCanvas(look.canvas, look.art));
    }
    // Kortet som nyss hittades ligger kvar i ramen: inget att läsa
    if (look.art.slice(0, 3).some((x) => x.id === skipKey || lastHit?.ids.has(x.id))) {
      lastHit && (lastHit.seen = Date.now());
      return status("Byt till nästa kort…");
    }
    trail.push({ game: look.game, framed, scores: new Map(look.art.slice(0, 12).map((x) => [x.id, x.s])) });
    if (trail.length > VOTE_FRAMES) trail.shift();
    const r = await lookHit(look, framed);
    if (r) return setPeek(r, artCanvas(look.canvas, look.art));
    twin = await twinName(look);
    if (twin) {
      setTwinSeen({ name: twin, art: look.art });
      // Numret har inte gått att läsa på några försök: man får välja utgåvan med ett tryck
      if (readRound >= TWIN_ROUNDS) showTwins(look);
      status(twinOpen ? `Vilken utgåva av <b>${esc(twin)}</b>?` : `Flera utgåvor av <b>${esc(twin)}</b>. Läser numret…`);
    } else {
      // Ett annat kort i ramen: numret ska inte längre välja bland det förra kortets utgåvor
      if (twinSeen && !look.art.slice(0, 3).some((x) => twinSeen.art.some((y) => y.id === x.id))) setTwinSeen(null);
      status(cand ? "Håll kortet stilla i ramen…" : "Läser av…");
    }
    // Ett kort som inte liknar något i indexet kan ändå läsas när ramen ser dess kanter (t.ex. nya kort)
    if (!reading && (framed || (look.art[0]?.s ?? 0) >= LIKE)) readBehind(look, framed);
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
  lastSeen = null;
  hasPrevMotion = false;
  setTorch(false);
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

  // Vissa Android-kameror rapporterar lampan först en stund efter start
  if (!torchSupported && track.getCapabilities) {
    setTimeout(() => {
      if (stream?.getVideoTracks()[0] !== track) return;
      torchSupported = !!track.getCapabilities().torch;
      if (torchBtn) torchBtn.hidden = !torchSupported;
    }, 800);
  }
}

// Bakre kameran, helst en med blixt. Telefoner med flera bakre kameror (vidvinkel, ultravidvinkel, tele) ger ofta
// en utan lampa när man bara ber om "environment", och då syns ingen blixtknapp. Saknar den valda kameran lampa
// provas de andra bakre kamerorna en i taget. Kameran med lampa sparas. Att ingen har lampa sparas bara för
// besöket, så att en kamera som var långsam att visa lampan får en ny chans nästa gång.
const TORCH_CAM = "nl-torch-cam";
const camera = (deviceId) => navigator.mediaDevices.getUserMedia({
  video: { ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" }), width: { ideal: 1920 }, height: { ideal: 1080 } },
  audio: false,
});
// Vissa kameror visar lampan först en stund efter start, så frågan ställs om efter en kort paus
const hasTorch = async (s) => {
  const t = s.getVideoTracks()[0];
  if (!t?.getCapabilities) return false;
  if (t.getCapabilities().torch) return true;
  await new Promise((r) => setTimeout(r, 300));
  return !!t.getCapabilities().torch;
};
const remember = (v) => { try { v === "-" ? sessionStorage.setItem(TORCH_CAM, v) : localStorage.setItem(TORCH_CAM, v); } catch {} };
async function openCamera() {
  let saved = null;
  try { saved = localStorage.getItem(TORCH_CAM) || sessionStorage.getItem(TORCH_CAM); } catch {}
  if (saved && saved !== "-") {
    try { return await camera(saved); } catch { remember(""); }
  }
  const first = await camera();
  const track = first.getVideoTracks()[0];
  if (saved === "-" || !track?.getCapabilities || (await hasTorch(first)) || track.getSettings().facingMode === "user") return first;
  const firstId = track.getSettings().deviceId;
  const others = (await navigator.mediaDevices.enumerateDevices().catch(() => []))
    .filter((c) => c.kind === "videoinput" && c.deviceId && c.deviceId !== firstId && !/front|user|fram/i.test(c.label));
  if (!others.length) { remember("-"); return first; }
  // Många telefoner kan inte ha två kameror öppna samtidigt
  first.getTracks().forEach((t) => t.stop());
  for (const c of others) {
    try {
      const s = await camera(c.deviceId);
      if ((await hasTorch(s)) && s.getVideoTracks()[0].getSettings().facingMode !== "user") { remember(c.deviceId); return s; }
      s.getTracks().forEach((t) => t.stop());
    } catch {}
  }
  remember("-");
  return camera(firstId);
}

function setTorch(on) {
  torchActive = on;
  const btn = dialog?.querySelector(".scan-torch");
  if (!btn) return;
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.querySelector("span").textContent = on ? "På" : "Av";
}

// ---------- 10. Träffen ----------
let skipKey = null; // senast hittade kortet, som inte räknas igen förrän det lämnat ramen
const GAME_LABEL = { pokemon: "Pokémon", rb: "Riftbound", op: "One Piece" };
const keyOf = (r) => r.cardId || `${r.name || ""}|${r.number || ""}/${r.total || ""}`;
const numberOf = (x) => (x.number ? (x.total ? `${x.number}/${x.total}` : x.number) : "");
const labelOf = (x) => x.name || (x.number ? `Nr ${numberOf(x)}` : "Okänt kort");

// Liten bild av kortet som kameran såg det
function thumbOf(canvas) {
  if (!canvas?.width) return null;
  const t = Object.assign(document.createElement("canvas"), { width: 126, height: 176 });
  t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL("image/jpeg", 0.7);
}

// Skannern stängs inte vid en träff. Kortet visas som en liten bild uppe till höger och kameran fortsätter, så att man
// kan ta nästa kort direkt. Ett nytt kort ersätter bilden. Trycker man på den öppnas kortet (onFound).
// autoOpen (Kortpriser): kortet öppnas direkt, utan bilden i hörnet.
let peek = null, resumeHit = null;
// Kortets pris i kronor (One Piece och Riftbound, ur kortfilerna), eller null
async function priceOf(r) {
  if (!r.cardId) return null;
  if (r.game === "rb") return (await rbData().catch(() => null))?.byId.get(r.cardId)?.sek ?? null;
  if (r.game === "op") return (await opData().catch(() => null))?.get(r.cardId)?.sek ?? null;
  return null;
}
const OPEN_WAIT = 2500; // ms som kortet längst väntar på priset när det öppnas direkt (Kortpriser)
const HIT_WAIT = 700; // ms som kortet längst väntar på priset innan det poppar upp ändå. Priset fylls i när det kommer.
const HIT_PAUSE = 1100; // ms innan nästa kort läses
const HIT_GAP = 1000; // ms som minst går mellan två träffar, så att samma kort inte räknas två gånger
const SAME_NAME = 2500; // ms efter att kortet senast setts som ett kort med samma namn räknas som samma kort (en annan utgåva)
// Senaste träffen: { ids, name, at, seen }. ids är korten som liknade bilden nästan lika mycket, t.ex. kortets andra utgåvor.
// De räknas inte igen förrän kortet lämnat ramen. seen: när kortet senast syntes.
let lastHit = null;
function isLastHit(r) {
  const same = !!lastHit && (lastHit.ids.has(r.cardId) || (!!r.name && r.name === lastHit.name && Date.now() - lastHit.seen < SAME_NAME));
  if (same) lastHit.seen = Date.now();
  return same;
}
// I valvet står alltid något om värdet
const priceText = (item) => (item.price != null ? kr(item.price) : item.pending ? "Hämtar pris…" : onHit || onLookup ? "Inget pris" : "");
// Markeringens färg i valvet efter kortets värde, med samma avrundning som priset som visas. Okänt pris blir grått.
const tierOf = (price) => {
  const k = price == null ? 0 : Math.round(price);
  return k > 1000 ? "diamond" : k > 500 ? "gold" : k > 100 ? "silver" : k > 50 ? "bronze" : k >= 5 ? "green" : "gray";
};
// saved: valvet har svarat att kortet är inlagt
const hitText = (item, saved) => (onHit
  ? saved ? `<b>${esc(labelOf(item))}</b> lagt i valvet! Håll nästa kort i ramen.` : `Hittade <b>${esc(labelOf(item))}</b>! Lägger i valvet…`
  : autoOpen ? `Hittade <b>${esc(labelOf(item))}</b>!`
  : `Hittade <b>${esc(labelOf(item))}</b>! Tryck på kortet för att öppna det, eller håll nästa i ramen.`);
// Kortets riktiga bild i stället för kamerabilden, när den har laddats. Går den inte att ladda ligger kamerabilden kvar.
const IMAGE_WAIT = 350; // ms som kortet längst väntar på bilden innan det poppar upp ändå
function useCardImage(item, c) {
  const src = cardImg(c, "low");
  if (!src) return Promise.resolve();
  return new Promise((done) => {
    const img = new Image();
    img.onload = () => {
      item.thumb = src;
      if (peek === item) paintPeek(item);
      done();
    };
    img.onerror = done;
    img.src = src;
  });
}
// Kortet i hörnet, och kortet som just poppat upp om det syns än
function paintPeek(item) {
  const btn = dialog.querySelector(".scan-peek"), price = btn.querySelector(".scan-price");
  btn.querySelector("img").src = item.thumb || "";
  btn.querySelector("img").hidden = !item.thumb;
  price.textContent = priceText(item);
  price.hidden = !price.textContent;
  btn.querySelector("span").textContent = labelOf(item);
  btn.setAttribute("aria-label", `Öppna ${labelOf(item)}${item.price != null ? `, ${kr(item.price)}` : ""}`);
  if (onHit || onLookup) btn.dataset.tier = tierOf(item.price);
  else delete btn.dataset.tier;
  const pop = [...dialog.querySelectorAll(".scan-pop")].at(-1);
  if (!pop) return;
  if (onHit || onLookup) pop.dataset.tier = tierOf(item.price);
  const popImg = pop.querySelector("img");
  if (popImg && item.thumb) popImg.src = item.thumb;
  pop.querySelector(".scan-price").textContent = priceText(item);
  pop.querySelector("span").textContent = labelOf(item);
}
// Silver-, guld- och diamantkort har egna ljud i stället för myntet (showReveal)
// Är animationerna av spelas nivåns ljud direkt, eftersom ingen visning kommer
const coinFor = (price) => {
  const tier = tierOf(price);
  if (!hasTierSound(tier)) playCoin();
  else if (fxOff()) playTier(tier);
};
function cheer(item) {
  if ("vibrate" in navigator) navigator.vibrate(45);
  if (onHit || onLookup) coinFor(item.price);
  const hud = dialog.querySelector(".scan-hud-status");
  hud?.classList.add("success");
  setTimeout(() => hud?.classList.remove("success"), 1500);
}
// r.picked: man har själv valt kortet (sökning, utgåva eller foto), så det räknas alltid
async function setPeek(r, canvas) {
  if (!r.picked) {
    if (Date.now() - (lastHit?.at || 0) < HIT_GAP) return;
    if (keyOf(r) === skipKey || isLastHit(r)) return status("Byt till nästa kort…");
    if (r.game === "rb" && r.cardId && await askSignature(r, canvas)) return;
  }
  const near = (r.art || []).filter((x) => x.s >= r.art[0].s - 0.08).map((x) => x.id);
  lastHit = { ids: new Set([r.cardId, ...near].filter(Boolean)), name: r.name || null, at: Date.now(), seen: Date.now() };
  skipKey = keyOf(r);
  newCard();
  hitTip();
  pauseUntil = Date.now() + HIT_PAUSE;
  const item = { game: r.game || "pokemon", name: r.name, number: r.number, total: r.total, cardId: r.cardId, canvas, dhash: r.dhash };
  const before = peek;
  peek = item;
  status(hitText(item));
  // Valvet svarar med det inlagda kortet, eller null om läsningen inte pekade ut något kort
  const adding = onHit && Promise.resolve(onHit(item)).then((c) => c || null, () => null);
  // Snabb skanning: priset till bilden i hörnet. Öppnas kortet direkt behövs det inte här.
  const lookup = !onHit && onLookup ? Promise.resolve(onLookup(item)).then((c) => c || null, () => null) : null;
  item.thumb = thumbOf(canvas) || r.image || null; // ett manuellt valt kort har kortets bild
  // Ingen träff att visa: förra kortet ligger kvar i hörnet, och samma kort får läsas om
  const failed = () => {
    peek = before;
    skipKey = null;
    lastHit = null;
    pauseUntil = Date.now() + PAUSE_AFTER_MISS;
    missed();
    const btn = dialog.querySelector(".scan-peek");
    if (before) paintPeek(before);
    else btn.hidden = true;
    status(`Kunde inte lägga <b>${esc(labelOf(item))}</b> i valvet. Håll kortet stilla så läses det om, eller tryck på <b>Värdera manuellt</b>.`);
  };
  // Svaret ger priset i kronor och kortets rätta namn (textläsningen kan missa t.ex. "ex")
  const take = (c) => {
    item.name = c.name || item.name;
    item.price = c.sek ?? null;
    item.pending = false;
    item.hi = cardImg(c, "high");
    return useCardImage(item, c);
  };
  // Dröjer svaret (undefined) poppar kortet upp ändå, och priset fylls i när det kommer
  // Vanlig eller foil väljs inte här: i valvet markeras kortet i den stora vyn
  const added = adding ? await Promise.race([adding, new Promise((done) => setTimeout(done, HIT_WAIT))]) : undefined;
  if (peek !== item) return; // ett nytt kort hann hittas
  if (added === null) return failed();
  if (added) await Promise.race([take(added), new Promise((done) => setTimeout(done, IMAGE_WAIT))]);
  else if (adding) item.pending = true;
  else if (lookup) {
    // Öppnas kortet direkt väntar det lite längre på priset, så att ljudet och animationen hinner följa med
    const c = await Promise.race([lookup, new Promise((done) => setTimeout(done, autoOpen ? OPEN_WAIT : HIT_WAIT))]);
    if (peek !== item) return;
    if (c) await Promise.race([take(c), new Promise((done) => setTimeout(done, IMAGE_WAIT))]);
    else if (c === undefined) item.pending = true;
  } else item.price = await priceOf(item);
  if (peek !== item) return;
  if (!item.pending) cheer(item);
  status(hitText(item, !!added));
  const btn = dialog.querySelector(".scan-peek");
  // Kortpriser: kortet visas med sin värdenivå (ljud och animation, som i valvet) och öppnas sedan
  if (autoOpen) {
    if (item.pending) item.pending = false; // priset kom inte i tid: kortet öppnas ändå
    const level = onLookup && revealLevel(item.price);
    if (level) await showReveal(item, level);
    else if (onLookup && !fxOff()) {
      paintPeek(item);
      btn.style.visibility = "hidden";
      await new Promise((done) => popCard(item, btn, done));
      btn.style.visibility = "";
    }
    if (peek !== item) return;
    return openPeek();
  }
  paintPeek(item);
  // Värdefulla kort visas över hela skärmen i stället för den lilla bilden, och landar sedan i hörnet
  btn.hidden = false;
  btn.style.visibility = "hidden";
  const level = !item.pending && revealLevel(item.price);
  if (level) {
    await showReveal(item, level);
    if (peek !== item) return;
    btn.style.visibility = "";
    btn.classList.remove("pop");
    void btn.offsetWidth;
    btn.classList.add("pop");
    return;
  }
  // Kortet poppar upp mitt i bilden med priset och flyger sedan upp till hörnet, där det ligger kvar.
  // Med animationerna av hamnar det direkt i hörnet.
  if (fxOff() && (onHit || onLookup)) btn.style.visibility = "";
  else popCard(item, btn, () => {
    if (peek !== item) return;
    btn.style.visibility = "";
    btn.classList.remove("pop");
    void btn.offsetWidth; // starta om animationen när bilden byts
    btn.classList.add("pop");
  });
  if (!item.pending) return;
  const c = await (adding || lookup);
  if (peek !== item) { if (c && adding) playCoin(); return; }
  if (!c && lookup) { item.pending = false; return paintPeek(item); }
  if (!c) return failed();
  await Promise.race([take(c), new Promise((done) => setTimeout(done, IMAGE_WAIT))]);
  if (peek !== item) return;
  cheer(item);
  status(hitText(item, true));
  paintPeek(item);
  // Priset kom efter att kortet poppat upp: den lilla bilden ger plats åt den stora visningen
  const late = revealLevel(item.price);
  if (!late) return;
  dialog.querySelectorAll(".scan-pop").forEach((x) => x.remove());
  await showReveal(item, late);
}
// Riftbound-kort som finns både vanligt och signerat (js/signature.js) har samma konstverk, så bilden kan inte skilja dem
// åt. Skanningen stannar och man väljer i remsan längst ner (samma som utgåvorna för Pokémon). Valet blir en träff
// (pickTwin), "Ingen av dem" läser om kortet. true: valet visas.
async function askSignature(r, canvas) {
  const rb = await rbData().catch(() => null), other = rb?.sigPairs.get(r.cardId);
  if (!other || twinOpen) return !!other && twinOpen;
  const [plain, signed] = [r.cardId, other].map((id) => rb.byId.get(id)).sort((a, b) => isSignature(a) - isSignature(b));
  twinOpen = true;
  twinCards = [plain, signed].map((c) => ({ sigOf: { ...rbResult(rb, c.id), art: r.art }, canvas }));
  const el = dialog.querySelector(".scan-twins");
  el.querySelector("b").textContent = `Vanligt eller Signature? ${r.name || plain.name}`;
  el.querySelector("div").innerHTML = [plain, signed].map((c, i) => {
    const src = cardImg(plain, "low") || cardImg(c, "low"); // samma konstverk, och signerade kort saknar ofta egen bild
    return `<button type="button" data-twin="${i}">${src ? `<img src="${esc(src)}" alt="">` : ""}<b>${i ? "✍ Signature" : "Vanligt"}</b><small>${esc(c.no || "")}${c.sek != null ? ` · ${esc(kr(c.sek))}` : ""}</small></button>`;
  }).join("");
  el.hidden = false;
  status(`Är <b>${esc(plain.name)}</b> signerat? Välj nedan.`);
  if ("vibrate" in navigator) navigator.vibrate(30);
  return true;
}
// ---------- Värdera manuellt ----------
// Pokémon på värderingssidan: skannern stängs och sidans egen manuella värdering öppnas (onPartial, utan text).
// Annars skrivs kortet in i skannern: One Piece och Riftbound får förslag ur korten (valvet även Pokémon, från TCGdex), och ett valt
// kort blir en träff precis som ett skannat (läggs i valvet eller öppnas). Pokémon utan egen värdering:
// det skrivna söks på sidan.
let manualOpen = false, manualHits = [];
function openManual() {
  if (scanGame === "pokemon" && onPartial) {
    stop();
    dialog.close();
    onPartial({ name: null, number: null });
    return;
  }
  manualOpen = true;
  const form = dialog.querySelector(".scan-manual"), input = form.querySelector("input");
  form.hidden = false;
  input.value = twin || ""; // kortet som hittades men inte gick att skilja från sina utgåvor
  renderManual();
  input.focus();
}
function closeManual() {
  manualOpen = false;
  numberLook = null;
  dialog.querySelector(".scan-manual").hidden = true;
  dialog.querySelector(".scan-number").hidden = true;
  stillTicks = 0;
  // Öppnades skannern direkt med sökrutan är kameran inte igång än
  if (dialog.open && !stream) startCamera();
}
// Numret för hand när skannern ser flera utgåvor. Bara siffror och ett snedstreck. "116/132" väljer utgåvan direkt, och
// "116" räcker när bara en utgåva har numret. numberLook: utgåvorna när rutan öppnades, skanningen står still under tiden.
let numberLook = null;
function cleanNumber(v) {
  const [no, ...rest] = v.replace(/[^\d/]/g, "").split("/");
  return (rest.length ? `${no}/${rest.join("")}` : no).slice(0, 7);
}
function openNumber() {
  numberLook = twinSeen;
  manualOpen = true;
  const form = dialog.querySelector(".scan-number"), input = form.querySelector("input");
  input.value = "";
  form.querySelector("p").textContent = "";
  form.hidden = false;
  input.focus();
}
async function pickNumber() {
  const form = dialog.querySelector(".scan-number"), say = (t) => { form.querySelector("p").textContent = t; };
  const look = numberLook, typed = form.querySelector("input").value, [, no, total] = typed.match(/^(\d+)(?:\/(\d*))?$/) || [];
  if (!look) return;
  if (!no) return say("Skriv numret, till exempel 116/132.");
  const [a, counts] = await Promise.all([loadArtIndex(), total ? setCounts() : null]);
  if (numberLook !== look) return;
  const score = (id) => look.art.find((x) => x.id === id)?.s ?? -1;
  const sized = (id) => { const c = counts?.get(setOf(id)); return !c || !total || c.official === +total || c.total === +total; };
  const hits = [...new Set(a?.ids || [])]
    .filter((id) => numKey(localOf(id)) === numKey(no) && a.names[a.idx.get(id)]?.replace(/^Basic /, "") === look.name && sized(id))
    .sort((x, y) => score(y) - score(x));
  if (!hits.length) return say(`Hittade ingen ${look.name} med numret ${typed}.`);
  if (hits.length > 1 && !total) return say("Flera utgåvor har det numret. Skriv hela, till exempel 116/132.");
  const id = hits[0], c = await getJSON(`${API}/cards/${encodeURIComponent(id)}`).catch(() => null);
  if (numberLook !== look) return;
  closeManual();
  pickTwin(c || { id, name: look.name, localId: localOf(id) });
}
async function renderManual() {
  const form = dialog.querySelector(".scan-manual"), input = form.querySelector("input");
  const list = form.querySelector(".scan-manual-list"), hint = form.querySelector(".scan-manual-hint");
  const q = input.value.trim().toLowerCase();
  manualHits = [];
  if (scanGame === "pokemon") {
    list.innerHTML = "";
    hint.textContent = q ? "Tryck på Enter för att söka på kortet." : "Skriv kortets namn, t.ex. Charizard ex.";
    return;
  }
  if (q.length < 2) {
    list.innerHTML = "";
    hint.textContent = "Skriv minst två bokstäver av namnet, eller kortnumret.";
    return;
  }
  // Valvet: Pokémonkort med namnet hämtas från TCGdex (från tre bokstäver), kort med bild först
  const [rb, op, pk] = await Promise.all([scanGame !== "op" ? rbData() : null, scanGame !== "rb" ? opData() : null,
    scanGame === "vault" && q.length >= 3 ? getJSON(`${API}/cards?${new URLSearchParams({ name: q })}`).catch(() => []) : null]);
  if (input.value.trim().toLowerCase() !== q) return; // ny text hann skrivas
  const all = [...(rb?.cards || []).map((c) => ({ game: "rb", c })), ...(op?.cards || []).map((c) => ({ game: "op", c }))];
  const words = q.split(/\s+/), hay = ({ c }) => `${c.name} ${c.no || ""} ${c.variant || ""}`.toLowerCase();
  // Namn som börjar med det skrivna först, sedan dyraste
  const hits = all.filter((x) => words.every((w) => hay(x).includes(w)))
    .sort((a, b) => b.c.name.toLowerCase().startsWith(q) - a.c.name.toLowerCase().startsWith(q) || (b.c.sek ?? -1) - (a.c.sek ?? -1));
  const pkHits = (Array.isArray(pk) ? pk : []).sort((a, b) => !!b.image - !!a.image)
    .map((c) => ({ game: "pokemon", c: { id: c.id, name: c.name, no: `#${c.localId} · ${setOf(c.id).toUpperCase()}`, image: c.image ? `${c.image}/low.webp` : null } }));
  manualHits = [...hits.slice(0, 8), ...pkHits.slice(0, 8)];
  list.innerHTML = manualHits.map(({ game, c }, i) => `<li><button type="button" data-i="${i}">
    ${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : "<i></i>"}
    <span><b>${esc(c.name)}</b><small>${esc([c.no, c.variant, scanGame === "vault" && GAME_LABEL[game]].filter(Boolean).join(" · "))}</small></span>
    ${c.sek != null ? `<em>${esc(kr(c.sek))}</em>` : ""}</button></li>`).join("");
  hint.textContent = manualHits.length ? "" : "Hittade inget kort med det namnet.";
}
function pickManual(i) {
  const q = dialog.querySelector(".scan-manual input").value.trim();
  if (scanGame === "pokemon") {
    if (!q) return;
    closeManual();
    stop();
    dialog.close();
    onFound?.({ game: "pokemon", name: q, number: null, total: null, cardId: null });
    return;
  }
  const x = manualHits[i];
  if (!x) return;
  if (onPreview) return openConfirm(x);
  closeManual();
  // Samma kort som nyss skannades ska gå att lägga in igen när man väljer det själv
  skipKey = null;
  setPeek({ game: x.game, cardId: x.c.id, name: x.c.name, number: (x.game === "pokemon" ? localOf(x.c.id) : x.c.no) || null, total: null, picked: true, image: x.c.image || null }, null);
}

// Valvet: ett valt kort visas direkt med sitt värde, utan kameran, och läggs in först efter ett Ja. Sökrutan ligger kvar
// under, så att "Lägg till fler" går tillbaka till den. Nej och Klar stänger skannern, och valvet syns igen.
let confirmItem = null;
function confirmStep(step, text) {
  const el = dialog.querySelector(".scan-confirm"), done = step === "done";
  el.dataset.step = step;
  el.querySelector("p").textContent = text;
  el.querySelector("[data-confirm-no]").textContent = done ? "Klar" : "Nej";
  el.querySelector("[data-confirm-yes]").textContent = done ? "Lägg till fler" : "Ja, lägg till";
  el.querySelector("[data-confirm-yes]").disabled = false;
}
async function openConfirm({ game, c }) {
  const item = { game, cardId: c.id, name: c.name, number: (game === "pokemon" ? localOf(c.id) : c.no) || null, total: null };
  confirmItem = item;
  const el = dialog.querySelector(".scan-confirm"), img = el.querySelector("img"), price = el.querySelector("em");
  img.src = c.image || "";
  img.hidden = !c.image;
  el.querySelector("b").textContent = c.name;
  el.querySelector("small").textContent = [c.no, c.variant, GAME_LABEL[game]].filter(Boolean).join(" · ");
  price.textContent = c.sek != null ? kr(c.sek) : "Hämtar pris…";
  el.dataset.tier = tierOf(c.sek);
  confirmStep("ask", "Vill du lägga till kortet i valvet?");
  el.hidden = false;
  dialog.classList.add("confirming");
  el.querySelector("[data-confirm-yes]").focus();
  const card = await Promise.resolve(onPreview(item)).catch(() => null);
  if (confirmItem !== item) return; // ett annat kort hann väljas
  price.textContent = card?.sek != null ? kr(card.sek) : "Inget pris";
  el.dataset.tier = tierOf(card?.sek);
  if (card?.name) el.querySelector("b").textContent = card.name;
}
async function confirmYes() {
  const el = dialog.querySelector(".scan-confirm"), item = confirmItem;
  if (el.dataset.step === "done") {
    hideConfirm();
    const input = dialog.querySelector(".scan-manual input");
    input.value = "";
    renderManual();
    input.focus();
    return;
  }
  el.querySelector("[data-confirm-yes]").disabled = true;
  const added = await Promise.resolve(onHit(item)).catch(() => null);
  if (confirmItem !== item) return;
  if (!added) return confirmStep("ask", "Kortet gick inte att lägga till. Försök igen.");
  if ("vibrate" in navigator) navigator.vibrate(45);
  coinFor(added.sek);
  confirmStep("done", "Tillagt i valvet! Vill du lägga till fler kort?");
  const level = revealLevel(added.sek);
  if (level) showReveal({ ...item, name: added.name || item.name, price: added.sek, thumb: cardImg(added, "low"), hi: cardImg(added, "high") }, level);
}
function hideConfirm() {
  confirmItem = null;
  dialog.querySelector(".scan-confirm").hidden = true;
  dialog.classList.remove("confirming");
}

function clearPeek() {
  peek = null;
  closeReveal?.();
  if (dialog) dialog.querySelector(".scan-peek").hidden = true;
}

function openPeek() {
  const r = peek;
  if (!r) return;
  // Valvet och Kortpriser går tillbaka till kameran när kortet stängs, och kortet ligger troligen kvar i handen: det ska inte läsas igen
  resumeHit = onHit || openMode ? { key: keyOf(r), hit: lastHit } : null;
  clearPeek();
  stop();
  dialog.close();
  onFound?.(r);
}

// ---------- Värdefulla kort i valvet ----------
// Över 100 kr visas bara kortet över hela skärmen med strålar bakom. Över 1 000 kr blir det jackpot: blixt, kortet poppar
// upp, ringar, mynt och priset som räknas upp (ingen text). Visningen ligger kvar tills man trycker.
const revealLevel = (price) => {
  const k = price == null ? 0 : Math.round(price);
  return (!onHit && !onLookup) || fxOff() ? null : k > 1000 ? "jackpot" : k > 100 ? "rays" : null;
};
let closeReveal = null;
// Gnistor från mitten, och vid jackpot även mynt som regnar. Slutar när rutan är borta.
function sparkle(canvas, level) {
  const g = canvas.getContext("2d"), dpr = Math.min(devicePixelRatio || 1, 1.5);
  const W = innerWidth, H = innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  g.scale(dpr, dpr);
  const jackpot = level === "jackpot";
  const colors = jackpot ? ["#fde68a", "#fbbf24", "#fff7d6", "#f59e0b"] : ["#ffffff", "#e2e8f0", "#fde68a"];
  const parts = [];
  const spark = (delay) => {
    const a = Math.random() * Math.PI * 2, v = (jackpot ? 5 : 3) + Math.random() * (jackpot ? 9 : 5);
    parts.push({ x: W / 2, y: H * 0.45, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: 1.5 + Math.random() * 3, life: 50 + Math.random() * 50, age: -delay, c: colors[(Math.random() * colors.length) | 0], fall: 0.05 });
  };
  const coin = (delay) => parts.push({ coin: true, x: Math.random() * W, y: -30, vx: (Math.random() - 0.5) * 1.2, vy: 3 + Math.random() * 4, r: 8 + Math.random() * 7, spin: Math.random() * 6, turn: 0.1 + Math.random() * 0.16, life: 400, age: -delay, fall: 0.04 });
  for (let i = 0; i < (jackpot ? 70 : 46); i++) spark(jackpot ? (i % 2) * 14 : Math.random() * 10);
  if (jackpot) for (let i = 0; i < 45; i++) coin(6 + i * 5);
  const draw = () => {
    if (!canvas.isConnected) return;
    g.clearRect(0, 0, W, H);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (++p.age < 0) continue;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.fall;
      if (!p.coin) { p.vx *= 0.985; p.vy *= 0.985; }
      if (p.age > p.life || p.y > H + 40) { parts.splice(i, 1); continue; }
      if (p.coin) {
        p.spin += p.turn;
        const wide = Math.abs(Math.cos(p.spin)) * p.r + 1;
        g.globalAlpha = 1;
        g.fillStyle = Math.cos(p.spin) > 0 ? "#fcd34d" : "#f59e0b";
        g.beginPath(); g.ellipse(p.x, p.y, wide, p.r, 0, 0, 7); g.fill();
        g.fillStyle = "rgba(255,255,255,.6)";
        g.beginPath(); g.ellipse(p.x, p.y, wide * 0.55, p.r * 0.6, 0, 0, 7); g.fill();
      } else {
        g.globalAlpha = Math.max(0, 1 - p.age / p.life);
        g.fillStyle = p.c;
        g.beginPath();
        g.moveTo(p.x, p.y - p.r * 2); g.lineTo(p.x + p.r * 0.6, p.y); g.lineTo(p.x, p.y + p.r * 2); g.lineTo(p.x - p.r * 0.6, p.y);
        g.closePath(); g.fill();
      }
    }
    if (parts.length) requestAnimationFrame(draw);
    else g.clearRect(0, 0, W, H);
  };
  requestAnimationFrame(draw);
}
// Priset räknas upp till kortets värde
function countUp(el, value, ms, delay) {
  const t0 = performance.now() + delay;
  el.textContent = kr(0);
  const step = (t) => {
    if (!el.isConnected) return;
    const k = Math.min(1, Math.max(0, (t - t0) / ms));
    el.textContent = kr(k >= 1 ? value : Math.round(value * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(step);
    else el.classList.add("done");
  };
  requestAnimationFrame(step);
}
// Svarar när visningen är över. Skannern läser inget nytt kort under tiden.
function showReveal(item, level) {
  closeReveal?.();
  return new Promise((done) => {
    const quick = matchMedia("(prefers-reduced-motion: reduce)").matches, jackpot = level === "jackpot";
    pauseUntil = Infinity;
    const el = document.createElement("div");
    el.className = `scan-reveal ${level}`;
    el.dataset.tier = tierOf(item.price);
    el.setAttribute("role", "status");
    el.setAttribute("aria-label", `${labelOf(item)}, ${kr(item.price)}`);
    el.innerHTML = `<i class="sr-rays"></i><i class="sr-rays two"></i><canvas aria-hidden="true"></canvas>
      ${jackpot ? '<i class="sr-flash"></i><i class="sr-ring"></i><i class="sr-ring two"></i>' : ""}
      <div class="sr-card">${item.thumb ? `<img src="${esc(item.thumb)}" alt="">` : "<i></i>"}<i class="sr-sheen"></i></div>
      <em class="sr-price" aria-hidden="true">${esc(kr(item.price))}</em><span class="sr-name" aria-hidden="true">${esc(labelOf(item))}</span>
      <small class="sr-tap" aria-hidden="true">Tryck för att fortsätta</small>`;
    dialog.append(el);
    // Skarpare bild när kortet poppat upp, så att bilden inte packas upp mitt i animationen. Går den inte att ladda ligger den lilla kvar.
    if (item.hi) setTimeout(() => {
      const hi = new Image();
      hi.src = item.hi;
      hi.decode().then(() => { const img = el.querySelector(".sr-card img"); if (img) img.src = item.hi; }).catch(() => {});
    }, 700);
    if (!quick) {
      // Vid jackpot kommer gnistorna och mynten när kortet poppat upp
      setTimeout(() => { if (el.isConnected) sparkle(el.querySelector("canvas"), level); }, jackpot ? 450 : 0);
      if (jackpot) countUp(el.querySelector(".sr-price"), item.price, 1300, 450);
    }
    dialog.classList.add("revealing");
    playTier(el.dataset.tier);
    if (jackpot) {
      if ("vibrate" in navigator) navigator.vibrate([70, 50, 70, 50, 180]);
    }
    const finish = () => {
      if (closeReveal !== finish) return;
      closeReveal = null;
      pauseUntil = Date.now() + HIT_PAUSE;
      el.classList.add("leaving");
      setTimeout(() => { el.remove(); dialog.classList.remove("revealing"); done(); }, quick ? 0 : 280);
    };
    closeReveal = finish;
    // Ett första tryck ska inte råka hoppa över hela visningen
    const opened = Date.now();
    el.addEventListener("pointerdown", () => { if (Date.now() - opened > 500) finish(); });
  });
}

// Kortet poppar upp mitt i bilden, stannar en stund och flyger till förhandsvisningen uppe till höger (target).
// end: när det har landat
function popCard(item, target, end) {
  const view = dialog.querySelector(".scan-view");
  const pop = document.createElement("div");
  pop.className = "scan-pop";
  pop.setAttribute("aria-hidden", "true");
  if (onHit || onLookup) pop.dataset.tier = tierOf(item.price);
  pop.innerHTML = `<div>${item.thumb ? `<img src="${item.thumb}" alt="">` : "<i></i>"}<em class="scan-price">${esc(priceText(item))}</em><span>${esc(labelOf(item))}</span></div>`;
  view.append(pop);
  target.hidden = false;
  const card = pop.firstElementChild, p = card.getBoundingClientRect(), t = target.getBoundingClientRect();
  const dx = t.left + t.width / 2 - (p.left + p.width / 2), dy = t.top + t.height / 2 - (p.top + p.height / 2);
  const s = Math.max(0.12, t.height / p.height);
  const quick = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const anim = card.animate([
    { transform: "scale(.55)", opacity: 0 },
    { transform: "scale(1.05)", opacity: 1, offset: 0.18 },
    { transform: "scale(1)", opacity: 1, offset: 0.3 },
    { transform: "scale(1)", opacity: 1, offset: 0.62 },
    { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0.6 },
  ], { duration: quick ? 400 : 1000, easing: "cubic-bezier(.45,0,.2,1)" });
  const landed = () => { pop.remove(); end(); };
  anim.finished.then(landed, landed);
}

// callback får ett komplett kort (namn + nummer + bild). partialCallback får en delläsning
// (bara namn eller bara nummer) när användaren tryckt "Skanna nu" eller valt ett foto.
// game: "pokemon" (känner också igen tydliga Riftbound- och One Piece-kort), "rb" eller "op". Svaret säger vilket
// spel kortet är (game).
// hit: får varje kort så fort det är hittat (Mitt valv lägger in kortet direkt).
// manual: sökrutan (Värdera manuellt) öppnas direkt, och kameran startar först om man går tillbaka till den
// open: träffen öppnas direkt (callback) när den har poppat upp, i stället för att vänta på ett tryck
// preview: slår upp ett kort utan att lägga in det. Då visas ett kort valt i sökrutan först, och läggs in (hit) efter ett Ja.
// lookup: slår upp en träff utan att lägga in den, så att bilden i hörnet visar kortets namn, bild och pris
// resume: skannern kommer tillbaka efter att en träff öppnats, och samma kort läses inte igen förrän det bytts
export async function openScanner(callback, partialCallback, { game = "pokemon", hit = null, manual = false, open = false, preview = null, resume = false, lookup = null } = {}) {
  scanGame = game;
  onFound = callback;
  onHit = hit;
  onPreview = preview;
  openMode = open;
  onLookup = lookup;
  autoOpen = open && !quickOn();
  if (!resume) resumeHit = null;
  onPartial = partialCallback || null;
  clearTimeout(restTimer);
  const d = ui();
  const title = { pokemon: "Skanna Pokémonkort", rb: "Skanna Riftbound-kort", op: "Skanna One Piece-kort" }[game] || "Skanna kort";
  d.setAttribute("aria-label", title);
  d.querySelector(".scan-sound").hidden = !hit && !lookup; // ljudet hör till valvet och Kortpriser
  d.querySelector(".scan-fx").hidden = !hit && !lookup;
  paintFx();
  d.querySelector(".scan-quick").hidden = !open;
  d.querySelector(".scan-quick").setAttribute("aria-pressed", String(open && !autoOpen));
  paintSound();
  d.querySelector(".scan-tip").textContent = game === "rb" || game === "vault"
    ? "Håll kortet i ramen. Battlefields hålls på högkant."
    : game === "pokemon" && partialCallback
      ? "Endast Pokémonkort. One Piece och Riftbound skannar du i Mitt valv."
      : "Håll kortet i ramen. Glänser det? Luta det lätt.";
  tipText = d.querySelector(".scan-tip").textContent;
  d.querySelector(".scan-tip").classList.remove("warn");
  clearTimeout(tipTimer);
  tipTimer = null;
  misses = 0;
  tipAgainAt = 0;
  newCard();
  if (game !== "rb") {
    loadArtIndex("op").catch(() => {});
    opData().catch(() => {});
  }
  clearPeek();
  // Tips om appen, för den som skannar i webbläsaren
  d.querySelector(".scan-app").hidden = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  d.showModal();
  // Värm upp textläsarna, setstorlekarna och bildindexen medan kameran startar
  if (game === "pokemon" || game === "vault") {
    getWorker("name").catch(() => {});
    setSizes().catch(() => {});
    loadArtIndex().catch(() => {});
  }
  if (game !== "pokemon") {
    rbData().catch(() => {});
    getWorker("number2").catch(() => {});
  }
  getWorker("number").catch(() => {});
  loadArtIndex("rb").catch(() => {});
  if (manual) return openManual();
  await startCamera();
}

// Startar kameran och skanningen. Används när skannern öppnas och när man går från sökrutan tillbaka till kameran.
async function startCamera() {
  const d = dialog;
  newCard();
  skipKey = resumeHit?.key ?? null;
  lastHit = resumeHit?.hit ? { ...resumeHit.hit, at: Date.now(), seen: Date.now() } : null;
  hasPrevMotion = false;
  stillTicks = 0;
  pauseUntil = resumeHit ? Date.now() + HIT_PAUSE : 0;
  resumeHit = null;
  openedAt = Date.now();
  // Återställ allt från förra gången, t.ex. om kameran inte gick att starta då
  d.querySelector(".scan-view").classList.remove("nocam");
  d.querySelector(".scan-frame i").classList.remove("is-moving", "is-reading");
  d.querySelector(".scan-now").classList.remove("nudge");
  d.querySelector(".scan-hud-status")?.classList.remove("success");
  status("Startar kameran…");

  try {
    stream = await openCamera();
    // Stängdes skannern medan kameran letades fram ska den inte lysa kvar
    if (!d.open) { stream.getTracks().forEach((t) => t.stop()); stream = null; return; }

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
