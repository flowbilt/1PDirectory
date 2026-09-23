// POST /api/heartbeat {site, screen:{w,h}, version} -> records when a screen last checked in.
import { SITE_RE, json, store } from "../lib/common.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Body must be valid JSON." }, 400); }
  const site = String(body?.site || "").toLowerCase();
  if (!SITE_RE.test(site)) return json({ error: "Bad site key." }, 400);

  const w = Math.round(Number(body?.screen?.w)) || 0;
  const h = Math.round(Number(body?.screen?.h)) || 0;
  await store().setJSON(`heartbeat/${site}`, {
    at: new Date().toISOString(),
    screen: w && h ? { w: Math.min(w, 20000), h: Math.min(h, 20000) } : null,
    version: String(body?.version || "").slice(0, 20),
  });
  return json({ ok: true });
};

export const config = { path: "/api/heartbeat" };
