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
      return { title, image: findImage(b), source, published: Number.isFinite(t) ? new Date(t).toISOString() : null };
    })
    .filter((i) => i.title.length > 8);
}

export function isBlocked(title, words) {
  const t = ` ${title.toLowerCase()} `;
  return words.some((w) => new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(t));
}
