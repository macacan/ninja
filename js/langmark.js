// Språksymbol nere till höger på produktbilden. Engelska (det vanliga) får ingen.
// Egen fil i stället för en ny export i site.js: en webbläsare med en gammal site.js i cachen skulle
// annars inte hitta exporten, och då laddas inte sidan alls.
const LANG_MARK = { ja: ["JP", "Japansk"], ko: ["KR", "Koreansk"], zh: ["CN", "Kinesisk"] };

export const langMark = (lang) => (LANG_MARK[lang] ? `<span class="plang ${lang}" title="${LANG_MARK[lang][1]}" aria-label="${LANG_MARK[lang][1]}">${LANG_MARK[lang][0]}</span>` : "");
