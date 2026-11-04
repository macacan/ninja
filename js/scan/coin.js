// Myntljudet i valvets skanner. Skannern hittar kort utan att man trycker på något, och då nekar mobilwebbläsare vanligt
// ljud (new Audio). Därför Web Audio: ljudet låses upp av trycket som öppnar skannern och kan sedan spelas när som helst.
// Ligger utanför card-scanner.js eftersom upplåsningen måste ske innan den stora skannern har laddats klart.
// Ljudvalet är samma som i spelet på startsidan (restock.js).
const SOUND_KEY = "nl:sound-muted";
const VOLUME = 0.6;
let muted = (() => { try { return localStorage.getItem(SOUND_KEY) === "1"; } catch { return false; } })();
let ctx = null, coin = null, loading = null;

export const coinMuted = () => muted;
export function setCoinMuted(on) {
  muted = on;
  try { localStorage.setItem(SOUND_KEY, on ? "1" : "0"); } catch {}
}

// Anropas direkt i ett tryck, innan något await
export function unlockCoin() {
  if (!window.AudioContext) return;
  ctx ||= new AudioContext();
  ctx.resume().catch(() => {});
  // En tyst ljudsnutt: äldre iPhones släpper inte fram ljud förrän något spelats i ett tryck
  const s = ctx.createBufferSource();
  s.buffer = ctx.createBuffer(1, 1, 22050);
  s.connect(ctx.destination);
  s.start();
  loading ||= fetch("sounds/coins.mp3").then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b))
    .then((b) => { coin = b; }).catch(() => { loading = null; });
}

export function playCoin() {
  if (muted || !ctx || !coin) return;
  if (ctx.state !== "running") ctx.resume().catch(() => {}); // iPhone kan pausa ljudet när kameran startar
  const s = ctx.createBufferSource(), gain = ctx.createGain();
  gain.gain.value = VOLUME;
  s.buffer = coin;
  s.connect(gain).connect(ctx.destination);
  s.start();
}
