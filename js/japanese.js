// Japanska kort (beta), gemensamt för Kortpriser och Värdera. TCGdex har en egen japansk databas där korten
// heter på japanska, så sökningen går via Pokédex-numret: engelskt namn → nummer → alla japanska kort med
// samma Pokémon. Tränar- och energikort har inget nummer och går därför inte att söka fram här.
import { API, getJSON, getList } from "./site.js";
import { filterByNumber, apiNumber } from "./card-autocomplete.js";

export const JA_API = API.replace(/\/en$/, "/ja");
export const apiFor = (lang) => (lang === "ja" ? JA_API : API);

const dexCache = new Map();
export async function dexNumber(name) {
  if (dexCache.has(name)) return dexCache.get(name);
  let list = await getList(`${API}/cards?${new URLSearchParams({ name: `eq:${name}` })}&pagination:itemsPerPage=5`);
  if (!list.length) list = await getList(`${API}/cards?${new URLSearchParams({ name })}&pagination:itemsPerPage=5`);
  for (const c of list) {
    const full = await getJSON(`${API}/cards/${encodeURIComponent(c.id)}`).catch(() => null);
    if (full?.dexId?.[0]) { dexCache.set(name, full.dexId[0]); return full.dexId[0]; }
  }
  return null;
}

// Japanska kort för en Pokémon (engelskt namn) och/eller ett kortnummer. Varje kort får lang och det engelska namnet.
// null betyder att namnet inte gick att koppla till en Pokémon.
export async function findJapanese(name, num = null, setTotal = null) {
  let list;
  if (name) {
    const dex = await dexNumber(name);
    if (!dex) return null;
    list = await getList(`${JA_API}/cards?dexId=eq:${dex}`);
    if (num) list = await filterByNumber(list, num, setTotal);
  } else if (num) {
    list = await filterByNumber(await getList(`${JA_API}/cards?${new URLSearchParams({ localId: apiNumber(num) })}`), num, setTotal);
  } else list = [];
  return list.map((c) => ({ ...c, lang: "ja", en: name || null }));
}
