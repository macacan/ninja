// Web Push utan beroenden: krypterar en notis till en webbläsares prenumeration (RFC 8291, aes128gcm) och
// signerar anropet med Lootninjas VAPID-nyckel (RFC 8292). Används av notify.mjs.
import { createECDH, createPrivateKey, createCipheriv, hkdfSync, randomBytes, sign } from "node:crypto";

export const VAPID_PUBLIC = "BKlh5desmb5StUSq70bmkjzTbZD0zaUed1JGYgnti2oznobTFidPAYoGisH24X3CCiUH0nv3WOyCgCVEpMiwYFo";
const SUBJECT = "mailto:hej@lootninja.se";

// Bara de stora webbläsarnas notistjänster. Adressen kommer från besökaren, så vi skickar aldrig någon annanstans.
export const PUSH_HOST = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

const b64u = (b) => Buffer.from(b).toString("base64url");

// VAPID-nyckeln som nyckelobjekt. Miljövariabeln innehåller bara den hemliga delen (d), den publika räknas fram.
export function vapidKey(privateB64u) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateB64u.trim(), "base64url"));
  const pub = ecdh.getPublicKey();
  if (b64u(pub) !== VAPID_PUBLIC) throw new Error("VAPID_PRIVATE_KEY hör inte ihop med den publika nyckeln i webpush.mjs");
  return createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "P-256", d: privateB64u.trim(), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
}

// En signerad JWT (ES256). Används både mot notistjänsterna och mot vår egen api/push.php.
export function jwt(key, claims) {
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" })), body = b64u(JSON.stringify(claims));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}

// Krypterar payload till prenumerationen: { endpoint, keys: { p256dh, auth } }.
export function encrypt(sub, payload) {
  const uaPublic = Buffer.from(sub.keys.p256dh, "base64url"), authSecret = Buffer.from(sub.keys.auth, "base64url");
  const ecdh = createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = randomBytes(16);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 markerar sista (och enda) posten.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Skickar en notis. Svarar "ok", "gone" (prenumerationen finns inte längre och ska tas bort) eller kastar ett fel.
export async function sendPush(sub, message, key, { ttl = 6 * 3600, urgency = "normal" } = {}) {
  const url = new URL(sub.endpoint);
  if (url.protocol !== "https:" || !PUSH_HOST.test(url.hostname)) return "gone";
  const token = jwt(key, { aud: url.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT });
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(ttl), urgency,
      authorization: `vapid t=${token}, k=${VAPID_PUBLIC}` },
    body: encrypt(sub, JSON.stringify(message)),
    signal: AbortSignal.timeout(15000),
  });
  if (r.ok) return "ok";
  if (r.status === 404 || r.status === 410) return "gone";
  throw new Error(`${url.hostname} ${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}`);
}
