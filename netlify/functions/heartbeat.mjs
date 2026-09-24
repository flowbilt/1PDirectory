// POST /api/heartbeat {key, screen:{w,h}, version} -> records when a screen last checked in.
import { SITE_RE, json } from "../lib/common.mjs";
import { db, enc } from "../lib/sb.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Body must be valid JSON." }, 400); }
  const key = String(body?.key || body?.site || "").toLowerCase();
  if (!SITE_RE.test(key)) return json({ error: "Bad screen key." }, 400);

  const w = Math.min(20000, Math.round(Number(body?.screen?.w)) || 0);
  const h = Math.min(20000, Math.round(Number(body?.screen?.h)) || 0);
  try {
    const rows = await db(`screens?key=eq.${enc(key)}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: { last_seen: new Date().toISOString(), last_report: { w, h, version: String(body?.version || "").slice(0, 20), agent: (req.headers.get("user-agent") || "").slice(0, 160) } },
    });
    if (!rows?.length) return json({ error: "Unknown screen." }, 404);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
};

export const config = { path: "/api/heartbeat" };
