// Local server for browser testing: the site, its functions, and a fake Supabase at /sb. No internet needed.
// node --import ./tests/register-stub.mjs tests/test-server.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createFake, SERVICE_KEY, ANON_KEY } from "./fake-supabase.mjs";
import { getStore } from "./blobs-stub.mjs";
import screen from "../netlify/functions/screen.mjs";
import heartbeat from "../netlify/functions/heartbeat.mjs";
import users from "../netlify/functions/users.mjs";
import migrate from "../netlify/functions/migrate.mjs";
import config from "../netlify/functions/config.mjs";
import weather from "../netlify/functions/weather.mjs";
import news from "../netlify/functions/news.mjs";
import agent from "../netlify/functions/agent.mjs";
import devices from "../netlify/functions/devices.mjs";
import networks from "../netlify/functions/networks.mjs";

const port = Number(process.argv[2]) || 8888;
const ORIGIN = `http://localhost:${port}`;
const SB = `${ORIGIN}/sb`;
Object.assign(process.env, { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: SERVICE_KEY, SUPABASE_ANON_KEY: ANON_KEY });
process.env.NEWS_FEEDS ||= "https://feeds.bbci.co.uk/x.xml,https://feeds.npr.org/1001/rss.xml";
const fake = createFake();
globalThis.__fake = fake;

// The old editor's saved Landmark Center, for the import test
await getStore({ name: "directory" }).setJSON("sites/landmark-center", JSON.parse(readFileSync(new URL("./fixtures/landmark-old.json", import.meta.url))));

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith(SB)) return fake.handle(new Request(u.replace(SB, "http://fake"), init));
  const ok = (b) => new Response(b, { status: 200 });
  if (u.includes("/points/")) return ok(fx("nws-points.json"));
  if (u.includes("/forecast/hourly")) return ok(fx("nws-hourly.json"));
  if (u.includes("bbci")) return ok(fx("bbc.xml"));
  if (u.includes("npr")) return ok(fx("npr.xml"));
  return new Response("offline", { status: 503 });
};

const ROUTES = { "/api/screen": screen, "/api/heartbeat": heartbeat, "/api/users": users, "/api/migrate": migrate, "/api/config": config, "/api/weather": weather, "/api/news": news, "/api/agent": agent, "/api/devices": devices, "/api/networks": networks };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
const PUB = new URL("../public/", import.meta.url).pathname;

createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const send = async (r) => { res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); };
  if (url.pathname === "/__outbox") return send(new Response(JSON.stringify(fake.outbox), { headers: { "Content-Type": "application/json" } }));
  if (url.pathname.startsWith("/sb/")) return send(await fake.handle(new Request("http://fake" + url.pathname.slice(3) + url.search, { method: req.method, headers: req.headers, body })));
  const fn = ROUTES[url.pathname];
  if (fn) return send(await fn(new Request(url, { method: req.method, headers: req.headers, body })));
  const file = normalize(join(PUB, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  try { const b = await readFile(file); res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(404); res.end("Not found"); }
}).listen(port, () => console.log(`Test server on ${ORIGIN}`));
