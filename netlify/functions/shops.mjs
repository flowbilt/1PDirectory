// /api/shops (DP-13, round T0): copies a shop (a menu, every board on it and the pictures they use) into an account as
// its own: a template from WayTuGo Templates into WayTuGo Samples before an appointment, or a fitted sample into the
// customer's account once they sign. 1Point only; never the customer.
//
//   POST { action: "copy", menu_id, org_id | new_account: { name, kind }, name, board_name?, boards?: { <board id>: name },
//          building?: { name, address, lat, lon, timezone } }
//        -> { menu_id, org_id, layouts: [{ id, from, name }], property_id, pictures }
//
// The picture files are copied first, each into the account's own folder (a key the account already has gets "-2"),
// then one database call (shop_copy, supabase/36-templates.sql) makes everything else in one transaction: the menu with a
// fresh history, each board published as it was (its own new phone-menu code), the boards' looks, the building. If that
// call is refused, the copied files are removed again (and a new account made for it). Nothing is shared with the
// original: changing or removing either never touches the other.
import { db, rpc, caller, enc, storageCopy, storageRemove } from "../lib/sb.mjs";
import { pictureKeys } from "../lib/images.mjs";
import { randomUUID } from "node:crypto";

const BUCKET = "layout-images";
const KINDS = ["owner", "manager", "templates", "samples"];
const TZS = ["America/Chicago", "America/New_York", "America/Denver", "America/Phoenix", "America/Los_Angeles"];
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (status, error) => Object.assign(new Error(error), { status });
const UUID = /^[0-9a-f-]{36}$/;
const name80 = (s) => String(s ?? "").trim().slice(0, 80);

/** Every "img:<key>" string in a value, renamed by the map (a copied picture whose key was taken in the account). */
export function renamePictures(value, map) {
  if (typeof value === "string") { const m = /^img:([a-z0-9][a-z0-9-]{0,59})$/.exec(value); return m && map[m[1]] ? `img:${map[m[1]]}` : value; }
  if (Array.isArray(value)) return value.map((v) => renamePictures(v, map));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renamePictures(v, map)]));
  return value;
}

/** The keys the copies get in an account that already has `taken`: the same, or "-2", "-3"… */
export function newKeys(keys, taken) {
  const used = new Set(taken), out = {};
  for (const k of keys) {
    let key = k;
    if (used.has(key)) { let n = 2; while (used.has(`${k.slice(0, 56)}-${n}`)) n++; key = `${k.slice(0, 56)}-${n}`; }
    used.add(key); out[k] = key;
  }
  return out;
}

/** A building's details from the dialog, checked (null: no building) */
function buildingOf(b) {
  if (!b || typeof b !== "object") return null;
  const name = name80(b.name);
  if (!name) throw fail(400, "Give the building a name.");
  const has = (v) => v !== null && v !== undefined && v !== "";
  let lat = null, lon = null;
  if (has(b.lat) || has(b.lon)) {
    lat = Number(b.lat); lon = Number(b.lon);
    if (!(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw fail(400, "The weather location is a latitude and a longitude, e.g. 33.3449, -86.8236.");
  }
  const timezone = TZS.includes(b.timezone) ? b.timezone : "America/Chicago";
  return { name, address: String(b.address || "").trim().slice(0, 200), lat, lon, timezone };
}

export default async (req) => {
  const copied = [];
  let madeOrg = null;
  try {
    if (req.method !== "POST") return json({ error: "POST only." }, 405);
    const { user, profile } = await caller(req);
    if (profile.role !== "platform_admin") throw fail(403, "Only WayTuGo can copy a shop.");
    const body = await req.json().catch(() => ({}));
    if (body.action !== "copy") throw fail(400, "Unknown action.");

    if (!UUID.test(String(body.menu_id || ""))) throw fail(400, "Choose the menu to copy.");
    const name = name80(body.name);
    if (!name) throw fail(400, "Give the copy a name, e.g. Salvatore's Pizza.");
    const [src] = await db(`menus?id=eq.${enc(body.menu_id)}&select=id,org_id,name,spec,content`);
    if (!src) throw fail(404, "No such menu.");
    const boards = await db(`layouts?menu_id=eq.${enc(src.id)}&select=id,name,orientation,draft,published_version&order=name.asc`);
    if (!boards.length) throw fail(400, `The menu "${src.name}" has no boards to copy.`);
    const building = buildingOf(body.building);

    // the published version of each board, as screens show it now
    const docs = {};
    for (const b of boards) if (b.published_version) {
      const [v] = await db(`layout_versions?layout_id=eq.${enc(b.id)}&version=eq.${b.published_version}&select=doc`);
      if (v) docs[b.id] = v.doc;
    }

    // the account: an existing one, or a new one made here
    let orgId;
    if (body.new_account && typeof body.new_account === "object") {
      const n = name80(body.new_account.name);
      if (!n) throw fail(400, "Give the new account a name.");
      const kind = KINDS.includes(body.new_account.kind) ? body.new_account.kind : "owner";
      [madeOrg] = await db("organizations", { method: "POST", prefer: "return=representation", body: { name: n, kind } });
      orgId = madeOrg.id;
    } else {
      if (!UUID.test(String(body.org_id || ""))) throw fail(400, "Choose the account to copy it into.");
      const [org] = await db(`organizations?id=eq.${enc(body.org_id)}&select=id`);
      if (!org) throw fail(404, "No such account.");
      orgId = org.id;
    }

    // the pictures the menu and its boards use (drafts too), copied into the account's own folder
    const keys = pictureKeys([src.content, ...boards.map((b) => b.draft), ...Object.values(docs)]);
    const pics = keys.length ? await db(`layout_images?org_id=eq.${enc(src.org_id)}&key=in.(${keys.map(enc).join(",")})&select=key,name,path,mime,width,height,bytes`) : [];
    const taken = (await db(`layout_images?org_id=eq.${enc(orgId)}&select=key`)).map((r) => r.key);
    const map = newKeys(pics.map((p) => p.key), taken);
    const images = [];
    for (const p of pics) {
      const ext = p.path.split(".").pop();
      const path = `${orgId}/${map[p.key]}-${randomUUID().slice(0, 8)}.${ext}`;
      try { await storageCopy(BUCKET, p.path, path); }
      catch (e) {
        if (/\(404\)/.test(e.message)) throw fail(409, `The picture "${p.name || p.key}" has no file in Storage, so it can't be copied. Upload it again in the original account (Accounts → Check storage lists such pictures), then copy.`);
        throw e;
      }
      copied.push(path);
      images.push({ key: map[p.key], name: p.name, path, mime: p.mime, width: p.width, height: p.height, bytes: p.bytes });
    }
    const renamed = Object.fromEntries(Object.entries(map).filter(([a, b]) => a !== b));

    // new ids for the boards, so the menu's board looks follow them
    const ids = Object.fromEntries(boards.map((b) => [b.id, randomUUID()]));
    const content = renamePictures({ ...src.content }, renamed);
    // T1b: the name on the boards (the shop's brand; the template's name otherwise stays on its logo)
    const shopName = String(body.board_name ?? "").trim().slice(0, 60);
    if (shopName) content.brand = { ...(content.brand || {}), name: shopName };
    if (src.content?.boards) content.boards = Object.fromEntries(Object.entries(src.content.boards).filter(([k]) => ids[k]).map(([k, v]) => [ids[k], v]));
    const layouts = boards.map((b) => ({
      id: ids[b.id], from: b.id,
      name: name80(body.boards?.[b.id]) || name80(`${name}: ${b.name}`),
      draft: renamePictures(b.draft || {}, renamed),
      doc: docs[b.id] ? renamePictures(docs[b.id], renamed) : null,
    }));

    let r;
    try {
      r = await rpc("shop_copy", { p_from: src.id, p_org: orgId, p_name: name, p_content: content, p_layouts: layouts, p_images: images, p_property: building, p_by: user.id });
    } catch (e) { throw fail(e.status && e.status < 500 ? 409 : 502, e.message); }
    copied.length = 0; madeOrg = null;   // kept
    return json({ ...r, org_id: orgId, pictures: images.length, renamed });
  } catch (e) {
    // nothing half-made is left: the copied files, and an account made for this copy
    if (copied.length) await storageRemove(BUCKET, copied).catch(() => {});
    if (madeOrg) await db(`organizations?id=eq.${enc(madeOrg.id)}`, { method: "DELETE", prefer: "return=minimal" }).catch(() => {});
    return json({ error: e.message }, e.status && e.status < 600 ? e.status : 502);
  }
};

export const config = { path: "/api/shops" };
