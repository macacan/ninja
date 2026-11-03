/* Bildfingeravtryck för kort: liten beskrivning av konstverket (ljushet 16x12 + färg 4x4).
   Samma kod körs i appen (canvas) och i bygget av kortindex (node + sharp), så avtrycken går att jämföra. */
(function (root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Fingerprint = factory();
})(typeof self !== 'undefined' ? self : this, function (){
  const CW = 126, CH = 176;                         // kortet skalas till denna storlek före beskrivningen
  const AX0 = .07, AX1 = .93, AY0 = .11, AY1 = .56; // konstverkets ruta i kortet
  const GC = 16, GR = 12, KC = 4, KR = 4, LEN = GC * GR + KC * KR * 3;
  /* data = pixlar (RGB eller RGBA), w x h = kortets bild. dx, dy = litet förskjutet utsnitt (andel av kortet). */
  function describe(data, w, h, stride, dx, dy){
    dx = dx || 0; dy = dy || 0;
    const x0 = (AX0 + dx) * w, x1 = (AX1 + dx) * w, y0 = (AY0 + dy) * h, y1 = (AY1 + dy) * h;
    const out = new Uint8Array(LEN);
    const cell = (cols, rows, fn) => {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++){
        const a = Math.max(0, Math.floor(x0 + (x1 - x0) * c / cols)), b = Math.min(w, Math.max(a + 1, Math.floor(x0 + (x1 - x0) * (c + 1) / cols)));
        const e = Math.max(0, Math.floor(y0 + (y1 - y0) * r / rows)), f = Math.min(h, Math.max(e + 1, Math.floor(y0 + (y1 - y0) * (r + 1) / rows)));
        let R = 0, G = 0, B = 0, n = 0;
        for (let y = e; y < f; y++) for (let x = a; x < b; x++){ const i = (y * w + x) * stride; R += data[i]; G += data[i+1]; B += data[i+2]; n++; }
        n = n || 1; fn(r * cols + c, R / n, G / n, B / n);
      }
    };
    cell(GC, GR, (i, r, g, b) => { out[i] = Math.round(r * .299 + g * .587 + b * .114); });
    cell(KC, KR, (i, r, g, b) => { const o = GC * GR + i * 3; out[o] = Math.round(r); out[o+1] = Math.round(g); out[o+2] = Math.round(b); });
    return out;
  }
  /* Normaliserad vektor (Int8): ljushet och färg med medelvärdet borttaget, så belysning och färgstick spelar mindre roll. */
  function vector(d){
    const v = new Float32Array(LEN), G = GC * GR;
    let m = 0; for (let i = 0; i < G; i++) m += d[i]; m /= G;
    for (let i = 0; i < G; i++) v[i] = d[i] - m;
    for (let ch = 0; ch < 3; ch++){
      let s = 0; for (let i = 0; i < KC * KR; i++) s += d[G + i * 3 + ch]; s /= KC * KR;
      for (let i = 0; i < KC * KR; i++) v[G + i * 3 + ch] = (d[G + i * 3 + ch] - s) * .7;
    }
    let n = 0; for (let i = 0; i < LEN; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1;
    const out = new Int8Array(LEN); for (let i = 0; i < LEN; i++) out[i] = Math.round(v[i] / n * 127);
    return out;
  }
  /* Bästa k träffarna i databasen (db = n vektorer efter varandra). Returnerar [{i, s}] med s = korrelation (-1..1). */
  function match(db, n, q, k){
    const top = [];
    for (let j = 0; j < n; j++){
      let s = 0, o = j * LEN; for (let i = 0; i < LEN; i++) s += db[o + i] * q[i];
      s /= 127 * 127;
      if (top.length < k || s > top[top.length - 1].s){
        top.push({ i: j, s }); top.sort((a, b) => b.s - a.s); if (top.length > k) top.pop();
      }
    }
    return top;
  }
  return { CW, CH, LEN, describe, vector, match };
});
