(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const PW_KEY = "dir-admin-pw";
  let pw = sessionStorage.getItem(PW_KEY) || "";
  let sites = [];
  let site = new URLSearchParams(location.search).get("site") || "";
  let draft = null;
  let dirty = false;

  // ── API ──
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      cache: "no-store",
      headers: { "Content-Type": "application/json", "x-admin-password": pw, ...(opts.headers || {}) },
    });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw Object.assign(new Error(body?.error || `Request failed (${res.status}).`), { status: res.status });
    return body;
  }

  function toast(msg, bad = false) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("bad", bad);
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3200);
  }

  const since = (iso) => {
    if (!iso) return "never";
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} hr ago`;
    return new Date(iso).toLocaleDateString();
  };

  // ── Login ──
  async function signIn() {
    const data = await api("/api/sites");
    sites = data.sites;
    sessionStorage.setItem(PW_KEY, pw);
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    fillSiteSelect();
    await openSite(site && sites.some((s) => s.site === site) ? site : sites[0]?.site);
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    pw = $("pw").value;
    $("login-error").hidden = true;
    try { await signIn(); }
    catch (err) { $("login-error").textContent = err.message; $("login-error").hidden = false; }
  });

  $("sign-out").addEventListener("click", () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    sessionStorage.removeItem(PW_KEY);
    location.href = "/admin.html";
  });

  // ── Site selection ──
  function fillSiteSelect() {
    $("site-select").innerHTML = sites.map((s) => `<option value="${s.site}">${escapeHtml(s.propertyName)} (${s.site})</option>`).join("");
    if (site) $("site-select").value = site;
  }

  function showCheckin() {
    const s = sites.find((x) => x.site === site);
    const el = $("checkin");
    if (!s?.lastSeen) { el.textContent = "No screen has checked in yet"; el.classList.add("stale"); return; }
    const mins = (Date.now() - Date.parse(s.lastSeen)) / 60000;
    el.textContent = `Screen checked in ${since(s.lastSeen)}`;
    el.classList.toggle("stale", mins > 15);
  }

  async function refreshSites() {
    try { sites = (await api("/api/sites")).sites; showCheckin(); } catch { /* keep old list */ }
  }

  async function openSite(key) {
    if (!key) return;
    const d = await api(`/api/directory?site=${encodeURIComponent(key)}`);
    site = key;
    history.replaceState(null, "", `?site=${encodeURIComponent(key)}`);
    $("site-select").value = key;
    const { site: _drop, ...rest } = d;
    draft = rest;
    fillForm();
    setDirty(false);
    $("updated").textContent = draft.updatedAt ? `Last published ${new Date(draft.updatedAt).toLocaleString()}` : "Not published yet (showing starting data)";
    $("open-display").href = `/?site=${encodeURIComponent(key)}`;
    showCheckin();
    loadPreview();
  }

  $("site-select").addEventListener("change", (e) => {
    if (dirty && !confirm("Discard unsaved changes?")) { e.target.value = site; return; }
    openSite(e.target.value).catch((err) => toast(err.message, true));
  });

  // ── Form <-> draft ──
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function fillForm() {
    $("propertyName").value = draft.propertyName || "";
    $("buildingLabel").value = draft.buildingLabel || "";
    $("m-name").value = draft.managedBy?.name || "";
    $("m-company").value = draft.managedBy?.company || "";
    $("m-phone").value = draft.managedBy?.phone || "";
    $("l-name").value = draft.leasedBy?.name || "";
    $("l-company").value = draft.leasedBy?.company || "";
    $("l-phone").value = draft.leasedBy?.phone || "";
    $("welcome").value = draft.welcome || "";
    $("weather-on").checked = draft.weather?.enabled !== false;
    $("lat").value = draft.weather?.lat ?? "";
    $("lon").value = draft.weather?.lon ?? "";
    $("news-on").checked = draft.news?.enabled !== false;
    $("rotate").value = draft.news?.rotateSeconds ?? 12;
    const tz = draft.timezone || "America/Chicago";
    if (![...$("timezone").options].some((o) => o.value === tz)) $("timezone").add(new Option(tz, tz));
    $("timezone").value = tz;
    renderLogo();
    renderBg();
    renderTenants();
  }

  function readForm() {
    draft.propertyName = $("propertyName").value.trim();
    draft.buildingLabel = $("buildingLabel").value.trim();
    draft.logoReplacesName = !!draft.logo && $("logo-replaces-name").checked;
    draft.managedBy = { name: $("m-name").value.trim(), company: $("m-company").value.trim(), phone: $("m-phone").value.trim() };
    draft.leasedBy = { name: $("l-name").value.trim(), company: $("l-company").value.trim(), phone: $("l-phone").value.trim() };
    draft.welcome = $("welcome").value.trim();
    draft.weather = { enabled: $("weather-on").checked, lat: parseFloat($("lat").value), lon: parseFloat($("lon").value) };
    draft.news = { enabled: $("news-on").checked, rotateSeconds: parseInt($("rotate").value, 10) || 12 };
    draft.timezone = $("timezone").value;
    const bg = draft.background || {};
    draft.background = {
      image: bg.image || "",
      enabled: !!bg.image && $("bg-on").checked,
      visibility: parseInt($("bg-vis").value, 10) || 15,
      position: parseInt($("bg-pos").value, 10),
      size: parseInt($("bg-size").value, 10) || 190,
    };
    $("bg-vis-val").textContent = `${draft.background.visibility}%`;
    draft.tenants = [...$("tenant-rows").querySelectorAll(".tenant-row")].map((row) => ({
      name: row.querySelector(".t-name").value.trim(),
      suite: row.querySelector(".t-suite").value.trim(),
      dir: row.querySelector(".t-dir").value,
    }));
  }

  function setDirty(v) {
    dirty = v;
    $("dirty").hidden = !v;
  }

  function changed() {
    readForm();
    setDirty(true);
    pushPreview();
  }

  $("editor").addEventListener("input", (e) => { if (e.target.id !== "logo-file") changed(); });
  $("editor").addEventListener("change", (e) => { if (e.target.matches("select, input[type=checkbox]")) changed(); });

  // ── Tenants ──
  const DIR_OPTS = [["", "None"], ["left", "Left"], ["right", "Right"], ["up", "Up"], ["down", "Down"]];

  function renderTenants() {
    const rows = draft.tenants || [];
    $("tenant-count").textContent = `(${rows.filter((t) => t.name).length})`;
    $("tenant-rows").innerHTML = rows.length
      ? rows
          .map(
            (t, i) => `<li class="tenant-row" data-i="${i}">
        <input class="t-name" value="${escapeHtml(t.name)}" placeholder="Company name" aria-label="Tenant ${i + 1} name" maxlength="90">
        <input class="t-suite" value="${escapeHtml(t.suite)}" placeholder="Suite" aria-label="Tenant ${i + 1} suite" maxlength="16">
        <select class="t-dir" aria-label="Tenant ${i + 1} arrow">${DIR_OPTS.map(([v, l]) => `<option value="${v}"${t.dir === v ? " selected" : ""}>${l}</option>`).join("")}</select>
        <span class="row-actions">
          <button type="button" class="icon-btn" data-act="up" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="icon-btn" data-act="down" aria-label="Move down" ${i === rows.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" class="icon-btn remove" data-act="remove" aria-label="Remove ${escapeHtml(t.name || "tenant")}">Remove</button>
        </span>
      </li>`
          )
          .join("")
      : `<li class="empty-rows">No tenants yet. Click Add tenant to start the list.</li>`;
  }

  $("tenant-rows").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    readForm();
    const i = Number(btn.closest(".tenant-row").dataset.i);
    const t = draft.tenants;
    if (btn.dataset.act === "up" && i > 0) [t[i - 1], t[i]] = [t[i], t[i - 1]];
    if (btn.dataset.act === "down" && i < t.length - 1) [t[i + 1], t[i]] = [t[i], t[i + 1]];
    if (btn.dataset.act === "remove") t.splice(i, 1);
    renderTenants();
    setDirty(true);
    pushPreview();
  });

  $("add-tenant").addEventListener("click", () => {
    readForm();
    draft.tenants.push({ name: "", suite: "", dir: "" });
    renderTenants();
    const rows = $("tenant-rows").querySelectorAll(".t-name");
    rows[rows.length - 1]?.focus();
    setDirty(true);
  });

  $("sort-az").addEventListener("click", () => {
    readForm();
    const key = (n) => n.toLowerCase().replace(/^the\s+/, "");
    draft.tenants.sort((a, b) => key(a.name).localeCompare(key(b.name), "en", { numeric: true }));
    renderTenants();
    setDirty(true);
    pushPreview();
  });

  // ── Logo ──
  function renderLogo() {
    $("logo-preview").innerHTML = draft.logo ? `<img src="${draft.logo}" alt="Current logo">` : "<span>No logo</span>";
    $("logo-remove").hidden = !draft.logo;
    $("logo-name-row").hidden = !draft.logo;
    $("logo-replaces-name").checked = !!draft.logoReplacesName;
  }

  $("logo-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      draft.logo = await shrinkImage(file);
      renderLogo();
      setDirty(true);
      pushPreview();
    } catch (err) { toast(err.message, true); }
  });

  $("logo-remove").addEventListener("click", () => { draft.logo = ""; renderLogo(); setDirty(true); pushPreview(); });

  function readAsDataURL(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("Could not read that file.")); r.readAsDataURL(file); });
  }

  // Scale raster logos to at most 900px wide so saves stay small. SVGs pass through.
  async function shrinkImage(file) {
    if (file.type === "image/svg+xml") {
      if (file.size > 600_000) throw new Error("That SVG is over 600 KB. Use a smaller file.");
      const text = await file.text();
      return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
    }
    const src = await readAsDataURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file isn't an image this browser can open.")); i.src = src; });
    const scale = Math.min(1, 900 / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const out = c.toDataURL("image/png");
    if (out.length > 880_000) throw new Error("That logo is still too large after resizing. Try a simpler image.");
    return out;
  }

  // ── Background photo ──
  function renderBg() {
    const bg = draft.background || {};
    const has = !!bg.image;
    $("bg-preview").style.backgroundImage = has ? `url("${bg.image}")` : "";
    $("bg-preview").style.backgroundPosition = `${bg.position ?? 50}% top`;
    $("bg-preview").innerHTML = has ? "" : "<span>No photo</span>";
    for (const id of ["bg-remove", "bg-on-row", "bg-vis-row", "bg-size-row", "bg-pos-row"]) $(id).hidden = !has;
    $("bg-size").value = bg.size ?? 190;
    $("bg-on").checked = !!bg.enabled;
    $("bg-vis").value = bg.visibility ?? 15;
    $("bg-pos").value = bg.position ?? 50;
    $("bg-vis-val").textContent = `${bg.visibility ?? 15}%`;
  }

  // Photos are scaled so the short side is at most 1080px and saved as JPEG, which keeps them near 150-400 KB.
  async function shrinkPhoto(file) {
    const src = await readAsDataURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file isn't a photo this browser can open.")); i.src = src; });
    const scale = Math.min(1, 1080 / Math.min(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.82, 0.7, 0.55]) {
      const out = c.toDataURL("image/jpeg", q);
      if (out.length <= 1_350_000) return out;
    }
    throw new Error("That photo is too large even after compressing. Try a smaller one.");
  }

  $("bg-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      readForm();
      draft.background = { ...(draft.background || {}), image: await shrinkPhoto(file), enabled: true, visibility: draft.background?.visibility || 15, position: 50, size: 190 };
      renderBg();
      setDirty(true);
      pushPreview();
    } catch (err) { toast(err.message, true); }
  });

  $("bg-remove").addEventListener("click", () => {
    readForm();
    draft.background = { ...draft.background, image: "", enabled: false };
    renderBg(); setDirty(true); pushPreview();
  });

  // Sliders move the preview live
  for (const id of ["bg-vis", "bg-pos", "bg-size"]) $(id).addEventListener("input", () => { readForm(); renderBg(); pushPreview(); });

  // ── Preview ──
  function scalePreview() {
    const box = $("preview-box");
    $("preview-frame").style.transform = `scale(${box.clientWidth / 1080})`;
  }
  function loadPreview() {
    const f = $("preview-frame");
    f.onload = () => pushPreview();
    f.src = `/?site=${encodeURIComponent(site)}&preview=1`;
    scalePreview();
  }
  function pushPreview() {
    const w = $("preview-frame").contentWindow;
    if (w && draft) w.postMessage({ type: "draft", data: { ...draft } }, location.origin);
  }
  window.addEventListener("resize", scalePreview);

  // ── Save ──
  $("editor").addEventListener("submit", async (e) => {
    e.preventDefault();
    readForm();
    if (!draft.propertyName) { toast("Property name is required.", true); $("propertyName").focus(); return; }
    const missingSuite = draft.tenants.find((t) => t.name && !t.suite);
    if (missingSuite && !confirm(`${missingSuite.name} has no suite number. Publish anyway?`)) return;
    const btn = $("save");
    btn.disabled = true;
    btn.textContent = "Publishing…";
    try {
      const saved = await api(`/api/directory?site=${encodeURIComponent(site)}`, { method: "PUT", body: JSON.stringify({ ...draft, tenants: draft.tenants.filter((t) => t.name) }) });
      const { site: _drop, ...rest } = saved;
      draft = rest;
      fillForm();
      setDirty(false);
      $("updated").textContent = `Last published ${new Date(draft.updatedAt).toLocaleString()}`;
      toast("Published. Screens update within a minute.");
      pushPreview();
      refreshSites();
    } catch (err) {
      if (err.status === 401) { toast("Your password was changed. Sign in again.", true); setTimeout(() => $("sign-out").click(), 1500); }
      else toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Publish to screens";
    }
  });

  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  // ── New building ──
  const slug = (s) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  $("new-site").addEventListener("click", () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    $("ns-name").value = ""; $("ns-key").value = ""; $("ns-url").textContent = ""; $("ns-error").hidden = true;
    $("new-site-dialog").showModal();
  });
  $("ns-name").addEventListener("input", () => { $("ns-key").value = slug($("ns-name").value); $("ns-key").dispatchEvent(new Event("input")); });
  $("ns-key").addEventListener("input", () => { $("ns-url").textContent = $("ns-key").value ? `Screen address: ${location.origin}/?site=${$("ns-key").value}` : ""; });
  $("new-site-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const name = $("ns-name").value.trim(), key = $("ns-key").value.trim();
    const err = (m) => { $("ns-error").textContent = m; $("ns-error").hidden = false; };
    if (!name) return err("Enter the property name.");
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(key)) return err("The key can use lowercase letters, numbers and dashes.");
    if (sites.some((s) => s.site === key)) return err("A building with that key already exists.");
    try {
      await api(`/api/directory?site=${key}`, { method: "PUT", body: JSON.stringify({ propertyName: name, tenants: [], timezone: "America/Chicago" }) });
      $("new-site-dialog").close();
      await refreshSites();
      fillSiteSelect();
      await openSite(key);
      toast(`${name} created. Add tenants, then publish.`);
    } catch (ex) { err(ex.message); }
  });

  // ── Boot ──
  if (pw) signIn().catch(() => { sessionStorage.removeItem(PW_KEY); pw = ""; });
  setInterval(() => { if (!$("app-view").hidden) refreshSites(); }, 60000);
})();
