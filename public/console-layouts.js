/* The console's Layouts tab (DP-11, round E1a; 1Point only). A layout is written as data (JSON: grid, theme, blocks;
   public/layout-format.mjs), then Checked (problems and guardrail warnings), Previewed (drawn exactly as a screen draws
   it, in the building chosen), and Published as a new version. Every version is kept; Roll back publishes an earlier
   one again. A screen is pointed at a layout in its Screen settings (Shows). The visual editors come later (E2 to E4)
   on the same data. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const { esc, toast, since } = window.UI;
  const L = { current: null, versions: [], lastPreview: { text: null, overflow: [] }, frameReady: false, waiters: [] };
  const S = () => window.ConsoleState;
  const look = () => window.ConsoleLookup;
  const FAMILY = { menu: "Menu", schedule: "Schedule", board: "Board", list: "List" };

  // ── The list ──
  function renderList() {
    const s = S(); if (!s?.admin) return;
    const used = (id) => s.screens.filter((x) => x.layout_id === id);
    $("layout-summary").textContent = `${s.layouts.length} layout${s.layouts.length === 1 ? "" : "s"}`;
    $("layout-rows").innerHTML = s.layouts.length ? s.layouts.map((l) => {
      const sc = used(l.id);
      return `<tr><td><strong>${esc(l.name)}</strong><div class="sub">${esc(FAMILY[l.family] || l.family)}</div></td>
        <td>${esc(look().org(l.org_id)?.name || "")}</td><td>${l.orientation === "portrait" ? "Portrait" : "Landscape"}</td>
        <td>${l.published_version ? `Version ${l.published_version}<div class="sub">${since(l.published_at)}</div>` : `<span class="warn">Not published</span>`}</td>
        <td>${sc.length ? sc.map((x) => esc(x.name)).join(", ") : `<span class="sub">none</span>`}</td>
        <td class="actions"><button type="button" class="ghost" data-open-layout="${l.id}">Open</button></td></tr>`;
    }).join("") : `<tr><td colspan="6" class="empty-rows">No layouts yet. Add one, paste its JSON, check, preview, publish; then choose it for a screen in Screen settings.</td></tr>`;
  }
  $("layout-rows").addEventListener("click", (e) => { const b = e.target.closest("[data-open-layout]"); if (b) openLayout(b.dataset.openLayout); });

  $("add-layout").addEventListener("click", () => {
    const s = S(), D = window.ConsoleDialog;
    D.open({
      title: "Add layout",
      body: `${D.field("l-org", "Account", `<select id="l-org">${s.orgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}</select>`, "The layout belongs to the account, so any of its buildings' screens can show it.")}
        ${D.field("l-name", "Name", `<input id="l-name" required maxlength="80" placeholder="e.g. Donut Joe's Pelham: case board">`)}
        ${D.field("l-family", "Kind", `<select id="l-family">${Object.entries(FAMILY).map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>`)}
        ${D.field("l-orient", "Orientation", `<select id="l-orient"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select>`, "Fixed for the layout; it can show only on screens with the same Orientation.")}`,
      async save() {
        const body = { org_id: $("l-org").value, name: $("l-name").value.trim(), family: $("l-family").value, orientation: $("l-orient").value };
        if (!body.name) throw new Error("Enter a name.");
        const [row] = await Auth.db("layouts", { method: "POST", body, prefer: "return=representation" });
        await window.ConsoleRefresh();
        openLayout(row.id);
      },
    });
  });

  // ── One layout ──
  const skeleton = (l) => ({ format: 1, orientation: l.orientation, grid: { cols: 12, rows: 24, gap: 16, margin: 40 }, viewing: { inches: 43, metres: 3 },
    theme: { palette: { bg: "#ffffff", ink: "#1b1f24" }, fonts: { display: "Fraunces", body: "Instrument Sans" } }, blocks: [] });

  async function openLayout(id) {
    const [l] = await Auth.db(`layouts?id=eq.${id}&select=*`);
    if (!l) { toast("That layout is gone.", true); return; }
    L.current = l;
    $("layout-list-view").hidden = true; $("layout-detail").hidden = false;
    const draft = l.draft && Object.keys(l.draft).length ? l.draft : skeleton(l);
    $("layout-json").value = JSON.stringify(draft, null, 2);
    $("layout-results").innerHTML = ""; $("layout-note").value = "";
    L.lastPreview = { text: null, overflow: [] };
    const props = S().props.filter((p) => p.org_id === l.org_id);
    $("layout-prop").innerHTML = props.length ? props.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("") : `<option value="">(no buildings yet)</option>`;
    const firstScreen = S().screens.find((x) => x.layout_id === l.id && x.property_id);
    if (firstScreen) $("layout-prop").value = firstScreen.property_id;
    const frame = $("layout-frame");
    frame.className = `layout-frame ${l.orientation}`;
    $("layout-iframe").src = "about:blank"; L.frameReady = false;
    showLTab("design"); $("layout-offer").hidden = true;
    meta(); await loadVersions(); await loadPictures(); await menuLine(); menuBox();
    history.replaceState(null, "", `#layouts`);
  }
  // ── E2e (DP-13): the layout page's tabs: Design (the JSON, Check, Preview, Publish), Menu (its lists, List settings,
  // customer editing), Versions, Pictures; the preview stays beside them ──
  function showLTab(t) {
    for (const b of document.querySelectorAll("[data-ltab]")) b.setAttribute("aria-selected", String(b.dataset.ltab === t));
    for (const p of document.querySelectorAll("[data-lpane]")) p.hidden = p.dataset.lpane !== t;
    if (t === "menu") listsTable();
    if (t === "sample") loadSamples();
  }
  document.querySelector(".ltabs").addEventListener("click", (e) => { const b = e.target.closest("[data-ltab]"); if (b) showLTab(b.dataset.ltab); });
  /** The Menu tab's table: every list on the layout's menu, its kind, room, what's on it, and whether this board shows it */
  async function listsTable() {
    const box = $("layout-lists"), l = L.current;
    if (!l?.menu_id) { box.innerHTML = ""; return; }
    const [m] = await Auth.db(`menus?id=eq.${l.menu_id}&select=spec,content`).catch(() => []);
    if (!m) { box.innerHTML = ""; return; }
    let doc; try { doc = JSON.parse($("layout-json").value); } catch { doc = l.draft; }
    const shown = new Set((doc?.blocks || []).map((b) => b.content?.list).filter(Boolean));
    const KIND = { items: "Items", text: "Text (one entry)", hours: "Hours" };
    box.innerHTML = `<h3 class="section-title">Lists on this menu</h3>
      <div class="table-wrap"><table class="grid"><thead><tr><th>List (the customer sees)</th><th>Key</th><th>Kind</th><th>Room</th><th>On it now</th><th>On this board</th></tr></thead><tbody>
      ${(m.spec?.lists || []).map((x) => `<tr><td><strong>${esc(x.name)}</strong>${x.schedule ? ` <span class="sub">· dates and times</span>` : ""}</td><td><code>${esc(x.key)}</code></td><td>${esc(KIND[x.kind] || x.kind)}</td>
        <td>${x.room}</td><td>${(m.content?.lists?.[x.key]?.entries || []).length}</td><td>${shown.has(x.key) ? "Yes" : `<span class="sub">no</span>`}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="hint">Names, rooms, boxes, dates and hints are changed in List settings. A list another board shows stays on the menu even when this board doesn't show it.</p>`;
  }
  // ── T0 (DP-13): sample links for this board (1Point only; supabase/36-templates.sql). Made, lengthened and turned off
  // straight to the database as the signed-in 1Point user; the page is netlify/functions/sample.mjs ──
  const SAMPLE_BASE = "https://waytugo.com/s/";
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
  const randomSlug = () => `demo-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("")}`;
  async function loadSamples() {
    const l = L.current; if (!l) return;
    const props = S().props.filter((p) => p.org_id === l.org_id);
    const keep = $("sample-prop").value;
    $("sample-prop").innerHTML = `<option value="">(none: the account's first)</option>` + props.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    if (keep && props.some((p) => p.id === keep)) $("sample-prop").value = keep; else if (props.length === 1) $("sample-prop").value = props[0].id;
    $("sample-make").disabled = !l.published_version;
    $("sample-make").title = l.published_version ? "" : "Publish the board first";
    const rows = await Auth.db(`sample_links?layout_id=eq.${l.id}&select=*&order=created_at.desc`).catch(() => []);
    const now = Date.now();
    $("sample-rows").innerHTML = rows.length ? rows.map((r) => {
      const ended = r.turned_off_at || Date.parse(r.expires_at) <= now;
      const ends = new Date(r.turned_off_at || r.expires_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      const p = r.property_id ? look().prop(r.property_id) : null;
      return `<tr data-sample="${esc(r.slug)}"${ended ? ' class="ended"' : ""}>
        <td><a href="${SAMPLE_BASE}${esc(r.slug)}" target="_blank" rel="noopener">waytugo.com/s/${esc(r.slug)}</a></td>
        <td>${p ? esc(p.name) : `<span class="sub">the account's first</span>`}</td>
        <td>${ended ? `<span class="warn">${r.turned_off_at ? "Turned off" : "Ended"} ${ends}</span>` : `${ends}<div class="sub">${r.days} days</div>`}</td>
        <td>${r.opens}${r.last_open_at ? `<div class="sub">last ${since(r.last_open_at)}</div>` : ""}</td>
        <td class="actions">${ended ? `<select data-sample-renew aria-label="Open it again for"><option value="">Open again for…</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option></select>`
          : `<button type="button" class="ghost" data-sample-copy>Copy link</button><select data-sample-days aria-label="Length from today"><option value="">Length from today…</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option></select><button type="button" class="ghost danger" data-sample-off>Turn off</button>`}</td></tr>`;
    }).join("") : `<tr><td colspan="5" class="empty-rows">No sample links for this board yet.</td></tr>`;
  }
  $("sample-make").addEventListener("click", async () => {
    const l = L.current; if (!l) return;
    const slug = ($("sample-slug").value.trim().toLowerCase() || randomSlug()).replace(/\s+/g, "-");
    if (!SLUG_RE.test(slug)) { toast("A link name is 3 to 40 letters, numbers and dashes, starting with a letter or number.", true); return; }
    try {
      await Auth.db("sample_links", { method: "POST", body: { slug, layout_id: l.id, property_id: $("sample-prop").value || null, days: Number($("sample-days").value) }, prefer: "return=minimal" });
      $("sample-slug").value = "";
      toast(`Sample link made: waytugo.com/s/${slug}`);
      await loadSamples();
    } catch (ex) { toast(/duplicate|already exists|sample_links_pkey/i.test(ex.message) ? `"${slug}" is taken. Choose another name.` : ex.message, true); }
  });
  $("sample-rows").addEventListener("click", async (e) => {
    const tr = e.target.closest("[data-sample]"); if (!tr) return;
    const slug = tr.dataset.sample, url = `${SAMPLE_BASE}${slug}`;
    if (e.target.closest("[data-sample-copy]")) {
      try { await navigator.clipboard.writeText(url); toast("Link copied."); } catch { toast(url); }
    }
    if (e.target.closest("[data-sample-off]")) {
      if (!confirm(`Turn off waytugo.com/s/${slug}? It stops working at once.`)) return;
      try { await Auth.db(`sample_links?slug=eq.${encodeURIComponent(slug)}`, { method: "PATCH", body: { turned_off_at: new Date().toISOString() }, prefer: "return=minimal" }); toast("Turned off."); await loadSamples(); }
      catch (ex) { toast(ex.message, true); }
    }
  });
  $("sample-rows").addEventListener("change", async (e) => {
    const tr = e.target.closest("[data-sample]"), sel = e.target.closest("[data-sample-days],[data-sample-renew]"); if (!tr || !sel?.value) return;
    // a new length counts from today (the database sets the date); opening an ended link again clears Turned off
    const body = { days: Number(sel.value), expires_at: new Date().toISOString(), ...(sel.matches("[data-sample-renew]") ? { turned_off_at: null } : {}) };
    try { await Auth.db(`sample_links?slug=eq.${encodeURIComponent(tr.dataset.sample)}`, { method: "PATCH", body, prefer: "return=minimal" }); toast(`It now ends ${sel.value} days from today.`); await loadSamples(); }
    catch (ex) { toast(ex.message, true); }
  });

  // ── E2e: one file per board. After Check, blocks that still write their own items, text or hours are offered as
  // lists on the layout's menu ("Make these lists"), with a room each; the JSON then points at them ──
  function renderOffer(offer) {
    const box = $("layout-offer"), l = L.current, m = l?.menu_id ? look().menu(l.menu_id) : null;
    if (!offer?.length || !m) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = `<p><strong>${offer.length === 1 ? "One block writes" : `${offer.length} blocks write`} ${offer.length === 1 ? "its" : "their"} own content.</strong> Make ${offer.length === 1 ? "it a list" : "them lists"} on <strong>${esc(m.name)}</strong>, so the customer edits ${offer.length === 1 ? "it" : "them"} in the menu editor:</p>
      <ul class="make-lists">${offer.map((o) => `<li><input type="checkbox" data-of="${esc(o.block)}"${o.existing ? ` data-of-use="1"` : ""} checked aria-label="${o.existing ? "Use the list" : "Make a list from"} ${esc(o.block)}">
        <span><strong>${esc(o.name)}</strong> <span class="sub">${esc(o.key)} · ${esc(o.kind)} · ${o.existing ? "already on the menu: the board shows what's there (this file's sample entries are left out)" : `${o.entries} now`}</span></span>
        ${o.existing ? `<span class="sub">use it</span>` : o.kind === "text" ? `<span class="sub">room 1</span>` : `<label class="sub">room <input type="number" min="${Math.max(1, o.entries)}" max="${o.kind === "hours" ? 14 : 60}" value="${o.room}" data-of-room="${esc(o.block)}"></label>`}</li>`).join("")}</ul>
      <div class="row"><button type="button" class="primary" id="offer-make">Make these lists</button>
      <span class="hint">Then Preview and Publish. Untick a block to keep its content in the layout (only WayTuGo can change it there).</span></div>`;
  }
  $("layout-offer").addEventListener("click", async (e) => {
    if (e.target.id !== "offer-make") return;
    const ticked = [...document.querySelectorAll("[data-of]")].filter((x) => x.checked);
    if (!ticked.length) { toast("Tick at least one block.", true); return; }
    const blocks = ticked.map((x) => x.dataset.of), use = ticked.filter((x) => x.dataset.ofUse).map((x) => x.dataset.of);
    const rooms = Object.fromEntries([...document.querySelectorAll("[data-of-room]")].map((x) => [x.dataset.ofRoom, Number(x.value)]));
    e.target.disabled = true;
    try { await makeLists({ blocks, rooms, use }); $("layout-check").click(); }
    catch (ex) { toast(ex.message, true); }
    finally { e.target.disabled = false; }
  });
  /** Make lists (a new menu) or add them to the layout's menu, from the saved draft; the JSON box then shows the draft
   *  pointing at them. Shared by the Menu tab's dialog and Design's "Make these lists". */
  async function makeLists({ blocks, rooms = {}, names = {}, name = "", use = [] }) {
    const l = L.current, adding = !!l.menu_id;
    const r = await Auth.api("/api/layouts", { method: "POST", body: { action: "make_menu", layout_id: l.id, blocks, rooms, names, name, use } });
    await window.ConsoleRefresh();
    const [fresh] = await Auth.db(`layouts?id=eq.${l.id}&select=*`); if (fresh) L.current = fresh;
    $("layout-json").value = JSON.stringify(L.current.draft, null, 2);
    menuBox(); $("layout-offer").hidden = true;
    const u = (r.used || []).length;
    toast(`${r.made.length ? `${adding ? "Added" : "Made"} ${r.made.length} list${r.made.length === 1 ? "" : "s"}` : ""}${r.made.length && u ? "; " : ""}${u ? `${u} block${u === 1 ? " shows a list" : "s show lists"} already on the menu` : ""}. Preview and publish to put the board on them.`);
    return r;
  }
  function meta() {
    const l = L.current; if (!l) return;
    const sc = S().screens.filter((x) => x.layout_id === l.id);
    $("layout-title").textContent = l.name;
    $("layout-meta").textContent = `${look().org(l.org_id)?.name || ""} · ${FAMILY[l.family] || l.family} · ${l.orientation === "portrait" ? "Portrait" : "Landscape"} · ${l.published_version ? `version ${l.published_version} live` : "not published"} · ${sc.length ? `on ${sc.map((x) => x.name).join(", ")}` : "on no screens"}`;
  }
  async function loadVersions() {
    L.versions = await Auth.db(`layout_versions?layout_id=eq.${L.current.id}&select=version,published_at,overridden,note,rolled_back_from,checks&order=version.desc`).catch(() => []);
    const live = L.current.published_version;
    $("layout-versions").innerHTML = L.versions.length ? L.versions.map((v) => {
      const w = (v.checks?.warnings || []).length;
      return `<tr><td><strong>${v.version}</strong>${v.version === live ? ` <span class="sub">· live</span>` : ""}</td><td>${since(v.published_at)}</td>
        <td>${w ? `${w} warning${w === 1 ? "" : "s"}${v.overridden ? " (published anyway)" : ""}` : "OK"}</td><td>${esc(v.note || "")}</td>
        <td class="actions">${v.version === live ? "" : `<button type="button" class="ghost" data-rollback="${v.version}">Roll back to this</button>`}</td></tr>`;
    }).join("") : `<tr><td colspan="5" class="empty-rows">Not published yet.</td></tr>`;
  }
  $("layout-versions").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-rollback]"); if (!b) return;
    const v = Number(b.dataset.rollback);
    if (!confirm(`Publish version ${v} again? It becomes the newest version, and every screen showing this layout changes within a minute.`)) return;
    try {
      const r = await Auth.api("/api/layouts", { method: "POST", body: { action: "rollback", layout_id: L.current.id, version: v } });
      toast(`Version ${v} is live again (as version ${r.version}).`);
      await afterPublish(r.version);
    } catch (ex) { toast(ex.message, true); }
  });
  $("layout-back").addEventListener("click", () => { L.current = null; $("layout-detail").hidden = true; $("layout-list-view").hidden = false; renderList(); });
  $("layout-rename").addEventListener("click", () => {
    const D = window.ConsoleDialog, l = L.current;
    D.open({ title: "Rename layout", body: D.field("l-rename", "Name", `<input id="l-rename" required maxlength="80" value="${esc(l.name)}">`),
      async save() {
        const name = $("l-rename").value.trim(); if (!name) throw new Error("Enter a name.");
        await Auth.db(`layouts?id=eq.${l.id}`, { method: "PATCH", body: { name }, prefer: "return=minimal" });
        l.name = name; await window.ConsoleRefresh(); meta();
      } });
  });
  $("layout-remove").addEventListener("click", async () => {
    const l = L.current;
    if (!confirm(`Remove the layout "${l.name}" and all its versions? This can't be undone.`)) return;
    try { await Auth.db(`layouts?id=eq.${l.id}`, { method: "DELETE" }); toast("Layout removed."); $("layout-back").click(); await window.ConsoleRefresh(); }
    catch (ex) { toast(ex.message, true); }
  });

  // ── Check, preview, publish ──
  function parse() {
    try { return { doc: JSON.parse($("layout-json").value) }; }
    catch (ex) { return { error: `That isn't valid JSON: ${ex.message}` }; }
  }
  const list = (items) => `<ul>${items.map((x) => `<li><strong>${esc(x.where)}</strong>: ${esc(x.msg)}</li>`).join("")}</ul>`;
  function showResults({ errors = [], warnings = [], note = "", anyway = false }) {
    let h = "";
    if (!errors.length && !warnings.length) h += `<p class="ok">No problems found.${note ? ` ${esc(note)}` : ""}</p>`;
    if (errors.length) h += `<p class="errs"><strong>${errors.length} problem${errors.length === 1 ? "" : "s"} to fix</strong> (it can't be published until they're fixed):</p>${list(errors)}`;
    if (warnings.length) h += `<p class="warns"><strong>${warnings.length} warning${warnings.length === 1 ? "" : "s"}</strong> (the guardrails: a customer designer couldn't publish this; 1Point can, if it's meant):</p>${list(warnings)}`;
    if (anyway) h += `<div class="anyway"><button type="button" id="layout-anyway" class="primary">Publish anyway</button></div>`;
    $("layout-results").innerHTML = h;
  }
  $("layout-check").addEventListener("click", async () => {
    const p = parse(); if (p.error) { showResults({ errors: [{ where: "layout", msg: p.error }] }); return; }
    try {
      const r = await Auth.api("/api/layouts", { method: "POST", body: { action: "check", layout_id: L.current.id, doc: p.doc } });
      showResults({ ...r, note: "Kept as the draft." });
      renderOffer(r.offer);
    } catch (ex) { showResults({ errors: ex.data?.errors || [{ where: "layout", msg: ex.message }] }); renderOffer(null); }
  });

  // The preview: the real layout page in a frame, given the layout by message; it answers with the blocks that overflow
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || e.source !== $("layout-iframe").contentWindow) return;
    if (e.data?.type === "layout-ready") { L.frameReady = true; L.waiters.splice(0).forEach((f) => f()); }
    if (e.data?.type === "layout-report") {
      L.lastPreview.overflow = e.data.overflow || [];
      L.lastPreview.shrunk = e.data.shrunk || [];
      L.reportWaiter?.(); L.reportWaiter = null;
    }
  });
  function fitFrame() {
    const l = L.current; if (!l) return;
    const cw = l.orientation === "portrait" ? 1080 : 1920, ch = l.orientation === "portrait" ? 1920 : 1080;
    const f = $("layout-iframe"), box = $("layout-frame");
    f.style.width = `${cw}px`; f.style.height = `${ch}px`;
    f.style.transform = `scale(${box.clientWidth / cw})`;
  }
  window.addEventListener("resize", fitFrame);
  async function preview() {
    const p = parse(); if (p.error) { showResults({ errors: [{ where: "layout", msg: p.error }] }); return null; }
    const text = $("layout-json").value;
    let r;
    try { r = await Auth.api("/api/layouts", { method: "POST", body: { action: "preview", layout_id: L.current.id, doc: p.doc, property_id: $("layout-prop").value || null } }); }
    catch (ex) { showResults({ errors: ex.data?.errors || [{ where: "layout", msg: ex.message }] }); return null; }
    if (r.errors.length) { showResults(r); return null; }
    fitFrame();
    if (!L.frameReady) {
      await new Promise((res) => { L.waiters.push(res); $("layout-iframe").src = `/board.html?preview=1&o=${L.current.orientation}`; setTimeout(res, 8000); });
    }
    const reported = new Promise((res) => { L.reportWaiter = res; setTimeout(res, 6000); });
    $("layout-iframe").contentWindow.postMessage({ type: "layout-draft", data: r.payload }, location.origin);
    await reported;
    L.lastPreview.text = text;
    const overflow = (L.lastPreview.overflow || []).map((id) => ({ where: `block "${id}"`, msg: "Its text doesn't fit its box even at the smallest size allowed (marked in red in the preview). Make the box bigger or the text shorter." }));
    const shrunk = (L.lastPreview.shrunk || []).filter((x) => x.scale < 0.8);
    showResults({ errors: [], warnings: [...r.warnings, ...overflow], note: shrunk.length ? `(${shrunk.map((x) => `"${x.id}" shrunk to ${Math.round(x.scale * 100)}%`).join(", ")} to fit.)` : "" });
    $("layout-frame-note").textContent = `Preview: as a screen in ${$("layout-prop").selectedOptions[0]?.textContent || "no building"} draws it now (schedules follow the building's time).`;
    return { warnings: [...r.warnings, ...overflow] };
  }
  $("layout-preview").addEventListener("click", preview);

  async function publish(override) {
    const p = parse(); if (p.error) { showResults({ errors: [{ where: "layout", msg: p.error }] }); return; }
    // The overflow guardrail needs a preview of exactly this text
    if (L.lastPreview.text !== $("layout-json").value) { const pv = await preview(); if (!pv) return; }
    try {
      const r = await Auth.api("/api/layouts", { method: "POST", body: { action: "publish", layout_id: L.current.id, doc: p.doc, note: $("layout-note").value.trim(), override, overflow: L.lastPreview.overflow } });
      toast(`Published: version ${r.version} is live. Screens showing this layout change within a minute.`);
      $("layout-note").value = "";
      showResults({ errors: [], warnings: r.warnings || [], note: `Version ${r.version} published.` });
      await afterPublish(r.version);
    } catch (ex) {
      if (ex.status === 409) showResults({ errors: [], warnings: ex.data?.warnings || [], anyway: true });
      else showResults({ errors: ex.data?.errors || [{ where: "layout", msg: ex.message }], warnings: ex.data?.warnings || [] });
    }
  }
  $("layout-publish").addEventListener("click", () => publish(false));
  $("layout-results").addEventListener("click", (e) => { if (e.target.id === "layout-anyway" && confirm("Publish with these warnings? It's recorded with the version.")) publish(true); });
  async function afterPublish(version) {
    L.current.published_version = version;
    await window.ConsoleRefresh();
    const [l] = await Auth.db(`layouts?id=eq.${L.current.id}&select=*`); if (l) L.current = l;
    meta(); await loadVersions(); await menuLine(); menuBox();
  }

  // ── "Take this menu with you" (E1c): the layout's phone menu, its address and how often it's opened ──
  async function menuLine() {
    const l = L.current, el = $("layout-menu");
    if (!l?.menu_code) { el.hidden = true; return; }
    let base = "https://waytugo.com/m/";
    try { const c = await Auth.config(); if (c.menuBase) base = c.menuBase; } catch { /* the default */ }
    const url = base + l.menu_code, shown = url.replace(/^https?:\/\//, "");
    if (!l.published_version) { el.innerHTML = `Take this menu with you: <strong>${esc(shown)}</strong> works once the layout is published. A <code>qr</code> block puts its code on the board.`; el.hidden = false; return; }
    let opens = "";
    try { const n = await Auth.db("rpc/menu_scan_count", { method: "POST", body: { p_layout: l.id } }); opens = ` · opened ${n.last30} time${n.last30 === 1 ? "" : "s"} in the last 30 days (${n.total} in all)`; } catch { /* leave it out */ }
    el.innerHTML = `Take this menu with you: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(shown)}</a>${opens}. A <code>qr</code> block puts its code on the board.`;
    el.hidden = false;
  }

  // ── Pictures (E1b): the account's pictures, shared by its layouts and its menus; shrunk here, then sent to the site ──
  async function loadPictures() {
    const l = L.current; if (!l) return;
    $("pics-account").textContent = `· ${look().org(l.org_id)?.name || ""}`;
    L.pics = await Auth.db(`layout_images?org_id=eq.${l.org_id}&select=id,key,name,path,width,height,bytes,created_at&order=key.asc`).catch(() => []);
    const room = look().org(l.org_id)?.picture_room;
    if (room) $("pics-account").textContent += ` · ${L.pics.length} of ${room} pictures`;
    $("pics-grid").innerHTML = L.pics.length ? L.pics.map((p) => `<div class="pic">
        <img src="/img/${esc(p.path)}" alt="" loading="lazy">
        <div class="pic-body"><span class="pic-name" title="${esc(p.name)}">${esc(p.name || p.key)}</span>
          <span class="pic-key" title="img:${esc(p.key)}">img:${esc(p.key)}</span>
          <span class="sub">${p.width} × ${p.height} · ${Math.round(p.bytes / 1024)} KB</span></div>
        <div class="pic-actions"><button type="button" class="ghost" data-pic-copy="${esc(p.key)}">Copy key</button>
          <button type="button" class="ghost" data-pic-rename="${p.id}">Rename</button>
          <button type="button" class="ghost danger" data-pic-delete="${p.id}">Remove</button></div></div>`).join("")
      : `<p class="empty-rows">No pictures yet for this account.</p>`;
  }
  $("pics-file").addEventListener("change", async (e) => {
    const files = [...e.target.files]; e.target.value = "";
    if (!files.length || !L.current) return;
    const prog = $("pics-progress"); prog.hidden = false;
    const { shrink, asDataUrl, niceName } = await import("/picture-shrink.mjs");   // shared with the menu editor (E2c)
    const done = [], failed = [];
    for (const [i, f] of files.entries()) {
      prog.textContent = `Uploading ${i + 1} of ${files.length}: ${f.name}…`;
      try {
        const data = await asDataUrl(await shrink(f));
        const r = await Auth.api("/api/layouts", { method: "POST", body: { action: "upload", org_id: L.current.org_id, name: niceName(f.name), data } });
        done.push(r.picture.key);
      } catch (ex) { failed.push(`${f.name}: ${ex.message}`); }
    }
    prog.textContent = `${done.length} uploaded${done.length ? ` (keys: ${done.map((k) => `img:${k}`).join(", ")})` : ""}.${failed.length ? ` Not uploaded: ${failed.join("; ")}` : ""}`;
    await loadPictures();
  });
  $("pics-grid").addEventListener("click", async (e) => {
    const cp = e.target.closest("[data-pic-copy]"), rn = e.target.closest("[data-pic-rename]"), rm = e.target.closest("[data-pic-delete]");
    if (cp) { try { await navigator.clipboard.writeText(`img:${cp.dataset.picCopy}`); toast(`Copied img:${cp.dataset.picCopy}`); } catch { toast(`img:${cp.dataset.picCopy}`); } }
    if (rn) {
      const p = L.pics.find((x) => x.id === rn.dataset.picRename), D = window.ConsoleDialog;
      D.open({ title: "Rename picture", body: D.field("p-rename", "Name", `<input id="p-rename" maxlength="80" value="${esc(p.name)}">`, `Its key stays img:${esc(p.key)}, so layouts that use it don't change.`),
        async save() { await Auth.db(`layout_images?id=eq.${p.id}`, { method: "PATCH", body: { name: $("p-rename").value.trim() }, prefer: "return=minimal" }); await loadPictures(); } });
    }
    if (rm) {
      const p = L.pics.find((x) => x.id === rm.dataset.picDelete);
      if (!confirm(`Remove the picture "${p.name || p.key}"? This can't be undone.`)) return;
      try { await Auth.api("/api/layouts", { method: "POST", body: { action: "delete_image", id: p.id } }); toast("Picture removed."); await loadPictures(); }
      catch (ex) { toast(ex.message, true); }
    }
  });

  // ── The layout's menu (DP-12, E2a; 1Point): the lists its blocks show, which the customer edits in menu-edit.html ──
  const LISTABLE = { items: "items", chips: "items", rotator: "pictures", photo: "a picture", text: "text", hours: "hours" };
  function menuBox() {
    const l = L.current, box = $("layout-menu-box"); if (!l) return;
    if (!document.querySelector('[data-lpane="menu"]').hidden) listsTable();
    const m = l.menu_id ? look().menu(l.menu_id) : null;
    if (!("menu_id" in l)) { box.innerHTML = `<p class="hint">Menus come with 32-menus.sql.</p>`; return; }
    if (m) {
      box.innerHTML = `<div class="row"><span>Its lists come from <strong>${esc(m.name)}</strong>${m.rev ? ` · save ${m.rev}, ${since(m.updated_at)}` : ""}.</span></div>
        <div class="row"><a class="ghost" href="/menu-edit.html?m=${m.id}" target="_blank" rel="noopener">Edit the menu</a>
          <button type="button" class="ghost" id="menu-spec">List settings</button>
          <button type="button" class="ghost" id="menu-make">Add lists from this layout</button>
          <label class="check inline"><input type="checkbox" id="menu-cust"${m.customer_edit ? " checked" : ""}> The customer edits it too</label></div>
        <p class="hint">A block shows a list with <code>"list": "&lt;key&gt;"</code>; its heading, size and place stay here. The customer can't change the layout, only the lists (and only up to each list's room).</p>`;
      return;
    }
    const same = S().menus.filter((x) => x.org_id === l.org_id);
    box.innerHTML = `<p class="hint">No menu yet: everything on this layout is written here, so only 1Point can change it.</p>
      <div class="row"><button type="button" class="primary" id="menu-make">Make lists from this layout</button>
      ${same.length ? `<span class="sub">or use</span><select id="menu-pick">${same.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select><button type="button" class="ghost" id="menu-use">Use this menu</button>` : ""}</div>`;
  }
  $("layout-menu-box").addEventListener("change", async (e) => {
    if (e.target.id !== "menu-cust") return;
    const m = look().menu(L.current.menu_id);
    try { await Auth.db(`menus?id=eq.${m.id}`, { method: "PATCH", body: { customer_edit: e.target.checked }, prefer: "return=minimal" }); await window.ConsoleRefresh(); menuBox();
      toast(e.target.checked ? "The customer can edit this menu." : "Only 1Point edits this menu now (a full maintenance plan)."); }
    catch (ex) { toast(ex.message, true); e.target.checked = !e.target.checked; }
  });
  $("layout-menu-box").addEventListener("click", async (e) => {
    const l = L.current, D = window.ConsoleDialog;
    if (e.target.id === "menu-use") {
      try { await Auth.db(`layouts?id=eq.${l.id}`, { method: "PATCH", body: { menu_id: $("menu-pick").value }, prefer: "return=minimal" }); l.menu_id = $("menu-pick").value; await window.ConsoleRefresh(); menuBox();
        toast("Chosen. Give its blocks \"list\" keys, then check, preview and publish."); }
      catch (ex) { toast(ex.message, true); }
    }
    if (e.target.id === "menu-make") {
      const p = parse(); if (p.error) { showResults({ errors: [{ where: "layout", msg: p.error }] }); return; }
      // Lists are made from the draft, so the JSON here is checked (and kept as the draft) first
      try {
        const r = await Auth.api("/api/layouts", { method: "POST", body: { action: "check", layout_id: l.id, doc: p.doc } });
        if (r.errors.length) { showResults({ ...r }); return; }
        l.draft = p.doc;
      } catch (ex) { showResults({ errors: ex.data?.errors || [{ where: "layout", msg: ex.message }] }); return; }
      const { extractMenu } = await import("/menu-format.mjs");
      const adding = !!l.menu_id, theMenu = adding ? look().menu(l.menu_id) : null;   // E2b: more lists on its menu
      const ex = extractMenu(p.doc, (p.doc.blocks || []).filter((b) => LISTABLE[b.type] && !b.content?.list).map((b) => b.id));
      const dflt = extractMenu(p.doc);
      if (!ex.made.length) { toast(adding ? "Every block that can show a list already does." : "This layout has no items, pictures, text or hours to turn into lists.", true); return; }
      D.open({
        title: adding ? `Add lists to ${theMenu?.name || "its menu"}` : "Make lists from this layout",
        body: `${adding ? `<p class="hint">The ticked blocks become more lists on <strong>${esc(theMenu?.name || "")}</strong>, the menu this layout already shows (kept as a new save, made by 1Point). A key the menu already has gets "-2".</p>`
          : D.field("mk-name", "Menu name", `<input id="mk-name" maxlength="80" value="${esc(`${look().org(l.org_id)?.name || l.name}: menu`)}">`, "The customer sees this in the console. One menu can feed several boards and the phone menu.")}
          <p class="hint">Each ticked block becomes a list the customer edits, holding what it shows now, under the name given here (the board's heading doesn't change). Room: how many entries the list can hold (about a third more than now: past it is a menu expansion). Every box can be changed later under List settings.</p>
          <ul class="make-lists">${ex.spec.lists.map((x) => { const b = p.doc.blocks.find((y) => y.id === x.key); const on = dflt.made.includes(x.key);
            return `<li><input type="checkbox" data-mk="${esc(x.key)}"${on ? " checked" : ""} aria-label="Make a list from ${esc(x.key)}">
              <span><input data-name="${esc(x.key)}" maxlength="60" value="${esc(x.name)}" aria-label="List name for ${esc(x.key)}"> <span class="sub">${esc(x.key)} · ${LISTABLE[b.type]} · ${(ex.content.lists[x.key]?.entries || []).length} now</span></span>
              ${x.kind === "text" ? `<span class="sub">room 1</span>` : `<label class="sub">room <input type="number" min="1" max="${x.kind === "hours" ? 14 : 60}" value="${x.room}" data-room="${esc(x.key)}"></label>`}</li>`; }).join("")}</ul>`,
        async save() {
          const blocks = [...document.querySelectorAll("[data-mk]")].filter((x) => x.checked).map((x) => x.dataset.mk);
          if (!blocks.length) throw new Error("Tick at least one block.");
          const rooms = Object.fromEntries([...document.querySelectorAll("[data-room]")].map((x) => [x.dataset.room, Number(x.value)]));
          const names = Object.fromEntries([...document.querySelectorAll("[data-name]")].map((x) => [x.dataset.name, x.value.trim()]));
          await makeLists({ blocks, rooms, names, name: $("mk-name")?.value.trim() || "" });
          showLTab("design");
        },
      });
    }
    if (e.target.id === "menu-spec") openListSettings(look().menu(l.menu_id));
  });

  // ── List settings as a form (DP-12, after E2b; Scot: menu edits never need code): one card per list. The JSON is
  //    still there behind Advanced, for 1Point. The database checks every rule again on save. ──
  const BOXES = { items: [["name", "Name"], ["line", "Description"], ["price", "Price"], ["image", "Picture"], ["tags", "Tags"], ["link", "Web link"]],
    text: [["title", "Heading"], ["body", "Text"], ["link", "Web link"]], hours: [] };
  const KIND_LABEL = { items: "Items", text: "Text (one entry)", hours: "Hours" };
  function listCard(Lt, used, F) {
    const boxes = BOXES[Lt.kind].map(([f, label]) => {
      const on = Lt.fields.includes(f), capped = F.FIELD_MAX[f], must = f === "name" && Lt.kind === "items";
      return `<div class="ls-box"><label class="check inline"><input type="checkbox" data-ls-field="${f}"${on ? " checked" : ""}${must ? " disabled" : ""}> ${label}</label>
        ${capped ? `<label class="ls-cap">most <input type="number" min="4" max="${capped}" value="${F.capOf(Lt, f)}" data-ls-cap="${f}" aria-label="Most characters for ${label}"${on ? "" : " disabled"}></label>` : ""}</div>`;
    }).join("");
    const sw = (k, label, show) => (show ? `<label class="check inline"><input type="checkbox" data-ls-sw="${k}"${Lt[k] ? " checked" : ""}> ${label}</label>` : "");
    return `<section class="ls-card" data-ls-key="${esc(Lt.key)}" data-ls-kind="${Lt.kind}">
      <div class="ls-head"><strong>${esc(Lt.name)}</strong> <span class="sub">${esc(KIND_LABEL[Lt.kind])} · key ${esc(Lt.key)} · ${used} on it now</span></div>
      <div class="ls-row">
        <label class="ls-name">Name the customer sees <input data-ls="name" maxlength="60" value="${esc(Lt.name)}"></label>
        <label class="ls-room">Room <input type="number" data-ls="room" min="${Math.max(1, used)}" max="${F.KINDS[Lt.kind].maxRoom}" value="${Lt.room}"${Lt.kind === "text" ? " disabled" : ""}></label>
      </div>
      ${BOXES[Lt.kind].length ? `<div class="ls-boxes"><span class="field-label">Boxes the customer fills</span>${boxes}</div>` : ""}
      <div class="ls-row">${sw("groupPrice", "Price over the whole list (e.g. $1.89 each)", Lt.kind === "items")}${sw("note", "Line under the hours", Lt.kind === "hours")}${sw("schedule", "Dates and times on each entry", Lt.kind !== "hours")}</div>
      <label class="ls-hint">Hint for the customer <span class="hint">optional, shown above the list</span><input data-ls="hint" maxlength="200" value="${esc(Lt.hint || "")}"></label>
    </section>`;
  }
  function specFromForm(old) {
    return { lists: old.lists.map((Lt) => {
      const card = document.querySelector(`.ls-card[data-ls-key="${CSS.escape(Lt.key)}"]`);
      if (!card) return Lt;
      const v = (k) => card.querySelector(`[data-ls="${k}"]`)?.value ?? "";
      const out = { key: Lt.key, name: v("name").trim(), kind: Lt.kind };
      if (Lt.kind === "text") out.room = 1; else out.room = Number(v("room"));
      if (Lt.kind !== "hours") {
        out.fields = BOXES[Lt.kind].map(([f]) => f).filter((f) => card.querySelector(`[data-ls-field="${f}"]`).checked || (f === "name" && Lt.kind === "items"));
        const caps = {};
        for (const f of out.fields) { const c = card.querySelector(`[data-ls-cap="${f}"]`); if (c) caps[f] = Number(c.value); }
        if (Object.keys(caps).length) out.caps = caps;
      }
      for (const k of ["groupPrice", "note", "schedule"]) { const c = card.querySelector(`[data-ls-sw="${k}"]`); if (c?.checked) out[k] = true; }
      if (v("hint").trim()) out.hint = v("hint").trim();
      return out;
    }) };
  }
  async function openListSettings(m) {
    const D = window.ConsoleDialog, F = await import("/menu-format.mjs");
    const [full] = await Auth.db(`menus?id=eq.${m.id}&select=id,name,spec,content`);
    const spec = F.checkMenuSpec(full.spec).spec || full.spec;
    const used = (k) => (full.content?.lists?.[k]?.entries || []).length;
    D.open({
      title: `List settings: ${full.name}`, wide: true,
      body: `${D.field("spec-name", "Menu name", `<input id="spec-name" maxlength="80" value="${esc(full.name)}">`, "The customer sees it in the console.")}
        <p class="hint">What the customer can do with each list on the boards. The headings, sizes and places on a board are its layout's. Room can't go below what's on a list now; a box can't be taken away while an entry uses it.</p>
        <div class="ls-cards">${spec.lists.map((Lt) => listCard(Lt, used(Lt.key), F)).join("")}</div>
        <details class="ls-advanced"><summary>Advanced: edit as JSON</summary>
          <p class="hint">For what the form doesn't do (taking a list off, which a published board mustn't show). Used instead of the form when changed.</p>
          <textarea id="spec-json" class="spec-json" spellcheck="false">${esc(JSON.stringify(full.spec, null, 2))}</textarea></details>`,
      afterOpen() {
        // a box's "most" is live only while the box is ticked
        $("dlg-body").addEventListener("change", (ev) => { const f = ev.target.dataset.lsField; if (f) { const c = ev.target.closest(".ls-box")?.querySelector("[data-ls-cap]"); if (c) c.disabled = !ev.target.checked; } });
      },
      async save() {
        const jsonBox = $("spec-json"), jsonChanged = jsonBox.value !== JSON.stringify(full.spec, null, 2);
        let next;
        if (jsonChanged) { try { next = JSON.parse(jsonBox.value); } catch (ex) { throw new Error(`The JSON under Advanced isn't valid: ${ex.message}`); } }
        // E2e: a layout pasted here by mistake (it has blocks, a grid or an orientation; list settings have only "lists")
        if (next && typeof next === "object" && ["blocks", "grid", "orientation", "format", "theme"].some((k) => k in next))
          throw new Error("This is a layout, not list settings. Cancel, then paste it on the Design tab, in Layout (JSON).");
        else next = specFromForm(spec);
        const c = F.checkMenuSpec(next);
        if (c.errors.length) throw new Error(c.errors.map((x) => `${x.where}: ${x.msg}`).join(" "));
        const cc = F.checkMenuContent(c.spec, full.content || { lists: {} });
        if (cc.errors.length) throw new Error(`What's on the lists now doesn't fit these settings: ${cc.errors.slice(0, 4).map((x) => `${x.where}: ${x.msg}`).join(" ")}`);
        await Auth.db(`menus?id=eq.${m.id}`, { method: "PATCH", body: { spec: next, name: $("spec-name").value.trim() || full.name }, prefer: "return=minimal" });
        await window.ConsoleRefresh(); menuBox(); toast("List settings saved. Boards on this menu follow within a minute.");
      },
    });
  }
  $("layout-room").addEventListener("change", () => $("layout-iframe").contentWindow?.postMessage({ type: "layout-room", on: $("layout-room").checked }, location.origin));

  window.ConsoleLayouts = {
    show() { if (!L.current) renderList(); else fitFrame(); },
    refreshed() { if (!$("panel-layouts").hidden) { if (L.current) { meta(); menuBox(); } else renderList(); } },
  };
})();
