// Skapar lösenordsraden för statistiköversikten (stats/dashboard.php).
//   node scripts/stats-password.mjs
// Skriv lösenordet när du blir ombedd (det visas som stjärnor). Raden som skrivs ut läggs i filen
// lootninja-stats-pass.txt i mappen ovanför public_html på Hostinger (hPanel → Filhanteraren).
// Själva lösenordet sparas ingenstans.
import { pbkdf2Sync, randomBytes } from "node:crypto";

// Läser en rad från terminalen utan att visa tecknen.
function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode?.(false); stdin.pause(); stdin.off("data", onData); stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") { stdout.write("\n"); process.exit(1); } // Ctrl+C
        if (ch === "\u007f" || ch === "\b") { if (value) { value = value.slice(0, -1); stdout.write("\b \b"); } continue; }
        value += ch; stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

const pw = await askHidden("Nytt lösenord för stats.lootninja.se (minst 12 tecken): ");
if (pw.length < 12) { console.log(`För kort (${pw.length} tecken), välj minst 12.`); process.exit(1); }
if (await askHidden("Skriv lösenordet igen: ") !== pw) { console.log("Lösenorden var inte lika, försök igen."); process.exit(1); }
const iterations = 210000, salt = randomBytes(16);
const hash = pbkdf2Sync(pw, salt, iterations, 32, "sha256");
console.log(`
Lägg den här raden (och inget annat) i lootninja-stats-pass.txt, i mappen ovanför public_html:

pbkdf2_sha256$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}
`);
