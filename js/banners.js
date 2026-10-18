// Egna pixelbanderoller under sidrubrikerna: varje sida har sin egen miljö.
// Allt ritas i kod i samma 8-bitarsstil som landskapen. Bakgrunden ritas en gång,
// och bara de rörliga detaljerna (bil, folk, löpband, nyhetsrad ...) ritas om, 8 gånger i sekunden.
import { PAL, SPRITES, rng, makeCloud, buildSky } from "./pixel.js";

const SCALE = 2; // varje pixel blir 2 × 2 skärmpixlar
const H = 32; // banderollens höjd i pixlar, alltså 64 px på skärmen

// ---------- Ritverktyg ----------
const R = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
function box(g, x, y, w, h, fill, line = "#1b1b2f") {
  R(g, x, y, w, h, line);
  if (fill) R(g, x + 1, y + 1, w - 2, h - 2, fill);
}
function spr(g, rows, x, y, pal = PAL, flip = false) {
  x = Math.round(x); y = Math.round(y);
  rows.forEach((row, j) => [...row].forEach((_, i) => {
    const ch = row[flip ? row.length - 1 - i : i];
    if (ch !== "." && pal[ch]) R(g, x + i, y + j, 1, 1, pal[ch]);
  }));
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

// Typsnitt 3 × 5 pixlar för korta skyltar.
const FONT = {
  A: [".#.", "#.#", "###", "#.#", "#.#"], B: ["##.", "#.#", "##.", "#.#", "##."], C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."], E: ["###", "#..", "##.", "#..", "###"], F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"], H: ["#.#", "#.#", "###", "#.#", "#.#"], I: ["###", ".#.", ".#.", ".#.", "###"],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"], L: ["#..", "#..", "#..", "#..", "###"], M: ["#.#", "###", "###", "#.#", "#.#"],
  N: ["##.", "#.#", "#.#", "#.#", "#.#"], O: [".#.", "#.#", "#.#", "#.#", ".#."], P: ["##.", "#.#", "##.", "#..", "#.."],
  R: ["##.", "#.#", "##.", "#.#", "#.#"], S: [".##", "#..", ".#.", "..#", "##."], T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"], V: ["#.#", "#.#", "#.#", "#.#", ".#."], W: ["#.#", "#.#", "###", "###", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."], X: ["#.#", "#.#", ".#.", "#.#", "#.#"], J: ["..#", "..#", "..#", "#.#", ".#."],
  Q: [".#.", "#.#", "#.#", "##.", ".##"], Z: ["###", "..#", ".#.", "#..", "###"], 0: ["###", "#.#", "#.#", "#.#", "###"], 1: [".#.", "##.", ".#.", ".#.", "###"],
  2: ["##.", "..#", ".#.", "#..", "###"], 3: ["##.", "..#", ".#.", "..#", "##."], 4: ["#.#", "#.#", "###", "..#", "..#"],
  5: ["###", "#..", "##.", "..#", "##."], 6: [".##", "#..", "###", "#.#", "###"], 7: ["###", "..#", ".#.", ".#.", ".#."],
  8: ["###", "#.#", "###", "#.#", "###"], 9: ["###", "#.#", "###", "..#", "##."], "-": ["...", "...", "###", "...", "..."],
  "!": [".#.", ".#.", ".#.", "...", ".#."], "+": ["...", ".#.", "###", ".#.", "..."], ".": ["...", "...", "...", "...", ".#."], "%": ["#.#", "..#", ".#.", "#..", "#.#"], "/": ["..#", "..#", ".#.", "#..", "#.."], " ": ["...", "...", "...", "...", "..."],
};
const textW = (s) => s.length * 4 - 1;
function text(g, s, x, y, c) {
  [...s.toUpperCase()].forEach((ch, k) => (FONT[ch] || FONT[" "]).forEach((row, j) => [...row].forEach((p, i) => {
    if (p === "#") R(g, x + k * 4 + i, y + j, 1, 1, c);
  })));
}

// Små människor, 4 × 8 pixlar. Två bilder för att gå.
const PERSON = [
  [".hh.", "hssh", ".ss.", "cccc", "cccc", ".cc.", ".nn.", "n..n"],
  [".hh.", "hssh", ".ss.", "cccc", "cccc", ".cc.", ".nn.", ".nn."],
];
const HAIR = ["#1b1b2f", "#8a5a3b", "#f2b632", "#e4572e", "#5c6273"];
const SHIRT = ["#e4572e", "#5b9be0", "#6cc06a", "#f95587", "#f2b632", "#8a6cd1", "#3b4a6b", "#9bd1c0"];
const PANTS = ["#3b4a6b", "#1b1b2f", "#5c6273", "#8a5a3b"];
const look = (rand) => ({ h: pick(rand, HAIR), s: "#f7e3c3", c: pick(rand, SHIRT), n: pick(rand, PANTS) });
const person = (g, x, y, lk, step = 1, flip = false) => spr(g, PERSON[step], x, y, lk, flip);

function clouds(g, W, rand, maxY = 6) {
  for (let i = 0; i < Math.max(2, Math.round(W / 90)); i++) {
    const c = makeCloud(14 + Math.floor(rand() * 12), rand);
    g.drawImage(c, Math.round((i + rand() * 0.6) * (W / Math.max(2, Math.round(W / 90)))), Math.floor(rand() * maxY));
  }
}
function street(g, W, top) {
  R(g, 0, top, W, 3, "#d9dee7"); R(g, 0, top, W, 1, "#eef1f6");
  for (let x = 3; x < W; x += 9) R(g, x, top + 1, 1, 2, "#c4cad6");
  R(g, 0, top + 3, W, 1, "#9aa3b5");
  R(g, 0, top + 4, W, H - top - 4, "#4a4f5e");
  for (let x = 2; x < W; x += 10) R(g, x, top + 6, 5, 1, "#f2e6b8");
}
// Bil, 14 × 6 pixlar, med framlykta (y) åt höger.
const CAR = ["....kkkkkk....", "...kbiibiibk..", ".kkbbbbbbbbbk.", "kbbbbbbbbbbbyk", "kkkkkkkkkkkkkk", "..kak....kak.."];
const car = (g, x, y, body, flip = false) => spr(g, CAR, x, y, { k: "#1b1b2f", b: body, i: "#bfe6ff", a: "#9aa3b5", y: "#f2e6b8" }, flip);

// ---------- Teman ----------
const THEMES = {
  // Släpp: släppdag utanför butiken. Kön ringlar sig, bilen kommer med nya kartonger.
  slapp: {
    seed: 11,
    build(g, W, rand) {
      g.drawImage(buildSky(W, 24), 0, 0);
      clouds(g, W, rand);
      // Avlägsna hus
      for (let x = 0; x < W;) {
        const w = 8 + Math.floor(rand() * 12), h = 5 + Math.floor(rand() * 8);
        R(g, x, 24 - h, w, h, "#c3d3ec");
        for (let wy = 26 - h; wy < 22; wy += 3) for (let wx = x + 2; wx < x + w - 2; wx += 3) R(g, wx, wy, 1, 1, "#e3ecf9");
        x += w + 1 + Math.floor(rand() * 4);
      }
      street(g, W, 24);
      // Butiken med skylten "NYTT SET"
      const sw = Math.max(40, Math.min(56, Math.round(W * 0.3))), sx = Math.min(W - sw - 4, Math.round(W * 0.6));
      R(g, sx - 2, 4, sw + 4, 2, "#e4572e"); R(g, sx - 2, 4, sw + 4, 1, "#1b1b2f");
      box(g, sx, 6, sw, 18, "#f7e3c3");
      box(g, sx + 3, 7, sw - 6, 7, "#fffaf0");
      text(g, "NYTT SET", sx + Math.round((sw - textW("NYTT SET")) / 2), 8, "#e4572e");
      for (let x = sx - 1, i = 0; x < sx + sw + 1; x += 3, i++) { R(g, x, 14, 3, 2, i % 2 ? "#fffaf0" : "#e4572e"); if (i % 2 === 0) R(g, x + 1, 16, 1, 1, "#e4572e"); }
      box(g, sx + 3, 17, sw - 15, 7, "#bfe6ff");
      for (let x = sx + 5; x < sx + sw - 15; x += 5) box(g, x, 19, 4, 4, pick(rand, ["#f2b632", "#5b9be0", "#e4572e", "#8a6cd1"]));
      box(g, sx + sw - 10, 16, 7, 8, "#8a5a3b"); R(g, sx + sw - 5, 20, 1, 1, "#f2b632");
      spr(g, SPRITES.balloon, sx + sw + 1, 2);
      // Kalendertavla med ett inringat datum
      if (W > 200) {
        const cx = Math.round(W * 0.1);
        R(g, cx + 3, 15, 1, 9, "#5c6273"); R(g, cx + 12, 15, 1, 9, "#5c6273");
        box(g, cx, 3, 16, 13, "#fffaf0"); R(g, cx + 1, 4, 14, 3, "#e4572e");
        for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) R(g, cx + 2 + i * 3, 8 + j * 2, 2, 1, "#9aa3b5");
        R(g, cx + 7, 9, 4, 3, "#e4572e"); R(g, cx + 8, 10, 2, 1, "#fffaf0");
      }
      // Kön till dörren
      const queue = [];
      for (let x = sx - 6, i = 0; x > (W > 200 ? Math.round(W * 0.1) + 18 : 2) && i < 10; x -= 6, i++) queue.push({ x, lk: look(rand) });
      return { queue, sx, sw };
    },
    frame(g, W, f, st) {
      st.queue.forEach((p, i) => person(g, p.x, (f + i * 7) % 48 < 3 ? 15 : 16, p.lk));
      // Konfetti över skylten
      const conf = ["#e4572e", "#f2b632", "#5b9be0", "#6cc06a", "#f95587"];
      for (let k = 0; k < 9; k++) {
        const y = (f * 0.6 + k * 5) % 14;
        R(g, st.sx + ((k * 13 + Math.floor(f / 6)) % st.sw), y - 4 + 4, 1, 1, conf[k % conf.length]);
      }
      // Leveransbilen med nya kartonger
      const x = ((f * 1.5) % (W + 60)) - 30;
      R(g, x, 20, 18, 8, "#1b1b2f"); R(g, x + 1, 21, 16, 6, "#fffaf0"); R(g, x + 1, 25, 16, 1, "#e4572e");
      text(g, "KORT", x + 2, 21, "#e4572e");
      R(g, x + 18, 22, 6, 6, "#1b1b2f"); R(g, x + 18, 23, 5, 4, "#5b9be0"); R(g, x + 20, 23, 3, 2, "#bfe6ff");
      const wob = Math.floor(f / 2) % 2;
      R(g, x + 3, 28, 3, 3, "#1b1b2f"); R(g, x + 4 + wob, 29, 1, 1, "#9aa3b5");
      R(g, x + 18, 28, 3, 3, "#1b1b2f"); R(g, x + 19 + wob, 29, 1, 1, "#9aa3b5");
    },
  },

  // Butiker: en gata full av kortbutiker. Folk promenerar och bilar kör förbi.
  stad: {
    seed: 23,
    build(g, W, rand) {
      g.drawImage(buildSky(W, 24), 0, 0);
      clouds(g, W, rand, 4);
      for (let x = 0; x < W;) {
        const w = 7 + Math.floor(rand() * 12), h = 8 + Math.floor(rand() * 10);
        R(g, x, 22 - h, w, h, "#b9c7e3");
        for (let wy = 24 - h; wy < 20; wy += 3) for (let wx = x + 2; wx < x + w - 1; wx += 3) R(g, wx, wy, 1, 1, "#d7e2f5");
        x += w + Math.floor(rand() * 3);
      }
      const walls = ["#c9634a", "#5fa8a0", "#f2c75c", "#9a8fd1", "#9bd1c0", "#f2b8a4", "#8ec5ff"];
      const awn = ["#e4572e", "#3b4a6b", "#6cc06a", "#8a6cd1", "#f95587", "#5b9be0"];
      const words = ["KORT", "TCG", "SHOP", "SPEL", "CARDS", "SAMLA", "PACKS", "BOXAR", "PROMO"];
      for (let x = 1; x < W;) {
        const w = 30 + Math.floor(rand() * 10), top = Math.floor(rand() * 7), wall = pick(rand, walls), aw = pick(rand, awn);
        box(g, x, top, w, 24 - top, wall);
        R(g, x - 1, top, w + 2, 2, "#1b1b2f");
        for (let wy = top + 3; wy < 8; wy += 3) for (let wx = x + 3; wx < x + w - 4; wx += 5) {
          R(g, wx - 1, wy - 1, 5, 4, "#1b1b2f"); R(g, wx, wy, 3, 2, rand() < 0.35 ? "#f2d36b" : "#7fa7d9");
        }
        const fits = words.filter((s) => textW(s) <= w - 6);
        const word = fits[Math.floor(rand() * fits.length)] || "TCG";
        box(g, x + 2, 9, w - 4, 7, "#fffaf0");
        text(g, word, x + Math.round((w - textW(word)) / 2), 10, aw);
        for (let ax = x, i = 0; ax < x + w; ax += 2, i++) R(g, ax, 16, 2, 2, i % 2 ? "#fffaf0" : aw);
        box(g, x + 2, 18, w - 10, 6, "#bfe6ff");
        for (let cx = x + 4; cx < x + w - 10; cx += 4) { R(g, cx, 20, 2, 3, pick(rand, ["#f2b632", "#e4572e", "#5b9be0", "#6cc06a"])); R(g, cx, 20, 2, 1, "#f2d36b"); }
        box(g, x + w - 7, 18, 5, 6, "#8a5a3b");
        x += w;
        // Luft mellan husen: antingen ett träd, en gatlykta eller en tom gräsplätt.
        const gap = 7 + Math.floor(rand() * 6);
        const gx = x + Math.floor(gap / 2);
        const kind = rand();
        if (kind < 0.4) { R(g, gx - 1, 13, 1, 11, "#8a5a3b"); spr(g, SPRITES.leaf, gx - 3, 4); R(g, gx - 2, 6, 5, 6, "#3f8f3f"); R(g, gx - 1, 4, 3, 2, "#6cc06a"); }
        else if (kind < 0.7) { R(g, gx, 10, 1, 14, "#3b4a6b"); R(g, gx - 1, 9, 3, 1, "#3b4a6b"); R(g, gx - 1, 10, 3, 1, "#ffe9a6"); }
        else { R(g, gx - 2, 20, 5, 2, "#6cc06a"); R(g, gx, 19, 1, 1, "#f2d36b"); }
        x += gap;
      }
      street(g, W, 24);
      const walkers = Array.from({ length: Math.max(3, Math.round(W / 60)) }, (_, i) => ({ x: rand() * W, dir: i % 2 ? 1 : -1, lk: look(rand), v: 0.35 + rand() * 0.3 }));
      return { walkers };
    },
    frame(g, W, f, st) {
      for (const p of st.walkers) {
        const x = (((p.x + p.dir * p.v * f) % (W + 8)) + W + 8) % (W + 8) - 4;
        person(g, x, 18, p.lk, Math.floor(f / 3) % 2, p.dir < 0);
      }
      car(g, ((f * 1.3) % (W + 40)) - 20, 26, "#e4572e");
      car(g, W - (((f * 0.9) + W / 2) % (W + 40)) + 20, 26, "#5b9be0", true);
    },
  },

  // Kortpriser: en kortbörs. Kursgrafer som går upp och ner, en rullande kurstavla och skärmar på disken.
  butik: {
    seed: 37,
    build(g, W, rand) {
      R(g, 0, 0, W, H, "#0f1a2e");
      for (let y = 6; y < 24; y += 4) R(g, 0, y, W, 1, "#16294a");
      // Disken och lådorna under
      R(g, 0, 23, W, 1, "#c08a5c"); R(g, 0, 24, W, 8, "#5a3a26");
      for (let x = 4; x < W; x += 16) { R(g, x, 26, 12, 1, "#3d2818"); R(g, x + 5, 25, 2, 1, "#f2b632"); }
      R(g, 0, 31, W, 1, "#2a1a0e");
      // Kursgrafer: en per panel, med ett slumpmässigt "kursförlopp" som sedan skiftar åt vänster.
      // Tre smala skärmar med tomrum emellan, och fyra personer mellan och vid sidorna.
      const centers = [0.2, 0.5, 0.8];
      const charts = centers.map((p) => {
        const w = Math.round(W * 0.2), x = Math.round(W * p) - Math.floor(w / 2), iw = w - 2;
        let v = 0.3 + rand() * 0.4;
        const series = Array.from({ length: iw }, () => (v = Math.min(0.92, Math.max(0.08, v + (rand() - 0.5) * 0.22))));
        return { x, w, series };
      });
      const mons = centers.map((p) => Math.round(W * p) - 5);
      const people = [0.05, 0.35, 0.65, 0.95].map((p) => ({ x: Math.round(W * p) - 2, lk: look(rand) }));
      return { charts, mons, people };
    },
    frame(g, W, f, st) {
      // Kurstavlan: en rullande rad med tickers
      R(g, 0, 0, W, 6, "#0b1322");
      const items = [["KORT", "+4"], ["PIKA", "-2"], ["CHAR", "+12"], ["MEW", "+1"], ["VMAX", "-3"], ["EX", "+7"]];
      const parts = items.map(([name, d]) => ({ name, d }));
      const seg = (p) => textW(p.name) + 1 + textW((p.d.startsWith("-") ? "" : "+") + p.d + "%") + 6;
      const total = parts.reduce((s, p) => s + seg(p), 0);
      let x = -(f % total);
      for (let k = 0; k < 3; k++) for (const p of parts) {
        text(g, p.name, x, 1, "#f7e3c3");
        const val = (p.d.startsWith("-") ? "" : "+") + p.d + "%";
        text(g, val, x + textW(p.name) + 1, 1, p.d.startsWith("-") ? "#e4572e" : "#6cc06a");
        x += seg(p);
      }
      // Rubriken på kurstavlan (ligger över rullningen)
      const lw = textW("KORTBORSEN") + 4;
      R(g, 0, 0, lw + 2, 6, "#1b1b2f"); text(g, "KORTBORSEN", 2, 1, "#f2b632");

      // Kursgraferna skiftar ett steg åt vänster var annan bildruta
      if (f % 2 === 0) for (const c of st.charts) {
        const last = c.series[c.series.length - 1];
        c.series.shift();
        c.series.push(Math.min(0.92, Math.max(0.08, last + (Math.random() - 0.5) * 0.22)));
      }
      for (const c of st.charts) {
        box(g, c.x, 7, c.w, 12, "#0b1322", "#2f5d8f");
        for (let gy = 9; gy < 17; gy += 3) R(g, c.x + 1, gy, c.w - 2, 1, "#1d3a5f");
        const iw = c.w - 2, up = c.series[c.series.length - 1] >= c.series[0];
        const col = up ? "#6cc06a" : "#e4572e";
        let prev = null;
        for (let i = 0; i < iw; i++) {
          const y = 8 + Math.round((1 - c.series[i]) * 9);
          const a = prev == null ? y : prev, lo = Math.min(a, y), hi = Math.max(a, y);
          R(g, c.x + 1 + i, lo, 1, hi - lo + 1, col);
          prev = y;
        }
        // Senaste punkten blinkar
        R(g, c.x + iw, 8 + Math.round((1 - c.series[iw - 1]) * 9) - 1, 2, 2, f % 4 < 2 ? "#ffffff" : col);
      }

      // Skärmarna på disken: staplar som växer och krymper
      st.people.forEach((p, k) => person(g, p.x, 17, p.lk, Math.floor(f / 6 + k) % 2));
      for (let m = 0; m < st.mons.length; m++) {
        const mx = st.mons[m];
        box(g, mx, 18, 10, 5, "#2b5f9e", "#1b1b2f");
        for (let b = 0; b < 4; b++) {
          const bh = 1 + ((f + m * 5 + b * 3) % 5 === 0 ? 1 : (f * (b + 2) + m * 7) % 4);
          R(g, mx + 2 + b * 2, 22 - bh, 1, bh, b % 2 ? "#6cc06a" : "#e4572e");
        }
      }
    },
  },

  // Gradering: ett labb där korten åker på ett löpband, skannas, granskas i mikroskop och kommer ut graderade.
  labb: {
    seed: 51,
    build(g, W, rand) {
      R(g, 0, 0, W, 24, "#dfe4ec");
      for (let x = 15; x < W; x += 16) R(g, x, 4, 1, 20, "#c9d0dc");
      R(g, 0, 13, W, 1, "#c9d0dc");
      R(g, 0, 1, W, 2, "#9aa3b5"); R(g, 0, 1, W, 1, "#b7bfcd");
      for (let x = 8; x < W; x += 20) R(g, x, 0, 2, 4, "#7d8698");
      for (let y = 24; y < 26; y++) for (let x = 0; x < W; x++) R(g, x, y, 1, 1, ((x + y) >> 1) % 2 ? "#f2b632" : "#1b1b2f");
      R(g, 0, 26, W, H - 26, "#5c6273");
      for (let x = 4; x < W; x += 12) R(g, x, 28, 6, 1, "#6b7184");
      const scanX = Math.round(W * 0.3), micX = Math.round(W * 0.55), signX = Math.round(W * 0.78);
      // Skärmar på väggen
      const mons = [Math.round(W * 0.06)];
      if (W > 260) mons.push(Math.round(W * 0.42));
      mons.forEach((mx) => box(g, mx, 4, 16, 10, "#14324a"));
      // Tekniker-ninjan står bakom löpbandet
      spr(g, SPRITES.ninjaA, micX + 17, 11);
      // Mikroskop över bandet: pelare, arm, tub ner mot korten och ett snett okular upptill.
      box(g, micX + 9, 3, 4, 17, "#5c6273"); R(g, micX + 13, 9, 2, 3, "#1b1b2f");
      box(g, micX + 1, 3, 12, 4, "#9aa3b5");
      box(g, micX + 2, 6, 5, 7, "#9aa3b5"); R(g, micX + 3, 7, 1, 5, "#c9d0dc");
      box(g, micX + 3, 12, 3, 2, "#3b4a6b");
      R(g, micX - 1, 1, 3, 3, "#1b1b2f"); R(g, micX + 1, 2, 2, 2, "#1b1b2f"); R(g, micX - 1, 0, 3, 1, "#3b4a6b");
      // Låda med färdiga, graderade fodral längst till höger
      if (W > 300) {
        const bx = W - 30;
        for (let i = 0; i < 5; i++) { box(g, bx + 2 + i * 4, 11 + (i % 2), 4, 6, "#e8f2ff", "#9aa3b5"); R(g, bx + 3 + i * 4, 12 + (i % 2), 2, 1, "#e4572e"); }
        box(g, bx, 15, 24, 9, "#a7764f"); R(g, bx + 1, 16, 22, 1, "#c08a5c"); text(g, "PSA", bx + 7, 18, "#5a3a26");
      }
      // Skannerbåge
      R(g, scanX, 7, 14, 2, "#3b4a6b"); R(g, scanX, 7, 2, 12, "#3b4a6b"); R(g, scanX + 12, 7, 2, 12, "#3b4a6b");
      // Skylt "GRADE"
      if (signX + 24 < W) { box(g, signX, 3, textW("GRADE") + 6, 8, "#fffaf0"); text(g, "GRADE", signX + 3, 4, "#e4572e"); }
      // Löpbandet
      R(g, 0, 19, W, 1, "#1b1b2f"); R(g, 0, 20, W, 2, "#3b3f4d"); R(g, 0, 22, W, 1, "#1b1b2f");
      for (let x = 6; x < W; x += 18) R(g, x, 23, 1, 3, "#3b4a6b");
      return { scanX, micX, mons, colors: ["#e4572e", "#5b9be0", "#6cc06a", "#8a6cd1", "#f2b632"], off: 0, hold: 0, lastStop: -1e9, grade: null, heldX: 0, lastLabel: null, lastK: 0 };
    },
    frame(g, W, f, st) {
      // Bandet rör sig, men står still i 2 sekunder när ett kort är vid scannern. Då visas ett slumpat betyg.
      const gap = 26, n = Math.ceil(W / gap) + 1, loop = n * gap;
      const xOf = (i) => ((i * gap + st.off) % loop) - gap / 2;
      if (st.hold > 0) {
        st.hold--;
      } else {
        let hit = -1;
        for (let i = 0; i < n && hit < 0; i++) { const x = xOf(i); if (x >= st.scanX + 5 && x <= st.scanX + 6) hit = i; }
        if (hit >= 0 && st.off - st.lastStop >= gap) {
          st.lastStop = st.off;
          st.hold = 16; // 16 bildrutor × 125 ms = 2 sekunder
          st.heldX = xOf(hit);
          const k = Math.floor(Math.random() * 11); // 0 = OK, 1–10 = betyg
          st.grade = { label: k === 0 ? "OK" : String(k), k };
          st.lastLabel = st.grade.label; st.lastK = k;
        } else {
          st.off += 0.75;
        }
      }
      for (let x = -(f % 4); x < W; x += 4) R(g, x, 21, 2, 1, "#5a5f70");
      for (let i = 0; i < n; i++) {
        const x = xOf(i), col = st.colors[i % st.colors.length];
        if (x < st.micX + 4) { box(g, x, 14, 4, 5, "#f2d36b"); R(g, x + 1, 15, 2, 2, col); }
        else { box(g, x, 11, 6, 8, "#e8f2ff", "#9aa3b5"); R(g, x + 1, 12, 4, 1, "#e4572e"); R(g, x + 2, 14, 2, 3, col); }
      }
      // Betyget visas i en skylt ovanför kortet som står vid scannern
      if (st.grade && st.hold > 0) {
        const lbl = st.grade.label, bw = textW(lbl) + 4;
        const sx = Math.max(0, Math.min(W - bw, Math.round(st.heldX + 2 - bw / 2)));
        const k = st.grade.k;
        const tone = k === 0 ? "#5b9be0" : k >= 8 ? "#6cc06a" : k >= 5 ? "#f2b632" : "#e4572e";
        box(g, sx, 0, bw, 7, "#1b1b2f", tone);
        text(g, lbl, sx + 2, 1, tone);
      }
      R(g, st.scanX + 2 + (f % 10), 9, 1, 10, "rgba(228,87,46,.85)");
      R(g, st.scanX + 5, 7, 4, 1, st.hold > 0 ? "#6cc06a" : f % 8 < 4 ? "#6cc06a" : "#2f6b2f");
      // Ljuskon från mikroskopets lins ner mot kortet
      const glow = f % 6 < 3 ? "rgba(95,211,224,.55)" : "rgba(95,211,224,.3)";
      R(g, st.micX + 4, 14, 1, 1, "#5fd3e0"); R(g, st.micX + 3, 15, 3, 1, glow); R(g, st.micX + 2, 16, 5, 2, glow);
      st.mons.forEach((mx, k) => {
        R(g, mx + 1, 5, 14, 8, "#14324a");
        if (k === 0) for (let x = 0; x < 14; x++) R(g, mx + 1 + x, 9 + Math.round(Math.sin((x + f * 0.4) / 2) * 2), 1, 1, "#6cc06a");
        else if (st.lastLabel) text(g, st.lastLabel, mx + 5, 7, st.lastK === 0 ? "#5b9be0" : st.lastK >= 8 ? "#6cc06a" : st.lastK >= 5 ? "#f2b632" : "#e4572e");
        else text(g, "--", mx + 5, 7, "#9aa3b5");
      });
    },
  },

  // Nyheter: en nyhetsbyrå. Nyhetsraden rullar överst och reportrarna sitter vid sina skärmar under den.
  nyheter: {
    seed: 67,
    build(g, W, rand) {
      R(g, 0, 0, W, H, "#e6ebf3");
      const sw = textW("NYHETER") + 6, sx = Math.round((W - sw) / 2);
      // Fönster på väggen
      for (let x = 4; x < W - 22; x += 96) {
        if (x + 24 > sx - 14 && x < sx + sw + 16) continue;
        box(g, x, 8, 24, 11, "#a6daff", "#3b4a6b");
        R(g, x + 12, 8, 1, 11, "#3b4a6b");
      }
      box(g, sx, 7, sw, 8, "#e4572e"); text(g, "NYHETER", sx + 3, 8, "#fffaf0");
      // Golvet
      R(g, 0, 24, W, 8, "#c9d0dc");
      for (let x = 0; x < W; x += 12) R(g, x, 27, 6, 1, "#b7bfcd");
      // Tre skrivbord, med en reporter vid varje
      const desks = [];
      for (let k = 0, dx = 4; k < 3; k++, dx = 4 + k * Math.floor((W - 30) / 3)) {
        person(g, dx + 15, 15, look(rand));
        box(g, dx + 2, 14, 11, 8, "#2b5f9e");
        R(g, dx, 22, 26, 2, "#a7764f"); R(g, dx, 24, 26, 1, "#5a3a26");
        R(g, dx + 1, 25, 1, 3, "#5a3a26"); R(g, dx + 24, 25, 1, 3, "#5a3a26");
        R(g, dx + 20, 20, 4, 2, "#fffaf0"); R(g, dx + 21, 19, 2, 1, "#fffaf0");
        desks.push(dx);
      }
      return { desks, sx, sw, msg: "SENASTE NYTT - NYA SET - KORTPRISER - SLAPPDATUM - VIDEOR - " };
    },
    frame(g, W, f, st) {
      // Nyhetsraden överst: långsam, ett steg var tredje bildruta
      const mw = textW(st.msg) + 4, off = Math.floor(f / 3) % mw;
      R(g, 20, 0, W - 20, 6, "#1b1b2f");
      for (let x = 22 - off; x < W; x += mw) text(g, st.msg, x, 1, "#f2b632");
      R(g, 0, 0, 19, 6, "#e4572e"); text(g, "NYTT", 2, 1, "#fffaf0");
      R(g, 0, 6, W, 1, "#e4572e");
      // LIVE-lampa bredvid rubriken
      const live = f % 10 < 5;
      if (st.sx + st.sw + 22 < W) { R(g, st.sx + st.sw + 3, 9, 3, 3, live ? "#e4572e" : "#7a1f10"); text(g, "LIVE", st.sx + st.sw + 7, 8, "#1b1b2f"); }
      // Skärmarna: staplar som rör sig
      st.desks.forEach((dx, i) => {
        for (let k = 0; k < 3; k++) {
          const h = ((f + i * 3 + k * 5) % 5) + 1;
          R(g, dx + 4 + k * 3, 20 - h, 2, h, k % 2 ? "#6cc06a" : "#8ec5ff");
        }
      });
    },
  },
};

// ---------- Motor ----------
function mountBanner(canvas, theme) {
  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W = 0, bg = null, st = {}, frame = 0, timer = null;

  function setup() {
    if (!canvas.clientWidth) return;
    W = Math.ceil(canvas.clientWidth / SCALE);
    canvas.width = W; canvas.height = H;
    canvas.style.height = `${H * SCALE}px`;
    bg = Object.assign(document.createElement("canvas"), { width: W, height: H });
    st = theme.build(bg.getContext("2d"), W, rng(theme.seed)) || {};
    draw();
  }
  function draw() {
    if (!bg) return;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bg, 0, 0);
    theme.frame?.(ctx, W, frame, st);
  }

  // Rita om när bredden ändras, även om sidan först laddats i en dold flik med bredden 0.
  let lastW = -1, rt;
  new ResizeObserver(() => {
    const w = canvas.clientWidth;
    if (!w || w === lastW) return;
    lastW = w;
    clearTimeout(rt); rt = setTimeout(setup, W ? 150 : 0);
  }).observe(canvas);
  canvas.style.height = `${H * SCALE}px`;
  if (!reduce) {
    const start = () => { clearInterval(timer); timer = setInterval(() => { frame++; draw(); }, 125); };
    document.addEventListener("visibilitychange", () => (document.hidden ? clearInterval(timer) : start()));
    start();
  }
}

export function mountBanners() {
  document.querySelectorAll("canvas[data-banner]").forEach((c) => {
    const theme = THEMES[c.dataset.banner];
    if (theme) mountBanner(c, theme);
  });
}
