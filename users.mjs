// /api/users  — people who can sign in.
//   GET                                   list the users the caller may manage
//   POST {action:"invite", email, full_name, role, org_id}
//   POST {action:"email", user_id}        invitation again if they never signed in, otherwise a password reset
//   PATCH {user_id, role?, full_name?}
//   DELETE ?user_id=...
// 1Point admins manage everyone. Owner admins manage their own organization's users. Editors manage no one.
import { json } from "../lib/common.mjs";
import { audit, auth, caller, db, enc } from "../lib/sb.mjs";

const ORG_ROLES = ["org_admin", "org_editor"];
const ALL_ROLES = ["platform_admin", ...ORG_ROLES];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (status, error) => Object.assign(new Error(error), { status });

function mayManage(me, target) {
  if (me.role === "platform_admin") return true;
  return me.role === "org_admin" && target.org_id && target.org_id === me.org_id && target.role !== "platform_admin";
}

async function listAuthUsers() {
  const out = new Map();
  for (let page = 1; page <= 20; page++) {
    const d = await auth(`/admin/users?page=${page}&per_page=200`);
    const users = d?.users || [];
    users.forEach((u) => out.set(u.id, u));
    if (users.length < 200) break;
  }
  return out;
}

async function loadTarget(user_id) {
  if (!user_id) throw fail(400, "user_id is required.");
  const [p] = await db(`profiles?user_id=eq.${enc(user_id)}&select=*`);
  if (!p) throw fail(404, "No such user.");
  return p;
}

async function sendSignInEmail(profile, origin) {
  const u = await auth(`/admin/users/${enc(profile.user_id)}`);
  const redirect = `?redirect_to=${enc(origin + "/login.html")}`;
  if (!u?.last_sign_in_at) {
    await auth(`/invite${redirect}`, { method: "POST", body: { email: profile.email, data: { full_name: profile.full_name } } });
    return "invitation";
  }
  await auth(`/recover${redirect}`, { method: "POST", body: { email: profile.email } });
  return "password reset";
}

export default async (req) => {
  try {
    const { user, profile: me } = await caller(req);
    if (me.role === "org_editor") throw fail(403, "Only account admins can manage users.");
    const origin = new URL(req.url).origin;

    if (req.method === "GET") {
      const filter = me.role === "platform_admin" ? "" : `&org_id=eq.${enc(me.org_id)}`;
      const [profiles, orgs, authUsers] = await Promise.all([
        db(`profiles?select=*&order=email.asc${filter}`),
        db("organizations?select=id,name"),
        listAuthUsers(),
      ]);
      const orgName = Object.fromEntries(orgs.map((o) => [o.id, o.name]));
      return json({
        users: profiles.map((p) => {
          const a = authUsers.get(p.user_id) || {};
          return { ...p, org_name: orgName[p.org_id] || "", last_sign_in_at: a.last_sign_in_at || null, invited_at: a.invited_at || null, is_me: p.user_id === user.id };
        }),
      });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));

      if (body.action === "invite") {
        const email = String(body.email || "").trim().toLowerCase();
        const full_name = String(body.full_name || "").trim().slice(0, 80);
        const role = String(body.role || "");
        const org_id = role === "platform_admin" ? null : body.org_id || (me.role === "org_admin" ? me.org_id : null);
        if (!EMAIL_RE.test(email)) throw fail(400, "Enter a valid email address.");
        if (!ALL_ROLES.includes(role)) throw fail(400, "Choose a role.");
        if (role !== "platform_admin" && !org_id) throw fail(400, "Choose which account this person belongs to.");
        if (!mayManage(me, { role, org_id })) throw fail(403, "You can only add people to your own account.");
        const [existing] = await db(`profiles?email=eq.${enc(email)}&select=user_id`);
        if (existing) throw fail(409, "That person already has a login.");

        const invited = await auth(`/invite?redirect_to=${enc(origin + "/login.html")}`, { method: "POST", body: { email, data: { full_name } } });
        const uid = invited?.id || invited?.user?.id;
        if (!uid) throw fail(502, "Supabase didn't return the new user.");
        try {
          await db("profiles", { method: "POST", prefer: "return=minimal", body: { user_id: uid, email, full_name, role, org_id } });
        } catch (e) {
          await auth(`/admin/users/${enc(uid)}`, { method: "DELETE" }).catch(() => {});
          throw e;
        }
        await audit(user.id, "invite", "user", uid, { email, role, org_id });
        return json({ ok: true, user_id: uid }, 201);
      }

      if (body.action === "email") {
        const target = await loadTarget(body.user_id);
        if (!mayManage(me, target)) throw fail(403, "You can't manage that user.");
        const kind = await sendSignInEmail(target, origin);
        await audit(user.id, `send ${kind}`, "user", target.user_id, { email: target.email });
        return json({ ok: true, sent: kind });
      }
      throw fail(400, "Unknown action.");
    }

    if (req.method === "PATCH") {
      const body = await req.json().catch(() => ({}));
      const target = await loadTarget(body.user_id);
      if (!mayManage(me, target)) throw fail(403, "You can't manage that user.");
      const patch = {};
      if (body.full_name !== undefined) patch.full_name = String(body.full_name).trim().slice(0, 80);
      if (body.role !== undefined) {
        if (!ALL_ROLES.includes(body.role)) throw fail(400, "Unknown role.");
        if (body.role === "platform_admin" && me.role !== "platform_admin") throw fail(403, "Only 1Point can grant 1Point access.");
        if (target.user_id === user.id && body.role !== me.role) throw fail(400, "You can't change your own role.");
        patch.role = body.role;
        if (body.role === "platform_admin") patch.org_id = null;
        else if (body.org_id && me.role === "platform_admin") patch.org_id = body.org_id;
        else if (!target.org_id) throw fail(400, "Choose which account this person belongs to.");
      }
      if (!Object.keys(patch).length) throw fail(400, "Nothing to change.");
      await db(`profiles?user_id=eq.${enc(target.user_id)}`, { method: "PATCH", prefer: "return=minimal", body: patch });
      await audit(user.id, "update", "user", target.user_id, patch);
      return json({ ok: true });
    }

    if (req.method === "DELETE") {
      const target = await loadTarget(new URL(req.url).searchParams.get("user_id"));
      if (target.user_id === user.id) throw fail(400, "You can't remove yourself.");
      if (!mayManage(me, target)) throw fail(403, "You can't manage that user.");
      await auth(`/admin/users/${enc(target.user_id)}`, { method: "DELETE" }); // profile goes with it (cascade)
      await audit(user.id, "remove", "user", target.user_id, { email: target.email });
      return json({ ok: true });
    }

    throw fail(405, "Method not allowed.");
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
};

export const config = { path: "/api/users" };
