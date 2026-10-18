// Minimal robots.txt-tolk enligt RFC 9309: grupper per user-agent, allow/disallow med * och $,
// längsta matchning vinner och allow vinner vid lika längd.

export function parseRobots(text = "") {
  const groups = [];
  let current = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase(), value = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent) { current = { agents: [], rules: [], delay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") { if (value) current.rules.push({ allow: key === "allow", path: value }); }
    else if (key === "crawl-delay") { const d = parseFloat(value); if (d >= 0) current.delay = d; }
  }
  const sitemaps = [...text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  return { groups, sitemaps };
}

// Vår egen grupp om butiken har en sådan, annars *-gruppen.
export function groupFor(robots, token) {
  const t = token.toLowerCase();
  const own = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && t.includes(a)));
  const pick = own.length ? own : robots.groups.filter((g) => g.agents.includes("*"));
  return { rules: pick.flatMap((g) => g.rules), delay: pick.map((g) => g.delay).find((d) => d != null) ?? null };
}

const toRegex = (p) => new RegExp("^" + p.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$|\$$/, "$"));

export function isAllowed(group, pathAndQuery) {
  let best = null;
  for (const r of group.rules) {
    if (!toRegex(r.path).test(pathAndQuery)) continue;
    const len = r.path.replace(/[*$]/g, "").length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}
