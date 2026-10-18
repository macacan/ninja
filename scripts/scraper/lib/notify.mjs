// Skickar nya händelser till mobilen (ntfy) och valfritt till Discord.
// ntfy-ämnet läses från config.json eller miljövariabeln NTFY_TOPIC. Discord-webhooken är hemlig och
// läses bara från miljövariabeln DISCORD_WEBHOOK, så att den aldrig hamnar i koden.

const KIND = {
  ny: { label: "Ny produkt", tag: "new" },
  tillbaka: { label: "Tillbaka i lager", tag: "white_check_mark" },
  prissankt: { label: "Prissänkt", tag: "chart_with_downwards_trend" },
  forbestallning: { label: "Förbeställning öppen", tag: "calendar" },
};
const MAX_SINGLE = 8; // fler händelser än så i en körning blir en sammanfattning, så att ingen får notisspam

const kr = (n) => `${Math.round(n).toLocaleString("sv-SE")} kr`;
export const slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function line(e, storeName) {
  const k = KIND[e.kind] || { label: e.kind };
  const price = e.kind === "prissankt" ? `${kr(e.from)} → ${kr(e.price)}` : kr(e.price);
  return { title: `${k.label}: ${e.title}`, body: `${storeName[e.store] || e.store} · ${price}`, tag: k.tag };
}

// Tre försök med paus, så att en kort störning hos ntfy inte gör att en påfyllningsnotis försvinner.
async function post(url, body, label) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(15000) });
      if (r.ok) return;
      if (r.status < 500 && r.status !== 429) throw Object.assign(new Error(`${label} ${r.status}`), { final: true });
      if (i >= 2) throw new Error(`${label} ${r.status}`);
    } catch (e) {
      if (e.final || i >= 2) throw e;
    }
    await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
  }
}

const ntfy = (topic, msg) => post("https://ntfy.sh", JSON.stringify({ topic, ...msg }), "ntfy");

async function toNtfy(base, events, storeName) {
  // Två sorters ämnen: ett med allt, och ett per produkttyp (t.ex. ninjaloot-xyz-elite-trainer-box).
  const groups = new Map([[`${base}-alla`, events]]);
  for (const e of events) {
    const t = `${base}-${slug(e.type || "ovrigt")}`;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(e);
  }
  for (const [topic, list] of groups) {
    if (list.length > MAX_SINGLE) {
      const counts = Object.entries(list.reduce((a, e) => ((a[e.kind] = (a[e.kind] || 0) + 1), a), {}))
        .map(([k, n]) => `${n} ${(KIND[k]?.label || k).toLowerCase()}`).join(", ");
      await ntfy(topic, { title: `${list.length} nya händelser i butikerna`, message: `${counts}. Öppna Ninjaloot för hela listan.`, tags: ["bell"] });
      continue;
    }
    for (const e of list) {
      const l = line(e, storeName);
      await ntfy(topic, { title: l.title, message: l.body, tags: [l.tag], click: e.url, priority: e.kind === "tillbaka" || e.kind === "forbestallning" ? 4 : 3 });
    }
  }
}

async function toDiscord(webhook, events, storeName) {
  // Discord tar högst 10 inbäddningar per meddelande.
  for (let i = 0; i < Math.min(events.length, 30); i += 10) {
    const embeds = events.slice(i, i + 10).map((e) => {
      const l = line(e, storeName);
      return { title: l.title.slice(0, 250), url: e.url, description: l.body, color: e.kind === "prissankt" ? 0xe3262f : e.kind === "tillbaka" ? 0x58c06a : 0xf2b632 };
    });
    await post(webhook, JSON.stringify({ username: "Ninjaloot", embeds }), "Discord");
  }
}

export async function notify(events, storeName, cfg = {}) {
  if (!events.length) return;
  const topic = process.env.NTFY_TOPIC || cfg.ntfyTopic;
  const webhook = process.env.DISCORD_WEBHOOK;
  const jobs = [];
  if (topic) jobs.push(toNtfy(topic, events, storeName).then(() => console.log(`Notiser skickade till ntfy (${topic}-…).`)));
  if (webhook) jobs.push(toDiscord(webhook, events, storeName).then(() => console.log("Notiser skickade till Discord.")));
  // En trasig notistjänst får aldrig stoppa själva bevakningen.
  for (const r of await Promise.allSettled(jobs)) if (r.status === "rejected") console.warn(`Notiser misslyckades: ${r.reason.message}`);
}
