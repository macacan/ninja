# Lootninja

Statisk webbplats för kortsläpp, set, kortpriser, nyheter och butikslager.

## Köra lokalt

```bash
npx http-server -p 5173 -c-1
```

Öppna http://localhost:5173.

## Automatiska uppdateringar

| Vad | Skript | Schema (GitHub Actions) |
|---|---|---|
| Nyheter och videor | `node scripts/update-news.mjs` | varje timme, i `.github/workflows/scrape.yml` (reserv: `news.yml`) |
| Släppkalendern | `node scripts/update-releases.mjs` | varje timme, i `scrape.yml` (reserv: `news.yml`) |
| Kortskannerns bildindex | `node scripts/build-card-index.mjs` (kräver `npm i --no-save sharp`) | första dagen varje månad, `.github/workflows/card-index.yml` |
| Butikslager | `node scripts/scraper/daemon.mjs` | var 15:e minut per butik, sparas en gång i timmen, `.github/workflows/scrape.yml` |

Båda skriver JSON till `data/`, som sidan läser.

## Släppkalendern

`data/release-calendar.json` byggs automatiskt och är det släppsidan läser. Den slås ihop av:

- **`data/releases.json`** – handskrivna släpp med produktomgångar, beskrivning och förrelease. Vinner alltid när något krockar. Skriv in eller rätta släpp här.
- **Bulbapedia** – set och produkter som är annonserade men inte släppta (sidor märkta "upcoming"). Nya set kommer med automatiskt, även utan datum.
- **TCGdex** – set som har släppts de senaste 60 dagarna.

Ändra aldrig `release-calendar.json` för hand, den skrivs över.

## Butiksbevakningen

Egen kod, inga beroenden. Den läser butikernas egna publika format:

- **Shopify**: `/products.json`
- **WooCommerce**: Store API `/wp-json/wc/store/v1/products`
- **Övriga** (Quickbutik, Starweb, Magento m.fl.): butikens sitemap och schema.org-data (JSON-LD eller microdata) på produktsidorna, ett begränsat antal sidor per körning.

Regler som alltid gäller:

- `robots.txt` kontrolleras före varje URL. Spärrade sidor hämtas inte.
- En förfrågan i taget per butik, minst 3 sekunder mellan anrop (längre om butiken anger `Crawl-delay` eller svarar 429/503).
- Boten identifierar sig som `PackninjaBot`. **Fyll i `scripts/scraper/config.json`** med din webbadress och e-post innan du kör skarpt.

### Vilka butiker som hämtas

Styrs av `status` i `scripts/scraper/stores.json`:

| status | betyder | hämtas |
|---|---|---|
| `tillstand` | butiken har gett skriftligt ok | ja |
| `ej-forbjuden` | inget förbud hittat i villkor eller robots.txt (kontrollerat 2026-10-12) | ja |
| `okand` | villkoren hittades inte, läs dem manuellt | nej |
| `forbjuden` | villkoren eller robots.txt förbjuder det | aldrig |

Vill du bara hämta butiker som gett tillstånd: `SCRAPE_STATUSES=tillstand node scripts/scraper/run.mjs`.

Testa en butik: `node scripts/scraper/run.mjs --only=poketalk`.

### Löpande bevakning (var tionde minut)

```bash
node scripts/scraper/daemon.mjs
```

På Windows går det också att dubbelklicka på `start-bevakning.cmd`.

- Varje butik har en egen klocka: var tionde minut som standard, var tjugonde minut för butiker som anger `Crawl-delay` eller svarar 429/503, högst en gång i timmen mellan 01 och 07, och nytt försök efter tio minuter om en butik inte svarar. Svar med `ETag` eller `Last-Modified` hämtas villkorligt, så en oförändrad sida ger bara ett tomt 304-svar.
- Sitemap-butiker läser 8 produktsidor per varv, och sitemapen läses om var 30:e minut. Nya produkt-URL:er läses först.
- Resultatet sparas i `data/` var 20:e sekund, och notiser skickas direkt när något ändras.
- Ändra takten i `scripts/scraper/config.json`: `intervalMinutes`, `calmIntervalMinutes`, `nightFrom`, `nightTo`, `nightIntervalMinutes`, `concurrency`.

- Butiker med botskydd (Cloudflare, Akamai m.fl.) försöker vi aldrig ta oss förbi. De markeras som blockerade och kollas igen först efter sex timmar. Ber en butik oss vänta längre än två minuter (`Retry-After`) väntar schemat så länge.
- Kör inte daemon.mjs och GitHub Actions-jobbet samtidigt: då bevakas butikerna dubbelt och notiserna kommer två gånger. Sätt repo-variabeln `SCRAPE_ON_ACTIONS=false` för att stänga av Actions-jobbet.

### På GitHub Actions

GitHub startar schemalagda jobb bara några gånger per dygn för det här repot, oavsett cron. Därför kör `scrape.yml` daemon.mjs i ungefär 5,5 timmar (`DAEMON_MINUTES`) med en kontroll per butik var 15:e minut. En gång i timmen hämtas nyheterna och ändrade filer committas. Sedan startar jobbet nästa körning själv. Notiser skickas direkt, inte bara vid commit. Cron-schemat är bara en reserv om kedjan bryts.

- Repo-variabler: `SCRAPE_INTERVAL_MINUTES` (minuter mellan kontrollerna per butik, standard 15), `SCRAPE_COMMIT_MINUTES` (hur ofta det sparas, standard 60) och `SCRAPE_DAEMON_MINUTES` (längd per körning, standard 330).
- Boten committar ofta, så kör `git pull --rebase` innan du pushar egna ändringar.
- Vill du hellre köra på en egen server eller dator: sätt `SCRAPE_ON_ACTIONS=false` och starta daemon.mjs där.

## Kortskannern (värderingssidan)

`js/card-scanner.js`, inga beroenden utöver Tesseract.js.

1. **Hitta kortet:** först kanterna nära ramen på skärmen (snabbt). Hittas de inte letas kortets fyra hörn i hela bilden med kanter och Hough-linjer (`js/scan/quad.js`). Kortet rätas sedan ut med en homografi.
2. **Bilden:** konstverket görs om till ett litet avtryck (`js/scan/fingerprint.js`) och jämförs med ett index över ca 22 000 kort i `data/hashes.*`. Det byggs första dagen varje månad av arbetsflödet **Bygg kortindex** (`scripts/build-card-index.mjs`) från TCGdex-bilderna, plus reservbilderna i `data/card-images.json`.
3. **Texten:** namn och nummer läses med Tesseract. Stämmer numret inte med något av korten som liknar bilden läses nummerraden igen på fler sätt (gråskala med kontrast för mörka kort, smalare och högre zoner).
4. **Avgör:** nummer + bild som pekar på samma kort, eller nummer + setstorlek där bilden avgör mellan seten, eller en mycket tydlig bildträff. Annars söks kortet på namn och nummer som förut.

## Sökmotorer (SEO)

- **Varje sida** har titel, beskrivning, `canonical`, Open Graph-taggar, en `h1` (dold för ögat) och strukturerad data (JSON-LD: `WebSite` + `Organization` på startsidan, `BreadcrumbList` på övriga). Ändrar du en sidas titel eller beskrivning: ändra också `og:title`/`og:description` bredvid.
- **`sitemap.xml`** byggs av `node scripts/build-sitemap.mjs`. En sida får dagens datum (`lastmod`) när dess HTML eller datan den visar ändrats, högst en gång per dag. Bevakningsjobbet (`scrape.yml`) kör skriptet vid varje sparning. Ny sida? Lägg till den i `PAGES` i skriptet.
- **IndexNow** (Bing, DuckDuckGo, Yahoo, Ecosia, Yandex m.fl.) pingas automatiskt med sidorna som fått nytt datum. Nyckeln ligger i `b8d9e432225c36038641009f3d2fd24e.txt` i roten och får inte tas bort.
- **Setsidorna** (`set/<namn>.html` och översikten `set/index.html`) byggs av `node scripts/build-set-pages.mjs` från `data/sets/` (alla set och kort från TCGdex, hämtas av `scripts/update-sets.mjs`), prishistoriken i `data/card-history/` och släppkalendern. Ändra aldrig filerna i `set/` för hand, de skrivs över. Korttrender-jobbet (`trends.yml`) hämtar seten och bygger sidorna varje morgon, och bevakningsjobbet bygger om dem när släppkalendern ändras. Butikernas lager på sidorna hämtas live av `js/setpage.js`.
- **Kortbilder som TCGdex saknar** (Shiny Vault, Trainer Gallery, Shining Legends, McDonald's, promos m.fl.) fylls i av `scripts/update-card-images.mjs` i `data/card-images.json`, från Pokémon TCG API:s öppna data på GitHub. Körs varje morgon i `trends.yml`. Bildadresser gissas aldrig: Scrydex svarar "finns" även för fel kort. Kort utan bild visar kortets baksida. Saknas en logga helt visas setets namn som textlogga.
- **Favicon**: `favicon.ico` (16/32/48 px) i roten, `logo.svg`, `img/favicon-48.png`, `img/apple-touch-icon.png` och `site.webmanifest` (Android). Alla sidor länkar till samma uppsättning.
- **`data/stock.json`** skrivs av bevakningen bredvid `products.json` och innehåller bara det som går att köpa (ca 1 MB i stället för 4 MB). Startsidan och setsidorna läser den, så att sidorna laddar snabbt, vilket Google väger in.
- `artikel.html` är `noindex`: artiklarna är sammanfattningar av andras texter och ska inte konkurrera med originalen.
- `.htaccess` skickar `www.` och `http://` till `https://lootninja.se` i ett enda steg, och märker JSON-filerna `noindex`.

### Koppla Google (görs en gång)

1. Gå till [Google Search Console](https://search.google.com/search-console) och välj **Lägg till egendom → Domän**, skriv `lootninja.se`.
2. Google ger en TXT-post. Lägg in den i Hostinger: **hPanel → Domäner → lootninja.se → DNS / Nameservers → Lägg till post**, typ `TXT`, namn `@`. Klicka **Verifiera** i Search Console (kan ta upp till en timme).
3. Under **Webbplatskartor**: skicka in `https://lootninja.se/sitemap.xml`.
4. Under **Webbadressgranskning**: klistra in `https://lootninja.se/` och klicka **Begär indexering**. Gör gärna samma sak för butiker, priser, släpp och värdering.

### Koppla Bing

Gå till [Bing Webmaster Tools](https://www.bing.com/webmasters) och välj **Importera från Google Search Console**. Då följer sitemapen med. Bing driver också DuckDuckGo, Yahoo och Ecosia.
