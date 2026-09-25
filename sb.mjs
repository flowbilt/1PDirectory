// Minimal Supabase client for Netlify functions: REST (PostgREST) and Auth (GoTrue) over fetch.
// Uses the service key, which bypasses row-level security, so every caller must check permissions first.

const base = () => {
  const u = process.env.SUPABASE_URL;
  if (!u) throw Object.assign(new Error("SUPABASE_URL is not set in the Netlify environment variables."), { status: 500 });
  return u.replace(/\/+$/, "");
};
const serviceKey = () => {
  const k = process.env.SUPABASE_SERVICE_KEY;
  if (!k) throw Object.assign(new Error("SUPABASE_SERVICE_KEY is not set in the Netlify environment variables."), { status: 500 });
  return k;
};

async function call(path, { method = "GET", body, apikey, token, prefer } = {}) {
  const res = await fetch(base() + path, {
    method,
    headers: {
      apikey,
      // Newer Supabase keys (sb_secret_/sb_publishable_) go in the apikey header only; older JWT keys (eyJ...) also
      // go in Authorization. A signed-in user's token always goes in Authorization.
      ...(token ? { Authorization: `Bearer ${token}` } : apikey.startsWith("eyJ") ? { Authorization: `Bearer ${apikey}` } : {}),
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.msg || data.message || data.error_description || data.error)) || `Supabase error ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status, data });
  }
  return data;
}

/** Database with the service key. path like "screens?key=eq.ppi-2s&select=*" */
export const db = (path, opts = {}) => call(`/rest/v1/${path}`, { ...opts, apikey: serviceKey() });

/** Calls a database function with the service key (supabase/05-tuning.sql). Returns what the function returns. */
export const rpc = (name, args) => db(`rpc/${name}`, { method: "POST", body: args });

/** Auth admin endpoints with the service key. path like "/admin/users" */
export const auth = (path, opts = {}) => call(`/auth/v1${path}`, { ...opts, apikey: serviceKey() });

/** Who is calling? Verifies the caller's access token with Supabase and returns their profile, or throws 401. */
export async function caller(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) throw Object.assign(new Error("Please sign in."), { status: 401 });
  let user;
  try {
    user = await call("/auth/v1/user", { apikey: process.env.SUPABASE_ANON_KEY || serviceKey(), token });
  } catch {
    throw Object.assign(new Error("Your sign-in has expired. Please sign in again."), { status: 401 });
  }
  const [profile] = await db(`profiles?user_id=eq.${encodeURIComponent(user.id)}&select=*`);
  if (!profile) throw Object.assign(new Error("This login isn't linked to an account yet. Contact 1Point."), { status: 403 });
  return { user, profile };
}

export async function audit(user_id, action, entity, entity_id, detail = {}) {
  try { await db("audit_log", { method: "POST", body: { user_id, action, entity, entity_id, detail }, prefer: "return=minimal" }); }
  catch { /* never block the real action on the log */ }
}

export const enc = encodeURIComponent;
