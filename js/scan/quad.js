/* Hittar kortets fyra hörn i ett foto och rätar ut det (perspektivkorrigering), utan AI.
   1) kanter (Sobel) i en liten kopia av bilden  2) raka linjer med Hough-transform (röstning i riktningen som kanten pekar)
   3) prova par av nästan parallella linjer och välj den fyrhörning som har kortets proportioner och starkast kant hela vägen runt
   4) homografi från kortets rektangel till fyrhörningen, och sampla om pixlarna (bilinjärt) till ett platt kort. */
(function (root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Quad = factory();
})(typeof self !== 'undefined' ? self : this, function (){
  const RATIO = 63 / 88;

  /* rgba = pixeldata (4 byte/pixel), w x h. Returnerar { pts: [[x,y] x4 (TL,TR,BR,BL) i samma skala], score } eller null. */
  function find(rgba, w, h){
    // gråskala + lätt utjämning (3x3 två gånger) så att tryck och holo-mönster inte ger kanter
    let g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) g[i] = rgba[j] * .299 + rgba[j+1] * .587 + rgba[j+2] * .114;
    for (let pass = 0; pass < 2; pass++){
      const t = new Float32Array(w * h);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++){
        const i = y * w + x;
        t[i] = (g[i-w-1] + 2*g[i-w] + g[i-w+1] + 2*g[i-1] + 4*g[i] + 2*g[i+1] + g[i+w-1] + 2*g[i+w] + g[i+w+1]) / 16;
      }
      g = t;
    }
    const mag = new Float32Array(w * h), ang = new Float32Array(w * h), hist = new Int32Array(1024);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++){
      const i = y * w + x;
      const gx = (g[i-w+1] + 2*g[i+1] + g[i+w+1]) - (g[i-w-1] + 2*g[i-1] + g[i+w-1]);
      const gy = (g[i+w-1] + 2*g[i+w] + g[i+w+1]) - (g[i-w-1] + 2*g[i-w] + g[i-w+1]);
      const m = Math.hypot(gx, gy); mag[i] = m; ang[i] = Math.atan2(gy, gx);
      hist[Math.min(1023, m | 0)]++;
    }
    // de ~9 % starkaste kanterna
    let thr = 1023, acc = 0; const want = w * h * .09;
    while (thr > 20 && acc + hist[thr] < want){ acc += hist[thr]; thr--; }
    // Hough: theta 0..179 grader, rho i hela pixlar. Varje kantpunkt röstar bara nära sin egen normalriktning (snabbt och rent).
    const NT = 180, diag = Math.ceil(Math.hypot(w, h)), NR = diag * 2 + 1, H = new Float32Array(NT * NR);
    const cs = new Float32Array(NT), sn = new Float32Array(NT);
    for (let t = 0; t < NT; t++){ cs[t] = Math.cos(t * Math.PI / 180); sn[t] = Math.sin(t * Math.PI / 180); }
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++){
      const i = y * w + x, m = mag[i]; if (m < thr) continue;
      let a = ang[i] * 180 / Math.PI; if (a < 0) a += 180; const t0 = Math.round(a);
      const v = Math.min(m, thr * 3);
      for (let d = -6; d <= 6; d++){
        const t = (t0 + d + NT) % NT, r = Math.round(x * cs[t] + y * sn[t]) + diag;
        H[t * NR + r] += v * (1 - Math.abs(d) / 8);
      }
    }
    // toppar med lokal maxsökning (±4 grader, ±6 px)
    const peaks = [];
    let hmax = 0; for (let k = 0; k < H.length; k++) if (H[k] > hmax) hmax = H[k];
    const floor = hmax * .12;
    for (let t = 0; t < NT; t++) for (let r = 1; r < NR - 1; r++){
      const v = H[t * NR + r]; if (v < floor) continue;
      let ok = true;
      for (let dt = -4; dt <= 4 && ok; dt++) for (let dr = -6; dr <= 6; dr++){
        if (!dt && !dr) continue;
        let tt = t + dt, rr = r + dr;
        if (tt < 0){ tt += NT; rr = NR - 1 - rr; } else if (tt >= NT){ tt -= NT; rr = NR - 1 - rr; }
        if (rr < 0 || rr >= NR) continue;
        const u = H[tt * NR + rr]; if (u > v || (u === v && (dt < 0 || (dt === 0 && dr < 0)))){ ok = false; break; }
      }
      if (ok) peaks.push({ t, r: r - diag, v });
    }
    peaks.sort((a, b) => b.v - a.v);
    const lines = peaks.slice(0, 30);
    if (lines.length < 4) return null;
    // linje: x cos t + y sin t = r.  Skärningspunkt mellan två linjer.
    const meet = (a, b) => {
      const c1 = cs[a.t], s1 = sn[a.t], c2 = cs[b.t], s2 = sn[b.t], det = c1 * s2 - s1 * c2;
      if (Math.abs(det) < 1e-6) return null;
      return [(a.r * s2 - s1 * b.r) / det, (c1 * b.r - a.r * c2) / det];
    };
    const adiff = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };
    // stöd längs en sträcka: andel punkter med stark kant som pekar vinkelrätt mot sträckan
    const support = (p, q) => {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]), n = Math.max(8, Math.round(len / 2));
      const nx = -(q[1] - p[1]) / len, ny = (q[0] - p[0]) / len;
      let hit = 0, cnt = 0;
      for (let k = 1; k < n; k++){
        const x = p[0] + (q[0] - p[0]) * k / n, y = p[1] + (q[1] - p[1]) * k / n;
        cnt++;
        let best = 0;
        for (let o = -2; o <= 2; o++){
          const xi = Math.round(x + nx * o), yi = Math.round(y + ny * o);
          if (xi < 2 || yi < 2 || xi >= w - 2 || yi >= h - 2) continue;
          const i = yi * w + xi; if (mag[i] < thr * .6) continue;
          const c = Math.abs(Math.cos(ang[i]) * nx + Math.sin(ang[i]) * ny);
          if (c > .85){ best = 1; break; }
        }
        hit += best;
      }
      return cnt ? hit / cnt : 0;
    };
    // par av nästan parallella linjer (perspektiv ger upp till ~18 graders skillnad)
    const pairs = [];
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++){
      const a = lines[i], b = lines[j];
      if (adiff(a.t, b.t) > 18) continue;
      // samma riktning: jämför rho med samma tecken (t nära 0/180 kan ha vänt)
      const flip = Math.abs(a.t - b.t) > 90, rb = flip ? -b.r : b.r;
      if (Math.abs(a.r - rb) < Math.min(w, h) * .15) continue;
      pairs.push([a, b]);
    }
    const area = q => { let s = 0; for (let k = 0; k < 4; k++){ const p = q[k], n = q[(k + 1) % 4]; s += p[0] * n[1] - n[0] * p[1]; } return s / 2; };
    // först bara geometrin (billigt), sedan kantstöd för de mest lovande
    const cands = [];
    for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++){
      const [a1, a2] = pairs[i], [b1, b2] = pairs[j];
      const da = adiff(a1.t, b1.t); if (da < 65) continue;            // de två paren ska vara ungefär vinkelräta
      const p1 = meet(a1, b1), p2 = meet(a1, b2), p3 = meet(a2, b2), p4 = meet(a2, b1);
      if (!p1 || !p2 || !p3 || !p4) continue;
      let q = [p1, p2, p3, p4];
      // hela kortet ska synas (ett kort som skärs av bildkanten tas av de andra metoderna)
      const mg = Math.min(w, h) * .01;
      if (q.some(p => p[0] < mg || p[1] < mg || p[0] > w - mg || p[1] > h - mg)) continue;
      let A = area(q); if (A < 0){ q = [p1, p4, p3, p2]; A = -A; }
      if (A < w * h * .1) continue;
      let convex = true;
      for (let k = 0; k < 4 && convex; k++){ const o = q[k], p = q[(k + 1) % 4], r = q[(k + 2) % 4]; if ((p[0] - o[0]) * (r[1] - p[1]) - (p[1] - o[1]) * (r[0] - p[0]) <= 0) convex = false; }
      if (!convex) continue;
      const L = k => Math.hypot(q[(k + 1) % 4][0] - q[k][0], q[(k + 1) % 4][1] - q[k][1]);
      const s02 = (L(0) + L(2)) / 2, s13 = (L(1) + L(3)) / 2, ar = Math.min(s02, s13) / Math.max(s02, s13);
      if (ar < RATIO * .9 || ar > RATIO * 1.1) continue;
      cands.push({ q, A, ar, v: a1.v + a2.v + b1.v + b2.v });
    }
    cands.sort((x, y) => y.v - x.v);
    let best = null;
    for (const c of cands.slice(0, 300)){
      const { q, A, ar } = c, sup = [];
      // varje sida måste ha stöd längs större delen av sin längd
      for (let k = 0; k < 4; k++){ const s = support(q[k], q[(k + 1) % 4]); if (s < .42) break; sup.push(s); }
      if (sup.length < 4) continue;
      const minS = Math.min(...sup), mean = sup.reduce((s, v) => s + v, 0) / 4;
      const score = mean * (.6 + .4 * minS) * Math.pow(A / (w * h), .6) * (1 - Math.abs(ar - RATIO) * .8);
      if (!best || score > best.score) best = { q, score, sup, ar };
    }
    if (!best) return null;
    // ordna hörnen: kortet står upprätt (långsidorna lodräta), övre vänstra först
    let q = best.q;
    const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
    q = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx)); // medurs från vänster (skärmkoordinater)
    // börja i det hörn som ligger närmast övre vänstra
    let k0 = 0, bd = Infinity;
    q.forEach((p, k) => { const d = (p[0] - cx) + (p[1] - cy); if (d < bd){ bd = d; k0 = k; } });
    q = [0, 1, 2, 3].map(k => q[(k0 + k) % 4]);
    const top = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), side = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
    if (top > side) return null;                                      // liggande kort: låt de andra metoderna ta det
    return { pts: q, score: best.score, sup: best.sup };
  }

  /* Homografi som tar (u,v) i en W x H-rektangel till fyrhörningen q (TL,TR,BR,BL). */
  function homography(q, W, H){
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
    const det = dx1 * dy2 - dx2 * dy1;
    const g = (sx * dy2 - dx2 * sy) / det, hh = (dx1 * sy - sx * dy1) / det;
    const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0, d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;
    return (u, v) => { const s = u / W, t = v / H, z = g * s + hh * t + 1; return [(a * s + b * t + c) / z, (d * s + e * t + f) / z]; };
  }
  /* Platt kort W x H ur källbilden (src = RGBA, sw x sh) och hörnen q i källans skala. Returnerar Uint8ClampedArray (RGBA). */
  function warp(src, sw, sh, q, W, H){
    const map = homography(q, W, H), out = new Uint8ClampedArray(W * H * 4);
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++){
      let [x, y] = map(u + .5, v + .5); x -= .5; y -= .5;
      const o = (v * W + u) * 4;
      if (x < 0 || y < 0 || x > sw - 1 || y > sh - 1){ out[o] = out[o+1] = out[o+2] = 40; out[o+3] = 255; continue; }
      const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, x2 = Math.min(sw - 1, xi + 1), y2 = Math.min(sh - 1, yi + 1);
      const i00 = (yi * sw + xi) * 4, i10 = (yi * sw + x2) * 4, i01 = (y2 * sw + xi) * 4, i11 = (y2 * sw + x2) * 4;
      for (let c = 0; c < 3; c++){
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx, bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
    return out;
  }
  return { find, warp, homography, RATIO };
});
