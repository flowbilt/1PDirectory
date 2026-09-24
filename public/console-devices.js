/* Console: the Pis behind the screens (agent phase 1).
   Loaded after console.js; hooks in through window.ConsoleDevices. */
window.ConsoleDevices = (() => {
  "use strict";
  const { esc, toast, since } = window.UI;
  const ONLINE_MIN = 15;
  let devices = [];
  let admin = false;
  const shots = new Map(); // device id -> object URL
  const $ = (id) => document.getElementById(id);

  const fresh = (iso) => iso && Date.now() - Date.parse(iso) <= ONLINE_MIN * 60000;
  const forScreen = (screenId) => devices.find((d) => d.screen_id === screenId);

  async function load(isAdmin) {
    admin = isAdmin;
    if (!admin) { devices = []; return; }          // Pi health is a 1Point tool; owners never load it
    try { devices = (await Auth.api("/api/devices")).devices; } catch { devices = []; }
    renderNew();
  }

  /** Extra status line under a screen's status: what its Pi says. */
  function statusNote(screen) {
    if (!admin) return "";
    const d = forScreen(screen.id);
    if (!d) return `<div class="sub">No agent</div>`;
    const h = d.last_health || {};
    const bits = [];
    if (!fresh(d.last_seen)) bits.push(d.last_seen ? `<span class="warn">Pi offline</span>` : `<span class="sub">Pi not checked in</span>`);
    else if (!fresh(screen.last_seen)) bits.push(`<span class="warn">Pi on, screen not reporting</span>`);
    if (h.under_voltage_now) bits.push(`<span class="warn" title="Weak power supply">⚡ Power low</span>`);
    else if (h.under_voltage_seen) bits.push(`<span class="sub" title="Under-voltage since last boot">⚡ Power dipped</span>`);
    if (typeof h.temp_c === "number") bits.push(`<span class="${h.temp_c >= 80 ? "warn" : "sub"}">${Math.round(h.temp_c)}°C</span>`);
    return `<div class="dev-note">${bits.join(" · ")}</div>`;
  }

  function thumbCell(screen) {
    const d = forScreen(screen.id);
    if (!d || !d.screenshot_at) return `<td class="thumb admin-only"></td>`;
    return `<td class="thumb admin-only"><button type="button" class="thumb-btn" data-device="${d.id}" aria-label="Screenshot of ${esc(screen.name)}"><img data-shot="${d.id}" alt=""></button></td>`;
  }

  function actionButton(screen) {
    const d = forScreen(screen.id);
    return d ? `<button type="button" class="ghost" data-device="${d.id}">Pi</button>` : "";
  }

  async function fillThumbs(root) {
    for (const img of root.querySelectorAll("img[data-shot]")) {
      const id = img.dataset.shot, d = devices.find((x) => x.id === id);
      const key = `${id}@${d?.screenshot_at}`;
      if (!shots.has(key)) shots.set(key, await Auth.blob(`/api/devices?screenshot=${id}`));
      if (shots.get(key)) img.src = shots.get(key);
    }
  }

  // ── New devices (1Point) ──
  function renderNew(screens = window.ConsoleState?.screens || []) {
    const list = admin ? devices.filter((d) => !d.screen_id) : [];
    $("new-devices").hidden = !list.length;
    const taken = new Set(devices.filter((d) => d.screen_id).map((d) => d.screen_id));
    const opts = `<option value="">Choose a screen…</option>` + screens.filter((s) => !taken.has(s.id)).map((s) => `<option value="${s.id}">${esc(s.name)} (${esc(s.key)})</option>`).join("");
    $("new-device-rows").innerHTML = list.map((d) => `<tr>
      <td><strong>${esc(d.serial)}</strong><div class="sub">${esc(d.model || "")}${d.last_health?.ip ? ` · ${esc(d.last_health.ip)}` : ""}</div></td>
      <td>${since(d.created_at)}</td><td>${since(d.last_seen)}</td>
      <td><select data-assign="${d.id}" aria-label="Assign ${esc(d.serial)}">${opts}</select></td></tr>`).join("");
  }
  document.addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-assign]");
    if (!sel || !sel.value) return;
    try {
      await Auth.api("/api/devices", { method: "POST", body: { action: "assign", device_id: sel.dataset.assign, screen_id: sel.value } });
      toast("Assigned. The Pi switches to that screen within a minute.");
      await window.ConsoleRefresh();
    } catch (ex) { toast(ex.message, true); }
  });

  // ── The Pi panel ──
  const ACTIONS = [
    ["reload", "Reload screen", "Restarts the browser. Takes about 15 seconds.", false],
    ["screenshot", "Take screenshot", "A fresh picture of the TV within a minute.", false],
    ["reboot", "Reboot Pi", "The screen is blank for about a minute.", true],
    ["update_agent", "Update agent", "Installs the latest agent from the site.", true],
  ];
  function panel(deviceId) {
    const d = devices.find((x) => x.id === deviceId);
    if (!d) return;
    const s = (window.ConsoleState?.screens || []).find((x) => x.id === d.screen_id);
    const h = d.last_health || {};
    const row = (k, v) => (v === undefined || v === null || v === "" ? "" : `<dt>${k}</dt><dd>${esc(v)}</dd>`);
    const up = h.uptime_s ? `${Math.floor(h.uptime_s / 86400)}d ${Math.floor((h.uptime_s % 86400) / 3600)}h` : "";
    const dlg = $("dev-dlg") || document.body.appendChild(Object.assign(document.createElement("dialog"), { id: "dev-dlg", className: "dev-dlg" }));
    dlg.innerHTML = `<div class="dev-panel">
      <header><h2>${esc(s?.name || "New device")}</h2><button type="button" class="ghost" data-close>Close</button></header>
      <div class="dev-body">
        <figure class="dev-shot">${d.screenshot_at ? `<img id="dev-shot-img" alt="What the screen is showing">` : `<div class="empty-rows">No screenshot yet</div>`}
          <figcaption class="sub">${d.screenshot_at ? `Screenshot ${since(d.screenshot_at)}` : ""}</figcaption></figure>
        <div>
          <dl class="dev-facts">
            ${row("Pi", `${d.serial}${d.model ? ` · ${d.model}` : ""}`)}
            ${row("Pi last check-in", since(d.last_seen))}
            ${row("Temperature", typeof h.temp_c === "number" ? `${h.temp_c}°C` : "")}
            ${row("Power", h.under_voltage_now ? "Under-voltage now: replace the power supply" : h.under_voltage_seen ? "Dipped since last boot" : h.throttled !== undefined ? "Normal" : "")}
            ${row("Browser", h.browser_running === false ? "Not running" : "Running")}
            ${row("Up for", up)}
            ${row("Storage used", h.disk_used_pct != null ? `${h.disk_used_pct}%` : "")}
            ${row("Address", h.ip)}
            ${row("System", h.os)}
            ${row("Agent", d.agent_version)}
          </dl>
          <div class="dev-actions">
            ${s ? `<button type="button" class="ghost" data-identify="${s.id}" title="Shows the screen's name on the TV for 90 seconds">Identify</button>` : ""}
            ${ACTIONS.filter(([, , , adminOnly]) => admin || !adminOnly).map(([c, label, hint]) => `<button type="button" class="ghost" data-cmd="${c}" title="${esc(hint)}">${label}</button>`).join("")}
          </div>
          ${admin ? `<details class="hw"><summary>More</summary><div class="dev-actions">
            <button type="button" class="ghost" data-dev-action="reset_key" title="Use if this Pi was reflashed and now gets 'key doesn't match'">Reset device key</button>
            <button type="button" class="ghost danger" data-dev-action="${d.status === "revoked" ? "activate" : "revoke"}">${d.status === "revoked" ? "Switch back on" : "Switch off (refuse this Pi)"}</button>
            ${d.screen_id ? `<button type="button" class="ghost" data-dev-action="unassign">Unassign from screen</button>` : ""}
          </div></details>` : ""}
          <h3>Recent actions</h3>
          <ul class="dev-cmds">${d.commands.length ? d.commands.map((c) => `<li><strong>${esc(c.command.replace("_", " "))}</strong> · ${esc(c.status)}${c.result ? ` · ${esc(c.result)}` : ""} <span class="sub">${since(c.created_at)}</span></li>`).join("") : `<li class="sub">None yet</li>`}</ul>
        </div>
      </div></div>`;
    dlg.showModal();
    if (d.screenshot_at) Auth.blob(`/api/devices?screenshot=${d.id}`).then((u) => { const i = $("dev-shot-img"); if (u && i) i.src = u; });
    dlg.onclick = async (e) => {
      if (e.target === dlg || e.target.closest("[data-close]")) return dlg.close();
      const cmd = e.target.closest("[data-cmd]")?.dataset.cmd;
      const ident = e.target.closest("[data-identify]")?.dataset.identify;
      const act = e.target.closest("[data-dev-action]")?.dataset.devAction;
      try {
        if (cmd) {
          if (cmd === "reboot" && !confirm("Reboot this Pi? The screen will be blank for about a minute.")) return;
          await Auth.api("/api/devices", { method: "POST", body: { action: "command", device_id: d.id, command: cmd } });
          toast("Sent. The Pi picks it up within a minute.");
        } else if (ident) {
          await Auth.api("/api/devices", { method: "POST", body: { action: "identify", screen_id: ident } });
          toast("The screen will show its name for 90 seconds, starting within a minute.");
        } else if (act) {
          if (act === "revoke" && !confirm("Switch off this Pi? It will be refused until switched back on.")) return;
          const body = act === "unassign" ? { action: "assign", device_id: d.id, screen_id: null } : { action: act, device_id: d.id };
          await Auth.api("/api/devices", { method: "POST", body });
          toast("Done."); dlg.close(); await window.ConsoleRefresh();
        }
      } catch (ex) { toast(ex.message, true); }
    };
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-device]");
    if (b) panel(b.dataset.device);
  });

  // ── Health tab: every Pi at a glance, with uptime history ──
  let health = null;
  const fmtPct = (v) => (v === null || v === undefined ? "–" : `${v}%`);
  const pctClass = (v) => (v === null || v === undefined ? "sub" : v >= 99 ? "good" : v >= 95 ? "" : "warn");
  async function loadHealth() {
    try { health = await Auth.api("/api/devices?summary=1"); } catch (ex) { toast(ex.message, true); return; }
    const accounts = [...new Set(health.devices.map((d) => d.account).filter(Boolean))].sort();
    const sel = $("health-account"), keep = sel.value;
    sel.innerHTML = `<option value="">All accounts</option>` + accounts.map((a) => `<option${a === keep ? " selected" : ""}>${esc(a)}</option>`).join("");
    renderHealth();
  }
  function healthRows() {
    const q = $("health-search").value.trim().toLowerCase(), acct = $("health-account").value, probs = $("health-problems").checked;
    return health.devices
      .filter((d) => (!acct || d.account === acct) && (!probs || d.problems.length))
      .filter((d) => !q || [d.screen?.name, d.screen?.key, d.building, d.account, d.serial, d.ip].join(" ").toLowerCase().includes(q))
      .sort((a, b) => b.problems.length - a.problems.length || String(a.screen?.name || "~").localeCompare(String(b.screen?.name || "~")));
  }
  function renderHealth() {
    if (!health) return;
    const f = health.fleet;
    $("health-cards").innerHTML = [
      ["Online", f.online, "good"], ["Offline", f.offline, f.offline ? "bad" : ""], ["Not checked in yet", f.never, ""],
      ["Need attention", f.with_problems, f.with_problems ? "bad" : "good"], ["Fleet uptime, 30 days", fmtPct(f.uptime_30d), pctClass(f.uptime_30d)],
    ].map(([label, v, cls]) => `<div class="hcard ${cls}"><div class="hval">${v}</div><div class="hlabel">${label}</div></div>`).join("");
    $("health-note").textContent = `${f.devices} Pis · updated ${new Date(health.generated_at).toLocaleTimeString()}`;
    const rows = healthRows();
    $("health-rows").innerHTML = rows.length ? rows.map((d) => `<tr class="${d.problems.length ? "has-problem" : ""}">
      <td><span class="dot ${d.online ? "online" : d.last_seen ? "offline" : "never"}"></span>${d.online ? "Online" : d.last_seen ? "Offline" : "Not yet"}
        ${d.problems.length ? `<div class="dev-note warn">${d.problems.map(esc).join(" · ")}</div>` : ""}</td>
      <td>${d.screen ? `<strong>${esc(d.screen.name)}</strong><div class="sub">${esc(d.building || "")}${d.account ? ` · ${esc(d.account)}` : ""}</div>` : `<span class="warn">Not assigned</span>`}</td>
      <td class="nums"><span class="${pctClass(d.uptime.d1)}">${fmtPct(d.uptime.d1)}</span> · <span class="${pctClass(d.uptime.d7)}">${fmtPct(d.uptime.d7)}</span> · <span class="${pctClass(d.uptime.d30)}">${fmtPct(d.uptime.d30)}</span>
        ${d.history_from ? `<div class="sub">since ${esc(d.history_from)}</div>` : ""}</td>
      <td class="nums">${d.power_now ? `<span class="warn">Low</span>` : d.last_seen ? "OK" : "–"} · ${d.dips.d7} · ${d.dips.d30}</td>
      <td class="nums">${d.temp_now !== null ? `<span class="${d.temp_now >= 80 ? "warn" : ""}">${Math.round(d.temp_now)}°C</span>` : "–"} · ${d.max_temp_7d !== null ? `${Math.round(d.max_temp_7d)}°C` : "–"}</td>
      <td class="nums">${d.browser_down_7d ? `<span class="warn">${d.browser_down_7d} min</span>` : d.last_seen ? "0 min" : "–"}</td>
      <td><button type="button" class="linkish" data-device="${d.id}">${esc(d.serial)}</button><div class="sub">${esc(d.ip || "")}${d.agent_version ? ` · agent ${esc(d.agent_version)}` : ""}</div></td>
      <td>${since(d.last_seen)}</td></tr>`).join("") : `<tr><td colspan="8" class="empty-rows">No devices match.</td></tr>`;
  }
  ["health-search", "health-account", "health-problems"].forEach((id) => document.addEventListener("input", (e) => { if (e.target.id === id) renderHealth(); }));
  document.addEventListener("click", (e) => {
    if (e.target.id !== "health-csv" || !health) return;
    const cols = ["Screen", "Screen address", "Building", "Account", "Pi serial", "Status", "Uptime today %", "Uptime 7 days %", "Uptime 30 days %", "Power now", "Power dips 7 days", "Power dips 30 days", "Temp now C", "Peak temp 7 days C", "Browser down 7 days (min)", "IP", "Agent", "Last check-in", "History since", "Problems"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [cols.map(q).join(",")].concat(healthRows().map((d) => [d.screen?.name, d.screen?.key, d.building, d.account, d.serial, d.online ? "Online" : d.last_seen ? "Offline" : "Not yet",
      d.uptime.d1, d.uptime.d7, d.uptime.d30, d.power_now ? "Low" : "OK", d.dips.d7, d.dips.d30, d.temp_now, d.max_temp_7d, d.browser_down_7d, d.ip, d.agent_version, d.last_seen, d.history_from, d.problems.join("; ")].map(q).join(",")));
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" })), download: `pi-health-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
  });

  return { load, statusNote, thumbCell, actionButton, fillThumbs, renderNew, loadHealth, list: () => devices };
})();
