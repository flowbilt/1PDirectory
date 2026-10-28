// /api/layouts (DP-11, round E1a): checks, previews, publishes and rolls back layouts. 1Point only in E1a.
// Making, renaming and removing a layout is done by the console straight to the database (supabase/29-layout-engine.sql
// lets 1Point do that and nobody else); the draft and the published versions go only through here, so every
// published version has passed the checks (public/layout-format.mjs). Each call is one or two database calls.
//
//   POST { action: "check",    doc, layout_id? }            -> { errors, warnings }; with layout_id, keeps it as the draft
//   POST { action: "preview",  doc, property_id }            -> { errors, warnings, payload } (what a screen would get)
//   POST { action: "publish",  layout_id, doc, note?, override?, overflow? }
//        -> { version }; 400 with errors; 409 with the warnings unless override (1Point publishing anyway)
//   POST { action: "rollback", layout_id, version }          -> { version } (the old version published again as a new one)
import { checkLayout } from "../../public/layout-format.mjs";
import { db, rpc, caller, enc } from "../lib/sb.mjs";
import { toLayoutPayload } from "./screen.mjs";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (status, error, extra = {}) => Object.assign(new Error(error), { status, extra });
const MAX_BYTES = 256 * 1024;

function parseDoc(doc) {
  if (typeof doc === "string") {
    if (doc.length > MAX_BYTES) throw fail(400, "That layout is too large (at most 256 KB).");
    try { doc = JSON.parse(doc); } catch (e) { throw fail(400, `That isn't valid JSON: ${e.message}`); }
  }
  if (JSON.stringify(doc ?? null).length > MAX_BYTES) throw fail(400, "That layout is too large (at most 256 KB).");
  return doc;
}

/** The preview's overflow report (from the console's preview of this exact layout), as warnings. */
function overflowWarnings(list) {
  return (Array.isArray(list) ? list : []).slice(0, 60).filter((id) => typeof id === "string" && /^[a-z0-9-]{1,40}$/.test(id))
    .map((id) => ({ where: `block "${id}"`, msg: "Its text doesn't fit its box even at the smallest size allowed (seen in the preview). Make the box bigger or the text shorter.", kind: "overflow" }));
}

async function loadLayout(id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id || ""))) throw fail(400, "Choose a layout.");
  const [l] = await db(`layouts?id=eq.${enc(id)}&select=id,org_id,name,orientation,published_version`);
  if (!l) throw fail(404, "No such layout.");
  return l;
}

export default async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "POST only." }, 405);
    const { user, profile } = await caller(req);
    if (profile.role !== "platform_admin") throw fail(403, "Only 1Point can change layouts for now.");
    const body = await req.json().catch(() => ({}));

    if (body.action === "check" || body.action === "preview" || body.action === "publish") {
      const doc = parseDoc(body.doc);
      const { errors, warnings, doc: clean } = checkLayout(doc);
      const layout = body.layout_id ? await loadLayout(body.layout_id) : null;
      if (layout && clean && clean.orientation && clean.orientation !== layout.orientation)
        errors.push({ where: "orientation", msg: `This layout is ${layout.orientation}, so "orientation" must be "${layout.orientation}".` });

      if (body.action === "check") {
        if (layout && !errors.length) await db(`layouts?id=eq.${enc(layout.id)}`, { method: "PATCH", prefer: "return=minimal", body: { draft: doc, updated_by: user.id } });
        return json({ errors, warnings });
      }

      if (body.action === "preview") {
        let prop = null;
        if (body.property_id) {
          if (!/^[0-9a-f-]{36}$/.test(String(body.property_id))) throw fail(400, "Choose a building.");
          [prop] = await db(`properties?id=eq.${enc(body.property_id)}&select=id,name,address,timezone,lat,lon`);
        }
        const payload = errors.length ? null : toLayoutPayload(
          { key: "preview", name: "Preview", orientation: clean.orientation, hide_powered_by: false, touch: false, screen_inches: clean.viewing.inches, touch_idle_s: 45 },
          { id: layout?.id || null, name: layout?.name || "Preview", version: null, doc }, prop);
        return json({ errors, warnings, payload });
      }

      // publish
      if (!layout) throw fail(400, "Choose a layout.");
      if (errors.length) return json({ error: "This layout has problems to fix before it can be published.", errors, warnings }, 400);
      const all = [...warnings, ...overflowWarnings(body.overflow)];
      if (all.length && body.override !== true) return json({ error: "This layout has warnings. Fix them, or publish anyway.", errors: [], warnings: all }, 409);
      const version = await rpc("layout_publish", { p_layout: layout.id, p_doc: doc, p_checks: { errors: [], warnings: all },
        p_overridden: all.length > 0, p_note: String(body.note || "").slice(0, 200), p_by: user.id });
      return json({ version, warnings: all });
    }

    if (body.action === "rollback") {
      const layout = await loadLayout(body.layout_id);
      const v = Number(body.version);
      if (!Number.isInteger(v) || v < 1) throw fail(400, "Choose a version.");
      const version = await rpc("layout_rollback", { p_layout: layout.id, p_version: v, p_by: user.id });
      return json({ version });
    }

    throw fail(400, "Unknown action.");
  } catch (e) {
    return json({ error: e.message, ...(e.extra || {}) }, e.status && e.status < 600 ? e.status : 502);
  }
};

export const config = { path: "/api/layouts" };
