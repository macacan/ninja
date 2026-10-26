<?php
// Tar emot händelser från js/tracker.js på lootninja.se.
//   POST api.php  { type, path, target?, value?, referrer?, device? }   (JSON, oftast via navigator.sendBeacon)
// Svarar alltid 204 utan innehåll, så att ett fel här aldrig märks på sidan. Händelser från botar, utan giltig typ
// eller över spamgränsen (60 per minut och besökare) sparas inte.
require __DIR__ . '/lib.php';

const STATS_ORIGINS = ['https://lootninja.se'];

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, STATS_ORIGINS, true)) {
  header('Access-Control-Allow-Origin: ' . $origin);
  header('Access-Control-Allow-Methods: POST');
  header('Access-Control-Allow-Headers: content-type');
  header('Vary: Origin');
}
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

function done(int $code = 204): void { http_response_code($code); exit; }

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') done();
if ($method !== 'POST') done(405);
// Bara från vår egen sida. Webbläsare skickar alltid Origin på sendBeacon och fetch med POST.
if ($origin !== '' && !in_array($origin, STATS_ORIGINS, true)) done(403);

$ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
if ($ua === '' || preg_match('/bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl|wget|python|java\//i', $ua)) done();

$raw = file_get_contents('php://input', false, null, 0, 2048);
$in = json_decode($raw ?: '', true);
if (!is_array($in)) $in = $_POST; // reserv om något skickar formulärdata
$type = $in['type'] ?? '';
if (!in_array($type, STATS_TYPES, true)) done(400);

// Sökväg utan frågesträng och fragment, t.ex. "/butiker.html".
$path = statsText(parse_url((string)($in['path'] ?? '/'), PHP_URL_PATH) ?: '/', 200) ?? '/';
if ($path[0] !== '/') $path = '/';
$target = statsText($in['target'] ?? null, 120);
if ($type === 'search' && $target !== null) $target = mb_strtolower($target, 'UTF-8');
$value = $in['value'] ?? null;
$value = is_numeric($value) ? (string)round(max(0, min(1000000, (float)$value)), 2) : null;
// Bara domännamnet på sidan besökaren kom från, eller "direct".
$ref = strtolower((string)($in['referrer'] ?? ''));
$ref = preg_replace('/^www\./', '', $ref);
$ref = preg_match('/^[a-z0-9._-]{1,100}$/', $ref) ? $ref : 'direct';
// Enhetstyp och app avgörs här från webbläsarens User-Agent, som skickas med varje anrop ändå, så att skriptet på
// sidan inte behöver läsa något från besökarens enhet. Appar som Instagram och TikTok öppnar länkar i en egen
// webbläsare som ofta inte skickar någon referrer, men som syns i User-Agent.
$device = statsDevice($ua);
if ($ref === 'direct') $ref = statsInApp($ua) ?? 'direct';

try {
  $db = statsDb();
  $visitor = statsVisitor($db);
  if (!statsRateOk($db, 'ev:' . $visitor, 60, 60)) done(429);
  $db->prepare('INSERT INTO events (created_at, type, path, target, value, referrer, device, visitor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    ->execute([date('Y-m-d H:i:s'), $type, $path, $target, $value, $type === 'pageview' ? $ref : null, $device, $visitor]);
  statsMaybePrune($db);
} catch (Throwable $e) {
  // Statistiken får aldrig störa sidan.
}
done();
