/* Sign-in and data access for the signed-in pages (login, console, editor).
   Talks to Supabase directly with the user's own session, so the database's access rules
   decide what each person can see and change. Admin-only actions go through /api/* functions. */
window.Auth = (() => {
  "use strict";
  const KEY = "dir-session";
  let cfg = null;
  let profile = null;

  async function config() {
    if (cfg) return cfg;
    const r = await fetch("/api/config");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "The site isn't connected to Supabase yet.");
    return (cfg = d);
  }

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));
  const fromToken = (d) => ({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000, user: d.user || null });

  async function gotrue(path, { method = "POST", body, token } = {}) {
    const c = await config();
    const r = await fetch(`${c.url}/auth/v1${path}`, {
      method,
      headers: { apikey: c.anonKey, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = d.error_description || d.msg || d.message || "Something went wrong.";
      throw new Error(/invalid login/i.test(msg) ? "That email and password don't match." : msg);
    }
    return d;
  }

  async function signIn(email, password) {
    save(fromToken(await gotrue("/token?grant_type=password", { body: { email: email.trim().toLowerCase(), password } })));
  }

  async function session() {
    let s = load();
    if (!s) return null;
    if (Date.now() > s.expires_at - 60_000) {
      try { s = fromToken(await gotrue("/token?grant_type=refresh_token", { body: { refresh_token: s.refresh_token } })); save(s); }
      catch { localStorage.removeItem(KEY); return null; }
    }
    return s;
  }

  async function requireSession() {
    const s = await session();
    if (!s) {
      location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      throw new Error("Signing in…");
    }
    return s;
  }

  function signOut() {
    localStorage.removeItem(KEY);
    location.href = "/login.html";
  }

  /** Database call as the signed-in user. path like "tenants?directory_id=eq.X&order=sort.asc" */
  async function db(path, { method = "GET", body, prefer } = {}) {
    const c = await config();
    const s = await requireSession();
    const r = await fetch(`${c.url}/rest/v1/${path}`, {
      method,
      headers: { apikey: c.anonKey, Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let d = null;
    try { d = text ? JSON.parse(text) : null; } catch { /* empty */ }
    if (r.status === 401) { signOut(); throw new Error("Your sign-in expired."); }
    if (!r.ok) throw new Error(friendly(d?.message) || `Request failed (${r.status}).`);
    return d;
  }

  /** Our own server functions, with the user's session attached. */
  async function api(path, { method = "GET", body } = {}) {
    const s = await requireSession();
    const r = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.error || `Request failed (${r.status}).`);
    return d;
  }

  /** An image from our server functions (e.g. a screenshot), as an object URL for <img src>. */
  async function blob(path) {
    const s = await requireSession();
    const r = await fetch(path, { headers: { Authorization: `Bearer ${s.access_token}` } });
    if (!r.ok) return null;
    return URL.createObjectURL(await r.blob());
  }

  function friendly(msg) {
    if (!msg) return "";
    if (/row-level security|permission denied/i.test(msg)) return "You don't have permission to make that change.";
    if (/directories_slug_key|screens_key_key|duplicate key/i.test(msg)) return "That address is already in use. Pick another.";
    return msg;
  }

  /** The signed-in person's profile: role and organization. */
  async function me() {
    if (profile) return profile;
    const s = await requireSession();
    const rows = await db(`profiles?user_id=eq.${s.user.id}&select=*`);
    if (!rows?.length) throw new Error("This login isn't linked to an account yet. Contact 1Point.");
    return (profile = rows[0]);
  }

  /** Invitation and password-reset emails land on /login.html with the session in the address. */
  function linkFromAddress() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("error_description")) return { error: h.get("error_description").replace(/\+/g, " ") };
    if (!h.get("access_token")) return null;
    return { access_token: h.get("access_token"), refresh_token: h.get("refresh_token"), expires_in: h.get("expires_in"), type: h.get("type") || "" };
  }

  async function setPassword(link, password) {
    const user = await gotrue("/user", { method: "PUT", body: { password }, token: link.access_token });
    save(fromToken({ ...link, user }));
  }

  const sendReset = (email) => gotrue(`/recover?redirect_to=${encodeURIComponent(location.origin + "/login.html")}`, { body: { email: email.trim().toLowerCase() } });

  return { config, signIn, signOut, session, requireSession, db, api, blob, me, linkFromAddress, setPassword, sendReset };
})();

/* Small shared helpers for the signed-in pages */
window.UI = {
  esc: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  toast(msg, bad = false) {
    let t = document.getElementById("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.toggle("bad", bad);
    t.hidden = false;
    clearTimeout(UI._t);
    UI._t = setTimeout(() => (t.hidden = true), bad ? 6500 : 3200);
  },
  since(iso) {
    if (!iso) return "never";
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} hr ago`;
    return new Date(iso).toLocaleDateString();
  },
  slug: (s) => String(s).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48),
  roleName: (r) => ({ platform_admin: "1Point admin", org_admin: "Account admin", org_editor: "Editor" }[r] || r),
};
