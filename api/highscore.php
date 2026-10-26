<?php
// Packöppnarens globala räknare och topplista (js/restock.js).
//   GET  ?action=stats                               -> { ok, totalOpened }
//   POST ?action=open      { set_id }                -> räknar upp ett öppnat pack: { ok, totalOpened, token }
//   GET  ?action=leaderboard&period=week|month|all   -> topp 10 efter packets värde
//   POST ?action=submit    { token, name, pack_value, set_id, set_name, best_card_name, best_card_value, best_card_img }
// Fuskskydd: ett resultat kräver token från ett pack som faktiskt öppnats (en gång, inom två timmar och samma set),
// värden över 25 000 kr avvisas och varje IP-adress (bara som saltad kontrollsumma) får ett begränsat antal anrop.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');
date_default_timezone_set('Europe/Stockholm');

const MAX_PACK_VALUE = 25000; // kronor
const TOKEN_TTL = 7200;       // sekunder
const TOP = 10;
// Namnfiltret (inbyggda ord plus de som lagts till i statistikens dashboard) delas med stats/dashboard.php.
require __DIR__ . '/name-filter.php';

function respond(int $code, array $body): void {
  http_response_code($code);
  echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

// Cloudflares adresser, som i api/pack-limit.php: bara därifrån går det att lita på CF-Connecting-IP.
const CLOUDFLARE = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
function inRange(string $ip, string $cidr): bool {
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
function visitorIp(): string {
  $remote = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
  $cf = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? '';
  if ($cf !== '' && filter_var($cf, FILTER_VALIDATE_IP)) {
    foreach (CLOUDFLARE as $range) if (inRange($remote, $range)) return $cf;
  }
  return $remote;
}

// ---------- Lagring: SQLite bredvid public_html (kan inte laddas ner), som packräknaren och pushnotiserna ----------
function db(): PDO {
  $parent = dirname(__DIR__, 2);
  $dir = (is_dir($parent) && is_writable($parent)) ? $parent : sys_get_temp_dir();
  $db = new PDO('sqlite:' . $dir . '/lootninja-game.db', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
  $db->exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  $db->exec('CREATE TABLE IF NOT EXISTS pack_pulls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    name TEXT NOT NULL,
    pack_value INTEGER NOT NULL,
    set_id TEXT,
    set_name TEXT,
    best_card_name TEXT,
    best_card_value INTEGER,
    best_card_img TEXT
  )');
  $db->exec('CREATE INDEX IF NOT EXISTS pulls_value ON pack_pulls (pack_value DESC, created_at)');
  $db->exec('CREATE INDEX IF NOT EXISTS pulls_time ON pack_pulls (created_at)');
  $db->exec('CREATE TABLE IF NOT EXISTS pack_stats (id INTEGER PRIMARY KEY CHECK (id = 1), total_opened INTEGER NOT NULL DEFAULT 0)');
  $db->exec('INSERT OR IGNORE INTO pack_stats (id, total_opened) VALUES (1, 0)');
  $db->exec('CREATE TABLE IF NOT EXISTS pack_tokens (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, set_id TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0)');
  $db->exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  $db->exec('CREATE TABLE IF NOT EXISTS rate (key TEXT PRIMARY KEY, win INTEGER NOT NULL, n INTEGER NOT NULL)');
  return $db;
}

// Saltad kontrollsumma av IP-adressen som byts varje dygn. IP-adressen sparas aldrig.
function ipKey(PDO $db): string {
  $secret = $db->query("SELECT v FROM meta WHERE k = 'secret'")->fetchColumn();
  if (!$secret) {
    $db->prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('secret', ?)")->execute([bin2hex(random_bytes(32))]);
    $secret = $db->query("SELECT v FROM meta WHERE k = 'secret'")->fetchColumn();
  }
  return substr(hash('sha256', $secret . '|' . date('Y-m-d') . '|' . visitorIp()), 0, 24);
}

function rateOk(PDO $db, string $key, int $max, int $seconds): bool {
  $win = intdiv(time(), $seconds) * $seconds;
  $row = $db->query('SELECT win, n FROM rate WHERE key = ' . $db->quote($key))->fetch();
  if ($row && (int)$row['win'] === $win) {
    if ((int)$row['n'] >= $max) return false;
    $db->prepare('UPDATE rate SET n = n + 1 WHERE key = ?')->execute([$key]);
  } else {
    $db->prepare('INSERT OR REPLACE INTO rate (key, win, n) VALUES (?, ?, 1)')->execute([$key, $win]);
  }
  return true;
}

function total(PDO $db): int { return (int)$db->query('SELECT total_opened FROM pack_stats WHERE id = 1')->fetchColumn(); }

// Text utan taggar och styrtecken, högst $len tecken.
function clean($v, int $len): string {
  if (!is_string($v)) return '';
  $v = strip_tags($v);
  $v = preg_replace('/[\x00-\x1F\x7F<>"`\\\\]+/u', '', $v) ?? '';
  $v = trim(preg_replace('/\s+/u', ' ', $v) ?? '');
  return mb_substr($v, 0, $len, 'UTF-8');
}

function nameOk(PDO $db, string $name): bool {
  return nameShapeOk($name) && nameBlockedBy($name, nameBlockedWords($db)) === null;
}

// ---------- Anropen ----------
$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$routes = ['stats' => 'GET', 'leaderboard' => 'GET', 'open' => 'POST', 'submit' => 'POST'];
if (!isset($routes[$action])) respond(400, ['ok' => false, 'error' => 'Okänd åtgärd.']);
if ($routes[$action] !== $method) respond(405, ['ok' => false, 'error' => $routes[$action] . ' krävs.']);

$in = [];
if ($method === 'POST') {
  $in = json_decode(file_get_contents('php://input', false, null, 0, 4096) ?: '', true);
  if (!is_array($in)) respond(400, ['ok' => false, 'error' => 'Felaktig data.']);
}

try {
  $db = db();

  if ($action === 'stats') respond(200, ['ok' => true, 'totalOpened' => total($db)]);

  if ($action === 'leaderboard') {
    $period = in_array($_GET['period'] ?? '', ['week', 'month', 'all'], true) ? $_GET['period'] : 'week';
    $from = $period === 'week' ? strtotime('monday this week 00:00') : ($period === 'month' ? strtotime(date('Y-m-01 00:00:00')) : 0);
    $s = $db->prepare('SELECT id, created_at, name, pack_value, set_id, set_name, best_card_name, best_card_value, best_card_img FROM pack_pulls WHERE created_at >= ? ORDER BY pack_value DESC, created_at ASC LIMIT ' . TOP);
    $s->execute([$from]);
    $entries = [];
    foreach ($s->fetchAll() as $i => $r) {
      $entries[] = [
        'rank' => $i + 1, 'id' => (int)$r['id'], 'name' => $r['name'], 'pack_value' => (int)$r['pack_value'],
        'set_id' => $r['set_id'], 'set_name' => $r['set_name'], 'best_card_name' => $r['best_card_name'],
        'best_card_value' => (int)$r['best_card_value'], 'best_card_img' => $r['best_card_img'], 'date' => date('Y-m-d', (int)$r['created_at']),
      ];
    }
    respond(200, ['ok' => true, 'period' => $period, 'entries' => $entries]);
  }

  $ip = ipKey($db);

  if ($action === 'open') {
    $setId = clean($in['set_id'] ?? '', 40);
    if ($setId === '' || !preg_match('/^[A-Za-z0-9._-]+$/', $setId)) respond(400, ['ok' => false, 'error' => 'Okänt set.']);
    // Sidan låter en besökare öppna ett pack om dagen (fler bara när packet är värt under 10 kr), så 30 i timmen räcker gott.
    if (!rateOk($db, 'open:' . $ip, 30, 3600)) respond(429, ['ok' => false, 'error' => 'Lugna ner dig, ninja. Försök igen om en stund.', 'totalOpened' => total($db)]);
    $token = bin2hex(random_bytes(16));
    $db->beginTransaction();
    $db->exec('UPDATE pack_stats SET total_opened = total_opened + 1 WHERE id = 1');
    $db->prepare('INSERT INTO pack_tokens (token, created_at, set_id) VALUES (?, ?, ?)')->execute([$token, time(), $setId]);
    $db->commit();
    if (random_int(1, 50) === 1) {
      $db->prepare('DELETE FROM pack_tokens WHERE created_at < ?')->execute([time() - TOKEN_TTL]);
      $db->prepare('DELETE FROM rate WHERE win < ?')->execute([time() - 2 * 86400]);
    }
    respond(200, ['ok' => true, 'totalOpened' => total($db), 'token' => $token]);
  }

  // submit
  if (!rateOk($db, 'submit:' . $ip, 10, 3600)) respond(429, ['ok' => false, 'error' => 'För många resultat på kort tid. Försök igen senare.']);
  $token = is_string($in['token'] ?? null) ? $in['token'] : '';
  $name = clean($in['name'] ?? '', 20);
  $value = filter_var($in['pack_value'] ?? null, FILTER_VALIDATE_FLOAT);
  $bestValue = filter_var($in['best_card_value'] ?? 0, FILTER_VALIDATE_FLOAT);
  $setId = clean($in['set_id'] ?? '', 40);
  $setName = clean($in['set_name'] ?? '', 60);
  $bestName = clean($in['best_card_name'] ?? '', 60);
  $img = is_string($in['best_card_img'] ?? null) ? $in['best_card_img'] : '';

  if (!nameOk($db, $name)) respond(400, ['ok' => false, 'error' => 'Välj ett annat ninjanick: 2–20 tecken, bokstäver, siffror och mellanslag.']);
  if ($value === false || $value < 1 || $value > MAX_PACK_VALUE) respond(400, ['ok' => false, 'error' => 'Packets värde ser inte rimligt ut.']);
  if ($bestValue === false || $bestValue < 0 || $bestValue > $value + 1) respond(400, ['ok' => false, 'error' => 'Kortets värde ser inte rimligt ut.']);
  // Kortbilderna kommer alltid från TCGdex.
  if ($img !== '' && !preg_match('#^https://assets\.tcgdex\.net/[A-Za-z0-9/._-]{1,200}$#', $img)) $img = '';

  $db->beginTransaction();
  $t = $db->prepare('SELECT created_at, set_id, used FROM pack_tokens WHERE token = ?');
  $t->execute([$token]);
  $row = $t->fetch();
  if (!$row || (int)$row['used'] || (int)$row['created_at'] < time() - TOKEN_TTL || $row['set_id'] !== $setId) {
    $db->rollBack();
    respond(403, ['ok' => false, 'error' => 'Det här packet går inte att skicka in längre. Öppna ett nytt pack.']);
  }
  $db->prepare('UPDATE pack_tokens SET used = 1 WHERE token = ?')->execute([$token]);
  $db->prepare('INSERT INTO pack_pulls (created_at, name, pack_value, set_id, set_name, best_card_name, best_card_value, best_card_img) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    ->execute([time(), $name, (int)round($value), $setId, $setName, $bestName, (int)round($bestValue), $img]);
  $id = (int)$db->lastInsertId();
  $db->commit();
  // Placering denna vecka, så att sidan kan säga "Du är 3:a den här veckan!".
  $r = $db->prepare('SELECT COUNT(*) FROM pack_pulls WHERE created_at >= ? AND pack_value > ?');
  $r->execute([strtotime('monday this week 00:00'), (int)round($value)]);
  respond(200, ['ok' => true, 'id' => $id, 'weekRank' => (int)$r->fetchColumn() + 1]);
} catch (Throwable $e) {
  if (isset($db) && $db->inTransaction()) $db->rollBack();
  respond(503, ['ok' => false, 'error' => 'Topplistan är inte nåbar just nu. Försök igen om en stund.']);
}
