// An account's pictures (DP-11 E1b; DP-12 E2c), shared by /api/layouts (1Point, in the Layouts tab) and /api/pictures
// (the menu editor: 1Point, and the account's admins and editors). Every file goes through readPicture (its own bytes
// say what it is); the room per account is the database's (supabase/34-customer-pictures.sql).
//
// Removing a picture (E2c, Scot: "when removed verify the pictures are removed from Supabase as well"):
//   1. layout_image_check   refuses, in plain words, while it's on the boards; otherwise gives the file's path
//   2. Storage              the file is deleted
//   3. Storage again        asked whether it still has the file; if it does, stop: nothing is removed
//   4. layout_image_delete  the row goes (it checks again)
import { db, rpc, enc, storagePut, storageRemove, storageList } from "./sb.mjs";
import { readPicture, pictureKey } from "./images.mjs";
import { randomUUID } from "node:crypto";

export const BUCKET = "layout-images";
const fail = (status, error) => Object.assign(new Error(error), { status });

export const pictureOut = (row) => ({ id: row.id, key: row.key, name: row.name, url: `/img/${row.path}`, width: row.width, height: row.height, bytes: row.bytes });

/** Stores a new picture for an account: { picture }. The file first, then its row; a refused row removes the file. */
export async function uploadPicture(orgId, { name, key: wantKey, data }, userId) {
  const pic = readPicture(data);
  if (pic.error) throw fail(400, pic.error);
  const nice = String(name || "").trim().slice(0, 80);
  let key = pictureKey(wantKey || nice);
  if (!key) throw fail(400, "Give the picture a name (letters or numbers), e.g. Maple Bacon.");
  // A key is fixed once made and unique in the account: a second "Maple Bacon" becomes maple-bacon-2
  const taken = new Set((await db(`layout_images?org_id=eq.${enc(orgId)}&key=like.${enc(key)}*&select=key`)).map((r) => r.key));
  if (taken.has(key)) { let n = 2; while (taken.has(`${key.slice(0, 56)}-${n}`)) n++; key = `${key.slice(0, 56)}-${n}`; }
  // The room first, so a full account doesn't upload a file only to have it refused (the database checks it again)
  const [org] = await db(`organizations?id=eq.${enc(orgId)}&select=picture_room`);
  const room = org?.picture_room ?? 100;
  const have = (await db(`layout_images?org_id=eq.${enc(orgId)}&select=id`)).length;
  if (have >= room) throw fail(409, `This account has ${have} pictures, the most it holds. Remove ones you no longer use, or ask WayTuGo for more room.`);
  const path = `${orgId}/${key}-${randomUUID().slice(0, 8)}.${pic.ext}`;   // a new file every time: never overwritten
  await storagePut(BUCKET, path, pic.bytes, pic.mime);
  let row;
  try {
    [row] = await db("layout_images", { method: "POST", prefer: "return=representation",
      body: { org_id: orgId, key, name: nice || key, path, mime: pic.mime, width: pic.width, height: pic.height, bytes: pic.bytes.length, created_by: userId } });
  } catch (e) {
    await storageRemove(BUCKET, [path]).catch(() => {});
    throw Object.assign(e, { status: e.status === 400 ? 409 : e.status });
  }
  return { picture: pictureOut(row) };
}

/** Whether Storage still has a file (asked of Storage's own list, not a cached public address). */
export async function storageHas(path) {
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash), file = path.slice(slash + 1);
  const items = await storageList(BUCKET, folder, { search: file, limit: 100 });
  return items.some((i) => i.name === file);
}

/** Removes a picture: refused while it's on the boards; the file goes from Storage, Storage is asked again, then the
 *  row goes. Returns { ok, path, verified: true }. */
export async function removePicture(id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id || ""))) throw fail(400, "Choose a picture.");
  const path = await rpc("layout_image_check", { p_id: id });
  await storageRemove(BUCKET, [path]);
  if (await storageHas(path)) throw fail(502, "Storage still has that picture's file, so nothing was removed. Try again in a minute, or contact WayTuGo.");
  try { await rpc("layout_image_delete", { p_id: id }); }
  catch (e) {
    // Only if someone put it on a board in the moment between: the file is gone but its row stays (Check storage shows it)
    throw Object.assign(new Error(`${e.message} (Its file was already removed; WayTuGo's Check storage shows it.)`), { status: e.status || 409 });
  }
  return { ok: true, path, verified: true };
}

/** 1Point's Check storage for one account: files with no picture row (left over), and rows whose file is missing. */
export async function storageReport(orgId) {
  const files = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await storageList(BUCKET, orgId, { limit: 1000, offset });
    files.push(...page.filter((i) => i.id !== null && i.name).map((i) => ({ path: `${orgId}/${i.name}`, at: Date.parse(i.created_at || "") || 0 })));
    if (page.length < 1000) break;
  }
  const rows = await db(`layout_images?org_id=eq.${enc(orgId)}&select=id,key,name,path`);
  const known = new Set(rows.map((r) => r.path)), have = new Set(files.map((f) => f.path));
  const settled = Date.now() - 10 * 60 * 1000;   // a file uploaded in the last 10 minutes may be waiting for its row
  return {
    files: files.length, pictures: rows.length,
    leftover: files.filter((f) => !known.has(f.path) && f.at < settled).map((f) => f.path),
    missing: rows.filter((r) => !have.has(r.path)).map((r) => ({ id: r.id, key: r.key, name: r.name, path: r.path })),
  };
}

/** Removes left-over files (ones with no picture row) and checks each is gone. */
export async function removeLeftovers(orgId) {
  const { leftover } = await storageReport(orgId);
  if (leftover.length) await storageRemove(BUCKET, leftover);
  const after = await storageReport(orgId);
  const still = after.leftover.filter((f) => leftover.includes(f));
  return { removed: leftover.length - still.length, still, report: after };
}
