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

// Värde för ett graderat kort jämfört med nyskickspriset. Grova riktvärden från sålda kort:
// moderna kort ligger kring 3-4 gånger råpriset i betyg 10 och ungefär på råpriset i betyg 9.
// Kort från Wizards-eran (1999-2003) har mycket större premie, eftersom få klarar höga betyg.
const GRADE_MULT = { 10: 3.4, 9: 1.1, 8: 0.9, 7: 0.75, 6: 0.6, 5: 0.5, 4: 0.4, 3: 0.3, 2: 0.25, 1: 0.2 };
const GRADE_MULT_VINTAGE = { 10: 12, 9: 3, 8: 1.5, 7: 1.1, 6: 0.85, 5: 0.7, 4: 0.55, 3: 0.4, 2: 0.3, 1: 0.25 };
export const gradeMult = (g, vintage = false) => (vintage ? GRADE_MULT_VINTAGE : GRADE_MULT)[g] ?? 0.2;

// Set från Wizards of the Coast, efter TCGdex set-id.
export const isVintage = (cardId = "") => /^(base\d|basep|gym\d|neo\d|lc|si1|ecard\d|wp)-/i.test(cardId);
