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
// Pictures (E1b; supabase/30-layout-images.sql), per account:
//   POST { action: "upload", org_id, name, data }            -> { picture } (data: a WebP, JPEG or PNG data URL, already
//        shrunk by the console; its key comes from the name and is fixed: "Maple Bacon" -> img:maple-bacon)
//   POST { action: "delete_image", id }                      -> { ok } (refused while on the boards: a menu's lists now, or
//        any layout's draft or kept version; E2c: the file is removed from Storage and checked gone before the row goes)
// Check, preview and publish also check that every picture a layout says exists in its account.
// Menus (E2a, DP-12; supabase/32-menus.sql): a layout's blocks may show lists of its menu ({"list": "donuts"}); check,
// preview and publish check each one against the menu, and the preview carries the menu as it is now.
//   POST { action: "make_menu", layout_id, blocks?, rooms?, names?, name? } -> { menu_id, made } "Make lists from this layout": the
//        layout's own items, chips, pictures, text and hours become a new menu's lists (room for about a third more),
//        the blocks point at them, and the draft is kept (publish it to put the board on the lists). E2b: on a layout
//        that already has a menu, the chosen blocks become more lists on that menu ("Add lists from this layout")
// Setting a menu's lists up (rooms, boxes, caps), who edits, and choosing a layout's menu are done by the console
// straight to the database (1Point only; the database checks every rule); the customer's saves go to menu_save.
import { checkLayout } from "../../public/layout-format.mjs";
import { extractMenu } from "../../public/menu-format.mjs";
import { db, rpc, caller, enc } from "../lib/sb.mjs";
import { pictureKeys } from "../lib/images.mjs";
import { uploadPicture, removePicture } from "../lib/pictures.mjs";
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

export const BUCKET = "layout-images";

/** The account's pictures a layout says, as key -> {path, w, h}; and the keys it says that the account doesn't have. */
async function picturesFor(orgId, doc) {
  const keys = pictureKeys(doc);
  if (!keys.length || !orgId) return { images: {}, missing: orgId ? [] : keys };
  const rows = await db(`layout_images?org_id=eq.${enc(orgId)}&key=in.(${keys.map(enc).join(",")})&select=key,path,width,height`);
  const images = Object.fromEntries(rows.map((r) => [r.key, { path: r.path, w: r.width, h: r.height }]));
  return { images, missing: keys.filter((k) => !images[k]) };
}
/** E2a: the pictures a menu's lists use (the preview draws them) */
async function menuPictures(layout, menu) {
  const keys = [...new Set(JSON.stringify(menu?.content || {}).match(/"img:[a-z0-9][a-z0-9-]{0,59}"/g)?.map((x) => x.slice(5, -1)) || [])];
  if (!keys.length || !layout) return {};
  const rows = await db(`layout_images?org_id=eq.${enc(layout.org_id)}&key=in.(${keys.map(enc).join(",")})&select=key,path,width,height`);
  return Object.fromEntries(rows.map((r) => [r.key, { path: r.path, w: r.width, h: r.height }]));
}
const missingErrors = (missing) => missing.map((k) => ({ where: `picture "img:${k}"`, msg: `There's no picture "${k}" in this account. Upload it under Pictures, or fix the name.` }));

async function loadLayout(id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id || ""))) throw fail(400, "Choose a layout.");
  const [l] = await db(`layouts?id=eq.${enc(id)}&select=id,org_id,name,orientation,published_version,menu_code,menu_id`);
  if (!l) throw fail(404, "No such layout.");
  return l;
}
/** E2a: the layout's menu as screens get it (null: the layout has no menu) */
async function menuOf(layout) {
  if (!layout?.menu_id) return null;
  const [m] = await db(`menus?id=eq.${enc(layout.menu_id)}&select=id,name,spec,content,rev`);
  return m || null;
}

/** E2e: the lists a layout's own content would make on its menu (as Make lists would by default: items, chips, pictures
 *  that take turns, text and hours, not a lone photo), each under its block's id where the menu doesn't have that key
 *  yet. Returns { spec, content, doc, offer: [{ block, key, name, kind, room, entries }] }. */
export function offerLists(doc, menu) {
  let ex;
  try { ex = extractMenu(checkLayout(doc).doc || { blocks: [] }); } catch { return null; }
  if (!ex?.made?.length) return { spec: { lists: [] }, content: { lists: {} }, doc, offer: [] };
  const have = Object.fromEntries((menu.spec?.lists || []).map((l) => [l.key, l]));
  const lists = ex.spec.lists.filter((l) => !have[l.key]);
  // E2f (DP-13): a block whose list is already on the menu, of the same kind (the board's file pasted again), is
  // offered that list ("use": it shows what the customer has there; the file's sample entries are dropped)
  const use = (l) => have[l.key] && have[l.key].kind === l.kind;
  return { spec: { lists }, content: { lists: Object.fromEntries(lists.map((l) => [l.key, ex.content.lists[l.key]])) }, doc: ex.doc,
    offer: ex.spec.lists.map((l) => ({ block: l.key, key: use(l) ? l.key : have[l.key] ? `${l.key}-2` : l.key, name: use(l) ? have[l.key].name : l.name, kind: l.kind,
      room: use(l) ? have[l.key].room : l.room, entries: (ex.content.lists[l.key]?.entries || []).length, ...(use(l) ? { existing: true } : {}) })) };
}

/** E2f: points blocks at the lists of the same key already on the menu, taking their own content off (as Make lists
 *  would). Returns the doc. */
export function useExisting(doc, ids, menu) {
  const have = Object.fromEntries((menu?.spec?.lists || []).map((l) => [l.key, l]));
  const ex = extractMenu(doc, ids);
  return { ...doc, blocks: doc.blocks.map((b) => {
    if (!ids.includes(b.id) || !ex.made.includes(b.id)) return b;
    const L = ex.spec.lists.find((x) => x.key === b.id);
    if (!have[b.id] || have[b.id].kind !== L?.kind) return b;
    return ex.doc.blocks.find((x) => x.id === b.id);
  }) };
}

export default async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "POST only." }, 405);
    const { user, profile } = await caller(req);
    if (profile.role !== "platform_admin") throw fail(403, "Only WayTuGo can change layouts.");
    const body = await req.json().catch(() => ({}));

    if (body.action === "check" || body.action === "preview" || body.action === "publish") {
      const doc = parseDoc(body.doc);
      const layout = body.layout_id ? await loadLayout(body.layout_id) : null;
      const menu = await menuOf(layout);
      // E2e (DP-13): one file per board. On a layout that has a menu, the blocks that still write their own items, text
      // or hours are offered as new lists on it ("Make these lists"), and until then they count as lists already, so
      // another block of the same file can show one (the chalkboard's specials beside the coffee bar). Publish doesn't
      // count them: a block can't go on a screen showing a list that isn't made yet.
      const pending = body.action !== "publish" && menu ? offerLists(doc, menu) : null;
      // E2a: with a layout, its blocks' lists are checked against its menu (no menu: a block on a list is a problem)
      const { errors, warnings, doc: clean } = checkLayout(doc, layout ? { lists: menu ? [...(menu.spec?.lists || []), ...(pending?.spec.lists || [])] : null } : {});
      if (layout && clean && clean.orientation && clean.orientation !== layout.orientation)
        errors.push({ where: "orientation", msg: `This layout is ${layout.orientation}, so "orientation" must be "${layout.orientation}".` });
      const pics = layout && clean ? await picturesFor(layout.org_id, doc) : { images: {}, missing: [] };
      errors.push(...missingErrors(pics.missing));

      if (body.action === "check") {
        if (layout && !errors.length) await db(`layouts?id=eq.${enc(layout.id)}`, { method: "PATCH", prefer: "return=minimal", body: { draft: doc, updated_by: user.id } });
        return json({ errors, warnings, offer: errors.length ? [] : pending?.offer || [] });
      }

      if (body.action === "preview") {
        let prop = null;
        if (body.property_id) {
          if (!/^[0-9a-f-]{36}$/.test(String(body.property_id))) throw fail(400, "Choose a building.");
          [prop] = await db(`properties?id=eq.${enc(body.property_id)}&select=id,name,address,timezone,lat,lon`);
        }
        const payload = errors.length ? null : toLayoutPayload(
          { key: "preview", name: "Preview", orientation: clean.orientation, hide_powered_by: false, touch: false, screen_inches: clean.viewing.inches, touch_idle_s: 45 },
          // E2e: lists still to be made are drawn as they will be once made
          { id: layout?.id || null, name: layout?.name || "Preview", version: null, doc: pending?.offer.length ? pending.doc : doc, menu_code: layout?.menu_code,
            lists: menu ? { id: menu.id, spec: { ...menu.spec, lists: [...(menu.spec?.lists || []), ...(pending?.spec.lists || [])] },
              content: { ...menu.content, lists: { ...(menu.content?.lists || {}), ...(pending?.content.lists || {}) } } } : null }, prop, { ...pics.images, ...(await menuPictures(layout, menu)) });
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

    if (body.action === "make_menu") {
      const layout = await loadLayout(body.layout_id);
      const [{ draft } = {}] = await db(`layouts?id=eq.${enc(layout.id)}&select=draft`);
      if (!draft || !Array.isArray(draft.blocks) || !draft.blocks.length) throw fail(400, "This layout has no blocks yet. Check its JSON first (Check keeps it as the draft).");
      let ids = Array.isArray(body.blocks) ? body.blocks.filter((x) => typeof x === "string") : undefined;
      // E2f: blocks to point at lists already on the layout's menu (same key and kind), rather than make "-2" copies
      const useIds = Array.isArray(body.use) ? body.use.filter((x) => typeof x === "string") : [];
      let base = draft;
      if (useIds.length) {
        const m0 = await menuOf(layout);
        if (!m0) throw fail(400, "This layout has no menu yet, so there are no lists to use.");
        base = useExisting(draft, useIds, m0);
        ids = (ids || []).filter((x) => !useIds.includes(x));
        if (!ids.length) {
          await db(`layouts?id=eq.${enc(layout.id)}`, { method: "PATCH", prefer: "return=minimal", body: { draft: base, updated_by: user.id } });
          return json({ menu_id: m0.id, made: [], used: useIds });
        }
      }
      const { spec, content, doc, made } = extractMenu(base, ids);
      if (!made.length) throw fail(400, "None of the chosen blocks has anything to turn into a list.");
      // the room the console's dialog chose for each list (the database refuses a room below what's in it)
      for (const l of spec.lists) {
        const n = Number(body.rooms?.[l.key]);
        if (l.kind !== "text" && Number.isInteger(n) && n >= 1) l.room = Math.min(l.kind === "hours" ? 14 : 60, n);
        const nm = String(body.names?.[l.key] || "").trim();
        if (nm) l.name = nm.slice(0, 60);
        if ((content.lists[l.key]?.entries || []).length > l.room) throw fail(400, `"${l.name}" has ${content.lists[l.key].entries.length} entries now, so its room can't be less than that.`);
      }
      // E2b: a layout that already has a menu gets more lists on it (a key the menu already has gets "-2", "-3"…)
      const menu = await menuOf(layout);
      if (menu) {
        const taken = new Set((menu.spec?.lists || []).map((l) => l.key));
        for (const l of spec.lists) {
          if (!taken.has(l.key)) { taken.add(l.key); continue; }
          let n = 2; while (taken.has(`${l.key.slice(0, 36)}-${n}`)) n++;
          const key = `${l.key.slice(0, 36)}-${n}`;
          content.lists[key] = content.lists[l.key]; delete content.lists[l.key];
          for (const b of doc.blocks) if (b.content?.list === l.key && made.includes(b.id)) b.content.list = key;
          l.key = key; taken.add(key);
        }
        const rev = await rpc("menu_add_lists", { p_menu: menu.id, p_lists: spec.lists, p_content: content.lists, p_by: user.id, p_layout: layout.id, p_draft: doc });
        return json({ menu_id: menu.id, made, spec, rev, used: useIds });
      }
      const name = String(body.name || `${layout.name}: menu`).trim().slice(0, 80);
      const menu_id = await rpc("menu_create", { p_org: layout.org_id, p_name: name, p_spec: spec, p_content: content, p_by: user.id, p_layout: layout.id, p_draft: doc });
      return json({ menu_id, made, spec });
    }

    if (body.action === "rollback") {
      const layout = await loadLayout(body.layout_id);
      const v = Number(body.version);
      if (!Number.isInteger(v) || v < 1) throw fail(400, "Choose a version.");
      const version = await rpc("layout_rollback", { p_layout: layout.id, p_version: v, p_by: user.id });
      return json({ version });
    }

    if (body.action === "upload") {
      if (!/^[0-9a-f-]{36}$/.test(String(body.org_id || ""))) throw fail(400, "Choose the account the picture belongs to.");
      const [org] = await db(`organizations?id=eq.${enc(body.org_id)}&select=id`);
      if (!org) throw fail(404, "No such account.");
      return json(await uploadPicture(org.id, body, user.id));
    }

    if (body.action === "delete_image") {
      // E2c: the file goes from Storage first, Storage is asked again, then the row (netlify/lib/pictures.mjs)
      return json(await removePicture(body.id));
    }

    throw fail(400, "Unknown action.");
  } catch (e) {
    return json({ error: e.message, ...(e.extra || {}) }, e.status && e.status < 600 ? e.status : 502);
  }
};

export const config = { path: "/api/layouts" };
