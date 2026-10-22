<?php
// Pushnotiser: sparar besökarnas prenumerationer (notistjänstens adress, krypteringsnycklarna och urvalet).
//   POST ?action=subscribe    { subscription: { endpoint, keys: { p256dh, auth } }, prefs: {...} }  (besökaren)
//   POST ?action=unsubscribe  { endpoint }                                                       (besökaren)
//   GET  ?action=list                                                     (bevakningen, signerad med VAPID-nyckeln)
//   POST ?action=prune        { ids: [...] }  tar bort prenumerationer som notistjänsten sagt inte finns (bevakningen)
// Bevakningen (scripts/scraper/lib/notify.mjs) bevisar vem den är med en JWT signerad med samma hemliga nyckel som
// notiserna. Här kontrolleras den mot den publika nyckeln, så ingen hemlighet behöver ligga på servern.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

const VAPID_PUBLIC = 'BHvJoQFrJA9X88GAo28EelLurqVR-ullGo6OUT2YrCXGcB43V9Y9obaS9ox-Qq_bAuItSf_GIexVrvpF1LOYtHw';
const AUDIENCE = 'https://lootninja.se/api/push.php';
const MAX_SUBS = 20000;
// Samma lista som PUSH_HOST i scripts/scraper/lib/webpush.mjs.
const PUSH_HOST = '/^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/';

function respond(int $code, array $body): void {
  http_response_code($code);
  echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}
function b64u(string $s): string|false { return base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true); }

// ---------- Bevakningens signatur (ES256) ----------
function derInt(string $b): string {
  $b = ltrim($b, "\0");
  if ($b === '' || ord($b[0]) > 0x7f) $b = "\0" . $b;
  return "\x02" . chr(strlen($b)) . $b;
}
function adminOk(): bool {
  // Eget huvud: Authorization tas ibland bort av webbhotellet innan det når PHP.
  $h = $_SERVER['HTTP_X_LOOTNINJA_AUTH'] ?? '';
  if (!preg_match('/^([\w-]+)\.([\w-]+)\.([\w-]+)$/', $h, $m)) return false;
  $claims = json_decode(b64u($m[2]) ?: '', true);
  if (!is_array($claims) || ($claims['aud'] ?? '') !== AUDIENCE || ($claims['exp'] ?? 0) < time() || ($claims['exp'] ?? 0) > time() + 600) return false;
  $sig = b64u($m[3]);
  if ($sig === false || strlen($sig) !== 64) return false;
  $der = derInt(substr($sig, 0, 32)) . derInt(substr($sig, 32));
  $der = "\x30" . chr(strlen($der)) . $der;
  $pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode(hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . b64u(VAPID_PUBLIC)), 64, "\n") . "-----END PUBLIC KEY-----\n";
  return openssl_verify("$m[1].$m[2]", $der, $pem, OPENSSL_ALGO_SHA256) === 1;
}

// ---------- Indata från besökaren ----------
function cleanList($v, int $max, int $len = 120): array {
  if (!is_array($v)) return [];
  $out = [];
  foreach (array_slice($v, 0, $max) as $s) if (is_string($s) && $s !== '' && strlen($s) <= $len) $out[] = $s;
  return array_values(array_unique($out));
}
function cleanPrefs($p): array {
  $p = is_array($p) ? $p : [];
  return [
    'stores' => cleanList($p['stores'] ?? [], 300), 'types' => cleanList($p['types'] ?? [], 60), 'sets' => cleanList($p['sets'] ?? [], 400),
    'langs' => cleanList($p['langs'] ?? [], 20), 'kinds' => cleanList($p['kinds'] ?? [], 10), 'watch' => cleanList($p['watch'] ?? [], 500, 200),
    'maxPrice' => max(0, min(1000000, (int)($p['maxPrice'] ?? 0))),
  ];
}
function validEndpoint($e): bool {
  if (!is_string($e) || strlen($e) > 1000) return false;
  $u = parse_url($e);
  return ($u['scheme'] ?? '') === 'https' && preg_match(PUSH_HOST, strtolower($u['host'] ?? ''));
}

// ---------- Lagring: en fil bredvid public_html (kan inte laddas ner), som packräknaren ----------
$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if (!in_array($action, ['subscribe', 'unsubscribe', 'list', 'prune'], true)) respond(400, ['ok' => false, 'error' => 'Okänd åtgärd.']);
if ($action === 'list' ? $method !== 'GET' : $method !== 'POST') respond(405, ['ok' => false]);
if (in_array($action, ['list', 'prune'], true) && !adminOk()) respond(401, ['ok' => false]);

$raw = $method === 'POST' ? file_get_contents('php://input', false, null, 0, 16384) : '';
$in = $raw ? json_decode($raw, true) : [];
if ($method === 'POST' && !is_array($in)) respond(400, ['ok' => false, 'error' => 'Felaktig data.']);

$parent = dirname(__DIR__, 2);
$dir = (is_dir($parent) && is_writable($parent)) ? $parent : sys_get_temp_dir();
$fh = @fopen($dir . '/lootninja-push.json', 'c+');
if (!$fh || !flock($fh, $action === 'list' ? LOCK_SH : LOCK_EX)) respond(503, ['ok' => false, 'error' => 'Försök igen om en stund.']);
$data = json_decode(stream_get_contents($fh) ?: '{}', true);
$subs = is_array($data['subs'] ?? null) ? $data['subs'] : [];

function save($fh, array $subs): void { ftruncate($fh, 0); rewind($fh); fwrite($fh, json_encode(['subs' => $subs], JSON_UNESCAPED_SLASHES)); fflush($fh); }

if ($action === 'list') {
  flock($fh, LOCK_UN); fclose($fh);
  $out = [];
  foreach ($subs as $id => $s) $out[] = ['id' => $id] + $s;
  respond(200, ['ok' => true, 'subs' => $out]);
}

if ($action === 'prune') {
  foreach (cleanList($in['ids'] ?? [], 5000, 64) as $id) unset($subs[$id]);
  save($fh, $subs); flock($fh, LOCK_UN); fclose($fh);
  respond(200, ['ok' => true, 'count' => count($subs)]);
}

$endpoint = $action === 'subscribe' ? ($in['subscription']['endpoint'] ?? null) : ($in['endpoint'] ?? null);
if (!validEndpoint($endpoint)) { flock($fh, LOCK_UN); respond(400, ['ok' => false, 'error' => 'Okänd notistjänst.']); }
$id = hash('sha256', $endpoint);

if ($action === 'unsubscribe') {
  unset($subs[$id]);
} else {
  $p256dh = $in['subscription']['keys']['p256dh'] ?? '';
  $auth = $in['subscription']['keys']['auth'] ?? '';
  $k1 = is_string($p256dh) ? b64u($p256dh) : false; $k2 = is_string($auth) ? b64u($auth) : false;
  if ($k1 === false || strlen($k1) !== 65 || $k1[0] !== "\x04" || $k2 === false || strlen($k2) !== 16) { flock($fh, LOCK_UN); respond(400, ['ok' => false, 'error' => 'Felaktiga nycklar.']); }
  if (!isset($subs[$id]) && count($subs) >= MAX_SUBS) { flock($fh, LOCK_UN); respond(503, ['ok' => false, 'error' => 'Fullt just nu.']); }
  $subs[$id] = ['endpoint' => $endpoint, 'keys' => ['p256dh' => $p256dh, 'auth' => $auth], 'prefs' => cleanPrefs($in['prefs'] ?? []), 'updated' => time()];
}
save($fh, $subs); flock($fh, LOCK_UN); fclose($fh);
respond(200, ['ok' => true]);
