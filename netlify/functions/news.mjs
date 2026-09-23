// GET /api/news -> up to 20 recent headlines with images, filtered for a public lobby.
// Feeds:     NEWS_FEEDS env var, comma-separated RSS/Atom URLs (defaults below).
// Blocklist: NEWS_BLOCKLIST env var, comma-separated whole words; replaces the default list.
import { json } from "../lib/common.mjs";
import { isBlocked, parseFeed } from "../lib/rss.mjs";

export const DEFAULT_FEEDS = [
  "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml",
  "https://feeds.npr.org/1001/rss.xml",
];

export const DEFAULT_BLOCKLIST = [
  "kill", "kills", "killed", "killing", "killings", "dead", "death", "deaths", "die", "dies", "died",
  "murder", "murdered", "shooting", "shootings", "shot", "gunman", "stabbing", "stabbed", "suicide",
  "rape", "abuse", "abused", "massacre", "bomb", "bombing", "terror", "terrorist", "hostage",
  "overdose", "corpse", "body", "bodies", "graphic", "sex", "sexual",
];

const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

export default async () => {
  const feeds = list(process.env.NEWS_FEEDS).length ? list(process.env.NEWS_FEEDS) : DEFAULT_FEEDS;
  const block = list(process.env.NEWS_BLOCKLIST).length ? list(process.env.NEWS_BLOCKLIST) : DEFAULT_BLOCKLIST;

  const results = await Promise.allSettled(
    feeds.map(async (u) => {
      const res = await fetch(u, { headers: { "User-Agent": "DirectoryDisplay/1.0" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`${res.status} ${u}`);
      return parseFeed(await res.text(), new URL(u).hostname);
    })
  );

  const seen = new Set();
  const items = results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .filter((i) => !isBlocked(i.title, block))
    .filter((i) => {
      const k = i.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0) || (b.published || "").localeCompare(a.published || ""))
    .slice(0, 20);

  const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason?.message);
  if (!items.length) return json({ items: [], errors: failed }, 502);

  return json({ items, errors: failed, at: new Date().toISOString() }, 200, {
    "Cache-Control": "public, max-age=300",
    "Netlify-CDN-Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600",
  });
};

export const config = { path: "/api/news" };
