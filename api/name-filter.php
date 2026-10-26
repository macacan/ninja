<?php
// Namnfiltret för topplistan. Används av api/highscore.php (när någon skickar in ett pack) och av
// stats/dashboard.php (där blockerade ord läggs till och tas bort, och befintliga namn kan rensas).
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === 'name-filter.php') { http_response_code(404); exit; }

// Inbyggda ord som aldrig får finnas i ett namn. Egna ord läggs till i dashboarden och sparas i tabellen blocked_words.
const NAME_BLOCKED = ['fitta', 'kuk', 'hora', 'hore', 'neger', 'nigger', 'nigga', 'fuck', 'cunt', 'bitch', 'whore', 'rape', 'nazi', 'hitler', 'faggot', 'bög', 'retard', 'jävla', 'javla', 'knull', 'slyna', 'mongo', 'heil', 'kkk', 'porr', 'porn'];

function nameBlockTable(PDO $db): void {
  $db->exec('CREATE TABLE IF NOT EXISTS blocked_words (word TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
}

// Alla blockerade ord: de inbyggda plus de som lagts till i dashboarden.
function nameBlockedWords(PDO $db): array {
  nameBlockTable($db);
  $own = $db->query('SELECT word FROM blocked_words')->fetchAll(PDO::FETCH_COLUMN);
  return array_values(array_unique(array_merge(NAME_BLOCKED, $own)));
}

// Ett ord som det sparas: gemener, bara bokstäver och siffror.
function nameNormalizeWord(string $w): string {
  return preg_replace('/[^\p{L}\p{N}]+/u', '', mb_strtolower(trim($w), 'UTF-8')) ?? '';
}

// 2–20 tecken: bokstäver, siffror, mellanslag och . _ - ! ?
function nameShapeOk(string $name): bool {
  $len = mb_strlen($name, 'UTF-8');
  return $len >= 2 && $len <= 20 && preg_match('/^[\p{L}\p{N} ._\-!?]+$/u', $name) === 1;
}

// Det blockerade ord som namnet innehåller, eller null. Jämförs utan mellanslag och med siffror som bokstäver (f4ck).
// Korta ord (högst 4 tecken, t.ex. "kuk", "rape") bara som egna ord, annars stoppas vanliga namn som Kukui och Grape.
function nameBlockedBy(string $name, array $words): ?string {
  $leet = strtr(mb_strtolower($name, 'UTF-8'), ['0' => 'o', '1' => 'i', '3' => 'e', '4' => 'a', '5' => 's', '7' => 't']);
  $flat = preg_replace('/[\s._\-!?]+/u', '', $leet);
  $parts = preg_split('/[\s._\-!?]+/u', $leet, -1, PREG_SPLIT_NO_EMPTY);
  foreach ($words as $w) {
    if ($w === '') continue;
    if (mb_strlen($w, 'UTF-8') <= 4 ? ($flat === $w || in_array($w, $parts, true)) : str_contains($flat, $w)) return $w;
  }
  return null;
}
