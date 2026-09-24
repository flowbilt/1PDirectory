// POST /api/migrate?slug=landmark-center  (1Point admins only)
// Copies a directory saved by the old password editor (Netlify Blobs) into Supabase:
// logo, background photo, contacts, address line, footer, weather location and tenants.
// Safe to run more than once; each run replaces that directory's tenants with the old copy.
import { SITE_RE, json, store } from "../lib/common.mjs";
import { audit, caller, db, enc } from "../lib/sb.mjs";

export default async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
    const { user, profile } = await caller(req);
    if (profile.role !== "platform_admin") return json({ error: "Only 1Point admins can import." }, 403);

    const slug = (new URL(req.url).searchParams.get("slug") || "").toLowerCase();
    if (!SITE_RE.test(slug)) return json({ error: "Bad directory name." }, 400);

    const old = await store().get(`sites/${slug}`, { type: "json" });
    if (!old) return json({ error: `Nothing saved under "${slug}" in the old editor, so there's nothing to import.` }, 404);

    const [dir] = await db(`directories?slug=eq.${enc(slug)}&select=id,property_id`);
    if (!dir) return json({ error: `No directory "${slug}" in Supabase.` }, 404);

    await db(`properties?id=eq.${enc(dir.property_id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: {
        address: old.buildingLabel || "",
        logo: old.logo || "",
        logo_replaces_name: !!old.logoReplacesName,
        background: old.background || {},
        managed_by: old.managedBy || {},
        leased_by: old.leasedBy || {},
        footer: old.welcome || "",
        timezone: old.timezone || "America/Chicago",
        ...(old.weather?.lat != null ? { lat: old.weather.lat, lon: old.weather.lon } : {}),
      },
    });
    await db(`directories?id=eq.${enc(dir.id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: {
        title: old.propertyName || undefined,
        news_enabled: old.news?.enabled !== false,
        rotate_seconds: Math.min(120, Math.max(5, Number(old.news?.rotateSeconds) || 12)),
        weather_enabled: old.weather?.enabled !== false,
      },
    });
    const tenants = (old.tenants || []).filter((t) => t?.name).map((t, i) => ({
      directory_id: dir.id, sort: i * 10, name: t.name, suite: t.suite || "", arrow: t.dir || "", note: t.note || "",
    }));
    await db(`tenants?directory_id=eq.${enc(dir.id)}`, { method: "DELETE", prefer: "return=minimal" });
    if (tenants.length) await db("tenants", { method: "POST", prefer: "return=minimal", body: tenants });

    await audit(user.id, "import from old editor", "directory", dir.id, { slug, tenants: tenants.length });
    return json({ ok: true, tenants: tenants.length, logo: !!old.logo, background: !!old.background?.image });
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
};

export const config = { path: "/api/migrate" };
