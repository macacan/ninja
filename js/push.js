// Pushnotiser (Web Push): notiser i mobilen och datorn, även när Lootninja är stängd. Webbläsaren ger en adress hos
// sin notistjänst (Google, Apple, Mozilla, Microsoft), som sparas i api/push.php tillsammans med urvalet. Bevakningen
// skickar sedan notiser dit (scripts/scraper/lib/notify.mjs). På iPhone och iPad fungerar det bara när sidan är
// tillagd på hemskärmen och öppnas därifrån (iOS 16.4 och senare).
import { getPrefs, savePrefs } from "./prefs.js";

const API = "api/push.php";
const VAPID_PUBLIC = "BKlh5desmb5StUSq70bmkjzTbZD0zaUed1JGYgnti2oznobTFidPAYoGisH24X3CCiUH0nv3WOyCgCVEpMiwYFo";

const key = () => Uint8Array.from(atob(VAPID_PUBLIC.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
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

// Visar en notis direkt från webbläsaren, utan att gå via servern. Kommer den fram vet besökaren att telefonen eller
// datorn släpper igenom notiser från Lootninja (och inte blockerar dem med Stör ej eller fokusläge).
export async function localNotice(body, tag = "lootninja-local") {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification("Lootninja", { body, icon: "img/icon-192.png?v=2", badge: "img/favicon-48.png?v=2", tag, data: { url: "butiker.html#notiser" } });
}

export async function enablePush() {
  if (await Notification.requestPermission() !== "granted") return false;
  const reg = await navigator.serviceWorker.register("sw.js");
  await navigator.serviceWorker.ready;
  // Välkomstnotisen visas innan prenumerationen sparas, så att den kommer även om servern inte svarar.
  await localNotice("Pushnotiser är på! Ninjan säger till när nya boxar eller prissänkningar dyker upp.", "lootninja-welcome").catch(() => {});
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key() });
  await post("subscribe", payload(sub));
  savePrefs({ ...getPrefs(), push: true });
  return true;
}

export const testPush = () => localNotice("Testnotis: Pushnotiser fungerar klockrent på den här enheten!", "lootninja-test");

// Var man tillåter notiser igen när de är blockerade, efter webbläsare och system.
export function blockedHelp() {
  const ua = navigator.userAgent;
  const browser = /edg\//i.test(ua) ? "Edge: klicka på hänglåset till vänster om adressen → Behörigheter för den här webbplatsen → Meddelanden → Tillåt."
    : /firefox/i.test(ua) ? "Firefox: klicka på hänglåset till vänster om adressen → Rensa behörigheter, eller Inställningar → Sekretess och säkerhet → Behörigheter → Aviseringar."
    : /safari/i.test(ua) && !/chrome|android/i.test(ua) ? "Safari: Safari → Inställningar → Webbplatser → Notiser → lootninja.se → Tillåt."
    : /android/i.test(ua) ? "Android: tryck på ikonen till vänster om adressen → Behörigheter → Aviseringar → Tillåt. Kolla också Inställningar → Appar → webbläsaren → Aviseringar."
    : "Chrome: klicka på ikonen till vänster om adressen → Webbplatsinställningar → Aviseringar → Tillåt.";
  return `Notiser är blockerade för lootninja.se. ${browser} Ladda sedan om sidan.`;
}

// Tips när notisen inte syns fast allt är påslaget: oftast stoppar systemet den.
export function silentHelp() {
  const ua = navigator.userAgent;
  if (/windows/i.test(ua)) return "Syns ingen notis? Stäng av Fokusassistans/Stör ej (Windows-inställningar → System → Meddelanden) och kolla att webbläsaren får visa meddelanden där.";
  if (/mac os x/i.test(ua) && !isIos()) return "Syns ingen notis? Stäng av Stör ej/Fokus i Kontrollcenter och tillåt notiser för webbläsaren under Systeminställningar → Notiser.";
  if (isIos()) return "Syns ingen notis? Stäng av Fokus/Stör ej i Kontrollcenter och tillåt notiser för Lootninja under Inställningar → Notiser.";
  if (/android/i.test(ua)) return "Syns ingen notis? Stäng av Stör ej och tillåt aviseringar för webbläsaren under Inställningar → Appar.";
  return "Syns ingen notis? Kolla att Stör ej/fokusläge är avstängt och att webbläsaren får visa notiser i systemets inställningar.";
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
