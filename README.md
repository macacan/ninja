# Ninjaloot

Statisk webbplats för kortsläpp, set, kortpriser, nyheter och butikslager.

## Köra lokalt

```bash
npx http-server -p 5173 -c-1
```

Öppna http://localhost:5173.

## Automatiska uppdateringar

| Vad | Skript | Schema (GitHub Actions) |
|---|---|---|
| Nyheter och videor | `node scripts/update-news.mjs` | var 3:e timme, `.github/workflows/news.yml` |
| Butikslager | `node scripts/scraper/daemon.mjs` | hela tiden (varannan minut per butik), sparas var 10:e minut, `.github/workflows/scrape.yml` |

Båda skriver JSON till `data/`, som sidan läser.

## Butiksbevakningen

Egen kod, inga beroenden. Den läser butikernas egna publika format:

- **Shopify**: `/products.json`
- **WooCommerce**: Store API `/wp-json/wc/store/v1/products`
- **Övriga** (Quickbutik, Starweb, Magento m.fl.): butikens sitemap och schema.org-data (JSON-LD eller microdata) på produktsidorna, ett begränsat antal sidor per körning.

Regler som alltid gäller:

- `robots.txt` kontrolleras före varje URL. Spärrade sidor hämtas inte.
- En förfrågan i taget per butik, minst 3 sekunder mellan anrop (längre om butiken anger `Crawl-delay` eller svarar 429/503).
- Boten identifierar sig som `NinjalootBot`. **Fyll i `scripts/scraper/config.json`** med din webbadress och e-post innan du kör skarpt.

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

### Löpande bevakning (varannan minut)

```bash
node scripts/scraper/daemon.mjs
```

På Windows går det också att dubbelklicka på `start-bevakning.cmd`.

- Varje butik har en egen klocka: varannan minut som standard, var femte minut för butiker som anger `Crawl-delay` eller svarar 429/503, och nytt försök efter tio minuter om en butik inte svarar.
- Sitemap-butiker läser 8 produktsidor per varv, och sitemapen läses om var 30:e minut. Nya produkt-URL:er läses först.
- Resultatet sparas i `data/` var 20:e sekund, och notiser skickas direkt när något ändras.
- Ändra takten i `scripts/scraper/config.json`: `intervalMinutes`, `calmIntervalMinutes`, `concurrency`.

- Butiker med botskydd (Cloudflare, Akamai m.fl.) försöker vi aldrig ta oss förbi. De markeras som blockerade och kollas igen först efter sex timmar. Ber en butik oss vänta längre än två minuter (`Retry-After`) väntar schemat så länge.
- Kör inte daemon.mjs och GitHub Actions-jobbet samtidigt: då bevakas butikerna dubbelt och notiserna kommer två gånger. Sätt repo-variabeln `SCRAPE_ON_ACTIONS=false` för att stänga av Actions-jobbet.

### På GitHub Actions

GitHub startar schemalagda jobb bara några gånger per dygn för det här repot, oavsett cron. Därför kör `scrape.yml` daemon.mjs i ungefär 5,5 timmar (`DAEMON_MINUTES`), committar ändrade filer var 10:e minut och startar sedan nästa körning själv. Cron-schemat är bara en reserv om kedjan bryts.

- Repo-variabler: `SCRAPE_COMMIT_MINUTES` (hur ofta det sparas, standard 10) och `SCRAPE_DAEMON_MINUTES` (längd per körning, standard 330).
- Boten committar ofta, så kör `git pull --rebase` innan du pushar egna ändringar.
- Vill du hellre köra på en egen server eller dator: sätt `SCRAPE_ON_ACTIONS=false` och starta daemon.mjs där.
