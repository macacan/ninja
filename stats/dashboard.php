<?php
// Lootninjas besöksstatistik i flikar: översikt, trafik och källor, butiker och sök, kort, spelet och övrigt.
// Skyddad med ett lösenord. Lösenordet sparas aldrig i repot, bara som en PBKDF2-summa i filen
// lootninja-stats-pass.txt bredvid public_html. Skapa raden med: node scripts/stats-password.mjs
require __DIR__ . '/lib.php';

header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');
header('X-Frame-Options: DENY');

const PASS_FILE = 'lootninja-stats-pass.txt';

function h($s): string { return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function num($n): string { return number_format((float)$n, 0, ',', ' '); }

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

if (isset($_GET['logout'])) { $_SESSION = []; session_destroy(); header('Location: dashboard.php'); exit; }

$error = '';
$hasPass = is_file(statsDir() . '/' . PASS_FILE);
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && isset($_POST['password'])) {
  try {
    $db = statsDb();
    $ok = statsRateOk($db, 'login:' . hash('sha256', statsSalt($db) . statsIp()), 10, 3600);
  } catch (Throwable $e) { $ok = true; }
  if (!$ok) $error = 'För många försök. Vänta en timme.';
  elseif (passwordOk((string)$_POST['password'])) { session_regenerate_id(true); $_SESSION['ok'] = true; header('Location: dashboard.php'); exit; }
  else { usleep(800000); $error = 'Fel lösenord.'; }
}
$authed = !empty($_SESSION['ok']);

// ---------- Vy och period ----------
// Flikarna: översikt, trafik, butiker och sök, kort, spelet (packöppnaren) och övrigt. Perioden är "I dag" om inget annat valts.
const VIEWS = ['oversikt' => 'Översikt', 'trafik' => 'Trafik', 'butiker' => 'Butiker & sök', 'kort' => 'Kort', 'spelet' => 'Spelet', 'ovrigt' => 'Övrigt'];
const PERIODS = [1 => 'I dag', 7 => '7 dagar', 30 => '30 dagar', 365 => '1 år'];
$v = $_GET['view'] ?? '';
$view = is_string($v) && array_key_exists($v, VIEWS) ? $v : 'oversikt';
$days = array_key_exists((int)($_GET['days'] ?? 1), PERIODS) ? (int)($_GET['days'] ?? 1) : 1;
$link = fn(array $change) => '?' . http_build_query(array_merge(['view' => $view, 'days' => $days], $change));

// Spelets databas (api/highscore.php) ligger bredvid statistikens.
function gameDb(): ?PDO {
  $file = statsDir() . '/lootninja-game.db';
  if (!is_file($file)) return null;
  return new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
}

// Ta bort ett resultat från topplistan (fula namn, eller när någon ber om det). Kräver sessionens nyckel mot CSRF.
if ($authed && empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));
$notice = '';
if ($authed && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && isset($_POST['delete_pull'])) {
  if (!hash_equals($_SESSION['csrf'], (string)($_POST['csrf'] ?? ''))) $error = 'Sidan hade gått ut. Ladda om och försök igen.';
  else {
    try {
      $g = gameDb();
      $g?->prepare('DELETE FROM pack_pulls WHERE id = ?')->execute([(int)$_POST['delete_pull']]);
      header('Location: dashboard.php' . $link(['view' => 'spelet', 'deleted' => 1])); exit;
    } catch (Throwable $e) { $error = 'Resultatet gick inte att ta bort: ' . $e->getMessage(); }
  }
}
if (isset($_GET['deleted'])) $notice = 'Resultatet är borttaget från topplistan.';

// ---------- Data ----------
$data = null;
if ($authed) {
  try {
    $db = statsDb();
    $since = fn(int $d) => date('Y-m-d 00:00:00', strtotime('-' . ($d - 1) . ' days'));
    $one = function (string $sql, array $args = []) use ($db) { $s = $db->prepare($sql); $s->execute($args); return $s->fetchColumn(); };
    $all = function (string $sql, array $args = []) use ($db) { $s = $db->prepare($sql); $s->execute($args); return $s->fetchAll(); };
    $from = $since($days);
    // Unika besökare räknas per dag (saltet byts varje natt), så flera dagar blir summan av dagarna.
    $visitors = fn(string $f) => (int)$one("SELECT COUNT(*) FROM (SELECT DISTINCT visitor, substr(created_at, 1, 10) FROM events WHERE type = 'pageview' AND created_at >= ?)", [$f]);
    $views = fn(string $f) => (int)$one("SELECT COUNT(*) FROM events WHERE type = 'pageview' AND created_at >= ?", [$f]);
    $top = fn(string $type, int $limit = 10) => $all("SELECT target, COUNT(*) AS n, AVG(CAST(value AS REAL)) AS avg, MAX(CAST(value AS REAL)) AS max FROM events WHERE type = ? AND created_at >= ? AND target IS NOT NULL GROUP BY target ORDER BY n DESC LIMIT $limit", [$type, $from]);
    $data = ['visitors' => $visitors($from), 'views' => $views($from)];

    if ($view === 'oversikt') {
      // I dag: en stapel per timme. Längre perioder: en stapel per dag (högst 30), tomma dagar räknas som noll.
      if ($days === 1) {
        $rows = $all("SELECT CAST(substr(created_at, 12, 2) AS INTEGER) AS k, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM events WHERE type = 'pageview' AND created_at >= ? GROUP BY k", [$from]);
        $keys = range(0, 23); $label = fn($k) => sprintf('%02d:00', $k);
      } else {
        $span = min($days, 30);
        $rows = $all("SELECT substr(created_at, 1, 10) AS k, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM events WHERE type = 'pageview' AND created_at >= ? GROUP BY k", [$since($span)]);
        $keys = array_map(fn($i) => date('Y-m-d', strtotime("-$i days")), range($span - 1, 0)); $label = fn($k) => $k;
      }
      $byKey = array_column($rows, null, 'k');
      $data['chart'] = array_map(fn($k) => ['label' => $label($k), 'views' => (int)($byKey[$k]['views'] ?? 0), 'visitors' => (int)($byKey[$k]['visitors'] ?? 0)], $keys);
      $data['totals'] = array_column($all("SELECT type, COUNT(*) AS n FROM events WHERE created_at >= ? GROUP BY type", [$from]), 'n', 'type');
      $data['scanOpen'] = (int)$one("SELECT COUNT(*) FROM events WHERE type = 'scan' AND target = 'Öppnad' AND created_at >= ?", [$from]);
      $data['compare'] = [['I dag', $visitors($since(1)), $views($since(1))], ['7 dagar', $visitors($since(7)), $views($since(7))], ['30 dagar', $visitors($since(30)), $views($since(30))]];
    }
    if ($view === 'trafik') {
      // Sidor med namn i stället för adress, och källor sammanslagna per tjänst (alla Googles domäner blir "Google").
      $pages = [];
      foreach ($all("SELECT path, COUNT(*) AS n FROM events WHERE type = 'pageview' AND created_at >= ? GROUP BY path", [$from]) as $r) {
        $name = statsPageName($r['path']); $pages[$name] = ($pages[$name] ?? 0) + (int)$r['n'];
      }
      $sources = $kinds = $others = [];
      foreach ($all("SELECT referrer, COUNT(*) AS n FROM events WHERE type = 'pageview' AND created_at >= ? GROUP BY referrer", [$from]) as $r) {
        $src = statsSource($r['referrer']);
        if (!$src) continue;
        [$name, $kind] = $src;
        $sources[$name] = ($sources[$name] ?? 0) + (int)$r['n'];
        $kinds[$kind] = ($kinds[$kind] ?? 0) + (int)$r['n'];
        if ($kind === 'Andra sidor') $others[$name] = ($others[$name] ?? 0) + (int)$r['n'];
      }
      $asRows = function (array $m, int $limit = 15) { arsort($m); return array_map(fn($k, $n) => ['target' => $k, 'n' => $n], array_keys(array_slice($m, 0, $limit, true)), array_slice($m, 0, $limit, true)); };
      $data += ['pages' => $asRows($pages), 'sources' => $asRows($sources), 'kinds' => $asRows($kinds), 'others' => $asRows($others), 'entries' => array_sum($sources),
        'devices' => $all("SELECT device AS target, COUNT(*) AS n FROM events WHERE type = 'pageview' AND created_at >= ? GROUP BY device ORDER BY n DESC", [$from])];
    }
    if ($view === 'butiker') $data += ['stores' => $top('store_click', 20), 'searches' => $top('search', 20), 'watch' => $top('watch', 15), 'outbound' => $top('outbound', 15)];
    if ($view === 'kort') $data += ['valuations' => $top('valuation', 20), 'cardViews' => $top('card_view', 20), 'scans' => $top('scan', 6)];
    if ($view === 'ovrigt') $data += ['push' => $top('push', 6), 'notFound' => $top('not_found', 25)];
    if ($view === 'spelet') {
      $data += ['packs' => $top('pack_open', 15), 'submits' => $top('pack_submit', 15),
        'opened' => (int)$one("SELECT COUNT(*) FROM events WHERE type = 'pack_open' AND created_at >= ?", [$from]),
        'submitted' => (int)$one("SELECT COUNT(*) FROM events WHERE type = 'pack_submit' AND created_at >= ?", [$from])];
      $g = gameDb();
      if ($g) {
        $data['gameTotal'] = (int)$g->query('SELECT total_opened FROM pack_stats WHERE id = 1')->fetchColumn();
        $data['gamePulls'] = (int)$g->query('SELECT COUNT(*) FROM pack_pulls')->fetchColumn();
        $s = $g->prepare('SELECT id, created_at, name, pack_value, set_name, best_card_name, best_card_value FROM pack_pulls WHERE created_at >= ? ORDER BY pack_value DESC, created_at ASC LIMIT 25');
        $s->execute([strtotime($from)]);
        $data['leaderboard'] = $s->fetchAll();
      }
    }
  } catch (Throwable $e) {
    $error = 'Databasen gick inte att öppna: ' . $e->getMessage();
  }
}

// En topplista med en liten stapel för andelen. $money visar snitt och max i kronor.
function board(string $title, array $rows, string $unit = 'st', bool $money = false, string $note = ''): string {
  $max = max(array_merge([1], array_map(fn($r) => (int)$r['n'], $rows)));
  $out = '<section class="box"><h2>' . h($title) . '</h2>' . ($note ? '<p class="muted note">' . h($note) . '</p>' : '');
  if (!$rows) return $out . '<p class="muted">Inget under perioden.</p></section>';
  $out .= '<ol class="board">';
  foreach ($rows as $r) {
    $extra = $money && ($r['avg'] ?? null) !== null ? '<small>snitt ' . num($r['avg']) . ' kr · max ' . num($r['max']) . ' kr</small>' : '';
    $out .= '<li><span class="lbl">' . h($r['target'] ?? '–') . $extra . '</span><b>' . num($r['n']) . ' ' . h($unit) . '</b><i style="--w:' . round((int)$r['n'] / $max * 100) . '%"></i></li>';
  }
  return $out . '</ol></section>';
}
function kpi(string $label, $value, string $sub = ''): string {
  return '<div class="box kpi"><span>' . h($label) . '</span><b>' . num($value) . '</b>' . ($sub ? '<small>' . h($sub) . '</small>' : '') . '</div>';
}
?><!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Lootninja Stats</title>
<link rel="icon" href="https://lootninja.se/img/favicon-48.png">
<?php
// Typsnitten bäddas in direkt från huvudsidans fonts/-mapp: webbläsaren får inte ladda typsnitt från lootninja.se
// till stats.lootninja.se utan CORS-huvud, och Hostingers CDN skickar inte med det.
$font = function (string $file): string {
  $data = @file_get_contents(dirname(__DIR__) . '/fonts/' . $file);
  return $data === false ? '' : 'url(data:font/woff2;base64,' . base64_encode($data) . ') format("woff2")';
};
$pixelify = $font('pixelify-sans-latin-9.woff2'); $inter = $font('inter-latin-7.woff2');
?>
<style>
<?php if ($pixelify): ?>@font-face{font-family:"Pixelify Sans";font-weight:400 700;font-display:swap;src:<?= $pixelify ?>}<?php endif; ?>
<?php if ($inter): ?>@font-face{font-family:"Inter";font-weight:100 900;font-display:swap;src:<?= $inter ?>}<?php endif; ?>
:root{--bg:#eceff4;--card:#fbfcfd;--ink:#1b1b2f;--muted:#555b6e;--line:#d9dee7;--gold:#f2b632;--red:#e4572e;--mint:#2f9e7a;--r:6px;
  --pixel:"Pixelify Sans","Courier New",monospace;--sans:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#1b1e28;--card:#232734;--ink:#e8eaf1;--muted:#a3abbe;--line:#363c4e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans)}
.wrap{max-width:1180px;margin:0 auto;padding:20px 16px 60px}
h1,h2{font-family:var(--pixel);font-weight:600;margin:0}
h1{font-size:1.7rem}
h2{font-size:1.1rem;margin-bottom:10px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:14px}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 18px;padding:0 0 12px;border-bottom:2px solid var(--line)}
.tabs a{font:600 .95rem var(--pixel);padding:8px 14px;border:2px solid transparent;border-radius:var(--r);text-decoration:none;color:var(--muted)}
.tabs a:hover{color:var(--ink);border-color:var(--line)}
.tabs a[aria-current]{color:#1b1b2f;background:var(--gold);border-color:var(--ink);box-shadow:3px 3px 0 var(--ink)}
.box{background:var(--card);border:2px solid var(--ink);border-radius:var(--r);box-shadow:3px 3px 0 var(--ink);padding:14px 16px;min-width:0}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));margin-top:16px}
.kpis{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr))}
.kpi span{font:600 .8rem var(--pixel);color:var(--muted);text-transform:uppercase;letter-spacing:1px}
.kpi b{display:block;font:700 2rem/1.1 var(--pixel);color:var(--ink)}
.kpi small{color:var(--muted)}
.mini{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr))}
.mini div{padding:10px 12px;border:2px solid var(--line);border-radius:var(--r)}
.mini span{display:block;font:600 .75rem var(--pixel);color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.mini b{font:700 1.5rem/1.2 var(--pixel)}
.section-title{margin:26px 0 10px;font:600 .85rem var(--pixel);color:var(--muted);text-transform:uppercase;letter-spacing:1px}
.seg{display:inline-flex;border:2px solid var(--ink);border-radius:var(--r);overflow:hidden;box-shadow:3px 3px 0 var(--ink)}
.seg a{font:600 .9rem var(--pixel);padding:8px 12px;text-decoration:none;color:var(--ink);background:var(--card)}
.seg a+a{border-left:2px solid var(--ink)}
.seg a[aria-current]{background:var(--gold);color:#1b1b2f}
.btn{font:600 .9rem var(--pixel);padding:8px 14px;border:2px solid var(--ink);border-radius:var(--r);box-shadow:3px 3px 0 var(--ink);background:var(--card);color:var(--ink);text-decoration:none;cursor:pointer}
.btn.gold{background:var(--gold);color:#1b1b2f}
.btn.small{padding:4px 10px;font-size:.8rem;box-shadow:2px 2px 0 var(--ink)}
.board{list-style:none;margin:0;padding:0;display:grid;gap:6px;counter-reset:r}
.board li{position:relative;display:flex;gap:10px;justify-content:space-between;align-items:center;padding:6px 8px;border-radius:4px;overflow:hidden;counter-increment:r}
.board li::before{content:counter(r);font:600 .8rem var(--pixel);color:var(--muted);width:1.4em;flex:none;position:relative;z-index:1}
.board .lbl{flex:1;min-width:0;overflow-wrap:anywhere;position:relative;z-index:1}
.board small{display:block;color:var(--muted);font-size:.75rem}
.board b{font:600 .95rem var(--pixel);white-space:nowrap;position:relative;z-index:1}
.board i{position:absolute;left:0;top:0;bottom:0;width:var(--w);background:var(--gold);opacity:.22}
.note{margin:-4px 0 10px;font-size:.8rem}
.chart{display:flex;align-items:flex-end;gap:3px;height:170px;padding-top:8px;border-bottom:2px solid var(--ink)}
.chart div{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:0}
.chart span{display:block;background:var(--gold);border:2px solid var(--ink);border-bottom:0}
.chart em{display:block;background:var(--mint);border:2px solid var(--ink);border-bottom:0;margin-top:-2px}
.chart span[style*="height:0%"],.chart em[style*="height:0%"]{border:0}
.axis{display:flex;justify-content:space-between;font-size:.72rem;color:var(--muted);margin-top:4px}
.legend{display:flex;gap:14px;font-size:.8rem;color:var(--muted);margin-top:8px}
.legend i{display:inline-block;width:10px;height:10px;border:2px solid var(--ink);margin-right:5px;vertical-align:-1px}
table.lb{width:100%;border-collapse:collapse;font-size:.88rem}
table.lb th,table.lb td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
table.lb th{font:600 .75rem var(--pixel);color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
table.lb td.num{font:700 1rem var(--pixel);white-space:nowrap;text-align:right}
table.lb form{margin:0}
.table-wrap{overflow-x:auto}
.muted{color:var(--muted)}
.err{color:var(--red);font-weight:600}
.ok{color:var(--mint);font-weight:600}
form.login{max-width:360px;margin:12vh auto 0;display:grid;gap:12px}
input[type=password]{font:inherit;padding:10px 12px;border:2px solid var(--ink);border-radius:var(--r);background:var(--bg);color:var(--ink)}
code{background:var(--bg);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
@media (max-width:640px){.seg a{padding:7px 9px;font-size:.8rem}.tabs a{padding:6px 10px;font-size:.85rem}.kpi b{font-size:1.6rem}}
</style>
</head>
<body><div class="wrap">
<?php if (!$authed): ?>
  <form class="login box" method="post" action="dashboard.php">
    <h1>Lootninja Stats</h1>
    <?php if (!$hasPass): ?>
      <p class="muted">Inget lösenord är satt än. Kör <code>node scripts/stats-password.mjs</code> på din dator och lägg raden den skriver ut i filen <code><?= h(PASS_FILE) ?></code> i mappen ovanför <code>public_html</code> (hPanel → Filhanteraren).</p>
    <?php endif; ?>
    <label for="pw">Lösenord</label>
    <input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
    <button class="btn gold" type="submit">Logga in</button>
    <?php if ($error): ?><p class="err" role="alert"><?= h($error) ?></p><?php endif; ?>
  </form>
<?php else: ?>
  <header>
    <h1>Lootninja Stats</h1>
    <nav class="seg" aria-label="Period">
      <?php foreach (PERIODS as $d => $label): ?>
        <a href="<?= h($link(['days' => $d])) ?>"<?= $d === $days ? ' aria-current="page"' : '' ?>><?= h($label) ?></a>
      <?php endforeach; ?>
    </nav>
    <a class="btn" href="?logout=1">Logga ut</a>
  </header>
  <nav class="tabs" aria-label="Delar">
    <?php foreach (VIEWS as $v => $label): ?>
      <a href="<?= h($link(['view' => $v])) ?>"<?= $v === $view ? ' aria-current="page"' : '' ?>><?= h($label) ?></a>
    <?php endforeach; ?>
  </nav>
  <?php if ($error): ?><p class="err"><?= h($error) ?></p><?php endif; ?>
  <?php if ($notice): ?><p class="ok"><?= h($notice) ?></p><?php endif; ?>

  <?php if ($data): $period = mb_strtolower(PERIODS[$days], 'UTF-8'); ?>

  <?php if ($view === 'oversikt'): ?>
    <div class="kpis">
      <?= kpi('Besökare', $data['visitors'], PERIODS[$days]) ?>
      <?= kpi('Sidvisningar', $data['views'], $data['visitors'] ? number_format($data['views'] / $data['visitors'], 1, ',', '') . ' per besökare' : '') ?>
      <?= kpi('Värderingar', $data['totals']['valuation'] ?? 0, 'kort som värderats') ?>
      <?= kpi('Butiksklick', $data['totals']['store_click'] ?? 0, 'vidare till butikerna') ?>
    </div>

    <section class="box" style="margin-top:16px">
      <h2><?= $days === 1 ? 'I dag, per timme' : 'Per dag, senaste ' . min($days, 30) . ' dagarna' ?></h2>
      <?php $peak = max(array_merge([1], array_column($data['chart'], 'views'))); ?>
      <div class="chart" role="img" aria-label="Sidvisningar och besökare">
        <?php foreach ($data['chart'] as $r): ?>
          <div title="<?= h($r['label']) ?>: <?= num($r['views']) ?> sidvisningar, <?= num($r['visitors']) ?> besökare">
            <span style="height:<?= round(($r['views'] - $r['visitors']) / $peak * 100, 1) ?>%"></span>
            <em style="height:<?= round($r['visitors'] / $peak * 100, 1) ?>%"></em>
          </div>
        <?php endforeach; ?>
      </div>
      <div class="axis"><span><?= h($data['chart'][0]['label']) ?></span><span><?= h(end($data['chart'])['label']) ?></span></div>
      <div class="legend"><span><i style="background:var(--mint)"></i>Besökare</span><span><i style="background:var(--gold)"></i>Fler sidvisningar</span></div>
    </section>

    <h2 class="section-title">Funktioner <?= h($period) ?></h2>
    <div class="box mini">
      <?php foreach (['search' => 'Sökningar', 'card_view' => 'Kortpriser öppnade', 'watch' => 'Nya bevakningar', 'outbound' => 'Andra utgående klick', 'pack_open' => 'Öppnade pack', 'pack_submit' => 'Till topplistan'] as $type => $label): ?>
        <div><span><?= h($label) ?></span><b><?= num($data['totals'][$type] ?? 0) ?></b></div>
      <?php endforeach; ?>
      <div><span>Skanningar</span><b><?= num($data['scanOpen']) ?></b></div>
    </div>

    <h2 class="section-title">Jämförelse</h2>
    <div class="kpis">
      <?php foreach ($data['compare'] as [$label, $v, $pv]) echo kpi($label, $v, 'besökare · ' . num($pv) . ' sidvisningar'); ?>
    </div>
    <p class="muted" style="font-size:.8rem;margin-top:14px">Besökare räknas per dag utan kakor, så samma person två dagar räknas två gånger.</p>

  <?php elseif ($view === 'trafik'): ?>
    <div class="kpis">
      <?= kpi('Besökare', $data['visitors'], PERIODS[$days]) ?>
      <?= kpi('Sidvisningar', $data['views']) ?>
      <?= kpi('Inkommande besök', $data['entries'], 'utifrån, inte klick inom sidan') ?>
    </div>
    <div class="grid">
      <?= board('Varifrån besökarna kommer', $data['sources'], 'besök', false, 'Google, ChatGPT, Instagram … Direkt = bokmärke, inskriven adress eller en app som inte berättar.') ?>
      <?= board('Typ av källa', $data['kinds'], 'besök') ?>
      <?= board('Mest besökta sidor', $data['pages'], 'visn.') ?>
      <?= board('Andra sidor som länkar hit', $data['others'], 'besök') ?>
      <?= board('Enheter', array_map(fn($r) => ['target' => ['mobile' => 'Mobil', 'tablet' => 'Surfplatta', 'desktop' => 'Dator'][$r['target']] ?? $r['target'], 'n' => $r['n']], $data['devices']), 'visn.') ?>
    </div>

  <?php elseif ($view === 'butiker'): ?>
    <div class="grid">
      <?= board('Mest klickade butiker', $data['stores'], 'klick', true, 'Klick vidare till butiken, med produktens pris.') ?>
      <?= board('Populäraste sökningarna', $data['searches'], 'st', false, 'Kortsökningar och produktfiltret på Butiker.') ?>
      <?= board('Nya bevakningar', $data['watch'], 'st') ?>
      <?= board('Andra utgående länkar', $data['outbound'], 'klick', false, 'Cardmarket, nyhetskällor, Bulbapedia …') ?>
    </div>

  <?php elseif ($view === 'kort'): ?>
    <div class="grid">
      <?= board('Värderade kort', $data['valuations'], 'st', true) ?>
      <?= board('Kortpriser som öppnats', $data['cardViews'], 'st', true) ?>
      <?= board('Kortskannern', $data['scans'], 'st', false, 'Öppnad → säker träff, läst och söker, eller bara delvis läst.') ?>
    </div>

  <?php elseif ($view === 'spelet'): ?>
    <div class="kpis">
      <?= kpi('Öppnade pack', $data['opened'], PERIODS[$days]) ?>
      <?= kpi('Till topplistan', $data['submitted'], PERIODS[$days]) ?>
      <?php if (isset($data['gameTotal'])): ?>
        <?= kpi('Pack totalt', $data['gameTotal'], 'räknaren på startsidan') ?>
        <?= kpi('Resultat totalt', $data['gamePulls'], 'på topplistan') ?>
      <?php endif; ?>
    </div>
    <section class="box" style="margin-top:16px">
      <h2>Topplistan <?= h($period) ?></h2>
      <?php if (!isset($data['leaderboard'])): ?>
        <p class="muted">Spelets databas (lootninja-game.db) finns inte än. Den skapas när första packet öppnas.</p>
      <?php elseif (!$data['leaderboard']): ?>
        <p class="muted">Inga inskickade pack under perioden.</p>
      <?php else: ?>
        <div class="table-wrap"><table class="lb">
          <thead><tr><th>#</th><th>Namn</th><th>Set</th><th>Bästa kort</th><th>Datum</th><th>Värde</th><th></th></tr></thead>
          <tbody>
          <?php foreach ($data['leaderboard'] as $i => $r): ?>
            <tr>
              <td><?= $i + 1 ?></td><td><b><?= h($r['name']) ?></b></td><td><?= h($r['set_name']) ?></td>
              <td><?= h($r['best_card_name']) ?><?= $r['best_card_value'] ? ' <span class="muted">' . num($r['best_card_value']) . ' kr</span>' : '' ?></td>
              <td class="muted"><?= h(date('Y-m-d H:i', (int)$r['created_at'])) ?></td>
              <td class="num"><?= num($r['pack_value']) ?> kr</td>
              <td><form method="post">
                <input type="hidden" name="csrf" value="<?= h($_SESSION['csrf']) ?>"><input type="hidden" name="delete_pull" value="<?= (int)$r['id'] ?>">
                <button class="btn small" type="submit">Ta bort</button></form></td>
            </tr>
          <?php endforeach; ?>
          </tbody>
        </table></div>
      <?php endif; ?>
    </section>
    <div class="grid">
      <?= board('Mest öppnade set', $data['packs'], 'pack', true) ?>
      <?= board('Set som skickats till topplistan', $data['submits'], 'st', true) ?>
    </div>

  <?php elseif ($view === 'ovrigt'): ?>
    <div class="grid">
      <?= board('Pushnotiser', $data['push'], 'st', false, 'Påslagna, avstängda, nekade och testnotiser.') ?>
      <?= board('Sidor som inte finns (404)', $data['notFound'], 'st', false, 'Adresser som gav 404. Många träffar på samma adress: lägg in en omdirigering.') ?>
    </div>
  <?php endif; ?>
  <?php endif; ?>
<?php endif; ?>
</div></body>
</html>
