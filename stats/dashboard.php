<?php
// Lootninjas besöksstatistik, i samma stil som statistiken för Embargo: nyckeltal med jämförelse mot förra perioden,
// diagram och tabeller med andelar. Flikar för översikt, butiker och sök, kort, spelet (packöppnaren) och övrigt.
// Skyddad med ett lösenord. Lösenordet sparas aldrig i repot, bara som en PBKDF2-summa i filen
// lootninja-stats-pass.txt bredvid public_html. Skapa raden med: node scripts/stats-password.mjs
require __DIR__ . '/lib.php';

header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');
header('X-Frame-Options: DENY');

const PASS_FILE = 'lootninja-stats-pass.txt';
const MON = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function h($s): string { return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function num($n): string { return number_format((float)$n, 0, ',', ' '); }
// Korta tal: 1 234 och 12,3 k.
function fmt_short($n): string { $n = (float)$n; return $n >= 10000 ? str_replace('.', ',', (string)round($n / 1000, 1)) . ' k' : num($n); }
function svg(string $d, string $style = ''): string { return '<svg class="i" viewBox="0 0 24 24"' . ($style ? ' style="' . $style . '"' : '') . '>' . $d . '</svg>'; }

// Raden i filen: pbkdf2_sha256$<varv>$<salt i base64>$<summa i base64>
function passwordOk(string $given): bool {
  $line = trim((string)@file_get_contents(statsDir() . '/' . PASS_FILE));
  $p = explode('$', $line);
  if (count($p) !== 4 || $p[0] !== 'pbkdf2_sha256' || (int)$p[1] < 100000) return false;
  $salt = base64_decode($p[2], true); $want = base64_decode($p[3], true);
  if ($salt === false || $want === false || $want === '') return false;
  return hash_equals($want, hash_pbkdf2('sha256', $given, $salt, (int)$p[1], strlen($want), true));
}

$cookiePath = rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/') . '/';
session_name('lnstats');
session_set_cookie_params(['lifetime' => 0, 'path' => $cookiePath, 'secure' => true, 'httponly' => true, 'samesite' => 'Strict']);
session_start();
if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));
$csrfOk = fn() => hash_equals($_SESSION['csrf'], (string)($_POST['csrf'] ?? ''));
$csrfField = fn() => '<input type="hidden" name="csrf" value="' . h($_SESSION['csrf']) . '">';
$action = (string)($_POST['action'] ?? '');

if ($action === 'logout' && $csrfOk()) { $_SESSION = []; session_destroy(); header('Location: dashboard.php'); exit; }

$error = $notice = '';
$hasPass = is_file(statsDir() . '/' . PASS_FILE);
if ($action === 'login') {
  try {
    $db = statsDb();
    $ok = statsRateOk($db, 'login:' . hash('sha256', statsSalt($db) . statsIp()), 10, 3600);
  } catch (Throwable $e) { $ok = true; }
  if (!$ok) $error = 'För många försök. Vänta en timme och försök igen.';
  elseif ($csrfOk() && passwordOk((string)($_POST['password'] ?? ''))) { session_regenerate_id(true); $_SESSION['ok'] = true; header('Location: dashboard.php'); exit; }
  else { usleep(800000); $error = 'Fel lösenord.'; }
}
$authed = !empty($_SESSION['ok']);

// ---------- Sidans skal ----------
const LOGO = '<img src="https://lootninja.se/logo.svg" alt="" width="20" height="20">';
function page_head(string $title): string {
  // Inter bäddas in från huvudsidans fonts/-mapp: Hostingers CDN skickar inte CORS-huvudet som typsnitt behöver.
  $inter = @file_get_contents(dirname(__DIR__) . '/fonts/inter-latin-7.woff2');
  $font = $inter === false ? '' : '<style>@font-face{font-family:Inter;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,' . base64_encode($inter) . ') format("woff2")}</style>';
  return '<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    . '<meta name="color-scheme" content="light"><meta name="theme-color" content="#ffffff"><meta name="robots" content="noindex, nofollow">'
    . '<title>' . h($title) . ' — Statistik</title><link rel="icon" href="https://lootninja.se/img/favicon-48.png">' . $font
    . '<link rel="stylesheet" href="style.css?v=1"></head><body>';
}
function auth_page(string $body): never {
  echo page_head('Logga in'), '<div class="app auth"><div class="brand">', LOGO, 'Statistik</div>', $body, '</div></body></html>';
  exit;
}
function msg(string $error, string $notice = ''): string {
  return ($error ? '<p class="msg err">' . h($error) . '</p>' : '') . ($notice ? '<p class="msg ok">' . h($notice) . '</p>' : '');
}

if (!$authed) {
  auth_page('<h1>Logga in</h1><p>Statistik för lootninja.se.</p>' . msg($error)
    . (!$hasPass ? '<p class="msg err">Inget lösenord är satt än. Kör <code>node scripts/stats-password.mjs</code> och lägg raden i <code>' . h(PASS_FILE) . '</code> i mappen ovanför public_html.</p>' : '')
    . '<form method="post" class="stack"><label>Lösenord<input type="password" name="password" autocomplete="current-password" required autofocus></label>'
    . '<input type="hidden" name="action" value="login">' . $csrfField() . '<button class="btn">Logga in</button></form>');
}

// ---------- Flik och period ----------
const VIEWS = ['oversikt' => 'Översikt', 'butiker' => 'Butiker & sök', 'kort' => 'Kort', 'spelet' => 'Spelet', 'ovrigt' => 'Övrigt'];
const PERIODS = ['idag' => 'Idag', '7d' => 'Senaste 7 dagarna', '30d' => 'Senaste 30 dagarna', '12m' => 'Senaste 12 månaderna'];
$v = $_GET['view'] ?? ''; $view = is_string($v) && array_key_exists($v, VIEWS) ? $v : 'oversikt';
$p = $_GET['p'] ?? ''; $pid = is_string($p) && array_key_exists($p, PERIODS) ? $p : 'idag';
$o = max(0, min(500, (int)($_GET['o'] ?? 0)));
$more = is_string($_GET['mer'] ?? null) ? $_GET['mer'] : '';
$url = fn(array $over) => 'dashboard.php?' . http_build_query(array_filter(array_merge(['view' => $view, 'p' => $pid, 'o' => $o ?: null, 'mer' => $more ?: null, 'alla' => !empty($_GET['alla']) ? 1 : null], $over), fn($x) => $x !== null && $x !== ''));

// En period: from/to som text (created_at sparas som 'Y-m-d H:i:s' i svensk tid), uttrycket som delar in den i staplar,
// staplarnas etiketter och en rubrik. $o = hur många perioder bakåt.
function period(string $pid, int $o): array {
  $d = fn(int $t, bool $y = false) => date('j', $t) . ' ' . MON[(int)date('n', $t) - 1] . ($y ? ' ' . date('Y', $t) : '');
  $b = [];
  switch ($pid) {
    case 'idag':
      $t = strtotime("today -$o days");
      for ($i = 0; $i < 24; $i++) $b[(string)$i] = sprintf('%02d:00', $i);
      return ['from' => date('Y-m-d 00:00:00', $t), 'to' => date('Y-m-d 00:00:00', strtotime('+1 day', $t)), 'bucket' => 'CAST(substr(created_at, 12, 2) AS INTEGER)', 'buckets' => $b,
        'label' => ($o === 0 ? 'Idag, ' : ($o === 1 ? 'Igår, ' : '')) . $d($t, true)];
    case '12m':
      $end = strtotime('first day of this month 00:00');
      if ($o) $end = strtotime('-' . (12 * $o) . ' months', $end);
      $start = strtotime('-11 months', $end);
      for ($i = 0; $i < 12; $i++) { $t = strtotime("+$i months", $start); $b[date('Y-m', $t)] = MON[(int)date('n', $t) - 1] . ' ' . date('y', $t); }
      return ['from' => date('Y-m-01 00:00:00', $start), 'to' => date('Y-m-01 00:00:00', strtotime('+1 month', $end)), 'bucket' => 'substr(created_at, 1, 7)', 'buckets' => $b,
        'label' => MON[(int)date('n', $start) - 1] . ' ' . date('Y', $start) . ' – ' . MON[(int)date('n', $end) - 1] . ' ' . date('Y', $end)];
    default: // 7d, 30d
      $n = $pid === '30d' ? 30 : 7;
      $end = strtotime('today -' . ($o * $n) . ' days');
      $start = strtotime('-' . ($n - 1) . ' days', $end);
      for ($i = 0; $i < $n; $i++) { $t = strtotime("+$i days", $start); $b[date('Y-m-d', $t)] = $d($t); }
      return ['from' => date('Y-m-d 00:00:00', $start), 'to' => date('Y-m-d 00:00:00', strtotime('+1 day', $end)), 'bucket' => 'substr(created_at, 1, 10)', 'buckets' => $b,
        'label' => $d($start) . ' – ' . $d($end, true)];
  }
}
$P = period($pid, $o);
$prev = period($pid, $o + 1);
// Idag jämförs med igår fram till samma klockslag, annars ser dagen alltid sämre ut än en hel gårdag.
if ($pid === 'idag' && $o === 0) $prev['to'] = date('Y-m-d H:i:s', time() - 86400);

// ---------- Ta bort ett resultat från topplistan (fula namn, eller när någon ber om det) ----------
function gameDb(): ?PDO {
  $file = statsDir() . '/lootninja-game.db';
  if (!is_file($file)) return null;
  return new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
}
// Ändringar i topplistan: ta bort eller ändra ett resultat, och lägga till eller ta bort blockerade ord.
// Efter en lyckad ändring skickas man tillbaka till Spelet med ett kvitto (?klart=...), så att en omladdning inte gör om den.
require dirname(__DIR__) . '/api/name-filter.php';
const DONE = [
  'bort' => 'Resultatet är borttaget från topplistan.', 'andrat' => 'Resultatet är ändrat.', 'ord' => 'Ordet är blockerat.',
  'ord-rensat' => 'Ordet är blockerat, och befintliga namn med ordet heter nu Ninja.', 'ord-bort' => 'Ordet är inte längre blockerat.',
];
if (in_array($action, ['delete_pull', 'edit_pull', 'add_word', 'remove_word'], true)) {
  $done = null;
  try {
    $g = gameDb();
    if (!$csrfOk()) $error = 'Sidan hade gått ut. Ladda om och försök igen.';
    elseif (!$g) $error = 'Spelets databas finns inte än.';
    elseif ($action === 'delete_pull') {
      $g->prepare('DELETE FROM pack_pulls WHERE id = ?')->execute([(int)($_POST['id'] ?? 0)]);
      $done = 'bort';
    } elseif ($action === 'edit_pull') {
      $name = trim(preg_replace('/\s+/u', ' ', (string)($_POST['name'] ?? '')) ?? '');
      $value = (int)($_POST['pack_value'] ?? 0);
      if (!nameShapeOk($name)) $error = 'Namnet måste vara 2–20 tecken: bokstäver, siffror, mellanslag och . _ - ! ?';
      elseif ($value < 1 || $value > 25000) $error = 'Värdet måste vara mellan 1 och 25 000 kr.';
      else { $g->prepare('UPDATE pack_pulls SET name = ?, pack_value = ? WHERE id = ?')->execute([$name, $value, (int)($_POST['id'] ?? 0)]); $done = 'andrat'; }
    } elseif ($action === 'add_word') {
      $word = nameNormalizeWord((string)($_POST['word'] ?? ''));
      if (mb_strlen($word, 'UTF-8') < 2 || mb_strlen($word, 'UTF-8') > 30) $error = 'Ordet måste vara 2–30 bokstäver eller siffror.';
      else {
        nameBlockTable($g);
        $g->prepare('INSERT OR IGNORE INTO blocked_words (word, created_at) VALUES (?, ?)')->execute([$word, time()]);
        $done = 'ord';
        // Valfritt: namn som redan finns på topplistan och innehåller ordet byter namn till "Ninja".
        if (!empty($_POST['rename'])) {
          $s = $g->prepare('UPDATE pack_pulls SET name = ? WHERE id = ?');
          foreach ($g->query('SELECT id, name FROM pack_pulls')->fetchAll() as $r) if (nameBlockedBy($r['name'], [$word])) $s->execute(['Ninja', $r['id']]);
          $done = 'ord-rensat';
        }
      }
    } elseif ($action === 'remove_word') {
      nameBlockTable($g);
      $g->prepare('DELETE FROM blocked_words WHERE word = ?')->execute([(string)($_POST['word'] ?? '')]);
      $done = 'ord-bort';
    }
  } catch (Throwable $e) { $error = 'Ändringen gick inte att spara: ' . $e->getMessage(); }
  if ($done) { header('Location: ' . $url(['view' => 'spelet', 'klart' => $done])); exit; }
  $view = 'spelet';
}
if (is_string($_GET['klart'] ?? null) && array_key_exists($_GET['klart'], DONE)) $notice = DONE[$_GET['klart']];

// ---------- Frågor ----------
$db = statsDb();
$q = function (string $sql, array $args = []) use ($db) { $s = $db->prepare($sql); $s->execute($args); return $s->fetchAll(); };
$q1 = function (string $sql, array $args = []) use ($db) { $s = $db->prepare($sql); $s->execute($args); return $s->fetchColumn(); };
$in = fn(array $per) => ['created_at >= ? AND created_at < ?', [$per['from'], $per['to']]];
// Antal händelser av en typ (och valfritt ett visst mål) under en period.
$count = function (string $type, array $per, ?string $target = null) use ($q1, $in) {
  [$w, $a] = $in($per);
  return (int)$q1("SELECT COUNT(*) FROM events WHERE type = ? AND $w" . ($target !== null ? ' AND target = ?' : ''), array_merge([$type], $a, $target !== null ? [$target] : []));
};
// Besökare räknas per dag (saltet byts varje natt), så flera dagar blir summan av dagarna.
$visitors = function (array $per) use ($q1, $in) { [$w, $a] = $in($per); return (int)$q1("SELECT COUNT(DISTINCT substr(created_at, 1, 10) || visitor) FROM events WHERE type = 'pageview' AND $w", $a); };
$lim = fn(string $k) => $more === $k ? 100 : 10;
// Toppen för en händelsetyp under perioden, med totalen så att andelen kan räknas.
$top = function (string $type, string $key) use ($q, $in, $P, $lim, $count) {
  [$w, $a] = $in($P);
  $rows = $q("SELECT target AS label, COUNT(*) AS n, AVG(CAST(value AS REAL)) AS avg FROM events WHERE type = ? AND $w AND target IS NOT NULL GROUP BY target ORDER BY n DESC LIMIT " . $lim($key), array_merge([$type], $a));
  return [$rows, $count($type, $P)];
};
$live = (int)$q1("SELECT COUNT(DISTINCT visitor) FROM events WHERE created_at > ?", [date('Y-m-d H:i:s', time() - 300)]);

// ---------- Innehållet per flik ----------
// $cards: [rubrik, värde nu, värde förra perioden]. $chart: [serie a, serie b ⊇ a, namn a, namn b] eller null.
// $tables: nyckel => [rubrik, kolumn, rader, total, ikontyp, visa snittvärde i kr].
$cards = $tables = []; $chart = null; $extra = '';
[$w, $a] = $in($P);
if ($view === 'oversikt') {
  $cards = [
    ['Sidvisningar', $count('pageview', $P), $count('pageview', $prev)],
    ['Besökare', $visitors($P), $visitors($prev)],
    ['Värderingar', $count('valuation', $P), $count('valuation', $prev)],
    ['Sökningar', $count('search', $P), $count('search', $prev)],
    ['Butiksklick', $count('store_click', $P), $count('store_click', $prev)],
    ['Skanningar', $count('scan', $P, 'Öppnad'), $count('scan', $prev, 'Öppnad')],
  ];
  $chart = ['type' => 'pageview', 'a' => 'Besökare', 'b' => 'Sidvisningar', 'distinct' => true];
  // Sidor med namn i stället för adress, källor sammanslagna per tjänst (alla Googles domäner blir "Google").
  $pages = $sources = $devices = [];
  foreach ($q("SELECT path, COUNT(*) AS n FROM events WHERE type = 'pageview' AND $w GROUP BY path", $a) as $r) { $k = statsPageName($r['path']); $pages[$k] = ($pages[$k] ?? 0) + (int)$r['n']; }
  foreach ($q("SELECT referrer, COUNT(*) AS n FROM events WHERE type = 'pageview' AND $w GROUP BY referrer", $a) as $r) {
    if ($src = statsSource($r['referrer'])) $sources[$src[0]] = ($sources[$src[0]] ?? 0) + (int)$r['n'];
  }
  foreach ($q("SELECT device, COUNT(DISTINCT substr(created_at, 1, 10) || visitor) AS n FROM events WHERE type = 'pageview' AND $w GROUP BY device", $a) as $r) {
    $devices[['mobile' => 'Mobil', 'tablet' => 'Surfplatta', 'desktop' => 'Dator'][$r['device']] ?? 'Dator'] = (int)$r['n'];
  }
  $rowsOf = function (array $m, string $key) use ($lim) { arsort($m); $m = array_slice($m, 0, $lim($key), true); return array_map(fn($k, $n) => ['label' => $k, 'n' => $n], array_keys($m), $m); };
  $labels = ['valuation' => 'Värderingar', 'card_view' => 'Kortpriser öppnade', 'search' => 'Sökningar', 'store_click' => 'Butiksklick', 'outbound' => 'Andra utgående klick',
    'watch' => 'Nya bevakningar', 'scan' => 'Kortskannern', 'pack_open' => 'Öppnade pack', 'pack_submit' => 'Till topplistan', 'push' => 'Pushnotiser', 'not_found' => 'Sidor som inte finns'];
  $features = [];
  foreach ($q("SELECT type, COUNT(*) AS n FROM events WHERE type <> 'pageview' AND $w GROUP BY type ORDER BY n DESC", $a) as $r) $features[] = ['label' => $labels[$r['type']] ?? $r['type'], 'n' => (int)$r['n']];
  $tables = [
    'sidor' => ['Sidor', 'Visningar', $rowsOf($pages, 'sidor'), array_sum($pages), 'sidor'],
    'kallor' => ['Källor', 'Besök', $rowsOf($sources, 'kallor'), array_sum($sources), 'kallor'],
    'enheter' => ['Enheter', 'Besökare', $rowsOf($devices, 'enheter'), array_sum($devices), 'enheter'],
    'funktioner' => ['Klick & händelser', 'Antal', $features, array_sum(array_column($features, 'n')), 'handelser'],
  ];
} elseif ($view === 'butiker') {
  $cards = [
    ['Butiksklick', $count('store_click', $P), $count('store_click', $prev)],
    ['Sökningar', $count('search', $P), $count('search', $prev)],
    ['Nya bevakningar', $count('watch', $P), $count('watch', $prev)],
    ['Utgående klick', $count('outbound', $P), $count('outbound', $prev)],
  ];
  $chart = ['type' => 'store_click', 'a' => 'Butiksklick', 'b' => 'Butiksklick', 'distinct' => false];
  [$r1, $t1] = $top('store_click', 'butiker'); [$r2, $t2] = $top('search', 'sok'); [$r3, $t3] = $top('watch', 'bevakat'); [$r4, $t4] = $top('outbound', 'ut');
  $tables = [
    'butiker' => ['Butiker', 'Klick', $r1, $t1, 'butik', true], 'sok' => ['Sökningar', 'Antal', $r2, $t2, 'sok'],
    'bevakat' => ['Bevakade produkter', 'Antal', $r3, $t3, 'butik'], 'ut' => ['Andra utgående länkar', 'Klick', $r4, $t4, 'kallor'],
  ];
} elseif ($view === 'kort') {
  $cards = [
    ['Värderingar', $count('valuation', $P), $count('valuation', $prev)],
    ['Kortpriser', $count('card_view', $P), $count('card_view', $prev)],
    ['Skanningar', $count('scan', $P, 'Öppnad'), $count('scan', $prev, 'Öppnad')],
    ['Säkra träffar', $count('scan', $P, 'Säker träff'), $count('scan', $prev, 'Säker träff')],
  ];
  $chart = ['type' => 'valuation', 'a' => 'Värderingar', 'b' => 'Värderingar', 'distinct' => false];
  [$r1, $t1] = $top('valuation', 'varderat'); [$r2, $t2] = $top('card_view', 'priser'); [$r3, $t3] = $top('scan', 'skanner');
  $tables = [
    'varderat' => ['Värderade kort', 'Antal', $r1, $t1, 'kort', true], 'priser' => ['Kortpriser som öppnats', 'Antal', $r2, $t2, 'kort', true],
    'skanner' => ['Kortskannern', 'Antal', $r3, $t3, 'handelser'],
  ];
} elseif ($view === 'spelet') {
  $cards = [
    ['Öppnade pack', $count('pack_open', $P), $count('pack_open', $prev)],
    ['Till topplistan', $count('pack_submit', $P), $count('pack_submit', $prev)],
  ];
  $chart = ['type' => 'pack_open', 'a' => 'Öppnade pack', 'b' => 'Öppnade pack', 'distinct' => false];
  [$r1, $t1] = $top('pack_open', 'set'); [$r2, $t2] = $top('pack_submit', 'inskickat');
  $tables = ['set' => ['Mest öppnade set', 'Pack', $r1, $t1, 'kort', true], 'inskickat' => ['Set till topplistan', 'Antal', $r2, $t2, 'kort', true]];
  // Topplistan och räknaren från spelets egen databas (api/highscore.php). Med ?alla=1 visas alla tider, inte bara perioden.
  $allTime = !empty($_GET['alla']);
  try {
    $g = gameDb();
    if ($g) {
      $cards[] = ['Pack totalt', (int)$g->query('SELECT total_opened FROM pack_stats WHERE id = 1')->fetchColumn(), null];
      $cards[] = ['Resultat totalt', (int)$g->query('SELECT COUNT(*) FROM pack_pulls')->fetchColumn(), null];
      $s = $g->prepare('SELECT id, created_at, name, pack_value, set_name, best_card_name, best_card_value FROM pack_pulls WHERE created_at >= ? AND created_at < ? ORDER BY pack_value DESC, created_at ASC LIMIT 50');
      $s->execute($allTime ? [0, PHP_INT_MAX] : [strtotime($P['from']), strtotime($P['to'])]);
      $board = $s->fetchAll();
      $blocked = nameBlockedWords($g);
      $ownWords = $g->query('SELECT word FROM blocked_words ORDER BY word')->fetchAll(PDO::FETCH_COLUMN);
    }
  } catch (Throwable $e) { $error = 'Spelets databas gick inte att läsa: ' . $e->getMessage(); }
  $pencil = svg('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>');
  $trash = svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>');
  ob_start(); ?>
  <section class="lb">
    <div class="thead lbhead"><span>Topplistan <small><?= $allTime ? 'alla tider' : h(mb_strtolower($P['label'], 'UTF-8')) ?></small></span>
      <a class="toggle" href="<?= h($url(['alla' => $allTime ? null : 1])) ?>"><?= $allTime ? 'Visa vald period' : 'Visa alla tider' ?></a></div>
    <?php if (!isset($board)): ?><p class="empty">Spelets databas finns inte än. Den skapas när första packet öppnas.</p>
    <?php elseif (!$board): ?><p class="empty">Inga inskickade pack <?= $allTime ? 'än' : 'för perioden' ?></p>
    <?php else: ?>
    <ul class="rows lbrows">
      <?php foreach ($board as $i => $r): $hit = nameBlockedBy($r['name'], $blocked); $t = (int)$r['created_at']; ?>
      <li class="<?= $hit ? 'flag' : '' ?>">
        <span class="rank r<?= $i + 1 ?>"><?= $i + 1 ?></span>
        <span class="name"><span><b><?= h($r['name']) ?></b><?php if ($hit): ?> <span class="badge bad" title="Namnet innehåller ett blockerat ord">Blockerat: <?= h($hit) ?></span><?php endif ?> · <?= h($r['set_name']) ?>
          <small><?= h($r['best_card_name']) ?><?= $r['best_card_value'] ? ' · ' . num($r['best_card_value']) . ' kr' : '' ?> · <?= h(date('j', $t) . ' ' . MON[(int)date('n', $t) - 1] . ' ' . date('Y H:i', $t)) ?></small></span></span>
        <span class="n"><?= num($r['pack_value']) ?> kr</span>
        <details class="edit">
          <summary class="act" title="Ändra namn eller värde" aria-label="Ändra <?= h($r['name']) ?>"><?= $pencil ?></summary>
          <form method="post" class="editform">
            <label>Namn<input name="name" value="<?= h($r['name']) ?>" maxlength="20" minlength="2" required></label>
            <label>Värde (kr)<input name="pack_value" type="number" min="1" max="25000" value="<?= (int)$r['pack_value'] ?>" required></label>
            <input type="hidden" name="action" value="edit_pull"><input type="hidden" name="id" value="<?= (int)$r['id'] ?>"><?= $csrfField() ?>
            <button class="btn">Spara</button>
          </form>
        </details>
        <form method="post"><input type="hidden" name="action" value="delete_pull"><input type="hidden" name="id" value="<?= (int)$r['id'] ?>"><?= $csrfField() ?>
          <button class="act del" title="Ta bort från topplistan" aria-label="Ta bort <?= h($r['name']) ?> från topplistan"><?= $trash ?></button></form>
      </li>
      <?php endforeach ?>
    </ul>
    <?php endif ?>
  </section>

  <?php if (isset($blocked)): ?>
  <section class="words">
    <div class="thead"><span>Blockerade ord</span><span></span></div>
    <p class="hint">Namn som innehåller ett blockerat ord kan inte skickas in. Siffror räknas som bokstäver (f4ck = fack) och mellanslag ignoreras. Ord på högst 4 tecken stoppas bara som egna ord, så att t.ex. Kukui och Grape går igenom.</p>
    <form method="post" class="addword">
      <input name="word" placeholder="Lägg till ett ord, t.ex. skit" maxlength="30" required aria-label="Ord att blockera">
      <label class="check"><input type="checkbox" name="rename" value="1" checked> Byt namn till Ninja på befintliga resultat med ordet</label>
      <input type="hidden" name="action" value="add_word"><?= $csrfField() ?>
      <button class="btn">Blockera</button>
    </form>
    <?php if ($ownWords): ?>
    <ul class="chips">
      <?php foreach ($ownWords as $wd): ?>
      <li><?= h($wd) ?><form method="post"><input type="hidden" name="action" value="remove_word"><input type="hidden" name="word" value="<?= h($wd) ?>"><?= $csrfField() ?>
        <button title="Sluta blockera <?= h($wd) ?>" aria-label="Sluta blockera <?= h($wd) ?>"><?= svg('<path d="M18 6 6 18M6 6l12 12"/>') ?></button></form></li>
      <?php endforeach ?>
    </ul>
    <?php else: ?><p class="empty">Inga egna ord än.</p><?php endif ?>
    <details class="builtin"><summary>Inbyggda ord (<?= count(NAME_BLOCKED) ?>)</summary><p><?= h(implode(', ', NAME_BLOCKED)) ?></p></details>
  </section>
  <?php endif ?>
  <?php $extra = ob_get_clean();
} else {
  $cards = [
    ['Push påslagna', $count('push', $P, 'Påslagna'), $count('push', $prev, 'Påslagna')],
    ['Push avstängda', $count('push', $P, 'Avstängda'), $count('push', $prev, 'Avstängda')],
    ['Sidor som inte finns', $count('not_found', $P), $count('not_found', $prev)],
  ];
  [$r1, $t1] = $top('push', 'push'); [$r2, $t2] = $top('not_found', '404');
  $tables = ['push' => ['Pushnotiser', 'Antal', $r1, $t1, 'handelser'], '404' => ['Sidor som inte finns (404)', 'Antal', $r2, $t2, 'sidor']];
}

// Staplarna: per timme, dag eller månad. Serie b ritas ljus bakom serie a.
$series = [];
if ($chart) {
  $col = $chart['distinct'] ? 'COUNT(DISTINCT substr(created_at, 1, 10) || visitor)' : 'COUNT(*)';
  foreach ($q("SELECT {$P['bucket']} AS b, $col AS a, COUNT(*) AS n FROM events WHERE type = ? AND $w GROUP BY b", array_merge([$chart['type']], $a)) as $r) {
    $series[(string)$r['b']] = [(int)$r['a'], (int)$r['n']];
  }
}

// ---------- Delar av sidan ----------
function badge(int $now, ?int $before): string {
  if ($before === null) return '';
  if ($before === 0) return '<span class="badge neutral">—</span>';
  $pct = (int)round(($now - $before) / $before * 100);
  if ($pct === 0) return '<span class="badge neutral">0 %</span>';
  return '<span class="badge ' . ($pct > 0 ? 'good' : 'bad') . '">' . svg($pct > 0 ? '<path d="M12 19V5M5 12l7-7 7 7"/>' : '<path d="M12 5v14M19 12l-7 7-7-7"/>', 'width:11px;height:11px') . abs($pct) . ' %</span>';
}

function chart(array $buckets, array $series, array $c): string {
  $max = 0;
  foreach ($series as [$v, $n]) $max = max($max, $n);
  // "Snygg" y-axel: steg om 1, 2 eller 5 × 10^n, ungefär fem linjer.
  $raw = max(1, $max) / 5;
  $mag = 10 ** floor(log10($raw));
  $step = max(1, (int)(($raw / $mag <= 1 ? 1 : ($raw / $mag <= 2 ? 2 : ($raw / $mag <= 5 ? 5 : 10))) * $mag));
  $top = max($step, (int)ceil(max(1, $max) / $step) * $step);
  $count = count($buckets);
  $gap = $count > 26 ? 3 : 8;
  $every = max(1, (int)ceil($count / 12));
  $two = $c['a'] !== $c['b'];
  $y = $grid = '';
  for ($v = 0; $v <= $top; $v += $step) {
    $p = round($v / $top * 100, 3);
    $y .= '<span style="bottom:' . $p . '%">' . fmt_short($v) . '</span>';
    if ($v > 0) $grid .= '<div class="grid-l" style="bottom:' . $p . '%"></div>';
  }
  $cols = $x = '';
  $i = 0;
  foreach ($buckets as $key => $label) {
    [$v, $n] = $series[(string)$key] ?? [0, 0];
    $hn = round($n / $top * 100, 3); $hv = round(($two ? $v : $n) / $top * 100, 3);
    $cols .= '<div class="col" tabindex="0" style="--h:' . $hn . '%">'
      . ($two ? '<div class="b pv" style="height:' . $hn . '%"></div>' : '') . '<div class="b v" style="height:' . $hv . '%"></div>'
      . '<span class="tip"><b>' . h($label) . '</b>' . ($two ? '<i class="dot-v"></i>' . num($v) . ' ' . mb_strtolower($c['a'], 'UTF-8') . '<br><i class="dot-pv"></i>' : '<i class="dot-v"></i>')
      . num($n) . ' ' . mb_strtolower($c['b'], 'UTF-8') . '</span></div>';
    $show = $i % $every === 0;
    $x .= '<span class="' . ($show && $i % ($every * 2) !== 0 ? 'm' : '') . '">' . ($show ? h($label) : '') . '</span>';
    $i++;
  }
  return '<div class="chart" style="--gap:' . $gap . 'px"><div class="yaxis">' . $y . '</div><div class="plot">' . $grid
    . '<div class="cols">' . $cols . '</div></div><div class="xaxis">' . $x . '</div></div>'
    . '<div class="legend">' . ($two ? '<span><i class="dot-v"></i>' . h($c['a']) . '</span><span><i class="dot-pv"></i>' . h($c['b']) . '</span>' : '<span><i class="dot-v"></i>' . h($c['a']) . '</span>') . '</div>';
}

function icon(string $kind, string $label): string {
  if ($kind === 'enheter') {
    $d = ['Mobil' => '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>', 'Surfplatta' => '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 18h2"/>'][$label]
      ?? '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>';
    return '<span class="ico" style="color:var(--text2)">' . svg($d) . '</span>';
  }
  if ($kind === 'sidor') return '';
  if ($kind === 'handelser') return '<span class="ico" style="color:var(--blue)">' . svg('<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>') . '</span>';
  if ($kind === 'sok') return '<span class="ico" style="color:var(--text2)">' . svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>') . '</span>';
  if ($kind === 'kort') return '<span class="ico" style="color:var(--gold)">' . svg('<rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="12" r="3"/>') . '</span>';
  if ($kind === 'butik') return '<span class="ico" style="color:var(--text2)">' . svg('<path d="M3 9l1.5-5h15L21 9M4 9v11h16V9M3 9h18M9 20v-6h6v6"/>') . '</span>';
  if ($label === 'Direkt') return '<span class="ico" style="color:var(--text2)">' . svg('<path d="M7 17 17 7M8 7h9v9"/>') . '</span>';
  if ($label === 'E-post') return '<span class="ico" style="color:var(--text2)">' . svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>') . '</span>';
  $brands = ['Google' => ['#4285f4', 'G'], 'Instagram' => ['#e1306c', 'I'], 'Facebook' => ['#1877f2', 'f'], 'TikTok' => ['#111', 'T'], 'Bing' => ['#008373', 'b'],
    'DuckDuckGo' => ['#de5833', 'D'], 'X (Twitter)' => ['#111', 'X'], 'LinkedIn' => ['#0a66c2', 'in'], 'Snapchat' => ['#f7c600', 'S'], 'YouTube' => ['#ff0000', 'Y'],
    'Reddit' => ['#ff4500', 'r'], 'Discord' => ['#5865f2', 'D'], 'Threads' => ['#111', '@'], 'Pinterest' => ['#e60023', 'P'], 'ChatGPT' => ['#10a37f', 'C'],
    'Perplexity' => ['#20808d', 'P'], 'Gemini' => ['#8e75ff', 'G'], 'Claude' => ['#d97757', 'C'], 'Copilot' => ['#0078d4', 'C'], 'Grok' => ['#111', 'G'],
    'Flashback' => ['#3a3a3a', 'F'], 'cardmarket.com' => ['#012169', 'C'], 'tcgplayer.com' => ['#0a2540', 'T']];
  [$bg, $ch] = $brands[$label] ?? [['#7c6cf0', '#f59e0b', '#10b981', '#ef4444', '#0ea5e9', '#8b5cf6'][crc32($label) % 6], mb_strtoupper(mb_substr($label, 0, 1))];
  return '<span class="ico" style="background:' . $bg . '">' . h($ch) . '</span>';
}

// ---------- Sidan ----------
echo page_head(VIEWS[$view]);
?>
<div class="app">
  <header class="top">
    <a class="brand" href="dashboard.php"><?= LOGO ?>Statistik</a>
    <div class="icons">
      <a href="https://lootninja.se/" target="_blank" rel="noopener" title="Öppna lootninja.se" aria-label="Öppna lootninja.se"><?= svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>') ?></a>
      <form method="post"><input type="hidden" name="action" value="logout"><?= $csrfField() ?><button title="Logga ut" aria-label="Logga ut"><?= svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>') ?></button></form>
    </div>
  </header>

  <div class="siterow">
    <h1><img src="https://lootninja.se/img/favicon-48.png" alt="">lootninja.se</h1>
    <span class="live"><i></i><?= $live ?> besökare just nu</span>
    <nav class="sites" aria-label="Delar"><?php foreach (VIEWS as $k => $label): ?><a href="<?= h($url(['view' => $k, 'mer' => null])) ?>" class="<?= $k === $view ? 'on' : '' ?>"><?= h($label) ?></a><?php endforeach ?></nav>
  </div>
  <?= msg($error, $notice) ?>

  <div class="metrics-row">
    <div class="metrics" style="--cols:<?= count($cards) % 3 === 0 ? 3 : 2 ?>">
      <?php foreach ($cards as [$lbl, $now, $before]): ?>
      <div class="metric"><span class="lbl"><?= h($lbl) ?></span><span class="val"><?= fmt_short($now) ?></span><?= badge($now, $before) ?></div>
      <?php endforeach ?>
    </div>
    <div>
      <div class="controls">
        <details class="dd">
          <summary><?= h(PERIODS[$pid]) ?><?= svg('<path d="m6 9 6 6 6-6"/>') ?></summary>
          <div class="menu"><?php foreach (PERIODS as $k => $label): ?><a href="<?= h($url(['p' => $k, 'o' => null])) ?>" class="<?= $k === $pid ? 'on' : '' ?>"><?= h($label) ?></a><?php endforeach ?></div>
        </details>
        <div class="nav2">
          <a href="<?= h($url(['o' => $o + 1])) ?>" title="Föregående period" aria-label="Föregående period"><?= svg('<path d="m15 18-6-6 6-6"/>') ?></a>
          <?php if ($o > 0): ?><a href="<?= h($url(['o' => $o - 1 ?: null])) ?>" title="Nästa period" aria-label="Nästa period"><?= svg('<path d="m9 18 6-6-6-6"/>') ?></a>
          <?php else: ?><span aria-hidden="true"><?= svg('<path d="m9 18 6-6-6-6"/>') ?></span><?php endif ?>
        </div>
      </div>
      <div class="range"><?= h($P['label']) ?></div>
    </div>
  </div>

  <?= $chart ? chart($P['buckets'], $series, $chart) : '' ?>
  <?= $extra ?>

  <div class="tables">
  <?php foreach ($tables as $key => $t): [$title, $colName, $rows, $total, $kind] = $t; $money = $t[5] ?? false; ?>
    <section>
      <div class="thead"><span><?= h($title) ?></span><span><?= h($colName) ?></span></div>
      <?php if (!$rows): ?><p class="empty">Ingen data för perioden</p><?php else: ?>
      <ul class="rows">
        <?php foreach ($rows as $r): $pct = $total ? (int)round($r['n'] / $total * 100) : 0; ?>
        <li><span class="name"><?= icon($kind, (string)$r['label']) ?><span title="<?= h($r['label']) ?>"><?= h($r['label'] ?: '—') ?><?php if ($money && ($r['avg'] ?? null) !== null): ?><small> · snitt <?= num($r['avg']) ?> kr</small><?php endif ?></span></span><span class="n"><?= fmt_short((int)$r['n']) ?></span><span class="pct"><i style="width:<?= min(100, $pct) ?>%"></i><em><?= $pct ?>%</em></span></li>
        <?php endforeach ?>
      </ul>
      <?php if ($key !== 'enheter' && count($rows) >= 10): ?>
        <a class="more" href="<?= h($url(['mer' => $more === $key ? null : $key])) ?>"><?= $more === $key ? 'Visa färre' : 'Visa fler' ?> <?= svg('<path d="M5 12h14M13 6l6 6-6 6"/>') ?></a>
      <?php endif ?>
      <?php endif ?>
    </section>
  <?php endforeach ?>
  </div>
  <?php if ($view === 'oversikt'): ?><p class="foot">Besökare räknas per dag utan kakor, så samma person två dagar räknas två gånger. Besök från klick inom Lootninja räknas inte som källa.</p><?php endif ?>
</div>
</body></html>
