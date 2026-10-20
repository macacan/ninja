// Artig hämtning: en förfrågan i taget per butik, paus mellan anrop, robots.txt kontrolleras före varje URL.
import { readFileSync } from "node:fs";
import { parseRobots, groupFor, isAllowed } from "./robots.mjs";

export const BOT = "PackninjaBot";
const cfg = (() => { try { return JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")); } catch { return {}; } })();
// Identifiera boten ärligt: namn, var man läser om den och hur man når ägaren.
export const UA = `${BOT}/1.0 (${[cfg.botInfoUrl && `+${cfg.botInfoUrl}`, cfg.contactEmail, "prisbevakning"].filter(Boolean).join("; ")})`;
const MIN_DELAY_MS = 3000;
const MAX_INLINE_WAIT_S = 120; // längre Retry-After än så: avbryt och låt schemat vänta i stället
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_BYTES = 20 * 1024 * 1024; // ett svar större än 20 MB läses inte, så att en trasig eller fientlig sida inte fyller minnet
const CACHE_MAX = 200; // sparade svar per butik för villkorlig hämtning (ETag/Last-Modified)

// Läser svaret som text men avbryter vid MAX_BYTES.
export async function readCapped(r, max = MAX_BYTES) {
  const len = +r.headers.get("content-length");
  if (len > max) { r.body?.cancel(); throw new Error(`svaret är för stort (${len} byte)`); }
  if (!r.body) return "";
  const reader = r.body.getReader(), parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { reader.cancel(); throw new Error(`svaret är för stort (över ${max} byte)`); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

// Butiken har slagit på ett botskydd (Cloudflare, Akamai, Imperva m.fl.). Vi försöker aldrig ta oss förbi
// sådant: det är butikens sätt att säga nej. Kontrollen pausas och butiken markeras som blockerad.
const CHALLENGE = /<title>\s*(just a moment|attention required|access denied|pardon our interruption)|challenge-platform|cf_chl_opt|_Incapsula_Resource|\/_sec\/cp_challenge|px-captcha/i;
function blockedBy(r, text) {
  if (r.headers.get("cf-mitigated") === "challenge") return "Cloudflare";
  if (!/html/i.test(r.headers.get("content-type") || "") || !CHALLENGE.test(text.slice(0, 6000))) return null;
  const server = (r.headers.get("server") || "").toLowerCase();
  return server.includes("cloudflare") ? "Cloudflare" : server.includes("akamai") ? "Akamai" : "botskydd";
}
const blocked = (who) => Object.assign(new Error(`${who} blockerar automatiska anrop`), { blocked: true });

export class Host {
  constructor(domain) {
    this.origin = `https://${domain}`;
    this.queue = Promise.resolve();
    this.last = 0;
    this.requests = 0;
    this.notModified = 0;
    // url → { etag, modified, text }. Svar med ETag eller Last-Modified sparas, och nästa gång frågar vi
    // butiken om sidan har ändrats. Svarar den 304 skickas ingen data alls och vi använder det sparade svaret.
    this.cache = new Map();
  }

  async init() {
    const r = await this.#raw(`${this.origin}/robots.txt`).catch(() => null);
    // Saknas robots.txt (404) är allt tillåtet. Kan vi inte läsa den alls (5xx, nätfel) avstår vi.
    if (r && r.status >= 500) throw new Error(`robots.txt svarade ${r.status}`);
    if (!r) throw new Error("kunde inte läsa robots.txt");
    const text = r.ok ? await readCapped(r) : "";
    const who = blockedBy(r, text);
    if (who) throw blocked(who);
    // 401/403 på robots.txt betyder i praktiken att boten är ovälkommen. Vi tolkar det som "allt förbjudet".
    this.robots = parseRobots(r.status === 401 || r.status === 403 ? "User-agent: *\nDisallow: /" : text);
    this.group = groupFor(this.robots, BOT);
    this.delay = Math.max(MIN_DELAY_MS, (this.group.delay || 0) * 1000);
    return this;
  }

  allowed(url) {
    const u = new URL(url, this.origin);
    return isAllowed(this.group, u.pathname + u.search);
  }

  // Node skickar själv accept-encoding (gzip, deflate, br). Webbläsarrubriker som sec-fetch-* skickar vi inte:
  // boten ska synas som den bot den är.
  // Accept skiljer på sidor och JSON: PrestaShop (t.ex. Mix-Max) svarar med en tom sida om application/json står med
  // när vi ber om HTML.
  #raw(url, extra = {}, type = "text") {
    const accept = type === "json" ? "application/json,*/*;q=0.5" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    const headers = { "user-agent": UA, accept, "accept-language": "sv-SE,sv;q=0.9,en;q=0.5", ...extra };
    return fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(20000) });
  }

  #remember(url, r, text) {
    const etag = r.headers.get("etag"), modified = r.headers.get("last-modified");
    this.cache.delete(url);
    if (!etag && !modified) return;
    this.cache.set(url, { etag, modified, text });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
  }

  // Köar förfrågan så att samma butik aldrig får två samtidiga anrop.
  get(url, { type = "text" } = {}) {
    const full = new URL(url, this.origin).href;
    if (!this.allowed(full)) return Promise.reject(Object.assign(new Error(`robots.txt tillåter inte ${full}`), { robots: true }));
    const job = this.queue.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const wait = this.last + this.delay - Date.now();
        if (wait > 0) await sleep(wait);
        this.last = Date.now();
        this.requests++;
        const saved = this.cache.get(full);
        const cond = { ...(saved?.etag && { "if-none-match": saved.etag }), ...(saved?.modified && { "if-modified-since": saved.modified }) };
        let r;
        try { r = await this.#raw(full, cond, type); }
        catch (e) {
          // Tillfälligt nätfel eller timeout: ett nytt försök efter en paus i stället för att hela butiken fallerar.
          if (attempt < 2) { await sleep(5000 * (attempt + 1)); continue; }
          throw Object.assign(new Error(`${full} → ${e.name === "TimeoutError" ? "timeout" : e.message}`), { network: true });
        }
        if (r.status === 304 && saved) {
          r.body?.cancel();
          this.notModified++;
          this.cache.delete(full); this.cache.set(full, saved); // senast använda svaret hamnar sist och rensas sist
          return type === "json" ? JSON.parse(saved.text) : saved.text;
        }
        const text = await readCapped(r);
        const who = blockedBy(r, text);
        if (who) throw blocked(who);
        // 429/503: butiken vill att vi saktar ner. Respektera Retry-After och backa.
        if (r.status === 429 || r.status === 503) {
          const ra = parseInt(r.headers.get("retry-after"), 10);
          const secs = Number.isFinite(ra) ? ra : 30;
          this.delay = Math.min(this.delay * 2, 60000);
          if (secs > MAX_INLINE_WAIT_S) throw Object.assign(new Error(`${full} → ${r.status}, vänta ${secs} s`), { status: r.status, retryAfter: secs });
          await sleep(secs * 1000);
          continue;
        }
        if (!r.ok) throw Object.assign(new Error(`${full} → ${r.status}`), { status: r.status });
        this.#remember(full, r, text);
        return type === "json" ? JSON.parse(text) : text;
      }
      throw Object.assign(new Error(`${full} → för många försök`), { status: 429 });
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
