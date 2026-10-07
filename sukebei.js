const sizeMap = {
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4
};

// ~124 days. Margin used when comparing upload dates against prequel/sequel dates.
const DATE_MARGIN = 10699393840;
const FETCH_TIMEOUT = 15000;

function zeropad(v = 1, l = 2) {
  return ("string" == typeof v ? v : v.toString()).padStart(l, "0");
}

// Matches "E05 ", "E05v", " 05 ", " 05v", " 05-" (spaces are real spaces; the whole query is encoded once later)
const epstring = (ep, digits = 2) => {
  const p = zeropad(ep, digits);
  return `"E${p} "|"E${p}v"|" ${p} "|" ${p}v"|" ${p}-"`;
};

// Remove characters that act as operators in Nyaa's search syntax
const clean = t => t.replace(/["()|~*+\\]/g, " ").replace(/\s+/g, " ").trim();

function createTitle(_titles) {
  const grouped = [...new Set(
    _titles.filter(name => null != name && name.length > 3).map(clean)
  )].filter(name => name.length > 3);

  const titles = new Set();
  const add = t => {
    titles.add(t);
    // "2nd Season" / "Season 2" -> also search "S2" (handles multi-digit, e.g. "10th Season")
    const m = t.match(/(\d+)(?:st|nd|rd|th) Season/i) ?? t.match(/Season (\d+)/i);
    if (m) titles.add(t.replace(/(\d+)(?:st|nd|rd|th) Season|Season \d+/i, `S${m[1]}`));
  };

  for (const t of grouped) {
    add(t);
    if (t.includes("-")) add(t.replaceAll("-", "").replace(/\s+/g, " ").trim());
  }
  return [...titles];
}

function findEdge(media, type, formats = ["TV", "TV_SHORT"], skip) {
  let res = media.relations?.edges?.find(
    edge => edge.relationType === type && formats.includes(edge.node.format)
  );
  if (!res && !skip && "SEQUEL" === type) {
    res = findEdge(media, type, ["TV", "TV_SHORT", "OVA"], true);
  }
  return res;
}

function anilistDate(d) {
  if (!d?.year) return null;
  return new Date(d.year, (d.month ?? 1) - 1, d.day ?? 1);
}

const decode = s =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;|&#0?34;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&"); // must be last

// Reads <name>value</name> or <name><![CDATA[value]]></name>; only non-CDATA text is entity-decoded
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
  return Number.isFinite(v) ? Math.round(v * (sizeMap[unit] ?? 1)) : 0;
}

function parseRSSItems(xml) {
  if (!xml) return [];
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while (null !== (match = itemRegex.exec(xml))) {
    const c = match[1];
    const title = tag(c, "title");
    const hash = tag(c, "nyaa:infoHash").trim().toLowerCase();
    const link = tag(c, "link").trim() || (hash ? `magnet:?xt=urn:btih:${hash}` : "");
    if (!title || !link) continue;
    items.push({
      title,
      link,
      seeders: parseInt(tag(c, "nyaa:seeders"), 10) || 0,
      leechers: parseInt(tag(c, "nyaa:leechers"), 10) || 0,
      downloads: parseInt(tag(c, "nyaa:downloads"), 10) || 0,
      size: parseSize(tag(c, "nyaa:size")),
      hash,
      accuracy: "low",
      date: new Date(tag(c, "pubDate"))
    });
  }
  return items;
}

async function getRSSContent(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) throw new Error(res.statusText || `HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    throw new Error("Failed fetching RSS!\n" + e.message);
  }
}

export default new class {
  url = atob("aHR0cHM6Ly9zdWtlYmVpLm55YWEuc2kv");

  async single({ media, episode, exclusions = [], episodeCount, absoluteEpisodeNumber }, _, isBatch = false) {
    if (!navigator.onLine) return [];
    if (!media.isAdult && !media.genres?.includes("Hentai")) return [];

    const titles = createTitle([...Object.values(media.title ?? {}), ...(media.synonyms ?? [])]);
    if (!titles.length) return [];

    const prequel = findEdge(media, "PREQUEL")?.node;
    const sequel = findEdge(media, "SEQUEL")?.node;

    const episodes = [episode];
    if (absoluteEpisodeNumber && absoluteEpisodeNumber !== episode && absoluteEpisodeNumber > episodeCount) {
      episodes.push(absoluteEpisodeNumber);
    }

    // Use the same padding width for batch and single searches (e.g. 100+ episode series)
    const digits = Math.max(2, String(episodeCount ?? 0).length);
    let ep = "";
    if (episodeCount > 1) {
      if (isBatch) {
        ep = [
          `"${zeropad(1, digits)}-${zeropad(episodeCount, digits)}"`,
          `"${zeropad(1, digits)}~${zeropad(episodeCount, digits)}"`,
          `"1-${episodeCount}"`,
          `"1~${episodeCount}"`,
          `"batch"`,
          `"complete"`
        ].join("|");
      } else {
        ep = episodes.map(e => epstring(e, digits)).join("|");
      }
    }

    const excl = exclusions.length
      ? " " + exclusions.map(e => `-"${clean(String(e))}"`).join(" ")
      : "";
    const query = `(${titles.join(")|(")})${ep ? ` (${ep})` : ""}${excl}`;
    const url = `${this.url}?page=rss&c=1_1&s=seeders&o=desc&q=${encodeURIComponent(query)}`;

    let entries = parseRSSItems(await getRSSContent(url));

    // Drop uploads that clearly belong to a prequel or a sequel.
    // Margins now go in the lenient direction, and unparseable dates are kept instead of silently dropped.
    const prequelEnd =
      "FINISHED" === media.status && "FINISHED" === prequel?.status ? anilistDate(prequel.endDate) : null;
    const sequelStart =
      "FINISHED" === media.status && ("FINISHED" === sequel?.status || "RELEASING" === sequel?.status)
        ? anilistDate(sequel.startDate)
        : null;

    if (prequelEnd) {
      const min = +prequelEnd - DATE_MARGIN;
      entries = entries.filter(e => isNaN(+e.date) || +e.date > min);
    }
    if (sequelStart && "TV" === media.format) {
      const max = +sequelStart + DATE_MARGIN;
      entries = entries.filter(e => isNaN(+e.date) || +e.date < max);
    }

    return entries;
  }

  batch = (args, opts) => this.single(args, opts, true);
  movie = this.batch;

  async test() {
    try {
      const res = await fetch(this.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!res.ok) throw new Error(`Failed to load data from ${this.url}! Is the site down?`);
      return true;
    } catch (error) {
      throw new Error(`Could not reach ${this.url}! Does the site work in your region?`);
    }
  }
}();
