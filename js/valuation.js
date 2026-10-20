// Gemensamma tumregler för värdering: skick och graderat värde jämfört med nyskickspriset.

// Andel av Cardmarkets trendpris i nyskick (Near Mint = 1) för ograderat kort.
export const CONDITIONS = [
  ["Mint", "Som nytt, helt felfritt", 1.15],
  ["Near Mint", "Inga synliga fel", 1],
  ["Excellent", "Lite slitage på nära håll", 0.7],
  ["Lätt spelat", "Vita prickar, lätta repor", 0.5],
  ["Spelat", "Kraftigt slitage, tydliga repor", 0.3],
  ["Dåligt", "Veck, fukt eller skador", 0.15],
];
// Skicket som är förvalt: Near Mint.
export const DEFAULT_COND = 1;

// Graderat kort i procent av NM-trendpriset. Moderna kort (utgivna 2017 eller senare) och äldre kort (före 2017).
const GRADE_MULT = { 10: 2.2, 9: 1.1, 8: 0.9, 7: 0.75, 6: 0.6, 5: 0.5, 4: 0.45, 3: 0.35, 2: 0.3, 1: 0.2 };
const GRADE_MULT_VINTAGE = { 10: 5, 9: 2.3, 8: 1.5, 7: 1.1, 6: 0.85, 5: 0.6, 4: 0.6, 3: 0.4, 2: 0.4, 1: 0.25 };
export const gradeMult = (g, vintage = false) => (vintage ? GRADE_MULT_VINTAGE : GRADE_MULT)[g] ?? 0.2;

// Äldre kort är utgivna före 2017 (före Sun & Moon). Okänt utgivningsår räknas som modernt.
export const isVintage = (year) => year != null && year < 2017;
