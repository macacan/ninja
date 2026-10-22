// 8-bitars landskap och ikoner. Allt ritas i kod: inga externa bilder och inga lånade figurer.
export const PAL = {
  k: "#1b1b2f", n: "#3b4a6b", s: "#f7e3c3", r: "#e4572e", w: "#fffaf0", m: "#9bd1c0", y: "#f2b632",
  g: "#3f8f3f", G: "#6cc06a", p: "#f2b8a4", b: "#8ec5ff", B: "#5b9be0", t: "#8a5a3b",
};

export const SPRITES = {
  ninjaA: [
    "...kkkkkk...", "..knnnnnnk..", ".knnnnnnnnk.", ".krrrrrrrrk.", "rkssssssssk.", "rkskksskksk.",
    ".knnnnnnnnk.", "..knnnnnnk..", "..knnnnnkwwk", ".knnnnnnkwmk", ".knnnnnnkwwk", "..knnnnnkkkk", "..kk...kk...",
  ],
  ninjaB: [
    "...kkkkkk...", "..knnnnnnk..", ".knnnnnnnnk.", "rkrrrrrrrrk.", "rkssssssssk.", ".kskksskksk.",
    ".knnnnnnnnk.", "..knnnnnnk..", "..knnnnnkwwk", ".knnnnnnkwmk", ".knnnnnnkwwk", "..knnnnnkkkk", "...kk.kk....",
  ],
  // Mossling: Lootninjas egen lilla varelse som gömmer sig i gräset.
  blob: ["...gG...", "..gGg...", ".kkkkkk.", "kppppppk", "kpkppkpk", "kppppppk", "kppkkppk", ".kkkkkk."],
  blobBlink: ["...gG...", "..gGg...", ".kkkkkk.", "kppppppk", "kppppppk", "kppppppk", "kppkkppk", ".kkkkkk."],
  tuftA: ["G...G", "GG.GG", ".GgG.", "ggggg"],
  tuftB: [".G.G.", "GG.GG", ".GgG.", "ggggg"],
  birdA: ["k...k", ".k.k."],
  birdB: ["kk.kk", "..k.."],
  sparkA: [".y.", "yyy", ".y."],
  sparkB: ["...", ".y.", "..."],
  flyA: ["P.P", "PkP"],
  flyB: [".P.", "PkP"],
  balloon: ["..rrr..", ".rrrrr.", "rrwrrrr", "rwrrrrr", "rrrrrrr", ".rrrrr.", "..rrr..", "...k...", "..k.k..", "..ttt..", "..ttt.."],
  alert: [".kkk.", "kwrwk", "kwrwk", "kwrwk", "kwwwk", "kwrwk", ".kkk."],
  leaf: ["Gg", "g."],
  star: ["..y..", ".yyy.", "yywyy", ".yyy.", "..y.."],
  burst: ["y...y", ".....", "..y..", ".....", "y...y"],
  heart: [".r.r.", "rrrrr", ".rrr.", "..r.."],
};
PAL.P = "#f95587";

function drawSprite(ctx, rows, x, y, flip = false) {
  for (let j = 0; j < rows.length; j++) {
    const row = rows[j];
    for (let i = 0; i < row.length; i++) {
      const ch = row[flip ? row.length - 1 - i : i];
      if (ch === ".") continue;
      ctx.fillStyle = PAL[ch];
      ctx.fillRect(x + i, y + j, 1, 1);
    }
  }
}

export function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Moln som pixelmask: union av cirklar, vit fyllning, blå kontur och skugga i underkanten.
export function makeCloud(w, rand) {
  const h = Math.ceil(w * 0.45);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  const blobs = [[w * 0.3, h * 0.62, h * 0.38], [w * 0.55, h * 0.45, h * 0.45], [w * 0.75, h * 0.66, h * 0.32], [w * 0.15, h * 0.75, h * 0.24]]
    .map(([x, y, r]) => [x + (rand() - 0.5) * 3, y, r]);
  const inside = (x, y) => y < h - 1 && blobs.some(([bx, by, r]) => (x - bx) ** 2 + (y - by) ** 2 <= r * r);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inside(x, y)) continue;
    const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
    g.fillStyle = edge ? "#c4d2ea" : !inside(x, y + 2) ? "#e6edf9" : "#ffffff";
    g.fillRect(x, y, 1, 1);
  }
  return c;
}

// Himmel i klassisk 8-bitarsstil: platta färgband med schackrutiga pixelövergångar.
export const SKY = ["#8fd0ff", "#a6daff", "#bde4ff", "#d3eeff", "#e8f7ff"];
// Kvällshimmel: mörkblått högst upp, ner mot en orange solnedgång vid horisonten.
export const SKY_DUSK = ["#1d2150", "#343a78", "#6b3f86", "#b4587a", "#f08e5c"];
// Nattlig himmel. Ljusare än den verkar, eftersom nattljuset läggs över hela scenen.
export const SKY_NIGHT = ["#1e2a6e", "#2a3880", "#3a4a92", "#4a5ca0", "#5e70ae"];
const isNight = () => document.documentElement.dataset.theme === "dark";
// Scener som ska bygga om sig när man byter mellan ljust och mörkt läge.
const sceneListeners = new Set();
new MutationObserver(() => sceneListeners.forEach((f) => f())).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
// Månen: en tunn halvmåne i pixlar.
const MOON = ["..yyy.", ".yy...", "yy....", "yy....", ".yy...", "..yyy."];
export function buildSky(W, horizon, palette = SKY) {
  const c = document.createElement("canvas"); c.width = W; c.height = horizon;
  const g = c.getContext("2d");
  const band = horizon / palette.length;
  for (let y = 0; y < horizon; y++) {
    const i = Math.min(palette.length - 1, Math.floor(y / band));
    const next = palette[Math.min(palette.length - 1, i + 1)];
    const intoBand = y - i * band;
    g.fillStyle = palette[i]; g.fillRect(0, y, W, 1);
    // De två sista raderna i varje band blandas med nästa färg i ett rutmönster.
    if (i < palette.length - 1 && intoBand >= band - 2) {
      g.fillStyle = next;
      const step = intoBand >= band - 1 ? 2 : 4;
      for (let x = (y % 2) * (step / 2); x < W; x += step) g.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

function buildStatic(W, H, o, rand, sign = null) {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  const px = (x, y, col) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };
  const col = (x, y0, y1, color) => { g.fillStyle = color; g.fillRect(x, y0, 1, y1 - y0); };
  const gt = H - o.ground;
  const ph = [rand() * 9, rand() * 9, rand() * 9, rand() * 9];

  const base = gt - 4, amp = Math.min(30, base - 6);
  const hillAmp = Math.min(12, gt - 3);
  const hillTop = (x) => gt - Math.round(hillAmp * (0.55 + 0.3 * Math.sin(x / 17 + ph[2]) + 0.15 * Math.sin(x / 7 + ph[3])));

  // Skylten på berget, som Hollywoodskylten. Den sitter uppe till vänster där loggan brukar sitta (se signBox i
  // mountScene) men alltid ovanför de gröna kullarna. Varje bokstavspixel blir s × s.
  let signGeo = null;
  if (o.sign && o.mountains) {
    const word = [...o.sign.toUpperCase()].filter((ch) => GLYPH[ch]);
    const s = H >= 90 ? 3 : 2;
    const x0 = sign ? sign.x : 7;
    const w = word.reduce((n, ch) => n + (GLYPH[ch][0].length + 1) * s, -s);
    let hillMin = Infinity;
    for (let x = x0 - 2; x < x0 + w + 2; x++) hillMin = Math.min(hillMin, hillTop(x));
    const want = sign ? (sign.center ? sign.y - Math.round((5 * s) / 2) : sign.y) : 6;
    signGeo = { word, s, x0, x1: x0 + w - 1, y: Math.max(4, Math.min(want, hillMin - 5 * s - 3)) };
  }
  // Under skylten reser sig berget till en kulle, så att bokstäverna står på bergssidan i stället för i luften.
  const TAPER = 18;
  const ridgeTop = (x) => {
    if (!signGeo) return Infinity;
    const d = x < signGeo.x0 - 4 ? signGeo.x0 - 4 - x : x > signGeo.x1 + 4 ? x - signGeo.x1 - 4 : 0;
    if (d >= TAPER) return Infinity;
    const top = signGeo.y - 3;
    return top + Math.round(((base - top) * (1 - Math.cos((Math.PI * d) / TAPER))) / 2);
  };
  if (o.mountains) {
    for (let x = 0; x < W; x++) {
      const natural = base - Math.round(amp * (0.55 + 0.3 * Math.sin(x / 23 + ph[0]) + 0.15 * Math.sin(x / 9 + ph[1])));
      const top = Math.min(natural, ridgeTop(x)), h = base - top;
      col(x, top, base + 1, "#c9d0f2");
      px(x, top, "#8f9bd0");
      // Ingen snö på kullen med skylten, så att de vita bokstäverna syns.
      if (h > amp * 0.78 && natural <= ridgeTop(x)) { col(x, top + 1, top + 3, "#ffffff"); px(x, top + 3, "#e6e9fa"); }
    }
  }

  for (let x = 0; x < W; x++) { const t = hillTop(x); col(x, t, gt + 1, "#c8ead9"); px(x, t, "#7fc4a6"); }

  const trees = [];
  if (o.trees) {
    for (let x = 6 + Math.floor(rand() * 10); x < W - 4; x += 14 + Math.floor(rand() * 16)) {
      const base = hillTop(x) + 2;
      trees.push({ x, y: base - 7 });
      if (rand() < 0.4) {
        // Gran: trappsteg av gröna rader.
        for (let j = 0; j < 9; j++) {
          const half = Math.floor(j / 2) + 1;
          for (let i = -half; i <= half; i++) px(x + i, base - 10 + j, Math.abs(i) === half ? "#2f6b3a" : "#58a95c");
        }
        col(x, base - 1, base + 1, "#8a5a3b");
      } else {
        const r = 3 + Math.floor(rand() * 2), cy = base - r - 2;
        for (let y = -r; y <= r; y++) for (let i = -r; i <= r; i++) {
          const d = i * i + y * y;
          if (d > r * r + 1) continue;
          const edge = d > (r - 1) * (r - 1) + 1;
          px(x + i, cy + y, edge ? "#2f6b3a" : (i < 0 && y < 0 ? "#9ad89a" : "#6fbf73"));
        }
        col(x, cy + r, base + 1, "#8a5a3b");
      }
    }
  }

  // Skylten ritas efter träden, så att de står bakom bokstäverna och inte tvärtom.
  if (signGeo) {
    const { word, s, y } = signGeo;
    const lit = [], letters = [];
    let x = signGeo.x0;
    for (const ch of word) {
      const gw = GLYPH[ch][0].length;
      GLYPH[ch].forEach((row, dy) => [...row].forEach((c, dx) => { if (c === "#") lit.push([x + dx * s, y + dy * s]); }));
      letters.push([x, gw * s]);
      x += (gw + 1) * s;
    }
    // Ben som håller bokstäverna och går ner i berget.
    g.fillStyle = "#4b5080";
    for (const [lx, lw] of letters) { g.fillRect(lx + 1, y + 5 * s, 1, 3); g.fillRect(lx + lw - 2, y + 5 * s, 1, 3); }
    // Skugga på bergssidan, mörk kontur och vita bokstäver.
    g.fillStyle = "#9ea8dc";
    for (const [lx, ly] of lit) g.fillRect(lx + 2, ly + 2, s, s);
    g.fillStyle = "#1b1b2f";
    for (const [lx, ly] of lit) g.fillRect(lx - 1, ly - 1, s + 2, s + 2);
    g.fillStyle = "#ffffff";
    for (const [lx, ly] of lit) g.fillRect(lx, ly, s, s);
    signGeo.lit = lit;
  }

  // Marken med lite pixelbrus.
  g.fillStyle = "#9bd67f"; g.fillRect(0, gt, W, H - gt);
  g.fillStyle = "#5fae55"; g.fillRect(0, gt, W, 1);
  for (let i = 0; i < W * (H - gt) * 0.05; i++) px(Math.floor(rand() * W), gt + 2 + Math.floor(rand() * (H - gt - 2)), "#86c86d");

  if (o.pond && W > 160) {
    const cx = Math.round(W * 0.78), cy = gt + 5, rx = 12, ry = 3;
    for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) {
      const d = (x * x) / (rx * rx) + (y * y) / (ry * ry);
      if (d > 1) continue;
      px(cx + x, cy + y, d > 0.65 ? "#5b9be0" : "#8ec5ff");
    }
  }

  if (o.path) {
    const top = H - 14;
    g.fillStyle = "#f0d9a8"; g.fillRect(0, top, W, 5);
    g.fillStyle = "#d9b97a"; g.fillRect(0, top, W, 1); g.fillRect(0, top + 5, W, 1);
    for (let i = 0; i < W / 6; i++) px(Math.floor(rand() * W), top + 1 + Math.floor(rand() * 4), "#e2c68e");
  }

  // Platser där detaljer inte får hamna: dammen, butiken och varelsens grästuva.
  const busy = [];
  if (o.pond && W > 160) busy.push([Math.round(W * 0.78) - 15, Math.round(W * 0.78) + 15]);
  if (o.shop && W > 200) busy.push([Math.round(W * 0.88) - 16, Math.round(W * 0.88) + 16]);
  if (o.blob) busy.push([Math.round(W * (W > 200 ? 0.62 : 0.36)) - 12, Math.round(W * (W > 200 ? 0.62 : 0.36)) + 12]);
  const free = (a, b) => busy.every(([x0, x1]) => b < x0 || a > x1);

  // Buskar med bär vid foten av kullarna.
  for (let i = 0; i < W / 40; i++) {
    const x = Math.floor(rand() * (W - 8)) + 2;
    if (!free(x - 3, x + 3)) continue;
    const y = gt;
    for (let dy = -3; dy <= 0; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (dx * dx + (dy + 1) * (dy + 1) * 2 > 10) continue;
      px(x + dx, y + dy, Math.abs(dx) === 3 || dy === -3 ? "#2f6b3a" : "#58a95c");
    }
    px(x - 1, y - 1, "#e4572e"); px(x + 2, y - 2, "#e4572e"); px(x, y - 2, "#9ad89a");
  }

  // Stenar i gräset.
  for (let i = 0; i < W / 55; i++) {
    const x = Math.floor(rand() * (W - 6)), y = gt + 3 + Math.floor(rand() * Math.max(1, (o.path ? H - 17 : H - 3) - gt - 3));
    if (!free(x - 2, x + 5)) continue;
    g.fillStyle = "#7d8496"; g.fillRect(x, y, 4, 2); g.fillRect(x + 1, y - 1, 2, 1);
    g.fillStyle = "#c7ccd8"; g.fillRect(x + 1, y - 1, 1, 1); g.fillRect(x + 1, y, 1, 1);
  }

  if (o.path) {
    const pathTop = H - 14;
    // Vägskylt som pekar mot butiken.
    const sx = o.shop && W > 200 ? Math.round(W * 0.88) - 30 : -100;
    if (sx > 0) {
      busy.push([sx - 4, sx + 10]);
      g.fillStyle = "#6b4325"; g.fillRect(sx + 4, pathTop - 10, 2, 10);
      g.fillStyle = "#6b4325"; g.fillRect(sx - 1, pathTop - 15, 13, 7);
      g.fillStyle = "#e2b77a"; g.fillRect(sx, pathTop - 14, 11, 5);
      g.fillStyle = "#fffaf0"; g.fillRect(sx + 2, pathTop - 12, 6, 1); g.fillRect(sx + 6, pathTop - 13, 1, 3); g.fillRect(sx + 7, pathTop - 12, 1, 1);
    }
    // Trästaket i bitar längs vägkanten.
    for (let x = Math.floor(rand() * 20); x < W - 6;) {
      const len = 12 + Math.floor(rand() * 26);
      if (free(x - 2, x + len + 2)) {
        g.fillStyle = "#b07a4a"; g.fillRect(x, pathTop - 4, len, 1); g.fillRect(x, pathTop - 2, len, 1);
        for (let p = x; p <= x + len; p += 5) {
          g.fillStyle = "#8a5a3b"; g.fillRect(p, pathTop - 5, 1, 5);
          g.fillStyle = "#d9a56a"; g.fillRect(p, pathTop - 5, 1, 1);
        }
      }
      x += len + 14 + Math.floor(rand() * 40);
    }
  }

  // Ninjans kortbutik längs vägen: randig markis, skylt och skyltfönster.
  const shopLamps = [];
  if (o.shop && W > 200) {
    const x0 = Math.round(W * 0.88) - 13, bottom = gt + 10, top = bottom - 15;
    g.fillStyle = "#1b1b2f"; g.fillRect(x0 - 1, top - 8, 28, 24);
    g.fillStyle = "#fffaf0"; g.fillRect(x0, top, 26, 15);
    for (let j = 0; j < 7; j++) { g.fillStyle = "#c2441f"; g.fillRect(x0 - 1 + Math.max(0, 6 - j) * 2, top - 8 + j, 28 - Math.max(0, 6 - j) * 4, 1); }
    g.fillStyle = "#e4572e"; g.fillRect(x0 + 1, top - 6, 24, 5);
    for (let i = 0; i < 26; i += 4) { g.fillStyle = "#fffaf0"; g.fillRect(x0 + i, top - 1, 2, 3); g.fillStyle = "#e4572e"; g.fillRect(x0 + i + 2, top - 1, 2, 3); }
    g.fillStyle = "#f2b632"; g.fillRect(x0 + 7, top + 3, 12, 4);
    g.fillStyle = "#1b1b2f"; for (let i = 0; i < 5; i++) g.fillRect(x0 + 8 + i * 2, top + 4, 1, 2);
    g.fillStyle = "#3b4a6b"; g.fillRect(x0 + 11, top + 8, 5, 7);
    g.fillStyle = "#f2b632"; g.fillRect(x0 + 15, top + 11, 1, 1);
    for (const wx of [x0 + 2, x0 + 19]) {
      g.fillStyle = "#1b1b2f"; g.fillRect(wx - 1, top + 8, 7, 6);
      g.fillStyle = "#8ec5ff"; g.fillRect(wx, top + 9, 5, 4);
      g.fillStyle = "#ffffff"; g.fillRect(wx, top + 9, 1, 2);
      g.fillStyle = "#f2b8a4"; g.fillRect(wx + 2, top + 11, 2, 2);
      // Kvällsljus: fönstrets lampa (se draw i mountScene).
      shopLamps.push({ x: wx + 2, y: top + 11, wx, wy: top + 9 });
    }
  }

  const flowers = ["#e4572e", "#f2b632", "#ffffff", "#b9c3e6"];
  for (let i = 0; i < W / 10; i++) {
    const x = Math.floor(rand() * W), y = gt + 2 + Math.floor(rand() * (H - gt - 3));
    if (o.path && y >= H - 15 && y <= H - 8) continue;
    px(x, y, flowers[i % flowers.length]);
  }
  return { canvas: c, gt, hillTop, trees, sign: signGeo, shopLamps };
}

// Bokstäverna till skylten på berget (5 pixlar höga).
const GLYPH = {
  P: ["###.", "#..#", "###.", "#...", "#..."], A: [".##.", "#..#", "####", "#..#", "#..#"],
  C: [".###", "#...", "#...", "#...", ".###"], K: ["#..#", "#.#.", "##..", "#.#.", "#..#"],
  N: ["#..#", "##.#", "#.##", "#..#", "#..#"], I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..##", "...#", "...#", "#..#", ".##."], L: ["#...", "#...", "#...", "#...", "####"],
  O: [".##.", "#..#", "#..#", "#..#", ".##."], T: ["####", ".#..", ".#..", ".#..", ".#.."],
};

export function mountScene(canvas, opts = {}) {
  const o = { height: 100, ground: 26, mountains: true, trees: true, pond: true, path: true, ninja: true, ninjaDir: 1, blob: true, birds: true, sky: true, seed: 7, ...opts };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W, H, scene, sky, clouds, tufts, birds, stars = [], frame = 0, ninjaX, blobX, timer, events = [], nextEvent = 40, rand;
  const ctx = canvas.getContext("2d");

  // Var skylten på berget ska sitta, i scenens pixlar. Scenen börjar där headern börjar (se heroUnderHeader i home.js).
  // På mobilen ritas scenen ovanpå headern, så skylten tar loggans plats. På dator ligger headern med loggan
  // över scenen, så skylten hamnar under headern i linje med loggan.
  function signBox(scale) {
    const logo = document.querySelector(".site-header .logo"), header = logo?.closest(".site-header");
    if (!logo) return null;
    const l = logo.getBoundingClientRect(), h = header.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    const onTop = getComputedStyle(header).position === "static";
    return {
      x: Math.max(2, Math.round((l.left - c.left) / scale)),
      y: Math.round((onTop ? l.top + l.height / 2 - h.top : h.height + 12) / scale),
      center: onTop,
    };
  }

  function setup() {
    if (!canvas.clientWidth) return;
    const small = innerWidth < 640;
    const scale = (small && o.smallScale) || o.scale || (small ? 3 : 4);
    const pW = W, pH = H, live = ninjaX !== undefined;
    H = small && o.smallHeight ? o.smallHeight : o.height;
    W = Math.ceil(canvas.clientWidth / scale);
    // Byter man bara nattläge (samma storlek) behålls ninjan, fåglarna, molnen och händelserna där de var.
    const same = live && W === pW && H === pH;
    canvas.width = W; canvas.height = H;
    // Exakt heltalsskala på höjden, annars blir pixlarna olika stora.
    canvas.style.height = `${H * scale}px`;
    rand = rng(o.seed);
    scene = buildStatic(W, H, o, rand, o.sign ? signBox(scale) : null);
    sky = o.sky ? buildSky(W, scene.gt + 1, isNight() ? SKY_NIGHT : SKY) : null;
    if (same) { draw(); return; }
    events = [];
    // Stjärnorna får en egen slumpföljd, så att dagscenerna inte ändras.
    const sr = rng(o.seed + 99);
    stars = Array.from({ length: Math.round(W / 5) }, () => ({ x: Math.floor(sr() * W), y: Math.floor(sr() * Math.max(4, scene.gt - 22)), ph: Math.floor(sr() * 23), c: sr() < 0.2 ? "#fff3b0" : "#ffffff" }));
    const skyH = Math.max(scene.gt - 24, 6);
    clouds = Array.from({ length: Math.max(2, Math.round(W / 70)) }, (_, i) => ({
      img: makeCloud(18 + Math.floor(rand() * 18), rand),
      x: (i / Math.max(2, Math.round(W / 70))) * (W + 40) - 20 + rand() * 20,
      y: 2 + Math.floor(rand() * skyH),
      speed: 6 + Math.floor(rand() * 5), // antal bildrutor per pixel: lägre är snabbare
    }));
    tufts = [];
    const lineY = o.path ? H - 6 : H - 5;
    for (let x = 2; x < W - 5; x += 5 + Math.floor(rand() * 9)) if (rand() < 0.55) tufts.push({ x, y: lineY, ph: Math.floor(rand() * 4) });
    // På breda skärmar täcker textpanelen vänster del av landskapet, så varelsen bor till höger.
    blobX = Math.round(W * (W > 200 ? 0.62 : 0.36));
    // En tät grästuva där varelsen gömmer sig.
    const blobLine = o.path ? scene.gt + 9 : H - 4;
    for (let i = -2; i <= 2; i++) tufts.push({ x: blobX + i * 4 - 1, y: blobLine - 3, ph: i & 1, cover: true });
    birds = o.birds ? [{ x: W * 0.2, y: 6 }, { x: W * 0.2 + 8, y: 9 }] : [];
    ninjaX = o.ninjaDir > 0 ? -14 : W + 2;
    draw();
  }
  sceneListeners.add(setup);

  // ---------- Slumpade händelser ----------
  // Varje händelse har en egen livslängd och ritas i rätt lager (himmel eller mark).
  const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const ninjaY = () => H - 14 + 3 - 12;
  function spawn() {
    const types = ["butterfly", "butterfly", "encounter", "star"];
    if (scene.trees.length) types.push("leaf", "leaf");
    if (scene.gt > 40) types.push("balloon");
    if (o.ninja && o.path) types.push("jump", "heart");
    const type = types[ri(0, types.length - 1)];
    const t = { type, age: 0 };
    if (type === "butterfly") Object.assign(t, { x: ri(10, W - 10), base: ri(scene.gt - 6, scene.gt + 6), dir: Math.random() < 0.5 ? -1 : 1, life: 220 });
    if (type === "balloon") Object.assign(t, { x: -8, y: ri(4, Math.max(5, scene.gt - 40)), life: Infinity });
    if (type === "encounter") Object.assign(t, { tuft: tufts.filter((x) => !x.cover)[ri(0, tufts.filter((x) => !x.cover).length - 1)], life: 28 });
    if (type === "leaf") { const tr = scene.trees[ri(0, scene.trees.length - 1)]; Object.assign(t, { x: tr.x, y: tr.y, ground: scene.gt + ri(1, 4), life: 200 }); }
    if (type === "star") Object.assign(t, { x: ri(20, W - 10), y: -5, ground: scene.gt + ri(2, 6), life: 160 });
    if (type === "jump") t.life = 10;
    if (type === "heart") t.life = 24;
    if (t.tuft !== undefined || type !== "encounter") events.push(t);
  }

  function drawEvents(layer) {
    for (const e of events) {
      if (layer === "sky" && e.type === "balloon") {
        drawSprite(ctx, SPRITES.balloon, Math.round(e.x), Math.round(e.y + Math.sin(e.age / 24) * 2));
      }
      if (layer !== "ground") continue;
      if (e.type === "butterfly") {
        const x = Math.round(e.x), y = Math.round(e.base + Math.sin(e.age / 7) * 4);
        drawSprite(ctx, Math.floor(e.age / 2) % 2 ? SPRITES.flyA : SPRITES.flyB, x, y);
      }
      if (e.type === "leaf") drawSprite(ctx, SPRITES.leaf, Math.round(e.x + Math.sin(e.age / 6) * 2), Math.round(e.y));
      if (e.type === "star") {
        if (e.y < e.ground) {
          drawSprite(ctx, SPRITES.star, Math.round(e.x) - 2, Math.round(e.y) - 2);
          ctx.fillStyle = "#fff6c9"; ctx.fillRect(Math.round(e.x) + 3, Math.round(e.y) - 4, 1, 1); ctx.fillRect(Math.round(e.x) + 5, Math.round(e.y) - 7, 1, 1);
        } else if (e.age % 6 < 3) drawSprite(ctx, SPRITES.burst, Math.round(e.x) - 2, Math.round(e.ground) - 4);
      }
      if (e.type === "encounter" && e.tuft) drawSprite(ctx, SPRITES.alert, e.tuft.x, e.tuft.y - 9 - (e.age < 4 ? 4 - e.age : 0));
      if (e.type === "heart") drawSprite(ctx, SPRITES.heart, Math.round(ninjaX) + 4, ninjaY() - 6 - Math.floor(e.age / 4));
    }
  }

  function updateEvents() {
    for (const e of events) {
      e.age++;
      if (e.type === "butterfly") e.x += e.dir * 0.3;
      if (e.type === "balloon") { e.x += 0.12; if (e.x > W + 10) e.life = 0; }
      if (e.type === "leaf" && e.y < e.ground && e.age % 2 === 0) e.y += 1;
      if (e.type === "star" && e.y < e.ground) { e.y += 0.8; e.x -= 0.4; if (e.y >= e.ground) e.age = 0, e.life = 18; }
    }
    events = events.filter((e) => e.age < e.life);
    if (frame >= nextEvent && events.length < 4) { spawn(); nextEvent = frame + ri(32, 80); }
  }

  function draw() {
    const night = isNight();
    ctx.clearRect(0, 0, W, H);
    if (sky) ctx.drawImage(sky, 0, 0);
    if (night) {
      // Stjärnorna blinkar var för sig, och månen står i övre vänstra hörnet.
      for (const s of stars) if ((frame + s.ph) % 23 < 18) { ctx.fillStyle = s.c; ctx.fillRect(s.x, s.y, 1, 1); }
      const mx = Math.round(W * 0.14);
      MOON.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === "y") { ctx.fillStyle = "#fff6c9"; ctx.fillRect(mx + i, 3 + j, 1, 1); } }));
    }
    for (const c of clouds) ctx.drawImage(c.img, Math.round(c.x), c.y);
    drawEvents("sky");
    for (const b of birds) drawSprite(ctx, Math.floor(frame / 3) % 2 ? SPRITES.birdA : SPRITES.birdB, Math.round(b.x), b.y);
    ctx.drawImage(scene.canvas, 0, 0);

    if (o.pond && W > 160) {
      const cx = Math.round(W * 0.78), cy = scene.gt + 5;
      ctx.fillStyle = "#ffffff";
      [[-6, -1], [3, 0], [7, -1], [-2, 1]].forEach(([dx, dy], i) => { if ((frame + i * 5) % 16 < 8) ctx.fillRect(cx + dx, cy + dy, 2, 1); });
    }

    if (o.blob) {
      // Varelsen tittar upp ungefär var femtonde sekund, långsamt.
      const line = o.path ? scene.gt + 9 : H - 4;
      const c = frame % 120;
      const rise = c < 12 ? Math.floor(c / 2) : c < 60 ? 6 : c < 72 ? 6 - Math.floor((c - 60) / 2) : 0;
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, line - 1); ctx.clip();
      drawSprite(ctx, c >= 34 && c < 37 ? SPRITES.blobBlink : SPRITES.blob, blobX - 4, line - 1 - rise);
      ctx.restore();
    }

    for (const t of tufts) {
      const shaking = events.some((e) => e.type === "encounter" && e.tuft === t);
      const dx = shaking ? (frame % 2 ? 1 : -1) : 0;
      drawSprite(ctx, (Math.floor(frame / 6) + t.ph) % 2 ? SPRITES.tuftA : SPRITES.tuftB, t.x + dx, t.y);
    }

    drawEvents("ground");

    let torch = null;
    if (o.ninja && o.path) {
      const jump = events.find((e) => e.type === "jump");
      const hop = jump ? [0, 2, 4, 5, 6, 6, 5, 4, 2, 0][jump.age] || 0 : 0;
      const y = ninjaY() - hop;
      const flip = o.ninjaDir < 0;
      drawSprite(ctx, Math.floor(frame / 3) % 2 ? SPRITES.ninjaA : SPRITES.ninjaB, Math.round(ninjaX), y, flip);
      const sx = flip ? Math.round(ninjaX) - 2 : Math.round(ninjaX) + 11;
      drawSprite(ctx, Math.floor(frame / 5) % 2 ? SPRITES.sparkA : SPRITES.sparkB, sx, y + 6);
      // Facklan bärs i handen. Den ritas efter nattljuset, så att lågan syns klart.
      if (night) torch = { x: flip ? Math.round(ninjaX) - 2 : Math.round(ninjaX) + 12, y: y + 2 };
    }

    if (night) {
      // Nattljus: en blå multiplicering över hela scenen, så att dagens färger blir mörka och mjuka.
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = "#8f97cf";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
      // Butikens fönster lyser inifrån, med ett svagt ljusskenet ut över gatan.
      for (const { x, y, wx, wy } of scene.shopLamps || []) {
        const gr = ctx.createRadialGradient(x, y, 0, x, y, 11);
        gr.addColorStop(0, "rgba(255,210,140,.22)"); gr.addColorStop(1, "rgba(255,210,140,0)");
        ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = gr; ctx.fillRect(x - 11, y - 11, 22, 22); ctx.restore();
        ctx.fillStyle = "#fff0c0"; ctx.fillRect(wx, wy, 5, 4);
      }
      // Skylten på berget är upplyst på natten: strålkastare underifrån och varmvita bokstäver ovanpå nattljuset.
      if (scene.sign?.lit) {
        const { lit, s, x0, x1, y } = scene.sign;
        const beam = ctx.createLinearGradient(0, y + 5 * s + 3, 0, y - 4);
        beam.addColorStop(0, "rgba(255,214,140,.38)");
        beam.addColorStop(1, "rgba(255,214,140,0)");
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = beam;
        ctx.fillRect(x0 - 3, y - 4, x1 - x0 + 7, 5 * s + 7);
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "#14142a";
        for (const [lx, ly] of lit) ctx.fillRect(lx - 1, ly - 1, s + 2, s + 2);
        ctx.fillStyle = "#fff4cf";
        for (const [lx, ly] of lit) ctx.fillRect(lx, ly, s, s);
      }
    }
    if (torch) {
      const { x: tx, y: ty } = torch;
      // Ljusskenet runt facklan, som flimrar med lågan.
      const glow = ctx.createRadialGradient(tx, ty, 0, tx, ty, 12);
      glow.addColorStop(0, `rgba(255,190,90,${frame % 2 ? 0.55 : 0.45})`);
      glow.addColorStop(1, "rgba(255,190,90,0)");
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = glow;
      ctx.fillRect(tx - 12, ty - 12, 24, 24);
      ctx.globalCompositeOperation = "source-over";
      // Skaftet och lågan, som flaxar mellan två bilder.
      ctx.fillStyle = "#6b4325"; ctx.fillRect(tx, ty, 1, 4);
      ctx.fillStyle = "#ff8a3d"; ctx.fillRect(tx - 1, ty - 2, 3, 2);
      ctx.fillStyle = "#ffd34d"; ctx.fillRect(tx, ty - 3 - (frame % 2), 1, 2);
    }
  }

  function tick() {
    if (!scene) return;
    frame++;
    for (const c of clouds) if (frame % c.speed === 0) { c.x -= 1; if (c.x < -c.img.width) c.x = W + 4; }
    for (const b of birds) { b.x += 0.2; if (b.x > W + 10) b.x = -10; }
    if (o.ninja) {
      // En pixel varannan bildruta: lugn promenad.
      ninjaX += o.ninjaDir * 0.5;
      if (ninjaX > W + 14) ninjaX = -14;
      if (ninjaX < -14) ninjaX = W + 2;
    }
    if (o.events !== false) updateEvents();
    draw();
  }

  // Rita om när bredden ändras, även när sidan först laddats i en dold flik med bredden 0.
  let rt, lastW = -1;
  new ResizeObserver(() => {
    const w = canvas.clientWidth;
    if (!w || w === lastW) return;
    lastW = w;
    clearTimeout(rt); rt = setTimeout(setup, W ? 150 : 0);
  }).observe(canvas);
  if (!reduce) {
    // 8 bilder per sekund ger den hackiga 8-bitarskänslan. Pausa när fliken inte syns.
    const start = () => { clearInterval(timer); timer = setInterval(tick, 167); };
    document.addEventListener("visibilitychange", () => (document.hidden ? clearInterval(timer) : start()));
    start();
  }
}

const ICONS = {
  home: ["....kk....", "...krrk...", "..krrrrk..", ".krrrrrrk.", "kkkkkkkkkk", ".kwwwwwwk.", ".kwbwwbwk.", ".kwwkkwwk.", ".kwwkkwwk.", ".kkkkkkkk."],
  calendar: ["kkkkkkkkkk", "krrrrrrrrk", "kkkkkkkkkk", "kwwwwwwwwk", "kwkwkwkwwk", "kwwwwwwwwk", "kwkwkwkwwk", "kwwwwwwwwk", "kwkwkrrwwk", "kkkkkkkkkk"],
  coin: ["...kkkk...", "..kyyyyk..", ".kyywyyyk.", ".kywyyyyk.", ".kywyyyyk.", ".kywyyyyk.", ".kyyyyyyk.", ".kyyyyyyk.", "..kyyyyk..", "...kkkk..."],
  news: ["kkkkkkkk..", "kwwwwwwkk.", "kwrrrrwkwk", "kwrrrrwkwk", "kwwwwwwkwk", "kwkkkkwkwk", "kwwwwwwkwk", "kwkkkkwkwk", "kwwwwwwkkk", "kkkkkkkkk."],
  card: [".kkkkkkk..", ".kwwwwwk..", ".kmmmmmk..", ".kmmymmk..", ".kmyyymk..", ".kmmymmk..", ".kwwwwwk..", ".kwkkkwk..", ".kwwwwwk..", ".kkkkkkk.."],
  info: ["..kkkkkk..", ".kbbbbbbk.", "kbbbwwbbbk", "kbbbbbbbbk", "kbbbwwbbbk", "kbbbwwbbbk", "kbbbwwbbbk", "kbbbwwbbbk", ".kbbbbbbk.", "..kkkkkk.."],
  search: ["..kkkk....", ".kwwwwk...", "kwbwwwwk..", "kwwwwwwk..", "kwwwwwwk..", ".kwwwwk...", "..kkkkkk..", "......kkk.", ".......kkk", "........kk"],
  camera: ["..........", "..kkk.....", ".kkkkkkkk.", "knnnkkknnk", "knnkbbkrnk", "knkbwbbknk", "knkbbbbknk", "knnkbbknnk", "knnnkknnnk", ".kkkkkkkk."],
  bell: ["....kk....", "...kyyk...", "..kyywyk..", "..kyywyk..", "..kyyyyk..", ".kyyyyyyk.", "kyyyyyyyyk", "kkkkkkkkkk", "....kk....", ".........."],
  phone: ["..kkkkkk..", "..kwwwwk..", "..kbbbbk..", "..kbwbbk..", "..kbbbbk..", "..kbbbbk..", "..kbbbbk..", "..kwwwwk..", "..kwkkwk..", "..kkkkkk.."],
  shop: ["..kkkkkk..", ".k......k.", "kkkkkkkkkk", "krwrwrwrwk", "kkkkkkkkkk", ".kwwwwwwk.", ".kwkkwwwk.", ".kwkkwbwk.", ".kwkkwwwk.", ".kkkkkkkk."],
};

export function icon(name, size = 22) {
  const rows = ICONS[name];
  if (!rows) return "";
  let rects = "";
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (c !== ".") rects += `<rect x="${x}" y="${y}" width="1.05" height="1.05" fill="${PAL[c]}"/>`; }));
  return `<svg class="px-icon" viewBox="0 0 ${rows[0].length} ${rows.length}" width="${size}" height="${size}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

export function mountAllScenes() {
  const presets = {
    // Startsidans landskap: hela scenen i dubbel skala, så att den blir hälften så hög som förut.
    hero: { height: 112, smallHeight: 58, scale: 2, ground: 26, seed: 7, shop: true, sign: "LOOTNINJA" },
    // Remsan under sidrubrikerna: lägre och i mindre skala, så att sidhuvudet inte tar halva skärmen.
    strip: { height: 30, smallHeight: 24, ground: 9, scale: 2, mountains: false, pond: false, path: false, ninja: false, seed: 21 },
    footer: { height: 52, ground: 22, mountains: false, pond: true, ninjaDir: -1, seed: 3 },
  };
  document.querySelectorAll("canvas[data-scene]").forEach((c) => mountScene(c, presets[c.dataset.scene] || {}));
}
