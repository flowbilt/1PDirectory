// Local server for browser testing without a Netlify account or internet.
// node --import ./tests/register-stub.mjs tests/test-server.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import directory from "../netlify/functions/directory.mjs";
import sites from "../netlify/functions/sites.mjs";
import heartbeat from "../netlify/functions/heartbeat.mjs";
import weather from "../netlify/functions/weather.mjs";
import news from "../netlify/functions/news.mjs";

process.env.ADMIN_PASSWORD ||= "test-password";
process.env.NEWS_FEEDS ||= "https://feeds.bbci.co.uk/x.xml,https://feeds.npr.org/1001/rss.xml";
const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (b) => new Response(b, { status: 200 });
  if (u.includes("/points/")) return ok(fx("nws-points.json"));
  if (u.includes("/forecast/hourly")) return ok(fx("nws-hourly.json"));
  if (u.includes("bbci")) return ok(fx("bbc.xml"));
  if (u.includes("npr")) return ok(fx("npr.xml"));
  return new Response("offline", { status: 503 });
};

const ROUTES = { "/api/directory": directory, "/api/sites": sites, "/api/heartbeat": heartbeat, "/api/weather": weather, "/api/news": news };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
const PUB = new URL("../public/", import.meta.url).pathname;
const port = Number(process.argv[2]) || 8888;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const fn = ROUTES[url.pathname];
  if (fn) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await fn(new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const file = normalize(join(PUB, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("Not found"); }
}).listen(port, () => console.log(`Test server on http://localhost:${port}`));
