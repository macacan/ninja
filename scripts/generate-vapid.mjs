// VAPID-nycklar för pushnotiserna (se README → Pushnotiser).
//   node scripts/generate-vapid.mjs          skapar ett nytt nyckelpar, om den hemliga nyckeln har kommit bort
//   node scripts/generate-vapid.mjs --check  kollar att miljövariabeln VAPID_PRIVATE_KEY hör ihop med den publika
//                                            nyckeln som sidan använder (bra när inga notiser kommer fram)
// Den hemliga nyckeln skrivs bara ut i terminalen. Lägg den aldrig i en fil i repot.
import { createECDH } from "node:crypto";
import { VAPID_PUBLIC } from "./scraper/lib/webpush.mjs";

const SECRET_PATH = "GitHub-repot → Settings → Secrets and variables → Actions → Repository secrets";

if (process.argv.includes("--check")) {
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!priv) {
    console.log("VAPID_PRIVATE_KEY är inte satt i den här terminalen. Sätt den först, t.ex. i PowerShell:");
    console.log('  $env:VAPID_PRIVATE_KEY = "<din hemliga nyckel>"; node scripts/generate-vapid.mjs --check');
    process.exit(1);
  }
  const e = createECDH("prime256v1");
  try { e.setPrivateKey(Buffer.from(priv.trim(), "base64url")); } catch { console.log("FEL: VAPID_PRIVATE_KEY är inte en giltig P-256-nyckel (base64url)."); process.exit(1); }
  if (e.getPublicKey("base64url") === VAPID_PUBLIC) {
    console.log("OK: Nyckeln stämmer med den publika nyckeln i js/push.js, api/push.php och webpush.mjs.");
    console.log(`   Kommer det ändå inga notiser: kontrollera att samma värde ligger i ${SECRET_PATH} med namnet VAPID_PRIVATE_KEY.`);
  } else {
    console.log("FEL: Nyckeln hör INTE ihop med den publika nyckeln sidan använder. Notiserna kommer att avvisas.");
    console.log("   Hitta rätt hemlig nyckel, eller skapa ett nytt par med: node scripts/generate-vapid.mjs");
    process.exit(1);
  }
  process.exit(0);
}

const e = createECDH("prime256v1");
e.generateKeys();
const pub = e.getPublicKey("base64url"), priv = e.getPrivateKey("base64url");

console.log(`
Nytt VAPID-nyckelpar för Lootninjas pushnotiser
================================================

VAPID_PUBLIC:      ${pub}
VAPID_PRIVATE_KEY: ${priv}

Gör så här:

1. Den HEMLIGA nyckeln (VAPID_PRIVATE_KEY):
   Gå till ${SECRET_PATH}
   → New repository secret (eller Update om den redan finns)
   → Name: VAPID_PRIVATE_KEY   Secret: värdet ovan.
   Kör du bevakningen själv (scripts/scraper/daemon.mjs) sätter du också miljövariabeln VAPID_PRIVATE_KEY där.

2. Den PUBLIKA nyckeln (VAPID_PUBLIC) byter du ut på tre ställen, mot värdet ovan:
   - js/push.js                     const VAPID_PUBLIC = "..."
   - api/push.php                   const VAPID_PUBLIC = '...'
   - scripts/scraper/lib/webpush.mjs export const VAPID_PUBLIC = "..."
   Committa och ladda upp sidan.

3. OBS: med ett nytt nyckelpar slutar alla befintliga prenumerationer att fungera. Besökarna måste
   stänga av och slå på notiserna igen under Butiker → Notiser.

Har du bara tappat bort var nyckeln ligger men har kvar värdet? Kontrollera det med:
   node scripts/generate-vapid.mjs --check
`);
