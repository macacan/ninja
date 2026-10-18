// Gemensamma tumregler för värdering: skick och graderat värde jämfört med nyskickspriset.

// Andel av nyskickspriset per skick (Near Mint = 1).
export const CONDITIONS = [
  ["Mint", "Som nytt, helt felfritt", 1.15],
  ["Near Mint", "Inga synliga fel", 1],
  ["Excellent", "Lite slitage på nära håll", 0.85],
  ["Lätt spelat", "Vita prickar, lätta repor", 0.7],
  ["Spelat", "Tydligt slitage, små veck", 0.5],
  ["Dåligt", "Veck, fukt eller skador", 0.25],
];
// Skicket som är förvalt: Near Mint.
export const DEFAULT_COND = 1;

// Värde för ett graderat kort jämfört med nyskickspriset. Grova riktvärden.
const GRADE_MULT = { 10: 5, 9: 2.3, 8: 1.4, 7: 1.1 };
export const gradeMult = (g) => GRADE_MULT[g] ?? 0.9;
