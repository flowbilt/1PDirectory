// GET /api/sites -> every directory with its last screen check-in (needs x-admin-password).
// The admin page also uses this call to confirm the password.
import { SEED } from "../lib/seed.mjs";
import { checkAuth, json, store } from "../lib/common.mjs";

export default async (req) => {
  if (req.method !== "GET") return json({ error: "Method not allowed." }, 405);
  const auth = checkAuth(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const s = store();
  const { blobs } = await s.list({ prefix: "sites/" });
  const keys = new Set([...Object.keys(SEED), ...blobs.map((b) => b.key.slice("sites/".length))]);

  const sites = await Promise.all(
    [...keys].sort().map(async (site) => {
      const data = (await s.get(`sites/${site}`, { type: "json" })) || SEED[site] || {};
      const hb = await s.get(`heartbeat/${site}`, { type: "json" });
      return {
        site,
        propertyName: data.propertyName || site,
        tenantCount: Array.isArray(data.tenants) ? data.tenants.length : 0,
        updatedAt: data.updatedAt || null,
        lastSeen: hb?.at || null,
        screen: hb?.screen || null,
      };
    })
  );
  return json({ sites });
};

export const config = { path: "/api/sites" };
