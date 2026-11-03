<?php
// Besökarens IP-adress bakom Cloudflare. Används av api/highscore.php, api/pack-limit.php, api/push.php och
// stats/lib.php. IP-adressen sparas aldrig i klartext någonstans, bara som saltad kontrollsumma.
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === 'client-ip.php') { http_response_code(404); exit; }

// Cloudflares egna adresser (https://www.cloudflare.com/ips/). Bara när anropet kommer därifrån går det att lita på
// CF-Connecting-IP. Annars kan vem som helst skicka med huvudet och hitta på en ny IP.
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

function ipInRange(string $ip, string $cidr): bool {
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

function clientIp(): string {
  $remote = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
  $cf = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? '';
  if ($cf !== '' && filter_var($cf, FILTER_VALIDATE_IP)) {
    foreach (CLOUDFLARE_RANGES as $range) if (ipInRange($remote, $range)) return $cf;
  }
  return $remote;
}
