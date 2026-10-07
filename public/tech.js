/* The technician page (/tech.html): one screen at a time, on a phone. 1Point logins only.
   Identify, Reload screen, Reboot Pi, Layout, and Wi-Fi search and join. Everything goes through /api/devices, which
   refuses anyone who isn't 1Point, so this page adds no access of its own. Reset device key, Unassign and the updates
   stay in the console. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const { esc, toast, since } = window.UI;
  const ONLINE_MIN = 15;                    // same as the console
  const WIFI_AGENT = "1.6.0";               // netlify/functions/agent.mjs
  const LAYOUTS = { auto: "Automatic (match the TV)", portrait: "Portrait", "portrait-flipped": "Portrait (turned the other way)",
                    landscape: "Landscape", "landscape-flipped": "Landscape (upside down)" };
  const NAMES = { reload: "Reload screen", reboot: "Reboot Pi", screenshot: "Screenshot", update_agent: "Update agent",
                  update_pi: "Update Pi", wifi_scan: "Wi-Fi search", wifi_join: "Wi-Fi join" };
  const STATES = { pending: "waiting for the Pi", sent: "running", done: "done", failed: "failed", expired: "not picked up (expired)" };

  const S = { screens: [], dirs: [], props: [], devices: [], saved: [], id: null, shown: null, scanId: null, joinId: null, drawnScan: null, fastUntil: 0,
              saveJoin: null };   // the join sent with Save ticked; the server saves it when the Pi says it worked
  let timer = null;

  const agentAtLeast = (have, want) => {
    const a = String(have || "").split(/[.-]/).map(Number), b = want.split(".").map(Number);
    if (!a.length || Number.isNaN(a[0])) return false;
    for (let i = 0; i < b.length; i++) { const x = Number.isFinite(a[i]) ? a[i] : 0; if (x !== b[i]) return x > b[i]; }
    return true;
  };
  const fresh = (iso) => !!iso && Date.now() - Date.parse(iso) <= ONLINE_MIN * 60000;
  const building = (s) => { const d = S.dirs.find((x) => x.id === s.directory_id); return d ? S.props.find((p) => p.id === d.property_id)?.name || "" : ""; };
  const piFor = (s) => S.devices.find((d) => d.screen_id === s.id);
  const parseScan = (c) => { try { return JSON.parse(c.result); } catch { return null; } };
  // A successful join sent after the search shown: the Pi is on that network now, whatever the search said.
  // The agent's result starts "Joined <network>; the directory site is reachable…".
  const joinedSince = (d, scan) => {
    const j = d?.commands.filter((c) => c.command === "wifi_join" && c.status === "done" && (!scan || c.created_at > scan.created_at))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    const m = j && /^Joined (.+?); the directory site is reachable/.exec(j.result || "");
    return m ? m[1] : null;
  };
  const strength = (n) => (n >= 67 ? "Strong" : n >= 40 ? "Good" : "Weak");

  // ── Loading ──
  async function loadAll() {
    const [screens, dirs, props] = await Promise.all([
      Auth.db("screens?select=id,directory_id,key,name,orientation&order=name.asc"),
      Auth.db("directories?select=id,property_id"),
      Auth.db("properties?select=id,name"),
    ]);
    Object.assign(S, { screens, dirs, props });
    await Promise.all([loadDevices(), loadSaved()]);
  }
  async function loadDevices() { S.devices = (await Auth.api("/api/devices")).devices; }
  /** The saved Wi-Fi's names (never passwords): a saved network joins with one tap. */
  async function loadSaved() { try { S.saved = (await Auth.api("/api/networks")).networks; } catch { S.saved = []; } }
  const savedNet = (ssid) => S.saved.find((n) => n.ssid === ssid);

  // ── Every screen ──
  function renderList() {
    const q = $("search").value.trim().toLowerCase();
    const rows = S.screens
      .map((s) => ({ s, b: building(s), d: piFor(s) }))
      .filter(({ s, b, d }) => !q || [s.name, s.key, b, d?.serial].join(" ").toLowerCase().includes(q))
      .sort((x, y) => x.b.localeCompare(y.b) || x.s.name.localeCompare(y.s.name));
    $("screen-list").innerHTML = rows.length ? rows.map(({ s, b, d }) => {
      const st = !d ? "No Pi" : !d.enrolled ? "Pi not enrolled" : fresh(d.last_seen) ? "Pi online" : d.last_seen ? `Pi offline, ${since(d.last_seen)}` : "Pi not checked in";
      const dot = d && d.enrolled ? (fresh(d.last_seen) ? "online" : d.last_seen ? "offline" : "") : "";
      return `<li><a href="#s=${encodeURIComponent(s.id)}"><span class="dot ${dot}"></span><strong>${esc(s.name)}</strong>
        <span class="sub">${b && b !== s.name ? `${esc(b)}. ` : !b ? "No building. " : ""}${esc(st)}</span></a></li>`;
    }).join("") : `<li class="t-empty">No screens match "${esc(q)}".</li>`;
  }
  $("search").addEventListener("input", renderList);

  // ── One screen ──
  function renderScreen() {
    const s = S.screens.find((x) => x.id === S.id);
    if (!s) { location.hash = ""; return; }
    const d = piFor(s), h = d?.last_health || {};
    const first = S.shown !== s.id;
    if (first) {
      S.shown = s.id; S.drawnScan = null; S.joinId = null;
      // A search from the last 10 minutes is still worth showing
      const recent = d?.commands.find((c) => c.command === "wifi_scan" && Date.now() - Date.parse(c.created_at) < 600_000);
      S.scanId = recent?.id || null;
      $("wifi-list").hidden = true; $("wifi-other").hidden = true; $("wifi-result").hidden = true;
      $("layout").innerHTML = Object.entries(LAYOUTS).map(([v, l]) => `<option value="${v}"${(s.orientation || "auto") === v ? " selected" : ""}>${l}</option>`).join("");
      window.scrollTo(0, 0);
    }
    $("s-name").textContent = s.name;
    $("s-where").textContent = building(s) || "No building";

    const status = $("s-status");
    let note = "";
    if (!d) { status.textContent = "No Pi is assigned to this screen"; status.className = "t-status"; note = "Identify still works. The office assigns a Pi to this screen in the console."; }
    else if (!d.enrolled) { status.textContent = "Pi not enrolled yet"; status.className = "t-status"; note = "Pi actions work once the office enrolls it (Pi, Open enrollment in the console)."; }
    else if (fresh(d.last_seen)) { status.textContent = `Pi online, checked in ${since(d.last_seen)}`; status.className = "t-status good"; }
    else {
      status.textContent = d.last_seen ? `Pi offline, last checked in ${since(d.last_seen)}` : "Pi hasn't checked in yet";
      status.className = "t-status bad";
      note = "Anything you send waits for the Pi's next check-in, and is dropped if it isn't picked up within an hour.";
    }
    if (d && h.tv === "standby") note += `${note ? " " : ""}The TV is off; the Pi is turning it back on.`;
    if (d && h.tv === "not-answering") note += `${note ? " " : ""}The TV isn't answering over HDMI: it's unplugged, or its CEC setting (SimpLink on LG) is off.`;
    if (d && h.under_voltage_now) note += `${note ? " " : ""}The Pi's power supply is too weak right now: replace it.`;
    $("s-note").textContent = note; $("s-note").hidden = !note;
    const facts = d ? [d.serial && `Pi ${d.serial}`, h.ip && `address ${h.ip}`, d.agent_version && `agent ${d.agent_version}`].filter(Boolean).join(", ") : "";
    $("s-where").textContent = [building(s) || "No building", facts].filter(Boolean).join(". ");

    const canPi = !!d?.enrolled;
    document.querySelectorAll("[data-pi]").forEach((b) => (b.disabled = !canPi));
    $("layout-save").textContent = canPi ? "Save and restart Pi" : "Save layout";
    $("layout-hint").textContent = canPi ? "The Pi restarts to turn the picture (dark for about a minute)." : "Saved for this screen; a Pi turns to match at its next start.";

    renderWifi(d);
    $("s-actions").innerHTML = d?.commands.length ? d.commands.map((c) => {
      const scan = c.command === "wifi_scan" && c.status === "done" ? parseScan(c) : null;
      const result = scan ? `found ${scan.networks.length} network${scan.networks.length === 1 ? "" : "s"}` : c.result;
      return `<li class="${c.status === "failed" ? "failed" : ""}"><strong>${esc(NAMES[c.command] || c.command)}</strong>, ${esc(STATES[c.status] || c.status)}${result ? `: ${esc(result)}` : ""}
        <span class="sub">${since(c.created_at)}</span></li>`;
    }).join("") : `<li class="sub">Nothing sent to this Pi yet.</li>`;
  }

  // ── Wi-Fi ──
  function renderWifi(d) {
    const ok = !!d?.enrolled && agentAtLeast(d.agent_version, WIFI_AGENT);
    $("wifi-scan").disabled = !ok;
    const scan = S.scanId && d?.commands.find((c) => c.id === S.scanId);
    const list = scan?.status === "done" ? parseScan(scan) : null;
    const joined = list ? joinedSince(d, scan) : null;   // moves "On Wi-Fi" and Connected without a new search
    if (!d?.enrolled) $("wifi-now").textContent = "Available once a Pi is assigned and enrolled.";
    else if (!ok) $("wifi-now").textContent = `This Pi's agent (${d.agent_version || "unknown"}) can't do Wi-Fi from here yet. Ask the office to run Update agent on it.`;
    else if (list) {
      const curSsid = joined || list.networks.find((n) => n.current)?.ssid;
      $("wifi-now").textContent = list.wired
        ? `On a network cable${curSsid ? `, and on Wi-Fi ${curSsid} as a backup` : ""}. The cable is always used first.`
        : curSsid ? `On Wi-Fi: ${curSsid}.` : "Not on any Wi-Fi network.";
    } else $("wifi-now").textContent = "Search to see the networks this Pi can pick up, and which one it's on.";

    // Waiting on a search or a join
    const join = S.joinId && d?.commands.find((c) => c.id === S.joinId);
    const waiting = [scan, join].find((c) => c && ["pending", "sent"].includes(c.status));
    $("wifi-wait").hidden = !waiting;
    if (waiting) $("wifi-wait").textContent = waiting.command === "wifi_scan"
      ? (waiting.status === "pending" ? "Sent. The Pi picks it up within a minute…" : "The Pi is searching…")
      : (waiting.status === "pending" ? "Sent. The Pi picks it up within a minute, then takes up to two more to join and check it reaches the site…"
        : "The Pi is joining and checking it reaches the site…")
        + (waiting.command === "wifi_join" && S.saveJoin === waiting.id ? " It's saved for other screens as soon as the Pi confirms the join, even if you lock the phone or close this page." : "");
    if (scan && ["failed", "expired"].includes(scan.status) && S.drawnScan !== `x${scan.id}`) {
      S.drawnScan = `x${scan.id}`; showResult(false, scan.status === "expired" ? "The Pi didn't pick up the search within an hour." : scan.result);
    }
    if (join && ["done", "failed", "expired"].includes(join.status) && S.drawnJoin !== join.id) {
      S.drawnJoin = join.id;
      const text = join.status === "expired" ? "The Pi didn't pick up the join within an hour; nothing changed." : join.result;
      // The server adds what the save did to the join's result (supabase/20-save-wifi.sql)
      const m = /^(.*?) (Saved for other screens|The saved password is updated)(: .*)$/s.exec(text || "");
      if (m) {
        showResult(true, m[1], `${m[2]}${m[3]}`);
        toast(`${m[2]}.`);
        loadSaved().catch(() => {});
      } else showResult(join.status === "done", S.saveJoin === join.id && join.status === "expired" ? `${text} Nothing was saved.` : text);
      if (S.saveJoin === join.id) S.saveJoin = null;
    }

    // The list is drawn once per search (and again after a join moves the Pi), so a password being typed is never
    // wiped by the refresh
    const drawKey = `${scan?.id}|${joined || ""}`;
    if (list && S.drawnScan !== drawKey) {
      S.drawnScan = drawKey;
      // Saved hidden networks never show up in a search, so they're listed after it
      const seen = new Set(list.networks.map((n) => n.ssid));
      const nets = list.networks.map((n) => ({ ...n, current: joined ? n.ssid === joined : n.current, saved: !!savedNet(n.ssid) }))
        .concat(S.saved.filter((x) => x.hidden && !seen.has(x.ssid)).map((x) => ({ ssid: x.ssid, open: false, signal: null, current: false, saved: true, hidden: true })));
      $("wifi-list").innerHTML = nets.length ? nets.map((n, i) => `<li data-i="${i}">
        <button type="button" class="net"><strong>${esc(n.ssid)}</strong><span class="bars">${n.signal === null ? "Hidden" : strength(n.signal)}</span>
        <span class="sub">${n.current ? "Connected" : n.saved ? "Saved: joins without typing the password" : n.open ? "Open, no password" : "Password needed"}</span></button></li>`).join("")
        : `<li class="t-empty">The Pi can't see any networks. Check it's within range, or join one by name below.</li>`;
      $("wifi-list").hidden = false; $("wifi-other").hidden = false;
      $("wifi-list").dataset.nets = JSON.stringify(nets);
      $("wifi-list").dataset.wired = list.wired ? "1" : "";
    }
  }

  function showResult(good, text, saved) {
    const r = $("wifi-result");
    r.textContent = text || (good ? "Done." : "That didn't work.");
    if (saved) { const b = document.createElement("strong"); b.className = "t-saved"; b.textContent = saved; r.append(b); }
    r.className = `t-result ${good ? "good" : "bad"}`;
    r.hidden = false;
  }

  /** The join form, under the network that was tapped (or for a network that isn't listed). */
  function joinForm(li, net) {
    document.querySelectorAll(".t-join").forEach((f) => f.remove());
    const other = !net, useSaved = !!net?.saved && !net.typed;
    const wired = !!$("wifi-list").dataset.wired;
    const f = document.createElement("form");
    f.className = "t-join";
    f.innerHTML = `${other ? `<label for="j-ssid">Network name</label><input id="j-ssid" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="32" required>` : ""}
      ${!useSaved && (other || !net.open) ? `<label for="j-psk">Password${other ? " (leave empty for an open network)" : ""}</label>
        <input id="j-psk" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" maxlength="63">
        <label class="t-show"><input type="checkbox" id="j-show"> Show password</label>` : ""}
      ${useSaved ? "" : `<label class="t-show"><input type="checkbox" id="j-save"> ${net?.saved ? "Update the saved password once it works" : "Save for other screens once it works"}</label>`}
      <button type="submit">${useSaved ? "Join with the saved password" : `Join ${other ? "this network" : esc(net.ssid)}`}</button>
      ${useSaved ? `<button type="button" class="t-linkish" id="j-type">Type a different password</button>` : ""}
      <p class="t-hint">${wired ? "The network cable stays in charge; this Wi-Fi becomes the backup."
        : "The screen can drop offline for a minute while the Pi switches. If the new network doesn't reach the site, the Pi goes back to the one it had."}</p>`;
    (li || $("wifi-other")).insertAdjacentElement(li ? "beforeend" : "afterend", f);
    f.querySelector("#j-type")?.addEventListener("click", () => joinForm(li, { ...net, typed: true }));
    const show = f.querySelector("#j-show");
    if (show) show.addEventListener("change", () => { f.querySelector("#j-psk").type = show.checked ? "text" : "password"; });
    (f.querySelector("#j-ssid") || f.querySelector("#j-psk") || f.querySelector("button")).focus();
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const ssid = other ? f.querySelector("#j-ssid").value : net.ssid;
      const psk = f.querySelector("#j-psk")?.value || "";
      const hidden = other || !!net?.hidden;
      const keep = !!f.querySelector("#j-save")?.checked;
      if (!ssid) return toast("Type the network's name.", true);
      if (psk && (psk.length < 8 || psk.length > 63)) return toast("A Wi-Fi password is 8 to 63 characters.", true);
      const d = piFor(S.screens.find((x) => x.id === S.id));
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const body = useSaved ? { action: "command", device_id: d.id, command: "wifi_join", ssid, saved: true }
          : { action: "command", device_id: d.id, command: "wifi_join", ssid, psk, hidden, ...(keep ? { save: true } : {}) };
        const r = await Auth.api("/api/devices", { method: "POST", body });
        S.joinId = r.id; $("wifi-result").hidden = true;
        S.saveJoin = keep ? r.id : null;
        f.remove(); faster(180_000);
        await refresh();
      } catch (ex) { toast(ex.message, true); btn.disabled = false; }
    });
  }

  $("wifi-list").addEventListener("click", (e) => {
    const b = e.target.closest("button.net");
    if (!b) return;
    const li = b.closest("li"), nets = JSON.parse($("wifi-list").dataset.nets || "[]");
    if (li.querySelector(".t-join")) { li.querySelector(".t-join").remove(); return; }   // tapping it again closes it
    joinForm(li, nets[Number(li.dataset.i)]);
  });
  $("wifi-other").addEventListener("click", () => joinForm(null, null));

  $("wifi-scan").addEventListener("click", async () => {
    const d = piFor(S.screens.find((x) => x.id === S.id));
    try {
      const r = await Auth.api("/api/devices", { method: "POST", body: { action: "command", device_id: d.id, command: "wifi_scan" } });
      S.scanId = r.id; S.drawnScan = null;
      $("wifi-list").hidden = true; $("wifi-other").hidden = true; $("wifi-result").hidden = true;
      faster(120_000); await refresh();
    } catch (ex) { toast(ex.message, true); }
  });

  // ── Identify, Reload, Reboot ──
  document.querySelector(".t-buttons").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-do]");
    if (!b) return;
    const s = S.screens.find((x) => x.id === S.id), d = piFor(s), what = b.dataset.do;
    if (what === "reboot" && !confirm("Reboot this Pi? The screen is dark for about a minute.")) return;
    b.disabled = true;
    try {
      if (what === "identify") {
        await Auth.api("/api/devices", { method: "POST", body: { action: "identify", screen_id: s.id } });
        toast("The TV shows this screen's name for 90 seconds, starting within a minute.");
      } else {
        await Auth.api("/api/devices", { method: "POST", body: { action: "command", device_id: d.id, command: what } });
        toast(what === "reboot" ? "Sent. The Pi restarts within a minute." : "Sent. The browser restarts within a minute.");
        faster(120_000);
      }
      await refresh();
    } catch (ex) { toast(ex.message, true); }
    finally { b.disabled = what !== "identify" && !d?.enrolled; }
  });

  // ── Layout ──
  $("layout-save").addEventListener("click", async () => {
    const s = S.screens.find((x) => x.id === S.id), d = piFor(s), orientation = $("layout").value;
    const restart = !!d?.enrolled;
    if (restart && !confirm(`Set the layout to ${LAYOUTS[orientation]} and restart the Pi? The screen is dark for about a minute.`)) return;
    try {
      const r = await Auth.api("/api/devices", { method: "POST", body: { action: "layout", screen_id: s.id, orientation, restart } });
      s.orientation = orientation;
      toast(r.restarted ? "Saved. The Pi restarts within a minute and comes back turned." : "Saved. A Pi turns to match at its next start.");
      faster(120_000); await refresh();
    } catch (ex) { toast(ex.message, true); }
  });

  // ── Refreshing: every 10 seconds on a screen, every 3 for a while after sending something; never in the background ──
  function faster(ms) { S.fastUntil = Date.now() + ms; schedule(); }
  function schedule() { clearTimeout(timer); timer = setTimeout(tick, Date.now() < S.fastUntil ? 3000 : 10000); }
  async function tick() {
    if (!document.hidden) await refresh();
    schedule();
  }
  async function refresh() {
    try { await loadDevices(); } catch { return; }       // keep what's shown
    if (S.id) renderScreen(); else renderList();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  // ── Which view: #s=<screen id> is one screen, anything else the list ──
  function route() {
    const m = location.hash.match(/^#s=(.+)$/);
    S.id = m ? decodeURIComponent(m[1]) : null;
    $("view-list").hidden = !!S.id; $("view-screen").hidden = !S.id;
    if (S.id) renderScreen(); else { S.shown = null; renderList(); }
  }
  window.addEventListener("hashchange", route);
  $("back").addEventListener("click", (e) => { e.preventDefault(); history.length > 1 && S.cameFromList ? history.back() : (location.hash = ""); });
  $("screen-list").addEventListener("click", () => { S.cameFromList = true; });
  $("sign-out").addEventListener("click", () => Auth.signOut());

  (async () => {
    try {
      await Auth.requireSession();
      const me = await Auth.me();
      if (me.role !== "platform_admin") {
        $("load-error").textContent = `This page is for 1Point technicians. You're signed in as ${me.email}; to edit your buildings, use the console.`;
        $("load-error").hidden = false;
        return;
      }
      await loadAll();
      route(); schedule();
    } catch (ex) {
      if (ex.message === "Signing in…") return;
      $("load-error").textContent = ex.message; $("load-error").hidden = false;
    }
  })();
})();
