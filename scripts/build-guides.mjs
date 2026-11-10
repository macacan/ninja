// Bygger guidesidorna under /guider/ från data/guides.json: en översikt (guider/index.html) och en sida per spel
// med frågor och svar. Varje fråga syns på sidan (utfällbar) och finns även som FAQPage i JSON-LD, så att sökmotorer
// och AI-tjänster kan läsa svaren. Körs med: node scripts/build-guides.mjs
// Lägg till eller ändra frågor i data/guides.json och kör skriptet igen. Glöm inte sitemapen (scripts/build-sitemap.mjs).
import { readFile, writeFile, mkdir } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const SITE = "https://lootninja.se";
const data = JSON.parse(await readFile(new URL("data/guides.json", ROOT), "utf8"));

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Svaren får bara innehålla interna länkar (<a href="...">). Allt annat escapas.
const answerHtml = (s) => {
  const parts = String(s).split(/(<a href="[^"<>]+">|<\/a>)/);
  return parts.map((p) => /^<a href="[^"<>]+">$/.test(p) ? `<a href="${esc(p.slice(9, -2))}">` : p === "</a>" ? p : esc(p)).join("");
};
const plain = (s) => String(s).replace(/<[^>]+>/g, "");
// JSON i <script>: "</" får inte förekomma.
const ld = (o) => JSON.stringify(o).replace(/<\//g, "<\\/");

const STATIC_FOOTER = `<footer class="static-footer">
  <nav aria-label="Huvudsidor och om sajten"><ul>
    <li><a href="/">Hem</a></li>
    <li><a href="/butiker.html">Produkter och butikslager</a></li>
    <li><a href="/priser.html">Kortpriser</a></li>
    <li><a href="/vardering.html">Värdering</a></li>
    <li><a href="/slapp.html">Släppkalender</a></li>
    <li><a href="/set/">Alla set</a></li>
    <li><a href="/nyheter.html">Nyheter</a></li>
    <li><a href="/guider/">Guider</a></li>
    <li><a href="/om.html">Om Lootninja</a></li>
    <li><a href="/villkor.html" rel="terms-of-service">Användarvillkor</a></li>
    <li><a href="/integritet.html" rel="privacy-policy">Integritet och kakor</a></li>
  </ul></nav>
</footer>`;

function page({ path, title, description, crumbs, graph, body }) {
  const url = `${SITE}/${path}`;
  const crumbHtml = crumbs.map(([name, href], i) => i === crumbs.length - 1
    ? `<span aria-current="page">${esc(name)}</span>` : `<a href="${href}">${esc(name)}</a><span aria-hidden="true">›</span>`).join("");
  const breadcrumb = { "@type": "BreadcrumbList", "@id": `${url}#breadcrumb`, itemListElement: crumbs.map(([name, href], i) => ({
    "@type": "ListItem", position: i + 1, name, item: `${SITE}/${href === "./" ? "" : href}`,
  })) };
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<!-- Byggd av scripts/build-guides.mjs från data/guides.json. Ändra där, inte här. -->
<!-- Sidan ligger i guider/. base gör att css, js och länkar hämtas från roten som på alla andra sidor. -->
<base href="/">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="max-image-preview:large">
<meta name="theme-color" content="#1b1e28">
<meta name="theme-color" content="#1b1e28" media="(prefers-color-scheme: dark)">
<link rel="icon" href="img/icon-192.png?v=4" sizes="192x192" type="image/png">
<link rel="icon" href="img/favicon-48.png?v=4" sizes="48x48" type="image/png">
<link rel="apple-touch-icon" href="img/apple-touch-icon.png?v=4">
<link rel="manifest" href="site.webmanifest">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Lootninja">
<meta property="og:locale" content="sv_SE">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/img/og-lootninja.jpg?v=20261109">
<meta property="og:image:alt" content="Lootninja – Pokémon, One Piece och Riftbound: släpp, butikslager och priser">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${ld({ "@context": "https://schema.org", "@graph": [...graph(url), breadcrumb] })}</script>
<link href="fonts/fonts.css" rel="stylesheet">
<link rel="stylesheet" href="style.css?v=20261110a">
<link rel="stylesheet" href="dark.css?v=20261029b" id="dark-css" media="(prefers-color-scheme: dark)">
<script src="js/theme.js?v=20261106"></script>
</head>
<body>
<main id="main">
  <header class="page-head">
    <div class="wrap">
      <nav class="crumbs" aria-label="Brödsmulor">${crumbHtml}</nav>
    </div>
    <canvas class="scene" data-scene="strip" aria-hidden="true"></canvas>
  </header>
  <div class="wrap prose guide-page">
${body}
  </div>
</main>
<!-- Länkarna som finns i sidfoten, direkt i HTML:en för sökmotorer och AI-agenter som inte kör skript.
     js/site.js byter ut den mot den riktiga sidfoten. -->
${STATIC_FOOTER}
<script type="module" src="js/site.js?v=20261106a"></script>
</body>
</html>
`;
}

const count = (g) => g.groups.reduce((n, gr) => n + gr.qs.length, 0);
const updated = `<p class="guide-updated">Senast uppdaterad <time datetime="${data.updated}">${new Date(data.updated).toLocaleDateString("sv-SE", { day: "numeric", month: "long", year: "numeric" })}</time>. Svaren är vägledande, kolla alltid de officiella reglerna inför turneringar.</p>`;

await mkdir(new URL("guider/", ROOT), { recursive: true });

for (const g of data.guides) {
  const path = `guider/${g.slug}.html`;
  const all = g.groups.flatMap((gr) => gr.qs);
  const body = `    <h1>${esc(g.h1)}</h1>
    <p class="lead">${answerHtml(g.intro)}</p>
    <nav class="guide-toc" aria-label="Innehåll"><ul>${g.groups.map((gr, i) => `<li><a href="${path}#del-${i + 1}">${esc(gr.name)}</a></li>`).join("")}</ul></nav>
${g.groups.map((gr, i) => `    <section aria-labelledby="del-${i + 1}">
      <h2 id="del-${i + 1}">${esc(gr.name)}</h2>
      <div class="seo-faq">
${gr.qs.map((x) => `        <details>
          <summary>${esc(x.q)}</summary>
          <p>${answerHtml(x.a)}</p>
        </details>`).join("\n")}
      </div>
    </section>`).join("\n")}
    ${updated}
${g.sources?.length ? `    <p class="guide-updated">Officiella källor: ${g.sources.map(([name, href]) => `<a href="${esc(href)}" rel="noopener">${esc(name)}</a>`).join(" · ")}</p>\n` : ""}    <p class="guide-more">Fler guider: ${data.guides.filter((o) => o !== g).map((o) => `<a href="guider/${o.slug}.html">${esc(o.game)}</a>`).join(" · ")} · <a href="guider/">Alla guider</a></p>`;
  const html = page({
    path, title: g.title, description: g.description,
    crumbs: [["Hem", "./"], ["Guider", "guider/"], [g.game, path]],
    graph: (url) => [{
      "@type": "FAQPage", "@id": `${url}#faq`, url, name: g.h1, description: g.description, inLanguage: "sv-SE",
      dateModified: data.updated, isPartOf: { "@id": `${SITE}/#website` }, publisher: { "@id": `${SITE}/#org` },
      about: { "@type": "Thing", name: g.game }, breadcrumb: { "@id": `${url}#breadcrumb` },
      ...(g.sources?.length ? { citation: g.sources.map(([name, href]) => ({ "@type": "CreativeWork", name, url: href })) } : {}),
      mainEntity: all.map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: plain(x.a) } })),
    }],
    body,
  });
  await writeFile(new URL(path, ROOT), html);
  console.log(`${path}: ${all.length} frågor`);
}

// Översikten
const indexBody = `    <h1>Guider</h1>
    <p class="lead">Korta svar på vanliga frågor om Pokémon TCG, One Piece Card Game och Riftbound: hur man börjar, vad boxarna innehåller, sällsynthet, kortvärde, regler och var man hittar produkterna i svenska butiker.</p>
    <ul class="guide-list">
${data.guides.map((g) => `      <li><a href="guider/${g.slug}.html"><b>${esc(g.h1)}</b></a><br>${esc(g.description)} <small>(${count(g)} frågor)</small></li>`).join("\n")}
    </ul>
    ${updated}`;
await writeFile(new URL("guider/index.html", ROOT), page({
  path: "guider/", title: "Guider – frågor och svar om Pokémon TCG, One Piece och Riftbound",
  description: "Lootninjas guider med korta svar om Pokémon TCG, One Piece Card Game och Riftbound: produkter, sällsynthet, kortvärde, regler och var man köper i Sverige.",
  crumbs: [["Hem", "./"], ["Guider", "guider/"]],
  graph: (url) => [{
    "@type": "CollectionPage", "@id": `${url}#page`, url, name: "Guider", inLanguage: "sv-SE", isPartOf: { "@id": `${SITE}/#website` },
    breadcrumb: { "@id": `${url}#breadcrumb` },
    hasPart: data.guides.map((g) => ({ "@id": `${SITE}/guider/${g.slug}.html#faq` })),
  }],
  body: indexBody,
}));
console.log("guider/index.html");
