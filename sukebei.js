// Sukebei torrent source for Hayase (v2, rewritten from scratch).
const BASE = atob("aHR0cHM6Ly9zdWtlYmVpLm55YWEuc2kv"); // https://sukebei.nyaa.si/
const TIMEOUT = 15000;
const MAX_TITLES = 8;

const TRACKERS = [
  "http://sukebei.tracker.wf:8888/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://exodus.desync.com:6969/announce"
];

const UNITS = { Bytes: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };

const pad = (n, l = 2) => String(n).padStart(l, "0");

// Strip characters that are operators in Nyaa's search syntax
const clean = t => String(t).replace(/["()|~*+\\]/g, " ").replace(/\s+/g, " ").trim();

function buildTitles(args) {
  const raw = [
    ...(Array.isArray(args.titles) ? args.titles : []),
    ...Object.values(args.media?.title ?? {}),
    ...(args.media?.synonyms ?? [])
  ];

  const seen = new Set();
  const originals = [];
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const t = clean(r);
    if (t.length <= 3 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    originals.push(t);
  }

  // Variants: "2nd Season" / "Season 2" -> "S2", and a hyphen-less copy
  const variants = [];
  for (const t of originals) {
    const m = t.match(/(\d+)(?:st|nd|rd|th) Season/i) ?? t.match(/Season (\d+)/i);
    if (m) variants.push(t.replace(/(\d+)(?:st|nd|rd|th) Season|Season \d+/i, `S${m[1]}`));
    if (t.includes("-")) variants.push(t.replaceAll("-", "").replace(/\s+/g, " ").trim());
  }

  const out = [];
  for (const t of [...originals, ...variants]) {
    if (!out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, MAX_TITLES);
}

const orGroup = list => `(${list.join(")|(")})`;

function episodePattern(episodes, digits, padded) {
  const alts = [];
  for (const e of episodes) {
    const p = padded ? pad(e, digits) : String(e);
    alts.push(`"E${p} "`, `"E${p}v"`, `" ${p} "`, `" ${p}v"`);
  }
  return alts.join("|");
}

function batchPattern(count, digits) {
  const alts = ['"batch"', '"complete"'];
  if (count > 1) {
    alts.push(
      `"${pad(1, digits)}-${pad(count, digits)}"`,
      `"${pad(1, digits)}~${pad(count, digits)}"`,
      `"1-${count}"`,
      `"1~${count}"`
    );
  }
  return alts.join("|");
}

// ---- RSS ----
const decode = s =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;|&#0?34;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&"); // must be last

function tag(xml, name) {
  const m = new RegExp(
    `<${name}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${name}>`,
    "i"
  ).exec(xml);
  if (!m) return "";
  return m[1] !== undefined ? m[1] : decode(m[2] ?? "");
}

function parseSize(s) {
  const [n, unit] = s.trim().split(/\s+/);
  const v = parseFloat(n);
  return Number.isFinite(v) ? Math.round(v * (UNITS[unit] ?? 1)) : 0;
}

function parseRSS(xml) {
  if (!xml) return [];
  const results = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const c = m[1];
    const title = tag(c, "title").trim();
    const hash = tag(c, "nyaa:infoHash").trim().toLowerCase();
    if (!title || !hash) continue;

    const date = new Date(tag(c, "pubDate"));
    const magnet =
      `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}` +
      TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join("");

    results.push({
      title,
      link: magnet,
      hash,
      seeders: parseInt(tag(c, "nyaa:seeders"), 10) || 0,
      leechers: parseInt(tag(c, "nyaa:leechers"), 10) || 0,
      downloads: parseInt(tag(c, "nyaa:downloads"), 10) || 0,
      size: parseSize(tag(c, "nyaa:size")),
      date: isNaN(+date) ? new Date(0) : date,
      accuracy: "medium",
      type: "alt"
    });
  }
  return results;
}

async function search(query) {
  const url = `${BASE}?page=rss&c=1_1&s=seeders&o=desc&q=${encodeURIComponent(query)}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw new Error(`Could not reach ${BASE}: ${e.message}`);
  }
  if (!res.ok) throw new Error(`Sukebei returned ${res.status} ${res.statusText}`);
  return parseRSS(await res.text());
}

function exclusionString(exclusions) {
  const list = (exclusions ?? []).map(clean).filter(Boolean);
  return list.length ? " " + list.map(e => `-"${e}"`).join(" ") : "";
}

function offline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export default new class {
  async single(args) {
    if (offline()) return [];
    const titles = buildTitles(args);
    if (!titles.length) return [];

    const { episode, episodeCount, absoluteEpisodeNumber } = args;
    const excl = exclusionString(args.exclusions);
    const base = orGroup(titles);

    // No episode filter for single-episode releases (movies/OVAs) or when no episode is given
    if (episode == null || episodeCount === 1) {
      return search(base + excl);
    }

    const episodes = [episode];
    if (absoluteEpisodeNumber && absoluteEpisodeNumber !== episode && absoluteEpisodeNumber > (episodeCount ?? 0)) {
      episodes.push(absoluteEpisodeNumber);
    }

    const digits = Math.max(2, String(Math.max(...episodes, episodeCount ?? 0)).length);

    let results = await search(`${base} (${episodePattern(episodes, digits, true)})${excl}`);
    if (!results.length) {
      // Fallback for releases that number episodes without zero padding
      results = await search(`${base} (${episodePattern(episodes, digits, false)})${excl}`);
    }
    return results;
  }

  async batch(args) {
    if (offline()) return [];
    const titles = buildTitles(args);
    if (!titles.length) return [];

    const digits = Math.max(2, String(args.episodeCount ?? 0).length);
    const query = `${orGroup(titles)} (${batchPattern(args.episodeCount ?? 0, digits)})${exclusionString(args.exclusions)}`;
    return (await search(query)).map(r => ({ ...r, type: "alt" }));
  }

  async movie(args) {
    if (offline()) return [];
    const titles = buildTitles(args);
    if (!titles.length) return [];
    return search(orGroup(titles) + exclusionString(args.exclusions));
  }

  async test() {
    try {
      const res = await fetch(`${BASE}?page=rss`, { signal: AbortSignal.timeout(TIMEOUT) });
      if (!res.ok) throw new Error(String(res.status));
      return true;
    } catch (e) {
      throw new Error(`Could not reach ${BASE}! Does the site work in your region?`);
    }
  }
}();
