/* Bildfingeravtryck för kort: liten beskrivning av konstverket (ljushet 16x12 + färg 4x4).
   Samma kod körs i appen (canvas) och i bygget av kortindex (node + sharp), så avtrycken går att jämföra. */
(function (root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Fingerprint = factory();
})(typeof self !== 'undefined' ? self : this, function (){
  const CW = 126, CH = 176;                         // kortet skalas till denna storlek före beskrivningen
  /* Konstverkets ruta i kortet [x0, x1, y0, y1] per spel. Riftbound: under kostnadscirkeln och ovanför typbandet.
     One Piece: bildens övre del, ovanför effekttexten och ovanför "SAMPLE"-stämpeln som TCGplayers bilder har. */
  const BOX = { pokemon: [.07, .93, .11, .56], rb: [.07, .93, .13, .51], op: [.08, .92, .1, .4] };
  const GC = 16, GR = 12, KC = 4, KR = 4, LEN = GC * GR + KC * KR * 3;
  /* data = pixlar (RGB eller RGBA), w x h = kortets bild. dx, dy = litet förskjutet utsnitt (andel av kortet).
     box = konstverkets ruta (BOX.pokemon om den inte anges). */
  function describe(data, w, h, stride, dx, dy, box){
    dx = dx || 0; dy = dy || 0;
    const [AX0, AX1, AY0, AY1] = box || BOX.pokemon;
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
  /* Bästa k träffarna i databasen (db = n vektorer efter varandra). Returnerar [{i, s}] med s = korrelation (-1..1).
     Fyra summor i taget (LEN är delbart med 4) och sortering bara när listan blir för lång: ungefär 20 % snabbare. */
  function match(db, n, q, k){
    const top = [];
    let min = -Infinity;
    for (let j = 0; j < n; j++){
      const o = j * LEN;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let i = 0; i < LEN; i += 4){ s0 += db[o+i] * q[i]; s1 += db[o+i+1] * q[i+1]; s2 += db[o+i+2] * q[i+2]; s3 += db[o+i+3] * q[i+3]; }
      const s = (s0 + s1 + s2 + s3) / (127 * 127);
      if (top.length < k || s > min){
        top.push({ i: j, s });
        if (top.length > k){ top.sort((a, b) => b.s - a.s); top.length = k; min = top[k - 1].s; }
      }
    }
    return top.sort((a, b) => b.s - a.s);
  }
  /* Var kortet kan sitta i den rätade bilden, i andelar av den. Kantsökningen hittar ofta plastfickans, toploaderns eller
     ramens kant i stället för kortets, och då ligger kortet en bit in (i en toploader ofta nere). Bildjämförelsen provar
     alla lägena, så att det inre kortet känns igen utan att bilden behöver rätas om. */
  const FRAMES = [
    { u0: 0, u1: 1, v0: 0, v1: 1 },
    { u0: .03, u1: .97, v0: .02, v1: .98 },   // plastficka
    { u0: .06, u1: .94, v0: .05, v1: .96 },
    { u0: .09, u1: .91, v0: .04, v1: .96 },
    { u0: .09, u1: .91, v0: .1, v1: .97 },    // toploader, kortet nere
    { u0: .12, u1: .88, v0: .12, v1: .94 },
    { u0: .12, u1: .88, v0: .04, v1: .92 },
    { u0: .15, u1: .85, v0: .15, v1: .92 },   // toploader långt bort
    { u0: .05, u1: .95, v0: .14, v1: .97 },
  ];
  const FRAME_COST = .03;
  /* Avtryck av kortbilden för små förskjutningar, så att en lite snett beskuren bild ändå matchar: 25 när kortet fyller
     bilden (frame 0), 9 för de inre lägena. Ett avtryck per spel, eftersom konstverket sitter lite olika (BOX).
     d = RGBA-pixlar i storleken CW x CH. */
  function queries(d, game, frame){
    const [x0, x1, y0, y1] = BOX[game], { u0, u1, v0, v1 } = FRAMES[frame];
    const box = [u0 + x0 * (u1 - u0), u0 + x1 * (u1 - u0), v0 + y0 * (v1 - v0), v0 + y1 * (v1 - v0)];
    const steps = frame ? [-.03, 0, .03] : [-.06, -.03, 0, .03, .06], out = [];
    for (const dy of steps) for (const dx of steps) out.push(vector(describe(d, CW, CH, 4, dx * (u1 - u0), dy * (v1 - v0), box)));
    return out;
  }
  /* Korten i databasen som liknar bilden mest: [{ i, s, frame }], osorterade, s = likhet. Hela databasen söks med några
     avtryck per läge i FRAMES, och korten som hittas jämförs sedan med alla avtryck. quick: bara ett avtryck söker, och
     de inre lägena provas inte. För en omrätning, där bilden redan är beskuren rätt eller inte alls. */
  function search(db, n, d, game, k, quick){
    const qs = (quick ? FRAMES.slice(0, 1) : FRAMES).map((_, f) => queries(d, game, f));
    const found = new Set();
    let top = -1;
    for (const q of (quick ? [12] : [12, 7, 17, 11, 13]).map((i) => qs[0][i])) for (const t of match(db, n, q, k)){ found.add(t.i); top = Math.max(top, t.s); }
    /* Liknar hela bilden redan ett kort tydligt behövs inte de inre lägena */
    if (top >= .9) qs.length = 1;
    for (const q of qs.slice(1).map((q) => q[4])) for (const t of match(db, n, q, k)) found.add(t.i);
    const out = [];
    for (const i of found){
      let s = -1, frame = 0;
      /* Ett inre läge får ett litet avdrag, så att många extra avtryck inte lyfter fel kort i en bild med blänk */
      qs.forEach((list, f) => {
        for (const q of list){
          let v = 0;
          for (let j = 0, o = i * LEN; j < LEN; j++) v += db[o + j] * q[j];
          v = v / (127 * 127) - (f ? FRAME_COST : 0);
          if (v > s){ s = v; frame = f; }
        }
      });
      out.push({ i, s, frame });
    }
    return out;
  }
  return { CW, CH, LEN, BOX, FRAMES, describe, vector, match, queries, search };
});
