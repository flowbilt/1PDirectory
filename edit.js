(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const { esc, toast, since } = window.UI;
  const params = new URLSearchParams(location.search);

  const S = { dir: null, prop: null, tenants: [], screens: [], siblings: 0, dirty: false };

  // ── Load ──
  async function load() {
    const id = params.get("d");
    if (!id) throw new Error("No directory chosen. Open one from the console.");
    const [dir] = await Auth.db(`directories?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!dir) throw new Error("That directory doesn't exist, or you don't have access to it.");
    const [[prop], tenants, screens, siblings] = await Promise.all([
      Auth.db(`properties?id=eq.${dir.property_id}&select=*`),
      Auth.db(`tenants?directory_id=eq.${dir.id}&select=*&order=sort.asc,name.asc`),
      Auth.db(`screens?directory_id=eq.${dir.id}&select=key,name,orientation,last_seen&order=name.asc`),
      Auth.db(`directories?property_id=eq.${dir.property_id}&select=id`),
    ]);
    Object.assign(S, { dir, prop, tenants: tenants.map((t) => ({ ...t })), screens, siblings: siblings.length });
  }

  // ── Form <-> state ──
  function fill() {
    const d = S.dir, p = S.prop;
    $("heading").textContent = `${p.name} · ${d.title}`;
    document.title = `Edit ${d.title}`;
    $("d-title").value = d.title;
    $("d-subtitle").value = d.subtitle || "";
    $("news-on").checked = d.news_enabled !== false;
    $("rotate").value = d.rotate_seconds || 12;
    $("weather-on").checked = d.weather_enabled !== false;
    $("address").value = p.address || "";
    $("m-name").value = p.managed_by?.name || ""; $("m-company").value = p.managed_by?.company || ""; $("m-phone").value = p.managed_by?.phone || "";
    $("l-name").value = p.leased_by?.name || ""; $("l-company").value = p.leased_by?.company || ""; $("l-phone").value = p.leased_by?.phone || "";
    $("welcome").value = d.footer_override ?? p.footer ?? "";
    $("lat").value = p.lat ?? ""; $("lon").value = p.lon ?? "";
    const tz = p.timezone || "America/Chicago";
    if (![...$("timezone").options].some((o) => o.value === tz)) $("timezone").add(new Option(tz, tz));
    $("timezone").value = tz;
    $("shared-note").textContent = S.siblings > 1 ? `shared by all ${S.siblings} directories in ${p.name}` : "";
    renderLogo(); renderBg(); renderTenants(); renderStatus();
  }

  function read() {
    const d = S.dir, p = S.prop;
    d.title = $("d-title").value.trim();
    d.subtitle = $("d-subtitle").value.trim();
    d.news_enabled = $("news-on").checked;
    d.rotate_seconds = Math.min(120, Math.max(5, parseInt($("rotate").value, 10) || 12));
    d.weather_enabled = $("weather-on").checked;
    p.address = $("address").value.trim();
    p.managed_by = { name: $("m-name").value.trim(), company: $("m-company").value.trim(), phone: $("m-phone").value.trim() };
    p.leased_by = { name: $("l-name").value.trim(), company: $("l-company").value.trim(), phone: $("l-phone").value.trim() };
    const footer = $("welcome").value.trim();
    if (d.footer_override != null) d.footer_override = footer; else p.footer = footer;
    const lat = parseFloat($("lat").value), lon = parseFloat($("lon").value);
    p.lat = Number.isFinite(lat) ? lat : null; p.lon = Number.isFinite(lon) ? lon : null;
    p.timezone = $("timezone").value;
    p.logo_replaces_name = !!p.logo && $("logo-replaces-name").checked;
    const bg = p.background || {};
    p.background = { image: bg.image || "", enabled: !!bg.image && $("bg-on").checked, visibility: parseInt($("bg-vis").value, 10) || 15, position: parseInt($("bg-pos").value, 10), size: parseInt($("bg-size").value, 10) || 190, offset: parseInt($("bg-offset").value, 10) || 0 };
    $("bg-vis-val").textContent = `${p.background.visibility}%`;
    S.tenants = [...$("tenant-rows").querySelectorAll(".tenant-row")].map((row) => ({
      id: row.dataset.id,
      name: row.querySelector(".t-name").value.trim(),
      suite: row.querySelector(".t-suite").value.trim(),
      arrow: row.querySelector(".t-dir").value,
      note: row.querySelector(".t-note")?.value.trim() || "",
    }));
  }

  function setDirty(v) { S.dirty = v; $("dirty").hidden = !v; }
  function changed() { read(); setDirty(true); pushPreview(); }
  $("editor").addEventListener("input", (e) => { if (!e.target.matches("[type=file]")) changed(); });
  $("editor").addEventListener("change", (e) => { if (e.target.matches("select, input[type=checkbox]")) changed(); });

  function renderStatus() {
    const s = S.screens;
    if (!s.length) { $("checkin").textContent = "No screen shows this directory yet"; $("open-display").hidden = true; return; }
    const fresh = s.filter((x) => x.last_seen && Date.now() - Date.parse(x.last_seen) < 15 * 60000).length;
    $("checkin").textContent = s.length === 1 ? (s[0].last_seen ? `Screen checked in ${since(s[0].last_seen)}` : "Screen hasn't checked in yet") : `${fresh} of ${s.length} screens online`;
    $("checkin").classList.toggle("stale", fresh < s.length);
    $("open-display").href = `/?screen=${encodeURIComponent(s[0].key)}`;
    $("updated").textContent = S.dir.updated_at ? `Last published ${new Date(S.dir.updated_at).toLocaleString()}` : "";
  }

  // ── Tenants ──
  const DIR_OPTS = [["", "None"], ["left", "Left"], ["right", "Right"], ["up", "Up"], ["down", "Down"]];
  function renderTenants() {
    const rows = S.tenants;
    $("tenant-count").textContent = `(${rows.filter((t) => t.name).length})`;
    $("tenant-rows").innerHTML = rows.length ? rows.map((t, i) => `<li class="tenant-row" data-i="${i}" data-id="${t.id}">
        <input class="t-name" value="${esc(t.name)}" placeholder="Company name" aria-label="Tenant ${i + 1} name" maxlength="90">
        <input class="t-suite" value="${esc(t.suite)}" placeholder="Suite" aria-label="Tenant ${i + 1} suite" maxlength="16">
        <select class="t-dir" aria-label="Tenant ${i + 1} arrow">${DIR_OPTS.map(([v, l]) => `<option value="${v}"${t.arrow === v ? " selected" : ""}>${l}</option>`).join("")}</select>
        <span class="row-actions">
          <button type="button" class="icon-btn" data-act="up" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="icon-btn" data-act="down" aria-label="Move down" ${i === rows.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" class="icon-btn" data-act="note" aria-label="Add a note under the name" title="Note under the name" ${t.note ? "hidden" : ""}>+ note</button>
          <button type="button" class="icon-btn remove" data-act="remove" aria-label="Remove ${esc(t.name || "tenant")}">Remove</button>
        </span>
        ${t.note !== "" || t._noteOpen ? `<input class="t-note" value="${esc(t.note)}" placeholder="Small line under the name, e.g. A subsidiary of…" aria-label="Tenant ${i + 1} note" maxlength="120">` : ""}
      </li>`).join("") : `<li class="empty-rows">No tenants yet. Click Add tenant to start the list.</li>`;
  }
  $("tenant-rows").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    read();
    const i = Number(btn.closest(".tenant-row").dataset.i), t = S.tenants;
    if (btn.dataset.act === "up" && i > 0) [t[i - 1], t[i]] = [t[i], t[i - 1]];
    if (btn.dataset.act === "down" && i < t.length - 1) [t[i + 1], t[i]] = [t[i], t[i + 1]];
    if (btn.dataset.act === "remove") t.splice(i, 1);
    if (btn.dataset.act === "note") t[i]._noteOpen = true;
    renderTenants();
    if (btn.dataset.act === "note") $("tenant-rows").querySelectorAll(".tenant-row")[i].querySelector(".t-note")?.focus();
    setDirty(true); pushPreview();
  });
  $("add-tenant").addEventListener("click", () => {
    read();
    S.tenants.push({ id: crypto.randomUUID(), name: "", suite: "", arrow: "", note: "" });
    renderTenants();
    const names = $("tenant-rows").querySelectorAll(".t-name");
    names[names.length - 1]?.focus();
    setDirty(true);
  });
  $("sort-az").addEventListener("click", () => {
    read();
    const key = (n) => n.toLowerCase().replace(/^the\s+/, "");
    S.tenants.sort((a, b) => key(a.name).localeCompare(key(b.name), "en", { numeric: true }));
    renderTenants(); setDirty(true); pushPreview();
  });

  // ── Logo ──
  function renderLogo() {
    const p = S.prop;
    $("logo-preview").innerHTML = p.logo ? `<img src="${esc(p.logo)}" alt="Current logo">` : "<span>No logo</span>";
    $("logo-remove").hidden = !p.logo;
    $("logo-name-row").hidden = !p.logo;
    $("logo-replaces-name").checked = !!p.logo_replaces_name;
  }
  const readAsDataURL = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("Could not read that file.")); r.readAsDataURL(file); });
  const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file isn't an image this browser can open.")); i.src = src; });
  async function shrinkLogo(file) {
    if (file.type === "image/svg+xml") {
      if (file.size > 600_000) throw new Error("That SVG is over 600 KB. Use a smaller file.");
      return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(await file.text())))}`;
    }
    const img = await loadImage(await readAsDataURL(file));
    const scale = Math.min(1, 900 / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const out = c.toDataURL("image/png");
    if (out.length > 880_000) throw new Error("That logo is still too large after resizing. Try a simpler image.");
    return out;
  }
  $("logo-file").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    try { read(); S.prop.logo = await shrinkLogo(file); renderLogo(); setDirty(true); pushPreview(); } catch (ex) { toast(ex.message, true); }
  });
  $("logo-remove").addEventListener("click", () => { read(); S.prop.logo = ""; S.prop.logo_replaces_name = false; renderLogo(); setDirty(true); pushPreview(); });

  // ── Background photo ──
  function renderBg() {
    const bg = S.prop.background || {}, has = !!bg.image;
    $("bg-preview").style.backgroundImage = has ? `url("${bg.image}")` : "";
    $("bg-preview").style.backgroundPosition = `${bg.position ?? 50}% top`;
    $("bg-preview").innerHTML = has ? "" : "<span>No photo</span>";
    for (const id of ["bg-remove", "bg-on-row", "bg-vis-row", "bg-size-row", "bg-offset-row", "bg-pos-row"]) $(id).hidden = !has;
    $("bg-on").checked = !!bg.enabled;
    $("bg-vis").value = bg.visibility ?? 15; $("bg-size").value = bg.size ?? 190; $("bg-offset").value = bg.offset ?? 0; $("bg-pos").value = bg.position ?? 50;
    $("bg-vis-val").textContent = `${bg.visibility ?? 15}%`;
  }
  async function shrinkPhoto(file) {
    const img = await loadImage(await readAsDataURL(file));
    const scale = Math.min(1, 1080 / Math.min(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.82, 0.7, 0.55]) { const out = c.toDataURL("image/jpeg", q); if (out.length <= 1_350_000) return out; }
    throw new Error("That photo is too large even after compressing. Try a smaller one.");
  }
  $("bg-file").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    try {
      read();
      S.prop.background = { ...(S.prop.background || {}), image: await shrinkPhoto(file), enabled: true, visibility: S.prop.background?.visibility || 15, position: 50, size: 190, offset: 0 };
      renderBg(); setDirty(true); pushPreview();
    } catch (ex) { toast(ex.message, true); }
  });
  $("bg-remove").addEventListener("click", () => { read(); S.prop.background = { ...S.prop.background, image: "", enabled: false }; renderBg(); setDirty(true); pushPreview(); });
  for (const id of ["bg-vis", "bg-pos", "bg-size", "bg-offset"]) $(id).addEventListener("input", () => { read(); renderBg(); pushPreview(); });

  // ── Preview (same shape /api/screen sends to real screens) ──
  function payload() {
    const d = S.dir, p = S.prop, scr = S.screens[0];
    return {
      key: scr?.key || d.slug, orientation: scr?.orientation || "auto",
      propertyName: d.title, buildingLabel: d.subtitle || p.address || "",
      logo: p.logo || "", logoReplacesName: !!(p.logo && p.logo_replaces_name),
      tenants: S.tenants.filter((t) => t.name).map((t) => ({ name: t.name, suite: t.suite, dir: t.arrow, note: t.note })),
      managedBy: p.managed_by || {}, leasedBy: p.leased_by || {},
      welcome: d.footer_override ?? p.footer ?? "",
      weather: { enabled: d.weather_enabled !== false && p.lat != null, lat: p.lat, lon: p.lon },
      timezone: p.timezone || "America/Chicago",
      news: { enabled: d.news_enabled !== false, rotateSeconds: d.rotate_seconds || 12 },
      background: p.background || {}, assigned: true, updatedAt: d.updated_at,
    };
  }
  function previewShape() {
    const o = S.screens[0]?.orientation || "auto";
    return o === "landscape" ? "landscape" : "portrait";
  }
  function scalePreview() {
    const box = $("preview-box"), land = previewShape() === "landscape";
    box.classList.toggle("landscape", land);
    document.querySelector(".workspace").classList.toggle("wide-preview", land);
    const f = $("preview-frame");
    f.style.width = land ? "1920px" : "1080px"; f.style.height = land ? "1080px" : "1920px";
    f.style.transform = `scale(${box.clientWidth / (land ? 1920 : 1080)})`;
  }
  function loadPreview() {
    const f = $("preview-frame");
    f.onload = () => pushPreview();
    f.src = `/?screen=${encodeURIComponent(S.screens[0]?.key || S.dir.slug)}&preview=1`;
    scalePreview();
  }
  function pushPreview() {
    const w = $("preview-frame").contentWindow;
    if (w) w.postMessage({ type: "draft", data: payload() }, location.origin);
  }
  window.addEventListener("resize", scalePreview);

  // ── Save ──
  $("editor").addEventListener("submit", async (e) => {
    e.preventDefault();
    read();
    const d = S.dir, p = S.prop;
    if (!d.title) { toast("Give the directory a title.", true); $("d-title").focus(); return; }
    const missing = S.tenants.find((t) => t.name && !t.suite);
    if (missing && !confirm(`${missing.name} has no suite number. Publish anyway?`)) return;
    const btn = $("save");
    btn.disabled = true; btn.textContent = "Publishing…";
    try {
      await Auth.db(`directories?id=eq.${d.id}`, { method: "PATCH", prefer: "return=minimal", body: {
        title: d.title, subtitle: d.subtitle, news_enabled: d.news_enabled, rotate_seconds: d.rotate_seconds, weather_enabled: d.weather_enabled,
        ...(d.footer_override != null ? { footer_override: d.footer_override } : {}),
      } });
      await Auth.db(`properties?id=eq.${p.id}`, { method: "PATCH", prefer: "return=minimal", body: {
        address: p.address, logo: p.logo || "", logo_replaces_name: !!p.logo_replaces_name, background: p.background || {},
        managed_by: p.managed_by, leased_by: p.leased_by, footer: p.footer || "", lat: p.lat, lon: p.lon, timezone: p.timezone,
      } });
      // Tenants: save every row first, then remove the ones deleted here. A failure part-way never loses rows.
      const rows = S.tenants.filter((t) => t.name).map((t, i) => ({ id: t.id, directory_id: d.id, sort: i * 10, name: t.name, suite: t.suite, arrow: t.arrow, note: t.note }));
      if (rows.length) await Auth.db("tenants", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: rows });
      const keep = rows.map((r) => r.id);
      await Auth.db(`tenants?directory_id=eq.${d.id}${keep.length ? `&id=not.in.(${keep.join(",")})` : ""}`, { method: "DELETE", prefer: "return=minimal" });
      await load(); fill(); setDirty(false); pushPreview();
      toast(S.screens.length ? "Published. Screens update within a minute." : "Saved. No screen shows this directory yet.");
    } catch (ex) {
      toast(ex.message, true);
    } finally {
      btn.disabled = false; btn.textContent = "Publish to screens";
    }
  });
  window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });

  // ── Boot ──
  (async () => {
    try {
      await Auth.requireSession();
      await Auth.me();
      await load();
      fill();
      loadPreview();
    } catch (ex) {
      if (ex.message === "Signing in…") return;
      $("load-error").textContent = ex.message; $("load-error").hidden = false;
      document.querySelector(".workspace").hidden = true;
    }
  })();
})();
