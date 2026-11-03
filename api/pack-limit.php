<?php
// Begränsar hur många pack en besökare får öppna per dag: 10 per IP-adress.
//   GET  api/pack-limit.php?action=status  -> hur många som är kvar
//   POST api/pack-limit.php?action=open    -> räknar upp ett öppnande, eller 429 om dagens 10 är slut
// IP-adressen sparas aldrig i klartext, bara som saltad hash. Räknaren och saltet byts vid midnatt (svensk tid), så att
// gårdagens summor inte går att räkna tillbaka genom att prova alla IP-adresser.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const PACK_LIMIT = 10;

function respond(int $status, array $body): void {
  http_response_code($status);
  echo json_encode($body, JSON_UNESCAPED_UNICODE);
  exit;
}

$action = $_GET['action'] ?? 'status';
if (!in_array($action, ['status', 'open'], true)) respond(400, ['ok' => false, 'error' => 'Okänd åtgärd.']);
if ($action === 'open' && ($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') respond(405, ['ok' => false, 'error' => 'POST krävs.']);

date_default_timezone_set('Europe/Stockholm');
$day = date('Y-m-d');
// Besökarens IP-adress bakom Cloudflare (clientIp), delad med de andra api-filerna.
require __DIR__ . '/client-ip.php';
$ip = clientIp();

// Filen ligger bredvid public_html om det går (så att den inte kan laddas ner), annars i systemets temp-mapp.
$parent = dirname(__DIR__, 2);
$dir = (is_dir($parent) && is_writable($parent)) ? $parent : sys_get_temp_dir();
$file = $dir . '/lootninja-pack-limit.json';

$fh = @fopen($file, 'c+');
if (!$fh || !flock($fh, LOCK_EX)) {
  // Går räknaren inte att skriva släpps besökaren igenom hellre än att sidan slutar fungera.
  respond(200, ['ok' => true, 'left' => PACK_LIMIT, 'limit' => PACK_LIMIT, 'counted' => false]);
}

$data = json_decode(stream_get_contents($fh) ?: '{}', true);
if (!is_array($data)) $data = [];
if (($data['day'] ?? '') !== $day || empty($data['salt'])) { $data = ['day' => $day, 'salt' => bin2hex(random_bytes(16)), 'ips' => []]; }

$key = hash('sha256', $data['salt'] . '|' . $ip . '|' . $day);
$used = (int)($data['ips'][$key] ?? 0);

if ($action === 'open') {
  if ($used >= PACK_LIMIT) {
    flock($fh, LOCK_UN); fclose($fh);
    respond(429, ['ok' => false, 'used' => $used, 'left' => 0, 'limit' => PACK_LIMIT, 'error' => 'Dagens 10 pack är slut.']);
  }
  $used++;
  $data['ips'][$key] = $used;
  ftruncate($fh, 0); rewind($fh); fwrite($fh, json_encode($data));
}

flock($fh, LOCK_UN); fclose($fh);
respond(200, ['ok' => true, 'used' => $used, 'left' => max(0, PACK_LIMIT - $used), 'limit' => PACK_LIMIT]);
