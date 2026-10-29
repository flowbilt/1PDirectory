// /api/pictures (DP-12, round E2c): an account's own pictures, from the menu editor. 1Point for any account; an account's
// Account Admins and Editors for their own, while customer editing is on for one of its menus (as for saving the menu).
//   POST { action: "list",   org_id }        -> { pictures: [{ id, key, name, url, width, height, bytes, use }], room, can_change }
//        use: null (not on the boards: can be removed), "menu" (in a menu's lists now), or "layout" (part of a layout: WayTuGo's)
//   POST { action: "upload", org_id, name, data } -> { picture } (data: a WebP, JPEG or PNG data URL, already shrunk in the browser)
//   POST { action: "rename", id, name }      -> { picture } (the name only; what the menu says, img:<key>, never changes)
//   POST { action: "delete", id }            -> { ok, verified } (refused while on the boards; the file is removed from
//        Storage and Storage is asked again before the picture's row goes: netlify/lib/pictures.mjs)
// 1Point only (the console's Accounts tab):
//   POST { action: "check_storage",    org_id } -> { files, pictures, leftover: [path], missing: [{ id, name, path }] }
//   POST { action: "remove_leftovers", org_id } -> { removed, still, report }
import { db, caller, enc, audit } from "../lib/sb.mjs";
import { menuPictureKeys } from "../../public/menu-format.mjs";
import { pictureKeys } from "../lib/images.mjs";
import { uploadPicture, removePicture, storageReport, removeLeftovers, pictureOut } from "../lib/pictures.mjs";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (status, error) => Object.assign(new Error(error), { status });
const UUID = /^[0-9a-f-]{36}$/;

/** What this person may do with this account's pictures: "all" (1Point), "change", "see", or a refusal. */
async function rightsFor(profile, orgId) {
  if (!UUID.test(String(orgId || ""))) throw fail(400, "Choose the account.");
  if (profile.role === "platform_admin") return "all";
  if (profile.org_id !== orgId || !["org_admin", "org_editor"].includes(profile.role)) throw fail(403, "Those pictures aren't in your account.");
  const open = await db(`menus?org_id=eq.${enc(orgId)}&customer_edit=is.true&select=id&limit=1`);
  return open.length ? "change" : "see";
}
const mustChange = (rights) => { if (rights === "see") throw fail(403, "WayTuGo keeps this menu up to date for you. Contact WayTuGo for changes."); };

async function pictureRow(id) {
  if (!UUID.test(String(id || ""))) throw fail(400, "Choose a picture.");
  const [row] = await db(`layout_images?id=eq.${enc(id)}&select=*`);
  if (!row) throw fail(404, "That picture is already gone.");
  return row;
}

export default async (req) => {
  try {
    if (req.method !== "POST") throw fail(405, "Use POST.");
    const { user, profile } = await caller(req);
    let body;
    try { body = await req.json(); } catch { throw fail(400, "Send JSON."); }

    if (body.action === "list") {
      const rights = await rightsFor(profile, body.org_id);
      const org = body.org_id;
      const [[o], rows, menus, layouts] = await Promise.all([
        db(`organizations?id=eq.${enc(org)}&select=picture_room`),
        db(`layout_images?org_id=eq.${enc(org)}&select=*&order=name.asc`),
        db(`menus?org_id=eq.${enc(org)}&select=content`),
        db(`layouts?org_id=eq.${enc(org)}&select=id,draft`),
      ]);
      const versions = layouts.length ? await db(`layout_versions?layout_id=in.(${layouts.map((l) => enc(l.id)).join(",")})&select=doc`) : [];
      const onMenu = new Set(menus.flatMap((m) => menuPictureKeys(m.content)));
      const inLayout = new Set([...layouts.flatMap((l) => pictureKeys(l.draft)), ...versions.flatMap((v) => pictureKeys(v.doc))]);
      return json({
        pictures: rows.map((r) => ({ ...pictureOut(r), use: onMenu.has(r.key) ? "menu" : inLayout.has(r.key) ? "layout" : null })),
        room: o?.picture_room ?? 100, can_change: rights !== "see", is_waytugo: rights === "all",
      });
    }

    if (body.action === "upload") {
      const rights = await rightsFor(profile, body.org_id);
      mustChange(rights);
      const out = await uploadPicture(body.org_id, body, user.id);
      await audit(user.id, "picture.upload", "layout_image", out.picture.id, { org_id: body.org_id, key: out.picture.key });
      return json(out);
    }

    if (body.action === "rename") {
      const row = await pictureRow(body.id);
      mustChange(await rightsFor(profile, row.org_id));
      const name = String(body.name || "").trim().slice(0, 80);
      if (!name) throw fail(400, "Give the picture a name.");
      const [after] = await db(`layout_images?id=eq.${enc(row.id)}`, { method: "PATCH", prefer: "return=representation", body: { name } });
      return json({ picture: pictureOut(after) });
    }

    if (body.action === "delete") {
      const row = await pictureRow(body.id);
      mustChange(await rightsFor(profile, row.org_id));
      const out = await removePicture(row.id);
      await audit(user.id, "picture.remove", "layout_image", row.id, { org_id: row.org_id, key: row.key, path: row.path, verified: true });
      return json({ ok: true, verified: out.verified });
    }

    if (body.action === "check_storage" || body.action === "remove_leftovers") {
      if ((await rightsFor(profile, body.org_id)) !== "all") throw fail(403, "Only WayTuGo can check storage.");
      if (body.action === "check_storage") return json(await storageReport(body.org_id));
      const out = await removeLeftovers(body.org_id);
      await audit(user.id, "picture.leftovers_removed", "organization", body.org_id, { removed: out.removed });
      return json(out);
    }

    throw fail(400, "Unknown action.");
  } catch (e) {
    return json({ error: e.message }, e.status && e.status < 600 ? e.status : 502);
  }
};

export const config = { path: "/api/pictures" };
