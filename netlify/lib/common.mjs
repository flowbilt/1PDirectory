import { createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

export const SITE_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const DIRS = new Set(["", "left", "right", "up", "down"]);
const MAX_LOGO_CHARS = 900_000; // ~650 KB image as a data URL
const MAX_BG_CHARS = 1_400_000; // ~1 MB photo as a data URL

export function store() {
  return getStore({ name: "directory", consistency: "strong" });
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function siteFrom(url) {
  const raw = (url.searchParams.get("site") || process.env.DEFAULT_SITE || "landmark-center").trim().toLowerCase();
  return SITE_RE.test(raw) ? raw : null;
}

export function checkAuth(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return { ok: false, status: 500, error: "ADMIN_PASSWORD is not set in the Netlify environment variables." };
  const given = req.headers.get("x-admin-password") || "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, status: 401, error: "Wrong password." };
}

const str = (v, max) => (typeof v === "string" ? v : v == null ? "" : String(v)).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
};
const contact = (c = {}) => ({ name: str(c.name, 80), company: str(c.company, 80), phone: str(c.phone, 40) });

// Throws Error with .status = 400 on bad input. Returns a clean copy.
export function validateSite(body) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!body || typeof body !== "object") throw bad("Body must be a JSON object.");

  const propertyName = str(body.propertyName, 80);
  if (!propertyName) throw bad("Property name is required.");

  if (!Array.isArray(body.tenants)) throw bad("Tenants must be a list.");
  if (body.tenants.length > 80) throw bad("A directory can hold up to 80 tenants.");
  const tenants = body.tenants
    .map((t) => ({ name: str(t?.name, 90), suite: str(t?.suite, 16), dir: DIRS.has(t?.dir) ? t.dir : "" }))
    .filter((t) => t.name);

  let logo = typeof body.logo === "string" ? body.logo : "";
  if (logo) {
    if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw bad("Logo must be a PNG, JPEG, WebP or SVG image.");
    if (logo.length > MAX_LOGO_CHARS) throw bad("Logo is too large. Use an image under 600 KB.");
  }

  let bgImage = typeof body.background?.image === "string" ? body.background.image : "";
  if (bgImage) {
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(bgImage)) throw bad("Background must be a JPEG, PNG or WebP photo.");
    if (bgImage.length > MAX_BG_CHARS) throw bad("Background photo is too large. Use a photo under 1 MB.");
  }

  let timezone = str(body.timezone, 64) || "America/Chicago";
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw bad(`Unknown time zone: ${timezone}`); }

  return {
    propertyName,
    buildingLabel: str(body.buildingLabel, 80),
    logo,
    logoReplacesName: !!logo && body.logoReplacesName === true,
    tenants,
    managedBy: contact(body.managedBy),
    leasedBy: contact(body.leasedBy),
    welcome: str(body.welcome, 140),
    weather: {
      enabled: body.weather?.enabled !== false,
      lat: num(body.weather?.lat, 18, 72, 33.5186),
      lon: num(body.weather?.lon, -180, -60, -86.8104),
    },
    timezone,
    news: { enabled: body.news?.enabled !== false, rotateSeconds: num(body.news?.rotateSeconds, 5, 120, 12) },
    background: {
      enabled: !!bgImage && body.background?.enabled === true,
      image: bgImage,
      visibility: num(body.background?.visibility, 5, 40, 15), // % of the photo showing through the navy
      position: num(body.background?.position, 0, 100, 50),   // slides the photo left/right
      size: num(body.background?.size, 100, 400, 190),        // photo width as % of screen width
    },
    updatedAt: null,
  };
}
