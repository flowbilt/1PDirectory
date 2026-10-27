(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const { esc, toast, since } = window.UI;
  const params = new URLSearchParams(location.search);

  const S = { dir: null, prop: null, tenants: [], screens: [], siblings: 0, dirty: false, sel: 0,
    boxes: new Map(), open: new Set(), peopleOff: false };   // people under tenants (26-people.sql)
  // Per-screen sizes, % of standard (supabase/18-sizes.sql, 22-widget-sizes.sql); 100 = standard and isn't stored
  const SIZES = ["title", "logo", "brand", "welcome", "clock", "weather", "news", "contacts", "qr"];
  const sizeOf = (scr, k) => Number(scr?.sizes?.[k]) || 100;

  // ── Load ──
  async function load() {
    const id = params.get("d");
    if (!id) throw new Error("No directory chosen. Open one from the console.");
    const [dir] = await Auth.db(`directories?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!dir) throw new Error("That directory doesn't exist, or you don't have access to it.");
    const [[prop], tenants, screens, siblings] = await Promise.all([
      Auth.db(`properties?id=eq.${dir.property_id}&select=*`),
      Auth.db(`tenants?directory_id=eq.${dir.id}&select=*&order=sort.asc,name.asc`),
      Auth.db(`screens?directory_id=eq.${dir.id}&select=id,key,name,orientation,last_seen,sizes,hide_powered_by,touch,screen_inches,touch_idle_s&order=name.asc`),
      Auth.db(`directories?property_id=eq.${dir.property_id}&select=id`),
    ]);
    const keepKey = S.screens[S.sel]?.key;
    for (const s of screens) s.saved = JSON.stringify(s.sizes || {});
    Object.assign(S, { dir, prop, tenants: tenants.map((t) => ({ ...t })), screens, siblings: siblings.length });
    await loadPeople();
    // The screen opened from the console (?s=), else the one shown before publishing, else the first
    const want = keepKey ? screens.findIndex((s) => s.key === keepKey) : screens.findIndex((s) => s.id === params.get("s"));
    S.sel = Math.max(0, want);
  }

  // ── People under tenants (DP-09 round 14; supabase/26-people.sql) ──
  // People belong to the building's company, not to this directory's row: every screen in the building that lists the
  // company shares one list. The database makes and links the companies from the tenant names. Each list is a "box":
  // keyed by its company, or by the tenant row for a tenant not yet published.
  const PERSON_FIELDS = [["first_name", "First name", 60], ["last_name", "Last name", 60], ["title", "Title", 80],
    ["phone", "Phone or ext.", 40], ["email", "Email", 120], ["suite", "Suite, if different", 16]];
  const blankPerson = () => ({ id: crypto.randomUUID(), first_name: "", last_name: "", title: "", phone: "", email: "", suite: "", show: true });
  const named = (x) => (x.first_name || "").trim() || (x.last_name || "").trim();
  async function loadPeople() {
    S.boxes = new Map();
    try {
      const cos = await Auth.db(`companies?property_id=eq.${S.prop.id}&select=id,name,show_people,show_title,show_phone,show_email`);
      const ids = cos.map((c) => c.id);
      const people = ids.length ? await Auth.db(`people?company_id=in.(${ids.join(",")})&select=*&order=sort.asc,last_name.asc,first_name.asc`) : [];
      for (const c of cos) S.boxes.set(c.id, { key: c.id, company_id: c.id, show_people: !!c.show_people, show_title: c.show_title !== false,
        show_phone: !!c.show_phone, show_email: !!c.show_email, people: people.filter((x) => x.company_id === c.id).map((x) => ({ ...x })), dirty: false });
      S.peopleOff = false;
    } catch { S.peopleOff = true; }            // 26-people.sql not run yet: the rest of the editor works as before
    for (const t of S.tenants) {
      t.box = t.company_id && S.boxes.has(t.company_id) ? t.company_id : `new:${t.id}`;
      if (S.open.delete(`new:${t.id}`)) S.open.add(t.box);   // a list opened before publishing stays open after it
    }
  }
  function boxFor(t) {
    if (!t.box) t.box = `new:${t.id}`;
    if (!S.boxes.has(t.box)) S.boxes.set(t.box, { key: t.box, company_id: null, show_people: false, show_title: true, show_phone: false, show_email: false, people: [], dirty: false });
    return S.boxes.get(t.box);
  }
  function renderBox(t, i) {
    const b = boxFor(t), first = S.tenants.findIndex((x) => x.box === t.box) === i;
    if (!first) return `<div class="people-box same" data-box="${esc(b.key)}"><span class="hint">People: the same company as above, so the same list.</span></div>`;
    return `<div class="people-box" data-box="${esc(b.key)}">
      <div class="people-head${b.show_people ? "" : " off"}">
        <label class="check"><input type="checkbox" class="p-on"${b.show_people ? " checked" : ""}> Show ${esc(t.name || "this company")}'s people on touch screens</label>
        <span class="people-details"><span class="hint">Details shown:</span>
          <label class="check inline"><input type="checkbox" class="ps-title"${b.show_title ? " checked" : ""}> Title</label>
          <label class="check inline"><input type="checkbox" class="ps-phone"${b.show_phone ? " checked" : ""}> Phone or ext.</label>
          <label class="check inline"><input type="checkbox" class="ps-email"${b.show_email ? " checked" : ""}> Email</label></span>
      </div>
      <p class="hint">${b.show_people ? "Visitors tap the company on a touch screen to see the people ticked Show, with the details ticked above." : "<strong class=\"people-off\">Switched off:</strong> no one in this list shows on any screen, whatever their own Show tick. Tick the box above to show the people ticked Show. They're kept for the building either way."}
        Shared by every screen in this building that lists the company. Display-only screens and the Directory to Go page never show people.</p>
      <ol class="people-rows">${b.people.map((x, pi) => `<li class="person" data-pi="${pi}">
        ${PERSON_FIELDS.map(([f, label, n]) => `<input class="p-${f}" value="${esc(x[f])}" placeholder="${label}" aria-label="${label}" maxlength="${n}"${f === "email" ? ' type="email" inputmode="email"' : f === "phone" ? ' inputmode="tel"' : ""}>`).join("")}
        <span class="person-actions">
          <label class="check inline${b.show_people ? "" : " waiting"}"><input type="checkbox" class="p-show"${x.show !== false ? " checked" : ""}> ${b.show_people ? "Show" : "Show (once the company is switched on)"}</label>
          <button type="button" class="icon-btn" data-pact="up" aria-label="Move up" ${pi === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="icon-btn" data-pact="down" aria-label="Move down" ${pi === b.people.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" class="icon-btn remove" data-pact="remove" aria-label="Remove ${esc([x.first_name, x.last_name].join(" ").trim() || "person")}">Remove</button>
        </span></li>`).join("") || `<li class="empty-rows">No people yet.</li>`}</ol>
      <div class="people-foot"><button type="button" class="ghost" data-pact="add">Add a person</button>
        ${b.people.length > 1 ? `<button type="button" class="ghost" data-pact="sort">Sort A to Z by last name</button>` : ""}
        <span class="hint">${b.people.filter(named).length} ${b.people.filter(named).length === 1 ? "person" : "people"}</span></div>
    </div>`;
  }
  /** What's typed in the open lists, back into the boxes. */
  function readBoxes() {
    for (const el of $("tenant-rows").querySelectorAll(".people-box:not(.same)")) {
      const b = S.boxes.get(el.dataset.box); if (!b) continue;
      const was = JSON.stringify([b.show_people, b.show_title, b.show_phone, b.show_email, b.people]);
      b.show_people = el.querySelector(".p-on").checked; b.show_title = el.querySelector(".ps-title").checked;
      b.show_phone = el.querySelector(".ps-phone").checked; b.show_email = el.querySelector(".ps-email").checked;
      b.people = [...el.querySelectorAll(".person")].map((row) => ({ ...b.people[Number(row.dataset.pi)],
        ...Object.fromEntries(PERSON_FIELDS.map(([f]) => [f, row.querySelector(`.p-${f}`).value.trim()])), show: row.querySelector(".p-show").checked }));
      if (JSON.stringify([b.show_people, b.show_title, b.show_phone, b.show_email, b.people]) !== was) b.dirty = true;
    }
  }
  function peopleLabel(t) {
    const b = S.boxes.get(t.box), n = b ? b.people.filter(named).length : 0;
    return `People${n ? ` ${n}` : ""}${n ? (b.show_people ? " · shown" : " · hidden") : ""}`;
  }
  /** After the tenants are saved: each changed list goes to the company its tenant now belongs to. */
  async function savePeople(dirId) {
    const dirty = [...S.boxes.values()].filter((b) => b.dirty);
    if (S.peopleOff || !dirty.length) return;
    const saved = await Auth.db(`tenants?directory_id=eq.${dirId}&select=id,company_id`);
    for (const b of dirty) {
      const t = S.tenants.find((x) => x.box === b.key && x.name);
      const target = t && saved.find((x) => x.id === t.id)?.company_id;
      if (!target) continue;                                     // its tenant was removed or left blank: nothing to save
      await Auth.db(`companies?id=eq.${target}`, { method: "PATCH", prefer: "return=minimal",
        body: { show_people: b.show_people, show_title: b.show_title, show_phone: b.show_phone, show_email: b.show_email } });
      // A list typed for another company (a rename to a name that already exists) is copied, never moved
      const same = target === b.company_id;
      const rows = b.people.filter(named).map((x, i) => ({ id: same ? x.id : crypto.randomUUID(), company_id: target, sort: i * 10,
        ...Object.fromEntries(PERSON_FIELDS.map(([f]) => [f, x[f] || ""])), show: x.show !== false }));
      if (rows.length) await Auth.db("people", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: rows });
      if (same) {
        const keep = rows.map((r) => r.id);
        await Auth.db(`people?company_id=eq.${target}${keep.length ? `&id=not.in.(${keep.join(",")})` : ""}`, { method: "DELETE", prefer: "return=minimal" });
      }
    }
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
    $("map-on").checked = !!d.map_enabled; $("times-on").checked = !!d.times_enabled; $("amen-on").checked = !!d.amenities_enabled;
    renderDestinations(); renderLists();
    $("togo-on").checked = !!d.togo_enabled; $("togo-line").value = d.togo_line || ""; renderTogo();
    $("kbd-on").checked = !!d.touch_keyboard;
    $("address").value = p.address || "";
    $("m-name").value = p.managed_by?.name || ""; $("m-company").value = p.managed_by?.company || ""; $("m-phone").value = p.managed_by?.phone || "";
    $("l-name").value = p.leased_by?.name || ""; $("l-company").value = p.leased_by?.company || ""; $("l-phone").value = p.leased_by?.phone || "";
    $("welcome").value = d.footer_override ?? p.footer ?? "";
    $("lat").value = p.lat ?? ""; $("lon").value = p.lon ?? "";
    const tz = p.timezone || "America/Chicago";
    if (![...$("timezone").options].some((o) => o.value === tz)) $("timezone").add(new Option(tz, tz));
    $("timezone").value = tz;
    $("shared-note").textContent = S.siblings > 1 ? `shared by all ${S.siblings} directories in ${p.name}` : "";
    renderLogo(); renderBg(); renderTenants(); renderStatus(); renderSizes();
  }

  function read() {
    const d = S.dir, p = S.prop;
    d.title = $("d-title").value.trim();
    d.subtitle = $("d-subtitle").value.trim();
    d.news_enabled = $("news-on").checked;
    d.rotate_seconds = Math.min(120, Math.max(5, parseInt($("rotate").value, 10) || 12));
    d.weather_enabled = $("weather-on").checked;
    d.map_enabled = $("map-on").checked; d.times_enabled = $("times-on").checked; d.amenities_enabled = $("amen-on").checked;
    p.destinations = [...$("dest-rows").querySelectorAll(".info-row-edit")].map((r) => ({ label: r.querySelector(".x-label").value.trim(), address: r.querySelector(".x-address").value.trim() }))
      .filter((x) => x.label || x.address).map((x) => ({ label: x.label || x.address, address: x.address || x.label }));
    readLists();
    d.togo_enabled = $("togo-on").checked; d.togo_line = $("togo-line").value.trim();
    d.touch_keyboard = $("kbd-on").checked;
    p.address = $("address").value.trim();
    p.managed_by = { name: $("m-name").value.trim(), company: $("m-company").value.trim(), phone: $("m-phone").value.trim() };
    p.leased_by = { name: $("l-name").value.trim(), company: $("l-company").value.trim(), phone: $("l-phone").value.trim() };
    const footer = $("welcome").value.trim();
    if (d.footer_override != null) d.footer_override = footer; else p.footer = footer;
    const lat = parseFloat($("lat").value), lon = parseFloat($("lon").value);
    p.lat = Number.isFinite(lat) ? lat : null; p.lon = Number.isFinite(lon) ? lon : null;
    p.timezone = $("timezone").value;
    p.logo_replaces_name = !!p.logo && $("logo-replaces-name").checked;
    p.logo_swap = !!p.company_logo && $("clogo-swap").checked;
    const bg = p.background || {};
    p.background = { image: bg.image || "", enabled: !!bg.image && $("bg-on").checked, visibility: parseInt($("bg-vis").value, 10) || 15, position: parseInt($("bg-pos").value, 10), size: parseInt($("bg-size").value, 10) || 190, offset: parseInt($("bg-offset").value, 10) || 0 };
    $("bg-vis-val").textContent = `${p.background.visibility}%`;
    const scr = S.screens[S.sel];
    if (scr) scr.sizes = Object.fromEntries(SIZES.map((k) => [k, parseInt($(`sz-${k}`).value, 10)]).filter(([, v]) => v && v !== 100));
    readBoxes();
    const prev = new Map(S.tenants.map((t) => [t.id, t]));
    S.tenants = [...$("tenant-rows").querySelectorAll(".tenant-row")].map((row) => ({
      ...(prev.get(row.dataset.id)?._noteOpen ? { _noteOpen: true } : {}),
      id: row.dataset.id, company_id: prev.get(row.dataset.id)?.company_id ?? null, box: prev.get(row.dataset.id)?.box || `new:${row.dataset.id}`,
      name: row.querySelector(".t-name").value.trim(),
      suite: row.querySelector(".t-suite").value.trim(),
      arrow: row.querySelector(".t-dir").value,
      note: row.querySelector(".t-note")?.value.trim() || "",
    }));
  }

  function setDirty(v) { S.dirty = v; $("dirty").hidden = !v; }
  function changed() { read(); setDirty(true); renderSizes(); pushPreview(); }
  // The Sizes screen picker isn't an edit: it has its own handler (below)
  $("editor").addEventListener("input", (e) => { if (!e.target.matches("[type=file], #sz-screen")) changed(); });
  $("editor").addEventListener("change", (e) => {
    if (!e.target.matches("select, input[type=checkbox]")) return;
    changed();
    if (e.target.matches(".p-on")) { const k = e.target.closest(".people-box").dataset.box; renderTenants();
      $("tenant-rows").querySelector(`.people-box[data-box="${CSS.escape(k)}"] .p-on`)?.focus(); }
  });

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
          ${S.peopleOff ? "" : `<button type="button" class="icon-btn people-btn${S.open.has(t.box) ? " open" : ""}" data-act="people" aria-expanded="${S.open.has(t.box)}" title="The people at this company">${esc(peopleLabel(t))}</button>`}
          <button type="button" class="icon-btn remove" data-act="remove" aria-label="Remove ${esc(t.name || "tenant")}">Remove</button>
        </span>
        ${t.note !== "" || t._noteOpen ? `<input class="t-note" value="${esc(t.note)}" placeholder="Small line under the name, e.g. A subsidiary of…" aria-label="Tenant ${i + 1} note" maxlength="120">` : ""}
        ${!S.peopleOff && S.open.has(t.box) ? renderBox(t, i) : ""}
      </li>`).join("") : `<li class="empty-rows">No tenants yet. Click Add tenant to start the list.</li>`;
  }
  $("tenant-rows").addEventListener("click", (e) => {
    const pb = e.target.closest("button[data-pact]");
    if (pb) { personAction(pb); return; }
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    read();
    const i = Number(btn.closest(".tenant-row").dataset.i), t = S.tenants;
    if (btn.dataset.act === "up" && i > 0) [t[i - 1], t[i]] = [t[i], t[i - 1]];
    if (btn.dataset.act === "down" && i < t.length - 1) [t[i + 1], t[i]] = [t[i], t[i + 1]];
    if (btn.dataset.act === "remove") t.splice(i, 1);   // its company and people stay with the building
    if (btn.dataset.act === "note") t[i]._noteOpen = true;
    if (btn.dataset.act === "people") {
      const k = t[i].box || `new:${t[i].id}`;
      if (S.open.has(k)) S.open.delete(k); else { S.open.add(k); if (!boxFor(t[i]).people.length) boxFor(t[i]).people.push(blankPerson()); }
      renderTenants();
      if (S.open.has(k)) $("tenant-rows").querySelector(`.people-box[data-box="${CSS.escape(k)}"] .person:last-child .p-first_name`)?.focus();
      return;                                                     // opening a list isn't an edit
    }
    renderTenants();
    if (btn.dataset.act === "note") $("tenant-rows").querySelectorAll(".tenant-row")[i].querySelector(".t-note")?.focus();
    setDirty(true); pushPreview();
  });
  function personAction(btn) {
    read();
    const box = S.boxes.get(btn.closest(".people-box").dataset.box); if (!box) return;
    const list = box.people, pi = Number(btn.closest(".person")?.dataset.pi), act = btn.dataset.pact;
    if (act === "add") list.push(blankPerson());
    if (act === "up" && pi > 0) [list[pi - 1], list[pi]] = [list[pi], list[pi - 1]];
    if (act === "down" && pi < list.length - 1) [list[pi + 1], list[pi]] = [list[pi], list[pi + 1]];
    if (act === "remove") list.splice(pi, 1);
    if (act === "sort") { const k = (x) => `${x.last_name} ${x.first_name}`.trim().toLowerCase(); list.sort((a, b) => k(a).localeCompare(k(b), "en", { numeric: true })); }
    box.dirty = true;
    renderTenants(); setDirty(true);
    if (act === "add") $("tenant-rows").querySelector(`.people-box[data-box="${CSS.escape(box.key)}"] .person:last-child .p-first_name`)?.focus();
  }
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
    $("clogo-preview").innerHTML = p.company_logo ? `<img src="${esc(p.company_logo)}" alt="Current owner or manager logo">` : "<span>No logo</span>";
    $("clogo-remove").hidden = !p.company_logo;
    $("clogo-swap-row").hidden = !p.company_logo;
    $("clogo-swap").checked = !!p.logo_swap;
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
  $("clogo-file").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    try { read(); S.prop.company_logo = await shrinkLogo(file); renderLogo(); setDirty(true); pushPreview(); } catch (ex) { toast(ex.message, true); }
  });
  $("clogo-remove").addEventListener("click", () => { read(); S.prop.company_logo = ""; S.prop.logo_swap = false; renderLogo(); setDirty(true); pushPreview(); });
  $("clogo-swap").addEventListener("change", () => { read(); setDirty(true); pushPreview(); });

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

  // ── Drive time destinations and nearby places (per building; DP-08 round 11) ──
  function renderDestinations() {
    const list = Array.isArray(S.prop.destinations) ? S.prop.destinations : [];
    $("dest-rows").innerHTML = [0, 1, 2].map((i) => { const x = list[i] || {}; return `<div class="info-row-edit">
      <input class="x-label" value="${esc(x.label)}" placeholder="${i === 0 ? "e.g. Birmingham Airport" : "Label"}" aria-label="Destination ${i + 1} label" maxlength="60">
      <input class="x-address" value="${esc(x.address)}" placeholder="${i === 0 ? "e.g. 5900 Messer Airport Hwy, Birmingham, AL" : "Address"}" aria-label="Destination ${i + 1} address" maxlength="200">
      <span></span></div>`; }).join("");
  }
  // ── Places and promotions: several lists, each with its own heading; a picture per entry (DP-08 round 12) ──
  const MAX_LISTS = 5, MAX_ITEMS = 12, MAX_PICTURES = 12;
  function placeLists() {
    if (!Array.isArray(S.prop.place_lists)) S.prop.place_lists = [];
    // Round 11's places become the first list (24-directory-to-go.sql does the same in the database)
    if (!S.prop.place_lists.length && (S.prop.amenities || []).length) S.prop.place_lists = [{ heading: "Nearby", items: S.prop.amenities.map((a) => ({ ...a })) }];
    return S.prop.place_lists;
  }
  /** The lists as typed (pictures kept from the model, which the page renders in the same order). */
  function readLists() {
    const old = placeLists();
    S.prop.place_lists = [...$("place-lists").querySelectorAll(".plist")].map((el, li) => ({
      heading: el.querySelector(".x-heading").value.trim(),
      items: [...el.querySelectorAll(".pitem")].map((r, ii) => ({
        name: r.querySelector(".x-name").value.trim(), distance: r.querySelector(".x-distance").value.trim(),
        line: r.querySelector(".x-line").value.trim(), link: r.querySelector(".x-link").value.trim(), qrline: r.querySelector(".x-qrline").value.trim(), image: old[li]?.items?.[ii]?.image || "",
      })),
    }));
  }
  const pictureCount = () => placeLists().reduce((n, l) => n + (l.items || []).filter((a) => a.image).length, 0);
  function renderLists() {
    const lists = placeLists();
    $("place-lists").innerHTML = lists.map((l, li) => `<div class="plist" data-li="${li}">
      <div class="plist-head"><input class="x-heading" value="${esc(l.heading)}" placeholder="Heading, e.g. Nearby or While you're here!" aria-label="List ${li + 1} heading" maxlength="40">
        <button type="button" class="ghost danger" data-act="remove-list">Remove this list</button></div>
      ${(l.items || []).map((a, ii) => `<div class="pitem" data-ii="${ii}">
        <label class="thumb${a.image ? " has" : ""}" style="${a.image ? `background-image:url('${a.image}')` : ""}" title="${a.image ? "Change the picture" : "Add a picture or logo (optional)"}">${a.image ? "" : "Picture"}<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Picture for ${esc(a.name || "this place")}"></label>
        <input class="x-name" value="${esc(a.name)}" placeholder="Name, e.g. Barber Motorsports Park" aria-label="Name" maxlength="60">
        <input class="x-distance" value="${esc(a.distance)}" placeholder="Distance or walk time" aria-label="Distance or walk time (optional)" maxlength="30">
        <input class="x-line" value="${esc(a.line)}" placeholder="A short line (optional)" aria-label="A short line (optional)" maxlength="120">
        <input class="x-link" value="${esc(a.link || "")}" placeholder="Address or web link, for a QR code on touch screens (optional)" aria-label="Address or web link (optional): a QR code on touch screens" maxlength="200">
        <input class="x-qrline" value="${esc(a.qrline || "")}" placeholder="Line beside the QR, e.g. Get tickets (optional)" aria-label="Line beside the QR code (optional; blank says Take it with you)" maxlength="80">
        <span class="pitem-actions">${a.image ? `<button type="button" class="icon-btn" data-act="remove-pic" aria-label="Remove the picture">No picture</button>` : ""}<button type="button" class="icon-btn remove" data-act="remove-item" aria-label="Remove ${esc(a.name || "place")}">Remove</button></span>
      </div>`).join("")}
      <div class="plist-foot"><button type="button" class="ghost" data-act="add-item"${(l.items || []).length >= MAX_ITEMS ? " disabled" : ""}>Add a place</button><span class="hint">${(l.items || []).length} of ${MAX_ITEMS}</span></div>
    </div>`).join("");
    $("lists-count").textContent = `${lists.length} of ${MAX_LISTS} lists · ${pictureCount()} of ${MAX_PICTURES} pictures`;
    $("add-list").disabled = lists.length >= MAX_LISTS;
  }
  /** A picture or logo, made small: at most 320 px on its longest side, compressed to about 100 KB or less. */
  async function shrinkThumb(file) {
    const im = await loadImage(await readAsDataURL(file));
    const scale = Math.min(1, 320 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(im.naturalWidth * scale)); c.height = Math.max(1, Math.round(im.naturalHeight * scale));
    const g = c.getContext("2d"); g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
    for (const q of [0.82, 0.7, 0.55, 0.4]) { const out = c.toDataURL("image/jpeg", q); if (out.length <= 120000) return out; }
    throw new Error("That picture is too large even after compressing. Try a smaller one.");
  }
  $("add-list").addEventListener("click", () => {
    read(); if (placeLists().length >= MAX_LISTS) return;
    S.prop.place_lists.push({ heading: "", items: [{ name: "", distance: "", line: "", link: "", image: "" }] });
    renderLists(); changed();
    $("place-lists").lastElementChild?.querySelector(".x-heading").focus();
  });
  $("place-lists").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    read();
    const li = Number(b.closest(".plist").dataset.li), ii = Number(b.closest(".pitem")?.dataset.ii), l = S.prop.place_lists[li];
    if (b.dataset.act === "add-item" && l.items.length < MAX_ITEMS) l.items.push({ name: "", distance: "", line: "", link: "", image: "" });
    if (b.dataset.act === "remove-item") l.items.splice(ii, 1);
    if (b.dataset.act === "remove-pic") l.items[ii].image = "";
    if (b.dataset.act === "remove-list" && (!l.items.some((a) => a.name) || confirm(`Remove the list "${l.heading || "Nearby"}" and its ${l.items.length} entries?`))) S.prop.place_lists.splice(li, 1);
    renderLists(); changed();
  });
  $("place-lists").addEventListener("change", async (e) => {
    if (!e.target.matches("input[type=file]")) return;
    e.stopPropagation();
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    const li = Number(e.target.closest(".plist").dataset.li), ii = Number(e.target.closest(".pitem").dataset.ii);
    try {
      read();
      const item = S.prop.place_lists[li].items[ii];
      if (!item.image && pictureCount() >= MAX_PICTURES) throw new Error(`A building can have ${MAX_PICTURES} pictures. Remove one first.`);
      item.image = await shrinkThumb(file);
      renderLists(); changed();
    } catch (ex) { toast(ex.message, true); }
  });

  // ── Directory to Go (DP-08 round 12) ──
  function renderTogo() {
    const d = S.dir, on = $("togo-on").checked;
    $("togo-opts").hidden = !on;
    const url = (S.togoBase || "https://waytugo.com/d/") + d.togo_code;
    $("togo-link").textContent = url; $("togo-link").href = url;
  }
  async function loadScans() {
    try {
      const r = await Auth.db("rpc/togo_scan_count", { method: "POST", body: { p_directory: S.dir.id } });
      $("togo-scans").textContent = `${r.last30} scan${r.last30 === 1 ? "" : "s"} in the last 30 days (${r.total} in all)`;
    } catch { $("togo-scans").textContent = "scans not available"; }
  }
  $("togo-on").addEventListener("change", renderTogo);
  $("togo-replace").addEventListener("click", async () => {
    if (!confirm("Replace the code? The QR code on the screen changes within a minute, and the old link stops working, including any copy someone saved or shared.")) return;
    try {
      const code = await Auth.db("rpc/togo_replace_code", { method: "POST", body: { p_directory: S.dir.id } });
      S.dir.togo_code = typeof code === "string" ? code : code?.togo_replace_code || S.dir.togo_code;
      renderTogo(); pushPreview();
      toast("New code saved. The screen shows it within a minute.");
    } catch (ex) { toast(ex.message, true); }
  });

  // ── Sizes (per screen) ──
  function renderSizes() {
    const has = S.screens.length > 0, scr = S.screens[S.sel], p = S.prop || {};
    $("sz-screen-row").hidden = S.screens.length < 2;
    $("sz-none").hidden = has;
    $("sz-reset").hidden = !has;
    $("sizes-note").textContent = S.screens.length > 1 ? "each screen has its own" : "for this screen only";
    const sel = $("sz-screen");
    if (sel.options.length !== S.screens.length) sel.innerHTML = S.screens.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join("");
    sel.value = String(S.sel);
    const swap = !!(p.logo_swap && p.company_logo), top = swap ? p.company_logo : p.logo, bottom = swap ? p.logo : p.company_logo;
    const wordmark = !swap && !!(p.logo && p.logo_replaces_name);
    const welcome = S.dir?.footer_override ?? p.footer ?? "";
    // Only the parts this screen actually shows
    const contact = (c) => !!(c && (c.name || c.company || c.phone));
    const shows = { title: !wordmark, logo: !!top, brand: !!bottom, welcome: !!welcome, clock: true,
      weather: S.dir?.weather_enabled !== false && p.lat != null,
      news: S.dir?.news_enabled !== false || !!(S.dir?.map_enabled || S.dir?.times_enabled || S.dir?.amenities_enabled),
      contacts: contact(p.managed_by) || contact(p.leased_by), qr: !!S.dir?.togo_enabled };
    for (const k of SIZES) {
      $(`sz-${k}-row`).hidden = !has || !shows[k];
      $(`sz-${k}`).value = sizeOf(scr, k);
      $(`sz-${k}-val`).textContent = `${sizeOf(scr, k)}%`;
    }
  }
  $("sz-screen").addEventListener("change", (e) => {
    e.stopPropagation(); read();
    S.sel = Number(e.target.value) || 0;
    renderSizes(); loadPreview();               // the other screen may be turned the other way
  });
  $("sz-reset").addEventListener("click", () => {
    const scr = S.screens[S.sel]; if (!scr) return;
    for (const k of SIZES) $(`sz-${k}`).value = 100;
    changed();
  });

  // ── Preview (same shape /api/screen sends to real screens) ──
  function payload() {
    const d = S.dir, p = S.prop, scr = S.screens[S.sel];
    return {
      key: scr?.key || d.slug, orientation: scr?.orientation || "auto",
      propertyName: d.title, buildingLabel: d.subtitle || p.address || "",
      logo: p.logo || "", logoReplacesName: !!(p.logo && p.logo_replaces_name),
      companyLogo: p.company_logo || "", logoSwap: !!(p.company_logo && p.logo_swap),
      // On a touch screen the preview's cards show the people as the screen would (the same rules as 26-people.sql)
      tenants: S.tenants.filter((t) => t.name).map((t) => ({ name: t.name, suite: t.suite, dir: t.arrow, note: t.note, people: previewPeople(t, scr) })),
      managedBy: p.managed_by || {}, leasedBy: p.leased_by || {},
      welcome: d.footer_override ?? p.footer ?? "",
      weather: { enabled: d.weather_enabled !== false && p.lat != null, lat: p.lat, lon: p.lon },
      timezone: p.timezone || "America/Chicago",
      news: { enabled: d.news_enabled !== false, rotateSeconds: d.rotate_seconds || 12 },
      // Same rules as the screen's (screen.mjs trafficFor); the preview never asks Google for times
      traffic: { map: !!(d.map_enabled && S.mapsKey && p.lat != null && p.lon != null), times: !!(d.times_enabled && (p.destinations || []).length),
        lat: p.lat ?? null, lon: p.lon ?? null, mapsKey: d.map_enabled ? S.mapsKey : "", destinations: (p.destinations || []).map((x) => x.label) },
      amenities: [],
      placeLists: d.amenities_enabled ? (p.place_lists || []).map((l) => ({ heading: l.heading || "Nearby", items: (l.items || []).filter((a) => a.name) })).filter((l) => l.items.length) : [],
      togo: { enabled: !!d.togo_enabled, url: (S.togoBase || "https://waytugo.com/d/") + d.togo_code, line: d.togo_line || "Take this directory with you!" },
      poweredBy: !scr?.hide_powered_by,
      touch: !!scr?.touch, screenInches: scr?.screen_inches ?? null, touchIdle: scr?.touch_idle_s || 45, keyboard: !!d.touch_keyboard,
      background: p.background || {}, sizes: scr?.sizes || {}, assigned: true, updatedAt: d.updated_at,
    };
  }
  function previewPeople(t, scr) {
    const b = S.boxes.get(t.box);
    if (!scr?.touch || !b?.show_people) return [];
    return b.people.filter((x) => named(x) && x.show !== false).map((x) => ({ first: x.first_name || "", last: x.last_name || "",
      title: b.show_title ? x.title || "" : "", phone: b.show_phone ? x.phone || "" : "", email: b.show_email ? x.email || "" : "", suite: x.suite || "" }));
  }
  function previewShape() {
    const o = S.screens[S.sel]?.orientation || "auto";
    return o.startsWith("landscape") ? "landscape" : "portrait";
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
    f.src = `/?screen=${encodeURIComponent(S.screens[S.sel]?.key || S.dir.slug)}&preview=1`;
    scalePreview();
  }
  function pushPreview() {
    if (S.dir) renderSizes();                   // a logo or bottom line added or removed changes which sliders apply
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
        map_enabled: !!d.map_enabled, times_enabled: !!d.times_enabled, amenities_enabled: !!d.amenities_enabled,
        togo_enabled: !!d.togo_enabled, togo_line: d.togo_line || "", touch_keyboard: !!d.touch_keyboard,
        ...(d.footer_override != null ? { footer_override: d.footer_override } : {}),
      } });
      await Auth.db(`properties?id=eq.${p.id}`, { method: "PATCH", prefer: "return=minimal", body: {
        address: p.address, logo: p.logo || "", logo_replaces_name: !!p.logo_replaces_name, background: p.background || {},
        company_logo: p.company_logo || "", logo_swap: !!(p.company_logo && p.logo_swap),
        managed_by: p.managed_by, leased_by: p.leased_by, footer: p.footer || "", lat: p.lat, lon: p.lon, timezone: p.timezone,
        destinations: p.destinations || [],
        // Entries without a name are dropped; the first list also goes to the round 11 column for screens not yet reloaded
        place_lists: (p.place_lists || []).map((l) => ({ heading: l.heading || "Nearby", items: (l.items || []).filter((a) => a.name) })),
        amenities: ((p.place_lists || [])[0]?.items || []).filter((a) => a.name).map(({ name, distance, line }) => ({ name, distance, line })),
      } });
      // Tenants: save every row first, then remove the ones deleted here. A failure part-way never loses rows.
      const rows = S.tenants.filter((t) => t.name).map((t, i) => ({ id: t.id, directory_id: d.id, sort: i * 10, name: t.name, suite: t.suite, arrow: t.arrow, note: t.note }));
      if (rows.length) await Auth.db("tenants", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: rows });
      const keep = rows.map((r) => r.id);
      await Auth.db(`tenants?directory_id=eq.${d.id}${keep.length ? `&id=not.in.(${keep.join(",")})` : ""}`, { method: "DELETE", prefer: "return=minimal" });
      // People: after the tenants, so new and renamed tenants have their companies (the database makes them)
      await savePeople(d.id);
      // Each screen whose sizes changed (the server checks access and keeps them in range)
      for (const s of S.screens) {
        if (JSON.stringify(s.sizes || {}) !== s.saved) await Auth.db("rpc/set_screen_sizes", { method: "POST", body: { p_screen: s.id, p_sizes: s.sizes || {} } });
      }
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
      try { const c = await Auth.config(); S.mapsKey = c.mapsKey || ""; S.togoBase = c.togoBase || ""; } catch { S.mapsKey = ""; }
      await load();
      fill();
      loadPreview();
      loadScans();
    } catch (ex) {
      if (ex.message === "Signing in…") return;
      $("load-error").textContent = ex.message; $("load-error").hidden = false;
      document.querySelector(".workspace").hidden = true;
    }
  })();
})();
