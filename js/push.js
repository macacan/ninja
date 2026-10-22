// Pushnotiser (Web Push): notiser i mobilen och datorn, även när Lootninja är stängd. Webbläsaren ger en adress hos
// sin notistjänst (Google, Apple, Mozilla, Microsoft), som sparas i api/push.php tillsammans med urvalet. Bevakningen
// skickar sedan notiser dit (scripts/scraper/lib/notify.mjs). På iPhone och iPad fungerar det bara när sidan är
// tillagd på hemskärmen och öppnas därifrån (iOS 16.4 och senare).
import { getPrefs, savePrefs } from "./prefs.js";

const API = "api/push.php";
const VAPID_PUBLIC = "BHvJoQFrJA9X88GAo28EelLurqVR-ullGo6OUT2YrCXGcB43V9Y9obaS9ox-Qq_bAuItSf_GIexVrvpF1LOYtHw";

const key = () => Uint8Array.from(atob(VAPID_PUBLIC.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// "on", "off", "denied", "unsupported" eller "ios-install" (iPhone/iPad som inte öppnat sidan från hemskärmen).
export function pushState() {
  if (isIos() && !isStandalone()) return "ios-install";
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return getPrefs().push && Notification.permission === "granted" ? "on" : "off";
}

const post = (action, data) => fetch(`${API}?action=${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) })
  .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const payload = (sub) => {
  const p = getPrefs();
  return { subscription: sub.toJSON(), prefs: { stores: p.stores, types: p.types, sets: p.sets, langs: p.langs, kinds: p.kinds, maxPrice: p.maxPrice, watch: p.watch } };
};
const subscription = async () => (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription() ?? null;

export async function enablePush() {
  if (await Notification.requestPermission() !== "granted") return false;
  const reg = await navigator.serviceWorker.register("sw.js");
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key() });
  await post("subscribe", payload(sub));
  savePrefs({ ...getPrefs(), push: true });
  return true;
}

export async function disablePush() {
  const sub = await subscription().catch(() => null);
  if (sub) {
    await post("unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  savePrefs({ ...getPrefs(), push: false });
}

// Skickar det sparade urvalet till servern, efter "Spara mina val", en ny bevakning med klockan och när sidan laddas
// (då kommer servern ikapp om webbläsaren bytt adress).
let timer;
export function syncPush() {
  if (!getPrefs().push || !supported()) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const sub = await subscription();
      if (sub) await post("subscribe", payload(sub));
      else savePrefs({ ...getPrefs(), push: false }); // prenumerationen är borta, t.ex. om man nekat notiser i inställningarna
    } catch {}
  }, 600);
}
