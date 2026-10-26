// Skapar lösenordsraden för statistiköversikten (stats/dashboard.php).
//   node scripts/stats-password.mjs
// Skriv lösenordet när du blir ombedd. Raden som skrivs ut läggs i filen lootninja-stats-pass.txt i mappen ovanför
// public_html på Hostinger (hPanel → Filhanteraren). Själva lösenordet sparas ingenstans.
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const pw = (await rl.question("Nytt lösenord för stats.lootninja.se (minst 12 tecken): ")).trim();
rl.close();
if (pw.length < 12) { console.log("För kort, välj minst 12 tecken."); process.exit(1); }
const iterations = 210000, salt = randomBytes(16);
const hash = pbkdf2Sync(pw, salt, iterations, 32, "sha256");
console.log(`
Lägg den här raden (och inget annat) i lootninja-stats-pass.txt, i mappen ovanför public_html:

pbkdf2_sha256$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}
`);
