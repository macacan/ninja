<?php
// Lootninjas besöksstatistik: sidvisningar, besökare, butiksklick, sökningar och packöppningar.
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

// ---------- Data ----------
$days = in_array((int)($_GET['days'] ?? 30), [1, 7, 30, 365], true) ? (int)($_GET['days'] ?? 30) : 30;
$data = null;
if ($authed) {
  try {
    $db = statsDb();
    $since = fn(int $d) => date('Y-m-d 00:00:00', strtotime('-' . ($d - 1) . ' days'));
    $one = function (string $sql, array $args = []) use ($db) { $s = $db->prepare($sql); $s->execute($args); return $s->fetchColumn(); };
    $all = function (string $sql, array $args = []) use ($db) { $s = $db->prepare($sql); $s->execute($args); return $s->fetchAll(); };
    // Unika besökare räknas per dag (saltet byts varje natt), så flera dagar blir summan av dagarna.
    $visitors = fn(string $from) => (int)$one("SELECT COUNT(*) FROM (SELECT DISTINCT visitor, substr(created_at, 1, 10) FROM events WHERE type = 'pageview' AND created_at >= ?)", [$from]);
    $views = fn(string $from) => (int)$one("SELECT COUNT(*) FROM events WHERE type = 'pageview' AND created_at >= ?", [$from]);
    $from = $since($days);
    $top = fn(string $type, int $limit = 10) => $all("SELECT target, COUNT(*) AS n, AVG(CAST(value AS REAL)) AS avg, MAX(CAST(value AS REAL)) AS max FROM events WHERE type = ? AND created_at >= ? AND target IS NOT NULL GROUP BY target ORDER BY n DESC LIMIT $limit", [$type, $from]);
    $data = [
      'kpi' => [
        ['I dag', $visitors($since(1)), $views($since(1))],
        ['7 dagar', $visitors($since(7)), $views($since(7))],
        ['30 dagar', $visitors($since(30)), $views($since(30))],
      ],
      'daily' => $all("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM events WHERE type = 'pageview' AND created_at >= ? GROUP BY day ORDER BY day", [$since(30)]),
      'pages' => $all("SELECT path AS target, COUNT(*) AS n FROM events WHERE type = 'pageview' AND created_at >= ? GROUP BY path ORDER BY n DESC LIMIT 12", [$from]),
      'stores' => $top('store_click', 15),
      'searches' => $top('search', 15),
      'packs' => $top('pack_open', 10),
      'watch' => $top('watch', 10),
      'refs' => $all("SELECT referrer AS target, COUNT(*) AS n FROM events WHERE type = 'pageview' AND created_at >= ? GROUP BY referrer ORDER BY n DESC LIMIT 10", [$from]),
      'devices' => $all("SELECT device AS target, COUNT(*) AS n FROM events WHERE type = 'pageview' AND created_at >= ? GROUP BY device ORDER BY n DESC", [$from]),
      'totals' => $all("SELECT type, COUNT(*) AS n FROM events WHERE created_at >= ? GROUP BY type", [$from]),
    ];
  } catch (Throwable $e) {
    $error = 'Databasen gick inte att öppna: ' . $e->getMessage();
  }
}

// En topplista som tabell med en liten stapel för andelen.
function board(string $title, array $rows, string $unit = 'st', bool $money = false): string {
  $max = max(array_merge([1], array_map(fn($r) => (int)$r['n'], $rows)));
  $out = '<section class="box"><h2>' . h($title) . '</h2>';
  if (!$rows) return $out . '<p class="muted">Inget än.</p></section>';
  $out .= '<ol class="board">';
  foreach ($rows as $r) {
    $extra = $money && $r['avg'] !== null ? '<small>snitt ' . num($r['avg']) . ' kr · max ' . num($r['max']) . ' kr</small>' : '';
    $out .= '<li><span class="lbl">' . h($r['target'] ?? '–') . $extra . '</span><b>' . num($r['n']) . ' ' . h($unit) . '</b><i style="--w:' . round((int)$r['n'] / $max * 100) . '%"></i></li>';
  }
  return $out . '</ol></section>';
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
h1{font-size:1.7rem;display:flex;align-items:center;gap:10px}
h2{font-size:1.1rem;margin-bottom:10px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:18px}
.box{background:var(--card);border:2px solid var(--ink);border-radius:var(--r);box-shadow:3px 3px 0 var(--ink);padding:14px 16px;min-width:0}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));margin-top:16px}
.kpis{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))}
.kpi span{font:600 .8rem var(--pixel);color:var(--muted);text-transform:uppercase;letter-spacing:1px}
.kpi b{display:block;font:700 2rem/1.1 var(--pixel);color:var(--ink)}
.kpi small{color:var(--muted)}
.seg{display:inline-flex;border:2px solid var(--ink);border-radius:var(--r);overflow:hidden;box-shadow:3px 3px 0 var(--ink)}
.seg a{font:600 .9rem var(--pixel);padding:8px 12px;text-decoration:none;color:var(--ink);background:var(--card)}
.seg a+a{border-left:2px solid var(--ink)}
.seg a[aria-current]{background:var(--gold);color:#1b1b2f}
.btn{font:600 .9rem var(--pixel);padding:8px 14px;border:2px solid var(--ink);border-radius:var(--r);box-shadow:3px 3px 0 var(--ink);background:var(--card);color:var(--ink);text-decoration:none;cursor:pointer}
.btn.gold{background:var(--gold);color:#1b1b2f}
.board{list-style:none;margin:0;padding:0;display:grid;gap:6px;counter-reset:r}
.board li{position:relative;display:flex;gap:10px;justify-content:space-between;align-items:center;padding:6px 8px;border-radius:4px;overflow:hidden;counter-increment:r}
.board li::before{content:counter(r);font:600 .8rem var(--pixel);color:var(--muted);width:1.4em;flex:none}
.board .lbl{flex:1;min-width:0;overflow-wrap:anywhere;position:relative;z-index:1}
.board small{display:block;color:var(--muted);font-size:.75rem}
.board b{font:600 .95rem var(--pixel);white-space:nowrap;position:relative;z-index:1}
.board i{position:absolute;left:0;top:0;bottom:0;width:var(--w);background:var(--gold);opacity:.22}
.chart{display:flex;align-items:flex-end;gap:3px;height:160px;padding-top:8px}
.chart div{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:0}
.chart span{display:block;background:var(--gold);border:2px solid var(--ink);border-bottom:0;min-height:2px}
.chart em{display:block;background:var(--mint);border:2px solid var(--ink);border-bottom:0;margin-top:-2px}
.legend{display:flex;gap:14px;font-size:.8rem;color:var(--muted);margin-top:6px}
.legend i{display:inline-block;width:10px;height:10px;border:2px solid var(--ink);margin-right:5px;vertical-align:-1px}
.muted{color:var(--muted)}
.err{color:var(--red);font-weight:600}
form.login{max-width:360px;margin:12vh auto 0;display:grid;gap:12px}
input[type=password]{font:inherit;padding:10px 12px;border:2px solid var(--ink);border-radius:var(--r);background:var(--bg);color:var(--ink)}
code{background:var(--bg);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
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
    <nav class="seg" aria-label="Period för topplistorna">
      <?php foreach ([1 => 'I dag', 7 => '7 dagar', 30 => '30 dagar', 365 => '1 år'] as $d => $label): ?>
        <a href="?days=<?= $d ?>"<?= $d === $days ? ' aria-current="page"' : '' ?>><?= h($label) ?></a>
      <?php endforeach; ?>
    </nav>
    <a class="btn" href="?logout=1">Logga ut</a>
  </header>
  <?php if ($error): ?><p class="err"><?= h($error) ?></p><?php endif; ?>
  <?php if ($data): ?>
    <div class="kpis">
      <?php foreach ($data['kpi'] as [$label, $v, $pv]): ?>
        <div class="box kpi"><span><?= h($label) ?></span><b><?= num($v) ?></b><small>besökare · <?= num($pv) ?> sidvisningar</small></div>
      <?php endforeach; ?>
    </div>

    <section class="box" style="margin-top:16px">
      <h2>Senaste 30 dagarna</h2>
      <?php $peak = max(array_merge([1], array_map(fn($r) => (int)$r['views'], $data['daily']))); ?>
      <div class="chart" role="img" aria-label="Sidvisningar och besökare per dag">
        <?php foreach ($data['daily'] as $r): ?>
          <div title="<?= h($r['day']) ?>: <?= num($r['views']) ?> sidvisningar, <?= num($r['visitors']) ?> besökare">
            <span style="height:<?= round(((int)$r['views'] - (int)$r['visitors']) / $peak * 100, 1) ?>%"></span>
            <em style="height:<?= round((int)$r['visitors'] / $peak * 100, 1) ?>%"></em>
          </div>
        <?php endforeach; ?>
      </div>
      <div class="legend"><span><i style="background:var(--mint)"></i>Besökare</span><span><i style="background:var(--gold)"></i>Fler sidvisningar</span></div>
      <p class="muted" style="margin:8px 0 0;font-size:.8rem">Besökare räknas per dag utan kakor, så samma person två dagar räknas två gånger.
        Perioden: <?php foreach ($data['totals'] as $t) echo h($t['type']) . ' ' . num($t['n']) . ' · '; ?></p>
    </section>

    <div class="grid">
      <?= board('Mest klickade butiker', $data['stores'], 'klick') ?>
      <?= board('Populäraste sökningarna', $data['searches'], 'st') ?>
      <?= board('Mest öppnade set i packöppnaren', $data['packs'], 'pack', true) ?>
      <?= board('Mest besökta sidor', $data['pages'], 'visn.') ?>
      <?= board('Varifrån besökarna kommer', $data['refs'], 'visn.') ?>
      <?= board('Bevakade produkter', $data['watch'], 'st') ?>
      <?= board('Enheter', $data['devices'], 'visn.') ?>
    </div>
  <?php endif; ?>
<?php endif; ?>
</div></body>
</html>
