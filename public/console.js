(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const { esc, toast, since, slug, roleName } = window.UI;
  const PAGE = 25;
  const ONLINE_MIN = 15;
  // Signed-in users may read only these screen columns (supabase/06-trust.sql); hardware comes from /api/devices.
  const SCREEN_COLS = "id,directory_id,key,name,location_note,orientation,last_seen,last_report,identify_until,created_at";

  const S = { me: null, admin: false, orgs: [], props: [], dirs: [], screens: [], tenantCount: {}, tenantText: {}, people: [], page: 0 };
  window.ConsoleState = S;
  const Dev = window.ConsoleDevices;

  // ── Load ──
  async function load() {
    const [orgs, props, dirs, screens, tenants] = await Promise.all([
      Auth.db("organizations?select=id,name,kind&order=name.asc"),
      Auth.db("properties?select=id,org_id,name,address&order=name.asc"),
      Auth.db("directories?select=id,property_id,slug,title,subtitle,updated_at&order=title.asc"),
      Auth.db(`screens?select=${SCREEN_COLS}&order=name.asc`),
      Auth.db("tenants?select=directory_id,name"),
    ]);
    Object.assign(S, { orgs, props, dirs, screens, tenantCount: {}, tenantText: {} });
    for (const t of tenants) {
      S.tenantCount[t.directory_id] = (S.tenantCount[t.directory_id] || 0) + 1;
      S.tenantText[t.directory_id] = (S.tenantText[t.directory_id] || "") + " " + t.name.toLowerCase();
    }
  }
  const prop = (id) => S.props.find((p) => p.id === id);
  const dir = (id) => S.dirs.find((d) => d.id === id);
  const org = (id) => S.orgs.find((o) => o.id === id);
  const status = (s) => (!s.last_seen ? "never" : (Date.now() - Date.parse(s.last_seen)) / 60000 <= ONLINE_MIN ? "online" : "offline");

  // ── Tabs ──
  document.querySelectorAll("[role=tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  // Back/forward buttons and links to #people etc. switch tabs too
  window.addEventListener("hashchange", () => {
    const t = location.hash.slice(1);
    const btn = document.querySelector(`[data-tab="${t}"]`);
    if (btn && !btn.hidden) showTab(t);
  });
  function showTab(name) {
    document.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    document.querySelectorAll(".tabpanel").forEach((p) => (p.hidden = p.id !== `panel-${name}`));
    if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
    if (name === "people") renderPeople();
    if (name === "health") Dev.loadHealth();
    if (name === "setup") window.ConsoleSetup?.load();
  }

  // ── Screens ──
  function renderScreens() {
    const q = $("screen-search").value.trim().toLowerCase();
    const ownerF = $("screen-owner").value, statusF = $("screen-status").value;
    const rows = S.screens.filter((s) => {
      const d = dir(s.directory_id), p = d && prop(d.property_id);
      if (ownerF && p?.org_id !== ownerF) return false;
      if (statusF && status(s) !== statusF) return false;
      if (!q) return true;
      const pi = Dev.list().find((x) => x.screen_id === s.id);
      return [s.name, s.key, s.location_note, d?.title, d?.subtitle, p?.name, S.tenantText[s.directory_id], pi?.serial, pi?.last_health?.ip].join(" ").toLowerCase().includes(q);
    });
    const counts = { online: 0, offline: 0, never: 0 };
    S.screens.forEach((s) => counts[status(s)]++);
    $("screen-summary").innerHTML = `<span class="dot online"></span>${counts.online} online <span class="dot offline"></span>${counts.offline} offline <span class="dot never"></span>${counts.never} not yet checked in`;

    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    S.page = Math.min(S.page, pages - 1);
    const shown = rows.slice(S.page * PAGE, S.page * PAGE + PAGE);
    $("screen-rows").innerHTML = shown.length ? shown.map((s) => {
      const d = dir(s.directory_id), p = d && prop(d.property_id), st = status(s);
      const rep = s.last_report || {};
      return `<tr>
        <td><span class="dot ${st}"></span>${{ online: "Online", offline: "Offline", never: "Not yet" }[st]}${Dev.statusNote(s)}</td>
        ${Dev.thumbCell(s)}
        <td><strong>${esc(s.name)}</strong><div class="sub">${esc(s.key)}${s.location_note ? ` · ${esc(s.location_note)}` : ""}</div></td>
        <td>${d ? `${esc(d.title)}${d.subtitle ? ` · ${esc(d.subtitle)}` : ""}<div class="sub">${esc(p?.name || "")} · ${S.tenantCount[d.id] || 0} tenants</div>` : `<span class="warn">Not assigned</span>`}</td>
        <td>${esc({ auto: "Automatic", portrait: "Portrait", landscape: "Landscape" }[s.orientation] || s.orientation)}${rep.w ? `<div class="sub">${rep.w}×${rep.h}</div>` : ""}</td>
        <td>${since(s.last_seen)}</td>
        <td class="actions">
          ${d ? `<a class="ghost" href="/edit.html?d=${d.id}">Edit tenants</a>` : ""}
          <a class="ghost" href="/?screen=${encodeURIComponent(s.key)}&view=1" target="_blank" rel="noopener">View</a>
          ${Dev.actionButton(s)}
          ${S.admin ? `<button type="button" class="ghost" data-screen="${s.id}">Settings</button>` : ""}
        </td></tr>`;
    }).join("") : `<tr><td colspan="7" class="empty-rows">No screens match.</td></tr>`;
    Dev.fillThumbs($("screen-rows"));
    $("screen-pager").innerHTML = pages > 1
      ? Array.from({ length: pages }, (_, i) => `<button type="button" class="ghost${i === S.page ? " current" : ""}" data-page="${i}">${i + 1}</button>`).join("")
      : "";
  }
  ["screen-search", "screen-owner", "screen-status"].forEach((id) => $(id).addEventListener("input", () => { S.page = 0; renderScreens(); }));
  $("screen-pager").addEventListener("click", (e) => { const b = e.target.closest("[data-page]"); if (b) { S.page = Number(b.dataset.page); renderScreens(); } });
  $("screen-rows").addEventListener("click", (e) => { const b = e.target.closest("[data-screen]"); if (b) screenDialog(S.screens.find((s) => s.id === b.dataset.screen)); });
  $("add-screen").addEventListener("click", () => screenDialog(null));

  const dirOptions = (selected) => `<option value="">Not assigned</option>` + S.props.map((p) => {
    const ds = S.dirs.filter((d) => d.property_id === p.id);
    return ds.length ? `<optgroup label="${esc(p.name)}">${ds.map((d) => `<option value="${d.id}"${d.id === selected ? " selected" : ""}>${esc(d.title)}${d.subtitle ? ` · ${esc(d.subtitle)}` : ""}</option>`).join("")}</optgroup>` : "";
  }).join("");

  function screenDialog(s) {
    const isNew = !s;
    openDialog({
      title: isNew ? "Add screen" : `Screen settings: ${s.name}`,
      body: `
        ${field("s-name", "Name", `<input id="s-name" required maxlength="80" value="${esc(s?.name || "")}">`)}
        ${field("s-key", "Screen address", `<input id="s-key" required pattern="[a-z0-9][a-z0-9-]{0,47}" value="${esc(s?.key || "")}" ${isNew ? "" : "readonly"}>`, isNew ? "Lowercase letters, numbers and dashes. The Pi opens this address, so it can't change later." : `The Pi opens ${location.origin}/?screen=${esc(s.key)}`)}
        ${field("s-dir", "Shows directory", `<select id="s-dir">${dirOptions(s?.directory_id)}</select>`)}
        ${field("s-orient", "Layout", `<select id="s-orient">${["auto", "portrait", "landscape"].map((o) => `<option value="${o}"${(s?.orientation || "auto") === o ? " selected" : ""}>${{ auto: "Automatic (match the TV)", portrait: "Portrait", landscape: "Landscape" }[o]}</option>`).join("")}</select>`, "If this doesn't match how the TV is mounted, the page turns itself to fit. Changes reach the screen within a minute.")}
        ${field("s-loc", "Location note", `<input id="s-loc" maxlength="120" value="${esc(s?.location_note || "")}" placeholder="e.g. 3rd floor, north elevator lobby">`)}
        <div id="s-hw"></div>
        ${isNew ? "" : `<button type="button" id="s-delete" class="ghost danger">Remove this screen</button>`}`,
      afterOpen() {
        if (!isNew && S.admin) Dev.hardware(s.id).then((hw) => {   // 1Point only; the server refuses everyone else
          if (!hw || !Object.keys(hw).length || !$("s-hw")) return;
          $("s-hw").innerHTML = `<details class="hw"><summary>Hardware</summary><dl>${Object.entries(hw).map(([k, v]) => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd>${esc(v)}</dd>`).join("")}</dl></details>`;
        });
        $("s-name").addEventListener("input", () => { if (isNew && !$("s-key").dataset.touched) $("s-key").value = slug($("s-name").value); });
        $("s-key").addEventListener("input", () => ($("s-key").dataset.touched = "1"));
        $("s-delete")?.addEventListener("click", async () => {
          if (!confirm(`Remove ${s.name}? The Pi will show an error until it's pointed at another screen.`)) return;
          await Auth.db(`screens?id=eq.${s.id}`, { method: "DELETE" });
          closeDialog(); toast("Screen removed."); refresh();
        });
      },
      async save() {
        const body = { name: $("s-name").value.trim(), directory_id: $("s-dir").value || null, orientation: $("s-orient").value, location_note: $("s-loc").value.trim() };
        if (!body.name) throw new Error("Enter a name.");
        if (isNew) {
          body.key = $("s-key").value.trim();
          if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(body.key)) throw new Error("The screen address can use lowercase letters, numbers and dashes.");
          await Auth.db("screens", { method: "POST", body, prefer: "return=minimal" });
        } else {
          await Auth.db(`screens?id=eq.${s.id}`, { method: "PATCH", body, prefer: "return=minimal" });
        }
        toast(isNew ? `Screen added. Point its Pi at /?screen=${body.key || s.key}` : "Saved. The screen updates within a minute.");
        await refresh();
      },
    });
  }

  // ── Buildings ──
  function renderBuildings() {
    const q = $("building-search").value.trim().toLowerCase();
    const list = S.props.filter((p) => !q || [p.name, p.address, org(p.org_id)?.name, ...S.dirs.filter((d) => d.property_id === p.id).map((d) => d.title)].join(" ").toLowerCase().includes(q));
    $("building-summary").textContent = `${S.props.length} building${S.props.length === 1 ? "" : "s"}, ${S.dirs.length} directories`;
    $("building-cards").innerHTML = list.map((p) => {
      const ds = S.dirs.filter((d) => d.property_id === p.id);
      return `<article class="card">
        <header><h2>${esc(p.name)}</h2>${S.admin ? `<span class="sub">${esc(org(p.org_id)?.name || "")}</span>` : ""}${p.address ? `<div class="sub">${esc(p.address)}</div>` : ""}</header>
        <ul class="dir-list">${ds.map((d) => {
          const scr = S.screens.filter((s) => s.directory_id === d.id);
          return `<li><a href="/edit.html?d=${d.id}"><strong>${esc(d.title)}</strong>${d.subtitle ? ` · ${esc(d.subtitle)}` : ""}</a>
            <span class="sub">${S.tenantCount[d.id] || 0} tenants · ${scr.length ? scr.map((s) => `<span class="dot ${status(s)}" title="${esc(s.name)}"></span>`).join("") : "no screen"}</span></li>`;
        }).join("") || `<li class="sub">No directories yet.</li>`}</ul>
        ${S.admin ? `<footer><button type="button" class="ghost" data-add-dir="${p.id}">Add directory</button><button type="button" class="ghost" data-edit-prop="${p.id}">Building details</button>
          ${ds.some((d) => d.slug === "landmark-center") ? `<button type="button" class="ghost" data-import="landmark-center">Import live settings from old editor</button>` : ""}</footer>` : ""}
      </article>`;
    }).join("") || `<p class="empty-rows">No buildings match.</p>`;
  }
  $("building-search").addEventListener("input", renderBuildings);
  $("add-building").addEventListener("click", () => buildingDialog(null));
  $("building-cards").addEventListener("click", async (e) => {
    const add = e.target.closest("[data-add-dir]"), ed = e.target.closest("[data-edit-prop]"), imp = e.target.closest("[data-import]");
    if (add) directoryDialog(add.dataset.addDir);
    if (ed) buildingDialog(prop(ed.dataset.editProp));
    if (imp) {
      if (!confirm("Copy the Landmark Center's logo, photo, contacts and tenants from the old editor? This replaces its tenant list here.")) return;
      try { const r = await Auth.api(`/api/migrate?slug=${imp.dataset.import}`, { method: "POST" }); toast(`Imported ${r.tenants} tenants${r.logo ? ", logo" : ""}${r.background ? ", background photo" : ""}.`); await refresh(); }
      catch (ex) { toast(ex.message, true); }
    }
  });

  const orgOptions = (selected) => S.orgs.map((o) => `<option value="${o.id}"${o.id === selected ? " selected" : ""}>${esc(o.name)}</option>`).join("");

  function buildingDialog(p) {
    const isNew = !p;
    openDialog({
      title: isNew ? "Add building" : `Building: ${p.name}`,
      body: `${field("b-org", "Account", `<select id="b-org">${orgOptions(p?.org_id)}</select>`)}
        ${field("b-name", "Building name", `<input id="b-name" required maxlength="80" value="${esc(p?.name || "")}">`)}
        ${field("b-addr", "Address", `<input id="b-addr" maxlength="120" value="${esc(p?.address || "")}">`, "Also shows under the name on screens that have no subtitle.")}
        ${isNew ? "" : `<p class="hint">Logo, photo, contacts and weather location are edited in any of this building's directories.</p>`}`,
      async save() {
        const body = { org_id: $("b-org").value, name: $("b-name").value.trim(), address: $("b-addr").value.trim() };
        if (!body.name) throw new Error("Enter the building name.");
        if (isNew) await Auth.db("properties", { method: "POST", body, prefer: "return=minimal" });
        else await Auth.db(`properties?id=eq.${p.id}`, { method: "PATCH", body, prefer: "return=minimal" });
        toast(isNew ? "Building added. Now add its directories." : "Saved.");
        await refresh();
      },
    });
  }

  function directoryDialog(propertyId) {
    const p = prop(propertyId);
    openDialog({
      title: `Add directory to ${p.name}`,
      body: `${field("d-title", "Title", `<input id="d-title" required maxlength="80" placeholder="e.g. ${esc(p.name)} - Third Floor">`, "The heading on the screen.")}
        ${field("d-sub", "Subtitle", `<input id="d-sub" maxlength="80" placeholder="e.g. North Tower">`, "Optional second line.")}
        ${field("d-slug", "Directory address", `<input id="d-slug" required pattern="[a-z0-9][a-z0-9-]{0,47}">`)}
        <label class="check"><input type="checkbox" id="d-screen" checked> Also create a screen for it, with the same address</label>
        ${field("d-orient", "Screen layout", `<select id="d-orient"><option value="auto">Automatic</option><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select>`)}`,
      afterOpen() {
        $("d-title").addEventListener("input", () => { if (!$("d-slug").dataset.touched) $("d-slug").value = slug($("d-title").value); });
        $("d-slug").addEventListener("input", () => ($("d-slug").dataset.touched = "1"));
      },
      async save() {
        const title = $("d-title").value.trim(), s = $("d-slug").value.trim();
        if (!title) throw new Error("Enter a title.");
        if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(s)) throw new Error("The address can use lowercase letters, numbers and dashes.");
        const [d] = await Auth.db("directories", { method: "POST", prefer: "return=representation", body: { property_id: p.id, title, subtitle: $("d-sub").value.trim(), slug: s } });
        if ($("d-screen").checked) await Auth.db("screens", { method: "POST", prefer: "return=minimal", body: { key: s, name: title, directory_id: d.id, orientation: $("d-orient").value } });
        toast("Directory added. Add its tenants next.");
        location.href = `/edit.html?d=${d.id}`;
      },
    });
  }

  // ── People ──
  async function renderPeople() {
    if (S.me.role === "org_editor") return;
    try { S.people = (await Auth.api("/api/users")).users; }
    catch (ex) { $("people-rows").innerHTML = `<tr><td colspan="5" class="error">${esc(ex.message)}</td></tr>`; return; }
    $("people-summary").textContent = `${S.people.length} ${S.people.length === 1 ? "person" : "people"}`;
    const roles = S.admin ? ["platform_admin", "org_admin", "org_editor"] : ["org_admin", "org_editor"];
    $("people-rows").innerHTML = S.people.map((u) => `<tr>
      <td><strong>${esc(u.full_name || u.email)}</strong>${u.full_name ? `<div class="sub">${esc(u.email)}</div>` : ""}</td>
      <td>${u.is_me ? roleName(u.role) : `<select data-role="${u.user_id}" aria-label="Role for ${esc(u.email)}">${roles.map((r) => `<option value="${r}"${r === u.role ? " selected" : ""}>${roleName(r)}</option>`).join("")}</select>`}</td>
      <td class="admin-only">${esc(u.org_name || (u.role === "platform_admin" ? "1Point" : ""))}</td>
      <td>${u.last_sign_in_at ? since(u.last_sign_in_at) : `<span class="warn">Invited, not signed in yet</span>`}</td>
      <td class="actions">${u.is_me ? `<span class="sub">You</span>` : `
        <button type="button" class="ghost" data-email="${u.user_id}">${u.last_sign_in_at ? "Send password reset" : "Resend invitation"}</button>
        <button type="button" class="ghost danger" data-remove="${u.user_id}">Remove</button>`}</td></tr>`).join("");
  }
  $("people-rows").addEventListener("click", async (e) => {
    const em = e.target.closest("[data-email]"), rm = e.target.closest("[data-remove]");
    try {
      if (em) { const r = await Auth.api("/api/users", { method: "POST", body: { action: "email", user_id: em.dataset.email } }); toast(`Sent a ${r.sent} email.`); }
      if (rm) {
        const u = S.people.find((x) => x.user_id === rm.dataset.remove);
        if (!confirm(`Remove ${u.email}? They won't be able to sign in.`)) return;
        await Auth.api(`/api/users?user_id=${u.user_id}`, { method: "DELETE" }); toast("Removed."); renderPeople();
      }
    } catch (ex) { toast(ex.message, true); }
  });
  $("people-rows").addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-role]"); if (!sel) return;
    const u = S.people.find((x) => x.user_id === sel.dataset.role);
    let org_id;
    if (S.admin && sel.value !== "platform_admin" && !u.org_id) {
      const name = prompt(`Which account should ${u.email} belong to?\n${S.orgs.map((o) => o.name).join("\n")}`);
      org_id = S.orgs.find((o) => o.name.toLowerCase() === String(name || "").trim().toLowerCase())?.id;
      if (!org_id) { toast("No matching account. Role not changed.", true); sel.value = u.role; return; }
    }
    try { await Auth.api("/api/users", { method: "PATCH", body: { user_id: u.user_id, role: sel.value, org_id } }); toast(`${u.email} is now ${roleName(sel.value)}.`); renderPeople(); }
    catch (ex) { toast(ex.message, true); sel.value = u.role; }
  });

  $("invite").addEventListener("click", () => {
    const roles = S.admin ? ["org_admin", "org_editor", "platform_admin"] : ["org_editor", "org_admin"];
    openDialog({
      title: "Invite someone",
      ok: "Send invitation",
      body: `${field("i-email", "Email", `<input id="i-email" type="email" required>`)}
        ${field("i-name", "Name", `<input id="i-name" maxlength="80">`)}
        ${field("i-role", "Role", `<select id="i-role">${roles.map((r) => `<option value="${r}">${roleName(r)}</option>`).join("")}</select>`,
          "Editors change tenants and building details. Account admins can also invite and remove their own people.")}
        ${S.admin ? field("i-org", "Account", `<select id="i-org">${orgOptions()}</select>`) : ""}`,
      afterOpen() { if (S.admin) { const sync = () => ($("f-i-org").hidden = $("i-role").value === "platform_admin"); $("i-role").addEventListener("change", sync); sync(); } },
      async save() {
        const body = { action: "invite", email: $("i-email").value, full_name: $("i-name").value, role: $("i-role").value, org_id: S.admin ? $("i-org").value : S.me.org_id };
        await Auth.api("/api/users", { method: "POST", body });
        toast(`Invitation sent to ${body.email}.`);
        renderPeople();
      },
    });
  });

  // ── Accounts (1Point only) ──
  function renderAccounts() {
    if (!S.admin) return;
    $("account-summary").textContent = `${S.orgs.length} account${S.orgs.length === 1 ? "" : "s"}`;
    $("account-rows").innerHTML = S.orgs.map((o) => {
      const ps = S.props.filter((p) => p.org_id === o.id);
      const sc = S.screens.filter((s) => ps.some((p) => p.id === dir(s.directory_id)?.property_id));
      return `<tr><td><strong>${esc(o.name)}</strong></td><td>${o.kind === "manager" ? "Owner / manager" : "Owner"}</td><td>${ps.length}</td><td>${sc.length}</td>
        <td><button type="button" class="linkish" data-people="${o.id}">View people</button></td>
        <td class="actions"><button type="button" class="ghost" data-edit-org="${o.id}">Rename</button></td></tr>`;
    }).join("");
  }
  $("account-rows").addEventListener("click", (e) => {
    const ed = e.target.closest("[data-edit-org]"), pp = e.target.closest("[data-people]");
    if (ed) accountDialog(org(ed.dataset.editOrg));
    if (pp) showTab("people");
  });
  $("add-account").addEventListener("click", () => accountDialog(null));
  function accountDialog(o) {
    openDialog({
      title: o ? `Account: ${o.name}` : "Add account",
      body: `${field("a-name", "Name", `<input id="a-name" required maxlength="80" value="${esc(o?.name || "")}">`)}
        ${field("a-kind", "Type", `<select id="a-kind"><option value="owner"${o?.kind === "owner" ? " selected" : ""}>Owner</option><option value="manager"${o?.kind === "manager" ? " selected" : ""}>Owner / manager</option></select>`)}
        ${o ? "" : `<p class="hint">Next, add their buildings on the Buildings tab and invite their people.</p>`}`,
      async save() {
        const body = { name: $("a-name").value.trim(), kind: $("a-kind").value };
        if (!body.name) throw new Error("Enter a name.");
        if (o) await Auth.db(`organizations?id=eq.${o.id}`, { method: "PATCH", body, prefer: "return=minimal" });
        else await Auth.db("organizations", { method: "POST", body, prefer: "return=minimal" });
        toast("Saved."); await refresh();
      },
    });
  }

  // ── Dialog helper ──
  const field = (id, label, control, hint = "") => `<div class="field" id="f-${id}"><label for="${id}">${label}</label>${control}${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;
  let current = null;
  function openDialog(opts) {
    current = opts;
    $("dlg-title").textContent = opts.title;
    $("dlg-body").innerHTML = opts.body;
    $("dlg-ok").textContent = opts.ok || "Save";
    $("dlg-error").hidden = true;
    $("dlg").showModal();
    opts.afterOpen?.();
    $("dlg-body").querySelector("input:not([readonly]),select")?.focus();
  }
  function closeDialog() { $("dlg").close(); current = null; }
  window.ConsoleDialog = { open: openDialog, field };   // for console-setup.js
  $("dlg-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const btn = $("dlg-ok");
    btn.disabled = true;
    try { await current.save(); closeDialog(); }
    catch (ex) { $("dlg-error").textContent = ex.message; $("dlg-error").hidden = false; }
    finally { btn.disabled = false; }
  });

  // ── Boot ──
  async function refresh() {
    await load();
    await Dev.load(S.admin);
    Dev.renderNew(S.screens);
    renderScreens(); renderBuildings(); renderAccounts();
  }
  window.ConsoleRefresh = refresh;
  $("sign-out").addEventListener("click", () => Auth.signOut());

  (async () => {
    try {
      await Auth.requireSession();
      S.me = await Auth.me();
      S.admin = S.me.role === "platform_admin";
      document.body.classList.toggle("is-admin", S.admin);
      $("tab-accounts").hidden = !S.admin;
      $("tab-health").hidden = !S.admin;
      $("tab-setup").hidden = !S.admin;
      $("tab-people").hidden = S.me.role === "org_editor";
      await refresh();
      $("who").textContent = `${S.me.full_name || S.me.email} · ${S.admin ? "1Point" : org(S.me.org_id)?.name || ""} · ${roleName(S.me.role)}`;
      if (S.admin) { $("screen-owner").hidden = false; $("screen-owner").innerHTML = `<option value="">All accounts</option>` + orgOptions(); }
      const tab = location.hash.slice(1);
      showTab(["screens", "buildings", "people", "health", "setup", "accounts"].includes(tab) && !document.querySelector(`[data-tab=${tab}]`).hidden ? tab : "screens");
      setInterval(async () => {
        if (document.querySelector("dialog[open]")) return; // don't redraw under an open panel
        try { S.screens = await Auth.db(`screens?select=${SCREEN_COLS}&order=name.asc`); await Dev.load(S.admin); Dev.renderNew(S.screens); renderScreens(); } catch { /* keep last */ }
      }, 60000);
    } catch (ex) {
      if (ex.message !== "Signing in…") { $("load-error").textContent = ex.message; $("load-error").hidden = false; }
    }
  })();
})();
