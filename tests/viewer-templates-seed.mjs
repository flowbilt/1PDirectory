// Two WayTuGo template shops for checking the viewer's menu board (DP-14, V4): the coffee shop's and the burger joint's
// 55" boards, each made into a menu as Make lists does (menu-format.mjs extractMenu), in a WayTuGo Templates account,
// published, with board names like the live ones. Their pictures aren't uploaded (a picture block draws its quiet panel). Used by the browser checks.
//   await seedTemplates(sb)   sb(path, init) = a call to the fake Supabase's REST with the service key and its own headers
import { readFileSync } from "node:fs";
import { checkLayout } from "../public/layout-format.mjs";
import { extractMenu } from "../public/menu-format.mjs";

const file = (f) => JSON.parse(readFileSync(new URL(`../layouts/${f}`, import.meta.url), "utf8"));
export const SEED = [
  { shop: "Daybreak Coffee Co. (template)", board: "Coffee shop · counter board 55", file: "template-coffee-55.json" },
  { shop: "The Meet Market (template)", board: "The Meet Market - Counter Board", file: "template-burger-55.json" },
];

export async function seedTemplates(sb) {
  const post = async (table, row) => (await sb(table, { method: "POST", body: JSON.stringify(row) })).data?.[0];
  const org = await post("organizations", { name: "WayTuGo Templates (viewer check)", kind: "templates" });
  const out = [], keys = new Set();
  for (const s of SEED) {
    const raw = file(s.file), checked = checkLayout(raw);
    const { spec, content, doc } = extractMenu(checked.doc);
    // the picture keys the board uses, as rows of the account (no files: the board draws their quiet panels)
    for (const key of new Set((JSON.stringify(raw).match(/"img:[a-z0-9-]+"/g) || []).map((k) => k.slice(5, -1)))) {
      if (!keys.has(key)) await post("layout_images", { org_id: org.id, key, name: key, path: `${org.id}/${key}.webp`, mime: "image/webp", width: 1200, height: 800, bytes: 1000 });
      keys.add(key);
    }
    const menu = await post("menus", { org_id: org.id, name: s.shop, spec, content, customer_edit: true });
    const layout = await post("layouts", { org_id: org.id, name: s.board, orientation: raw.orientation, draft: doc, menu_id: menu.id });
    await post("layout_versions", { layout_id: layout.id, version: 1, doc, checks: {}, overridden: false, note: "viewer check" });
    await sb(`layouts?id=eq.${layout.id}`, { method: "PATCH", body: JSON.stringify({ published_version: 1 }) });
    out.push({ menu, layout });
  }
  return { org, boards: out };
}
