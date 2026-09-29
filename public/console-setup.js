/* Console: Pi setup (1Point only). The Wi-Fi networks every prepared card carries, and one-hour prepare codes for
   the bench Pi (setup-kiosk.sh --prepare --code ...). Passwords go in but never come back out. */
window.ConsoleSetup = (() => {
  "use strict";
  const { esc, toast, since } = window.UI;
  const $ = (id) => document.getElementById(id);
  let nets = [];
  const clock = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  async function load() {
    try { nets = (await Auth.api("/api/networks")).networks; } catch (ex) { toast(ex.message, true); return; }
    const field = nets.filter((n) => n.on_cards === false).length;
    const count = `${nets.length} Wi-Fi network${nets.length === 1 ? "" : "s"}.`;
    $("wifi-summary").textContent = !nets.length ? "No Wi-Fi networks yet. Wired Pis don't need one."
      : field ? `${count} ${nets.length - field} go on every card prepared from now on; ${field} saved from the technician page ${field === 1 ? "is" : "are"} offered there only. A Pi joins whichever is in range, and a network cable always wins.`
      : `${count} Every prepared card carries all of them; a Pi joins whichever is in range, and a network cable always wins.`;
    $("wifi-rows").innerHTML = nets.length ? nets.map((n) => `<tr>
      <td><strong>${esc(n.ssid)}</strong>${n.hidden ? `<div class="sub">Hidden network</div>` : ""}</td>
      <td>${esc(n.label || "")}${n.on_cards === false ? `<div class="sub">Saved from the technician page; not on cards</div>` : ""}</td>
      <td>${n.has_password ? "Saved" : `<span class="sub">None (open network)</span>`}</td>
      <td>${since(n.updated_at)}</td>
      <td class="actions"><button type="button" class="ghost" data-wifi="${n.id}">Edit</button></td></tr>`).join("")
      : `<tr><td colspan="5" class="empty-rows">None yet.</td></tr>`;
  }

  // ── Alert emails: who gets them, and a test email ──
  let mail = { recipients: [], sender: {} };
  const KINDS = [["offline", "Offline"], ["power", "Low power"], ["hot", "Running hot"]];
  async function loadAlerts() {
    try { mail = await Auth.api("/api/alert-settings"); } catch (ex) { toast(ex.message, true); return; }
    const sd = mail.sender || {};
    $("mail-sender").textContent = sd.via
      ? `Sent through ${sd.via === "mail server" ? `the mail server ${sd.server}` : "Resend"}, from ${sd.from || "(ALERT_EMAIL_FROM isn't set in Netlify)"}. The mail server's sign-in is kept in Netlify, not here.`
      : "No mail server is set up in Netlify yet (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS), so alerts are only logged.";
    const on = mail.recipients.filter((r) => r.enabled);
    $("mail-summary").textContent = on.length
      ? `${on.length} recipient${on.length === 1 ? "" : "s"}. Alerts: a Pi goes offline, reports low power or runs hot, and again when it clears.`
      : sd.fallbackTo?.length ? `No recipients here yet, so every alert goes to ${sd.fallbackTo.join(", ")} (ALERT_EMAIL_TO in Netlify).` : "No recipients yet.";
    $("mail-rows").innerHTML = mail.recipients.length ? mail.recipients.map((r) => `<tr>
      <td><strong>${esc(r.name || r.email)}</strong>${r.name ? `<div class="sub">${esc(r.email)}</div>` : ""}${r.enabled ? "" : `<div class="sub">Paused</div>`}</td>
      <td>${esc(KINDS.filter(([k]) => r[k]).map(([, l]) => l).join(", ") || "Nothing")}</td>
      <td>${since(r.updated_at)}</td>
      <td class="actions"><button type="button" class="ghost" data-recipient="${r.id}">Edit</button></td></tr>`).join("")
      : `<tr><td colspan="4" class="empty-rows">None yet.</td></tr>`;
  }

  function recipientDialog(r) {
    const { open, field } = window.ConsoleDialog;
    open({
      title: r ? `Alert emails: ${r.name || r.email}` : "Add recipient",
      body: `
        ${field("m-email", "Email", `<input id="m-email" type="email" required value="${esc(r?.email || "")}" autocomplete="off">`)}
        ${field("m-name", "Name", `<input id="m-name" maxlength="80" value="${esc(r?.name || "")}" placeholder="e.g. Scot, or Service desk">`)}
        <p class="sub">Gets an email when a Pi:</p>
        ${KINDS.map(([k, l]) => `<label class="check"><input type="checkbox" id="m-${k}"${!r || r[k] ? " checked" : ""}> ${l === "Offline" ? "goes offline (and is back)" : l === "Low power" ? "reports low power (and it's normal again)" : "runs at 80°C or hotter (and cools down)"}</label>`).join("")}
        <label class="check"><input type="checkbox" id="m-enabled"${!r || r.enabled ? " checked" : ""}> Sending (untick to pause without removing)</label>
        ${r ? `<button type="button" id="m-delete" class="ghost danger">Remove this recipient</button>` : ""}`,
      afterOpen() {
        $("m-delete")?.addEventListener("click", async () => {
          if (!confirm(`Stop sending alerts to ${r.email}?`)) return;
          try { await Auth.api("/api/alert-settings", { method: "POST", body: { action: "delete", id: r.id } }); $("dlg").close(); toast("Removed."); loadAlerts(); }
          catch (ex) { toast(ex.message, true); }
        });
      },
      async save() {
        await Auth.api("/api/alert-settings", { method: "POST", body: { action: "save", id: r?.id, email: $("m-email").value, name: $("m-name").value,
          offline: $("m-offline").checked, power: $("m-power").checked, hot: $("m-hot").checked, enabled: $("m-enabled").checked } });
        toast("Saved.");
        loadAlerts();
      },
    });
  }

  function dialog(n) {
    const { open, field } = window.ConsoleDialog;
    const isNew = !n;
    const places = [...new Set([...(window.ConsoleState?.props || []).map((p) => p.name), "1Point office"])];
    open({
      title: isNew ? "Add Wi-Fi network" : `Wi-Fi: ${n.ssid}`,
      body: `
        ${field("w-label", "Where", `<input id="w-label" maxlength="80" list="w-places" value="${esc(n?.label || "")}" placeholder="e.g. Perimeter Park One">
          <datalist id="w-places">${places.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>`, "A building, or somewhere like the office where Pis are tested.")}
        ${field("w-ssid", "Network name", `<input id="w-ssid" required maxlength="32" value="${esc(n?.ssid || "")}" autocomplete="off" spellcheck="false">`, "Exactly as the network shows it, capitals included.")}
        ${field("w-psk", "Password", `<input id="w-psk" type="password" maxlength="63" autocomplete="new-password" placeholder="${isNew ? "" : n.has_password ? "Saved: leave empty to keep it" : ""}">`, "It can't be shown again after saving; type a new one to replace it.")}
        <label class="check"><input type="checkbox" id="w-open"${n && !n.has_password ? " checked" : ""}> Open network (no password)</label>
        <label class="check"><input type="checkbox" id="w-hidden"${n?.hidden ? " checked" : ""}> Hidden network (doesn't broadcast its name)</label>
        <label class="check"><input type="checkbox" id="w-cards"${!n || n.on_cards !== false ? " checked" : ""}> Put on newly prepared cards</label>
        <p class="sub">Untick for a network that only one building uses: the technician page still offers it to that building's Pis, and a lost card doesn't carry its password.</p>
        ${isNew ? "" : `<button type="button" id="w-delete" class="ghost danger">Remove this network</button>`}`,
      afterOpen() {
        const sync = () => { $("w-psk").disabled = $("w-open").checked; if ($("w-open").checked) $("w-psk").value = ""; };
        $("w-open").addEventListener("change", sync); sync();
        $("w-delete")?.addEventListener("click", async () => {
          if (!confirm(`Remove ${n.ssid}? Cards prepared from now on won't carry it. Cards already made keep it.`)) return;
          try { await Auth.api("/api/networks", { method: "POST", body: { action: "delete", id: n.id } }); $("dlg").close(); toast("Removed."); load(); }
          catch (ex) { toast(ex.message, true); }
        });
      },
      async save() {
        const body = { action: "save", id: n?.id, label: $("w-label").value.trim(), ssid: $("w-ssid").value.trim(), hidden: $("w-hidden").checked, on_cards: $("w-cards").checked };
        if (!body.ssid) throw new Error("Enter the network name.");
        const psk = $("w-psk").value;
        if ($("w-open").checked) body.psk = "";
        else if (psk) {
          if (psk.length < 8) throw new Error("A Wi-Fi password is at least 8 characters. For a network without one, tick Open network.");
          body.psk = psk;
        } else if (isNew || !n.has_password) throw new Error("Enter the password, or tick Open network.");
        await Auth.api("/api/networks", { method: "POST", body });
        toast(body.on_cards ? "Saved. Cards prepared from now on carry it." : "Saved. It's offered on the technician page, not put on cards.");
        load();
      },
    });
  }

  document.addEventListener("click", async (e) => {
    const edit = e.target.closest("[data-wifi]");
    if (edit) return dialog(nets.find((n) => n.id === edit.dataset.wifi));
    if (e.target.closest("#add-wifi")) return dialog(null);
    const rec = e.target.closest("[data-recipient]");
    if (rec) return recipientDialog(mail.recipients.find((r) => r.id === rec.dataset.recipient));
    if (e.target.closest("#add-recipient")) return recipientDialog(null);
    if (e.target.closest("#mail-test")) {
      const out = $("mail-test-out"), btn = $("mail-test");
      btn.disabled = true; out.hidden = false; out.className = "mail-test-out"; out.textContent = "Sending…";
      try {
        const r = await Auth.api("/api/alert-settings", { method: "POST", body: { action: "test" } });
        out.className = `mail-test-out ${r.ok ? "ok" : "bad"}`;
        out.textContent = r.ok ? `Sent to ${r.to.join(", ")}. Check the inbox (and spam, the first time).` : `Not sent: ${r.error}`;
      } catch (ex) { out.className = "mail-test-out bad"; out.textContent = `Not sent: ${ex.message}`; }
      btn.disabled = false;
      return;
    }
    if (e.target.closest("#prep-code")) {
      try {
        const r = await Auth.api("/api/networks", { method: "POST", body: { action: "code" } });
        const out = $("prep-out");
        out.hidden = false;
        out.innerHTML = `<div class="prep-code">${esc(r.code)}</div>
          <div class="sub">Works once, until ${esc(clock(r.expires_at))}. On the bench Pi, in Terminal:</div>
          <code class="prep-cmd">curl -fsSLO ${esc(location.origin)}/pi/setup-kiosk.sh<br>sudo bash setup-kiosk.sh --prepare --code ${esc(r.code)}</code>
          <div class="sub">Setting up a Pi directly instead (not a card to copy)? Leave out <code>--prepare</code>.</div>`;
      } catch (ex) { toast(ex.message, true); }
    }
  });

  return { load: () => { load(); loadAlerts(); } };
})();
