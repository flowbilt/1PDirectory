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
    meta(); await loadVersions();
    history.replaceState(null, "", `#layouts`);
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
    } catch (ex) { showResults({ errors: ex.data?.errors || [{ where: "layout", msg: ex.message }] }); }
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
    meta(); await loadVersions();
  }

  window.ConsoleLayouts = {
    show() { if (!L.current) renderList(); else fitFrame(); },
    refreshed() { if (!$("panel-layouts").hidden) { if (L.current) meta(); else renderList(); } },
  };
})();
