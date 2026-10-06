// Small RSS 2.0 / Atom parser. Good enough for mainstream news feeds; no dependencies.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026" };

export function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

const stripTags = (s) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

function attrs(el) {
  const out = {};
  for (const m of el.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? "");
  return out;
}

function findImage(block) {
  const candidates = [];
  for (const m of block.matchAll(/<media:(content|thumbnail)\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (!a.url) continue;
    if (m[1].toLowerCase() === "content" && a.medium && a.medium !== "image") continue;
    if (m[1].toLowerCase() === "content" && a.type && !a.type.startsWith("image")) continue;
    candidates.push({ url: a.url, w: Number(a.width) || 0 });
  }
  for (const m of block.matchAll(/<enclosure\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.url && (a.type || "").startsWith("image")) candidates.push({ url: a.url, w: 0 });
  }
  if (!candidates.length) {
    const html = decode(tag(block, "content:encoded") || tag(block, "description") || tag(block, "content") || tag(block, "summary"));
    const img = html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    if (img) candidates.push({ url: img[1], w: 0 });
  }
  if (!candidates.length) return "";
  candidates.sort((a, b) => b.w - a.w);
  let url = candidates[0].url.replace(/^\/\//, "https://");
  // BBC thumbnails come at 240px wide; the same image exists at 976px.
  url = url.replace(/(ichef\.bbci\.co\.uk\/(?:ace\/)?(?:standard|news)\/)\d+\//, "$1976/");
  return /^https?:\/\//.test(url) ? url.replace(/^http:/, "https:") : "";
}

export function parseFeed(xml, fallbackSource = "") {
  const channelTitle = stripTags(decode(tag(xml.replace(/<item[\s\S]*$/i, "").replace(/<entry[\s\S]*$/i, ""), "title")));
  // "BBC News - US & Canada" -> "BBC News", "News : NPR" -> "NPR"
  const source = (channelTitle.split(" - ")[0].split(" : ").pop() || "").trim() || fallbackSource;
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  return blocks
    .map((b) => {
      const title = stripTags(decode(tag(b, "title")));
      const dateRaw = stripTags(decode(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date")));
      const t = Date.parse(dateRaw);
      // The story's own text, for the blocklist only (never sent to the screens)
      const summary = stripTags(decode(tag(b, "description") || tag(b, "summary") || tag(b, "content"))).slice(0, 600);
      return { title, summary, image: findImage(b), source, published: Number.isFinite(t) ? new Date(t).toISOString() : null };
    })
    .filter((i) => i.title.length > 8);
}

// A blocklist word also catches its usual forms, so the list needn't spell them all out:
//   murder -> murders, murdered, murderer(s), murdering, murderous, murderer's;  kill -> killer, killings
//   body -> bodies;  die -> dies, died, dying;  stab -> stabbed, stabbing;  terror -> terrorist, terrorism
// but not other words that merely start the same way ("dead" never blocks "deadline", "die" never "diet" or
// "San Diego", "war" never "warm" or "Warriors"). Ending a word with * blocks every word starting with it
// ("terror*"). Several words ("mass shooting") match as a phrase, with forms on the last word.
const ENDINGS = "s|es|d|ed|er|ers|ing|ings|ism|ist|ists|ous";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function forms(word) {
  const alts = [`${esc(word)}(?:${ENDINGS})?`];
  if (/[^aeiou]e$/.test(word)) alts.push(`${esc(word.slice(0, -1))}(?:ing|er|ers|ist|ists|ism)`);   // abuse -> abusing
  if (/ie$/.test(word)) alts.push(`${esc(word.slice(0, -2))}ying`);                                 // die -> dying
  if (/[^aeiou]y$/.test(word)) alts.push(`${esc(word.slice(0, -1))}i(?:es|ed|er|ers)`);             // body -> bodies
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(word)) alts.push(`${esc(word)}${word.slice(-1)}(?:ed|ing|ings|er|ers)`); // stab -> stabbed
  return alts.join("|");
}
export function blockPattern(words) {
  const terms = words.map((w) => w.trim().toLowerCase()).filter(Boolean).map((w) => {
    const prefix = w.endsWith("*");
    const parts = w.replace(/\*$/, "").split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    const last = parts.pop();
    const head = parts.map((p) => esc(p) + "\\s+").join("");
    return prefix ? `${head}${esc(last)}[\\w'’-]*` : `${head}(?:${forms(last)})(?:['’]s)?(?![\\w'’-])`;
  }).filter(Boolean);
  return terms.length ? new RegExp(`(?<![\\w'’-])(?:${terms.join("|")})`, "i") : null;
}
// True if any of the texts (a headline, its description) contains a blocked word. `words` can be a list or a
// pattern from blockPattern (faster when checking many stories).
export function isBlocked(text, words) {
  const re = words instanceof RegExp ? words : blockPattern(words);
  return !!re && [].concat(text).some((t) => re.test(t || ""));
}
