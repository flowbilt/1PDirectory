// GET /api/config -> the public Supabase settings the sign-in pages need.
// The anon/publishable key is designed to be public; the database's access rules protect the data.
import { json } from "../lib/common.mjs";

export default async () => {
  const url = process.env.SUPABASE_URL, anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return json({ error: "Supabase isn't connected yet. Add SUPABASE_URL and SUPABASE_ANON_KEY in Netlify." }, 500);
  // mapsKey: the Google Maps browser key (GOOGLE_MAPS_KEY), public by design and locked to the site's address in
  // Google Cloud; the editor's preview uses it to draw the traffic map (DP-08 round 11). togoBase: the start of the
  // Directory to Go link, for the editor (DP-08 round 12); menuBase: the menu's (DP-11 E1c), for the console.
  return json({ url: url.replace(/\/+$/, ""), anonKey, mapsKey: process.env.GOOGLE_MAPS_KEY || "",
    togoBase: (process.env.TOGO_BASE || "https://waytugo.com/d/").replace(/\/*$/, "/"),
    menuBase: (process.env.MENU_BASE || "https://waytugo.com/m/").replace(/\/*$/, "/") }, 200, { "Cache-Control": "public, max-age=300" });
};

export const config = { path: "/api/config" };
