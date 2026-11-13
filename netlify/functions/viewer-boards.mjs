// The menu board in "See Your WayTuGo in Action" (DP-14, V4): WayTuGo's template shops and their boards, read live.
//   GET /api/viewer-boards             { templates: [{ id, name, boards: [{ id, name, orientation, inches, turns, looks }] }] }
//                                      the shops in WayTuGo Templates accounts with their published boards (never the
//                                      WayTuGo Samples accounts: real shops fitted for prospects)
//   GET /api/viewer-boards?board=<id>  one of those boards as a screen's answer (as a sample link's), in an invented
//                                      building in Birmingham (1Point's home) for its clock and weather; 404 otherwise
// Public and read-only: only boards anyone can already open from their QR codes. One database call each
// (supabase/53-viewer-menu.sql). The viewer draws the board on the real board page (board.html?preview=1), with the
// visitor's name, logo, look and items laid over it in their browser (viewer-sample.mjs menuDraft).
import { rpc } from "../lib/sb.mjs";
import { toLayoutPayload } from "./screen.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (o, status = 200, cache = "no-store") => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": cache, "X-Robots-Tag": "noindex" } });
// The building a template board is drawn in: Birmingham's clock and weather, and no real name or address
export const VIEWER_BUILDING = { id: null, name: "", address: "", timezone: "America/Chicago", lat: 33.5186, lon: -86.8104 };

export default async (req) => {
  if (req.method !== "GET") return json({ error: "GET only." }, 405);
  const board = new URL(req.url).searchParams.get("board");
  try {
    if (board === null) {
      const list = await rpc("viewer_boards", {});
      return json({ templates: Array.isArray(list) ? list : [] }, 200, "public, max-age=60");
    }
    if (!UUID_RE.test(board)) return json({ error: "No such board." }, 404);
    const r = await rpc("viewer_board", { p_layout: board.toLowerCase() });
    if (!r || r.missing) return json({ error: "No such board." }, 404);
    const screen = { key: "viewer", name: r.layout.name, orientation: "auto", hide_powered_by: false, touch: false, screen_inches: r.layout.doc?.viewing?.inches ?? null, touch_idle_s: 45 };
    return json({ ...toLayoutPayload(screen, { ...r.layout, lists: r.lists }, VIEWER_BUILDING, r.images), viewer: true }, 200, "public, max-age=60");
  } catch {
    return json({ error: "The templates are unavailable right now." }, 502);
  }
};

export const config = { path: "/api/viewer-boards" };
