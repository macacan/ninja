// Säkerhetskopior av Mitt valv. Allt stannar hos besökaren: filen sparas på telefonen när man själv trycker på knappen, och
// de automatiska kopiorna ligger i webbläsaren (IndexedDB). Inget skickas till oss, så det kräver inget samtycke.
// Filen skyddar mot det mesta: rensad webbplatsdata, en borttagen app och ny telefon. De automatiska kopiorna skyddar mot
// misstag och fel i sidan, men försvinner med webbplatsdatan.
const APP = "lootninja-valv";
const GAMES = new Set(["pokemon", "op", "rb"]);
const STATE_KEY = "nl:vault-backup"; // { at: senaste säkerhetskopian, added: kort inlagda sedan dess }
const MAX_FILE = 5e6;
const REMIND_FIRST = 10, REMIND_AGAIN = 20; // kort sedan senaste kopian innan påminnelsen visas

export const cardCount = (cards) => cards.reduce((n, c) => n + c.qty, 0);

// ---------- Fil ----------
export function backupFile(cards) {
  const day = new Date().toISOString().slice(0, 10);
  const text = JSON.stringify({ app: APP, version: 1, saved: new Date().toISOString(), cards }, null, 1);
  return new File([text], `lootninja-valv-${day}.json`, { type: "application/json" });
}

// Kort ur en säkerhetskopia, kontrollerade fält för fält: filen kan ha ändrats eller vara en helt annan fil.
export function parseBackup(text) {
  if (text.length > MAX_FILE) throw new Error("Filen är för stor för att vara en säkerhetskopia.");
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (data?.app !== APP || !Array.isArray(data.cards)) throw new Error("Det här är ingen säkerhetskopia från Lootninjas valv.");
  const seen = new Map();
  for (const c of data.cards) {
    const qty = Math.floor(c?.qty);
    if (!GAMES.has(c?.game) || typeof c.id !== "string" || !c.id || c.id.length > 80 || !(qty >= 1 && qty <= 99999)) continue;
    const card = { game: c.game, id: c.id, qty, at: Number.isFinite(c.at) ? c.at : Date.now(), p: Number.isFinite(c.p) ? c.p : null, ...(c.f && { f: 1 }) };
    const key = keyOf(card), old = seen.get(key);
    if (old) old.qty = Math.max(old.qty, qty);
    else seen.set(key, card);
  }
  if (!seen.size && data.cards.length) throw new Error("Filen innehåller inga kort som går att läsa.");
  return { cards: [...seen.values()], saved: Date.parse(data.saved) || null };
}

const keyOf = (c) => `${c.game}|${c.id}|${c.f ? 1 : 0}`;
// Båda listorna kommer oftast från samma samling, så ett kort som finns i båda behåller det högsta antalet och räknas inte dubbelt
export function mergeCards(current, incoming) {
  const out = current.map((c) => ({ ...c })), byKey = new Map(out.map((c) => [keyOf(c), c]));
  for (const c of incoming) {
    const same = byKey.get(keyOf(c));
    if (!same) out.push({ ...c });
    else { same.qty = Math.max(same.qty, c.qty); same.p ??= c.p; same.at = Math.min(same.at ?? c.at, c.at ?? same.at); }
  }
  return out;
}

const isIos = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// Sparar filen. iPhone: delningsrutan, där man väljer Spara i Filer (vanlig nedladdning fungerar dåligt i hemskärmsappen).
// Annars en vanlig nedladdning. Måste anropas direkt i ett tryck. Sant om filen sparades, falskt om man avbröt.
export async function saveFile(file) {
  if (isIos() && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Lootninja valv" }); return true; }
    catch (e) { if (e.name === "AbortError") return false; }
  }
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30e3);
  return true;
}

// ---------- Påminnelse ----------
const readState = () => { try { return JSON.parse(localStorage.getItem(STATE_KEY)) || null; } catch { return null; } };
const writeState = (s) => { try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch {} };
export const backupState = (count = 0) => readState() || { at: null, added: count };
export const markSaved = () => writeState({ at: Date.now(), added: 0 });
export function noteAdded(n, total) {
  const s = backupState(total - n);
  writeState({ ...s, added: s.added + n });
}
// Senare: påminn igen efter nästa omgång kort
export function snooze(count) {
  const s = backupState(count);
  writeState({ ...s, added: 0, later: true });
}
export function backupDue(count) {
  const s = backupState(count);
  return count > 0 && s.added >= (s.at || s.later ? REMIND_AGAIN : REMIND_FIRST);
}

// ---------- Automatiska kopior ----------
const DB = "nl-vault-copies", STORE = "copies";
const KEEP_RECENT = 5, KEEP_ALL = 12, SAME_COPY = 10 * 60e3;
function openDb() {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "at" });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
const done = (t) => new Promise((ok, no) => { t.oncomplete = ok; t.onerror = t.onabort = () => no(t.error); });

// De sparade kopiorna, nyaste först. Tom lista om webbläsaren inte kan spara dem.
export async function listCopies() {
  try {
    const db = await openDb();
    const all = await new Promise((ok, no) => {
      const r = db.transaction(STORE).objectStore(STORE).getAll();
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
    db.close();
    return all.sort((a, b) => b.at - a.at);
  } catch { return []; }
}

// Sparar läget. Ett tomt valv sparas aldrig, så att det som fanns ligger kvar. Ändringar inom några minuter blir samma kopia,
// utom när kort försvunnit: då ska läget innan finnas kvar. De senaste kopiorna behålls, och av de äldre en per dag.
export async function saveCopy(cards) {
  if (!cards.length) return;
  try {
    const list = await listCopies(), last = list[0], json = JSON.stringify(cards), count = cardCount(cards);
    if (last && JSON.stringify(last.cards) === json) return;
    const db = await openDb(), t = db.transaction(STORE, "readwrite"), store = t.objectStore(STORE), now = Date.now();
    if (last && now - last.at < SAME_COPY && count >= last.count) { store.delete(last.at); list.shift(); }
    store.put({ at: now, count, cards });
    const days = new Set();
    list.forEach((c, i) => {
      const day = new Date(c.at).toDateString(), keep = i < KEEP_RECENT - 1 || (!days.has(day) && i < KEEP_ALL - 1);
      days.add(day);
      if (!keep) store.delete(c.at);
    });
    await done(t);
    db.close();
  } catch {}
}
