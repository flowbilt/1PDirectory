// GET /api/config -> the public Supabase settings the sign-in pages need.
// The anon/publishable key is designed to be public; the database's access rules protect the data.
import { json } from "../lib/common.mjs";

export default async () => {
  const url = process.env.SUPABASE_URL, anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return json({ error: "Supabase isn't connected yet. Add SUPABASE_URL and SUPABASE_ANON_KEY in Netlify." }, 500);
  return json({ url: url.replace(/\/+$/, ""), anonKey }, 200, { "Cache-Control": "public, max-age=300" });
};

export const config = { path: "/api/config" };
