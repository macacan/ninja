<?php
// Delade delar för besöksstatistiken på stats.lootninja.se (api.php tar emot, dashboard.php visar).
// Inga kakor hos besökarna och ingen IP-adress i klartext: en besökare räknas med en kontrollsumma av IP-adress och
// webbläsare plus ett salt som byts varje dygn. Gamla salt raderas, så summan går inte att koppla mellan dagar eller
// räkna tillbaka till en IP-adress.
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === 'lib.php') { http_response_code(404); exit; }

date_default_timezone_set('Europe/Stockholm');

const STATS_KEEP_DAYS = 395; // drygt ett år, sedan raderas händelserna
const STATS_TYPES = ['pageview', 'store_click', 'outbound', 'search', 'watch', 'card_view', 'valuation', 'scan', 'pack_open', 'pack_submit', 'push', 'not_found'];

// Cloudflares egna adresser (samma lista som api/pack-limit.php). Bara då går det att lita på CF-Connecting-IP.
const STATS_CLOUDFLARE = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

function statsInRange(string $ip, string $cidr): bool {
  [$net, $bits] = explode('/', $cidr);
  $a = @inet_pton($ip); $b = @inet_pton($net);
  if ($a === false || $b === false || strlen($a) !== strlen($b)) return false;
  $bits = (int)$bits;
  $bytes = intdiv($bits, 8); $rest = $bits % 8;
  if (substr($a, 0, $bytes) !== substr($b, 0, $bytes)) return false;
  if ($rest === 0) return true;
  $mask = chr((0xff << (8 - $rest)) & 0xff);
  return ($a[$bytes] & $mask) === ($b[$bytes] & $mask);
}

function statsIp(): string {
  $remote = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
  $cf = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? '';
  if ($cf !== '' && filter_var($cf, FILTER_VALIDATE_IP)) {
    foreach (STATS_CLOUDFLARE as $range) if (statsInRange($remote, $range)) return $cf;
  }
  return $remote;
}

// Databasen ligger bredvid public_html (kan inte laddas ner), som packräknaren och pushnotiserna.
function statsDir(): string {
  $parent = dirname(__DIR__, 2);
  return (is_dir($parent) && is_writable($parent)) ? $parent : sys_get_temp_dir();
}

function statsDb(): PDO {
  $db = new PDO('sqlite:' . statsDir() . '/lootninja-stats.db', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
  $db->exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  $db->exec('CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL,
    path TEXT,
    target TEXT,
    value TEXT,
    referrer TEXT,
    device TEXT,
    visitor TEXT
  )');
  $db->exec('CREATE INDEX IF NOT EXISTS events_time ON events (created_at)');
  $db->exec('CREATE INDEX IF NOT EXISTS events_type_time ON events (type, created_at)');
  $db->exec('CREATE TABLE IF NOT EXISTS salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL)');
  $db->exec('CREATE TABLE IF NOT EXISTS rate (key TEXT PRIMARY KEY, win INTEGER NOT NULL, n INTEGER NOT NULL)');
  return $db;
}

// Dagens salt. Gårdagens och äldre raderas, så summorna kan inte räknas tillbaka.
function statsSalt(PDO $db): string {
  $day = date('Y-m-d');
  $salt = $db->query('SELECT salt FROM salts WHERE day = ' . $db->quote($day))->fetchColumn();
  if ($salt) return $salt;
  $salt = bin2hex(random_bytes(16));
  $db->prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)')->execute([$day, $salt]);
  $db->prepare('DELETE FROM salts WHERE day <> ?')->execute([$day]);
  return $db->query('SELECT salt FROM salts WHERE day = ' . $db->quote($day))->fetchColumn() ?: $salt;
}

// Kort kontrollsumma för besökaren i dag: räcker för att räkna unika besökare per dag och för spamskyddet.
function statsVisitor(PDO $db): string {
  return substr(hash('sha256', statsSalt($db) . '|' . statsIp() . '|' . ($_SERVER['HTTP_USER_AGENT'] ?? '')), 0, 16);
}

// Högst $max anrop per $seconds för samma nyckel. Returnerar false när gränsen är nådd.
function statsRateOk(PDO $db, string $key, int $max, int $seconds): bool {
  $window = intdiv(time(), $seconds) * $seconds; // fönstrets start (unix-tid)
  $row = $db->query('SELECT win, n FROM rate WHERE key = ' . $db->quote($key))->fetch();
  if ($row && (int)$row['win'] === $window) {
    if ((int)$row['n'] >= $max) return false;
    $db->prepare('UPDATE rate SET n = n + 1 WHERE key = ?')->execute([$key]);
  } else {
    $db->prepare('INSERT OR REPLACE INTO rate (key, win, n) VALUES (?, ?, 1)')->execute([$key, $window]);
  }
  return true;
}

// Rensar gamla händelser och spamräknare då och då (ungefär vart 200:e anrop).
function statsMaybePrune(PDO $db): void {
  if (random_int(1, 200) !== 1) return;
  $db->prepare('DELETE FROM events WHERE created_at < ?')->execute([date('Y-m-d H:i:s', time() - STATS_KEEP_DAYS * 86400)]);
  $db->prepare('DELETE FROM rate WHERE win < ?')->execute([time() - 2 * 86400]);
}

// Text från besökaren: utan styrtecken och taggar, högst $len tecken.
function statsText($v, int $len): ?string {
  if (!is_string($v) && !is_int($v) && !is_float($v)) return null;
  $v = trim(preg_replace('/[\x00-\x1F\x7F<>]+/u', ' ', (string)$v) ?? '');
  if ($v === '') return null;
  return mb_substr($v, 0, $len, 'UTF-8');
}

// ---------- Källor ----------
// Gör om det sparade värdet (domän, utm_source eller app) till ett namn och en typ av källa. Görs när översikten
// visas, så att nya regler gäller även gamla besök. "internal" (klick inom Lootninja) är ingen källa: null.
const STATS_SOURCES = [
  // [mönster mot värdet, namn, typ]. Första träffen vinner, så AI-tjänster hos Google och Microsoft står före sökmotorerna.
  ['/(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com)$|^chatgpt$/', 'ChatGPT', 'AI'],
  ['/(^|\.)perplexity\.ai$|^perplexity$/', 'Perplexity', 'AI'],
  ['/^(gemini|bard)\.google\.com$|^gemini$/', 'Gemini', 'AI'],
  ['/(^|\.)claude\.ai$|^claude$/', 'Claude', 'AI'],
  ['/^copilot\.microsoft\.com$|^edgeservices\.bing\.com$|^copilot$/', 'Copilot', 'AI'],
  ['/(^|\.)(grok\.com|x\.ai)$|^grok$/', 'Grok', 'AI'],
  ['/(^|\.)(deepseek\.com|chat\.mistral\.ai|you\.com|phind\.com|meta\.ai)$/', 'Annan AI', 'AI'],
  ['/^com\.google\.android\.gm$|(^|\.)mail\.google\.com$|(^|\.)outlook\.(live|office)\.com$/', 'E-post', 'E-post'],
  ['/(^|\.)google\.[a-z.]+$|^com\.google\.android\.googlequicksearchbox$|^google$/', 'Google', 'Sökmotor'],
  ['/(^|\.)bing\.com$|^bing$/', 'Bing', 'Sökmotor'],
  ['/(^|\.)duckduckgo\.com$/', 'DuckDuckGo', 'Sökmotor'],
  ['/(^|\.)(search\.)?yahoo\.[a-z.]+$/', 'Yahoo', 'Sökmotor'],
  ['/(^|\.)(ecosia\.org|startpage\.com|qwant\.com|search\.brave\.com|yandex\.[a-z]+)$/', 'Annan sökmotor', 'Sökmotor'],
  ['/(^|\.)instagram\.com$|^com\.instagram\.|^instagram(-app)?$|^ig$/', 'Instagram', 'Socialt'],
  ['/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$|^com\.facebook\.|^facebook(-app)?$|^fb$/', 'Facebook', 'Socialt'],
  ['/(^|\.)tiktok\.com$|^tiktok(-app)?$/', 'TikTok', 'Socialt'],
  ['/(^|\.)(youtube\.com|youtu\.be)$|^youtube$/', 'YouTube', 'Socialt'],
  ['/(^|\.)reddit\.com$|^reddit$/', 'Reddit', 'Socialt'],
  ['/^(t\.co|x\.com|twitter\.com)$|^(twitter|x)$/', 'X (Twitter)', 'Socialt'],
  ['/(^|\.)(discord\.com|discordapp\.com|discord\.gg)$|^discord(-app)?$/', 'Discord', 'Socialt'],
  ['/(^|\.)snapchat\.com$|^snapchat(-app)?$/', 'Snapchat', 'Socialt'],
  ['/(^|\.)threads\.(net|com)$|^threads$/', 'Threads', 'Socialt'],
  ['/(^|\.)(pinterest\.[a-z.]+|pin\.it)$|^pinterest(-app)?$/', 'Pinterest', 'Socialt'],
  ['/(^|\.)(linkedin\.com|lnkd\.in)$|^linkedin(-app)?$/', 'LinkedIn', 'Socialt'],
  ['/^line-app$/', 'LINE', 'Socialt'],
  ['/(^|\.)flashback\.org$/', 'Flashback', 'Forum'],
  ['/^direct$/', 'Direkt', 'Direkt'],
];

// Mobil, surfplatta eller dator från User-Agent. iPad med iPadOS 13+ säger att den är en Mac och räknas som dator.
function statsDevice(string $ua): string {
  if (preg_match('/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i', $ua)) return 'tablet';
  if (preg_match('/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|Opera Mini/i', $ua)) return 'mobile';
  return 'desktop';
}

// Appens inbyggda webbläsare, eller null.
function statsInApp(string $ua): ?string {
  foreach ([
    '/Instagram/' => 'instagram-app', '/FBAN|FBAV|FB_IAB/' => 'facebook-app', '/musical_ly|BytedanceWebview|TikTok/i' => 'tiktok-app',
    '/Snapchat/i' => 'snapchat-app', '/Discord/i' => 'discord-app', '/LinkedInApp/i' => 'linkedin-app', '/Pinterest/i' => 'pinterest-app', '/\bLine\//' => 'line-app',
  ] as $re => $app) if (preg_match($re, $ua)) return $app;
  return null;
}

function statsSource(?string $ref): ?array {
  $ref = strtolower((string)$ref);
  if ($ref === 'internal' || $ref === 'lootninja.se') return null;
  if ($ref === '') $ref = 'direct';
  foreach (STATS_SOURCES as [$re, $name, $kind]) if (preg_match($re, $ref)) return [$name, $kind];
  return [$ref, 'Andra sidor'];
}

// Sidans namn i stället för adressen, t.ex. "/" → "Startsidan" och "/set/151.html" → "Set: 151".
function statsPageName(string $path): string {
  static $names = [
    '/' => 'Startsidan', '/index.html' => 'Startsidan', '/butiker.html' => 'Butiker och lager', '/priser.html' => 'Kortpriser',
    '/vardering.html' => 'Värdering', '/slapp.html' => 'Släppkalender', '/nyheter.html' => 'Nyheter', '/artikel.html' => 'Artikel',
    '/om.html' => 'Om Lootninja', '/villkor.html' => 'Villkor', '/integritet.html' => 'Integritet', '/set/' => 'Alla set', '/404.html' => 'Sidan finns inte',
  ];
  if (isset($names[$path])) return $names[$path];
  if (preg_match('#^/set/([a-z0-9-]+)\.html$#', $path, $m)) return 'Set: ' . ucwords(str_replace('-', ' ', $m[1]));
  return $path;
}
