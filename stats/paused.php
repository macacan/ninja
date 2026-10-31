<?php
// Butiker som pausats i dashboarden (fliken Bevakningar). Läses av skraparen (scripts/scraper/lib/engine.mjs)
// varje minut, så att en pausad butik slutar hämtas och en startad börjar igen.
//   GET paused.php -> { updated, paused: ["butiks-id", ...] }
require __DIR__ . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

$j = json_decode((string)@file_get_contents(statsDir() . '/' . STATS_PAUSE_FILE), true);
echo json_encode(['updated' => (int)($j['updated'] ?? 0), 'paused' => statsPaused()]);
