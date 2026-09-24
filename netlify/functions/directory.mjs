// GET    /api/directory?site=landmark-center  -> the directory (public; screens poll this)
// PUT    /api/directory?site=...              -> save (needs x-admin-password)
// DELETE /api/directory?site=...              -> remove a saved site (needs x-admin-password)
import { createHash } from "node:crypto";
import { SEED } from "../lib/seed.mjs";
import { checkAuth, json, siteFrom, store, validateSite } from "../lib/common.mjs";

export default async (req) => {
  const url = new URL(req.url);
  const site = siteFrom(url);
  if (!site) return json({ error: "Site key may use lowercase letters, numbers and dashes only." }, 400);
  const key = `sites/${site}`;

  if (req.method === "GET") {
    const saved = await store().get(key, { type: "json" });
    const data = saved || SEED[site];
    if (!data) return json({ error: `No directory named "${site}".` }, 404);
    // Screens poll every minute. The ETag lets them skip the download when nothing changed,
    // which matters once a directory carries a logo or background photo.
    const body = JSON.stringify({ site, ...data });
    const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", ETag: etag };
    if ((req.headers.get("if-none-match") || "").split(/\s*,\s*/).includes(etag)) return new Response(null, { status: 304, headers });
    return new Response(body, { status: 200, headers });
  }

  const auth = checkAuth(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  if (req.method === "PUT") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "Body must be valid JSON." }, 400); }
    let clean;
    try { clean = validateSite(body); } catch (e) { return json({ error: e.message }, e.status || 400); }
    clean.updatedAt = new Date().toISOString();
    await store().setJSON(key, clean);
    return json({ site, ...clean });
  }

  if (req.method === "DELETE") {
    await store().delete(key);
    await store().delete(`heartbeat/${site}`);
    return json({ site, deleted: true });
  }

  return json({ error: "Method not allowed." }, 405, { Allow: "GET, PUT, DELETE" });
};

export const config = { path: "/api/directory" };
