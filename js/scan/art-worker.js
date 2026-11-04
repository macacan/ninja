// Bildjämförelsen i en egen tråd: att söka igenom 21 000 kort tar en stund på en telefon, och på sidans egen tråd
// hackar då kameran och kantsökningen. Svaret är detsamma som Fingerprint.search på sidan (reserven i card-scanner.js).
importScripts("fingerprint.js?v=20261106a");
const indexes = {};
onmessage = ({ data: m }) => {
  if (m.load) { indexes[m.load] = { db: m.db, n: m.n }; return; }
  const a = indexes[m.game];
  try { postMessage({ id: m.id, hits: self.Fingerprint.search(a.db, a.n, m.d, m.game, m.k, m.quick) }); }
  catch { postMessage({ id: m.id, failed: true }); }
};
