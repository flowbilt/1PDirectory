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
    $("wifi-summary").textContent = nets.length
      ? `${nets.length} Wi-Fi network${nets.length === 1 ? "" : "s"}. Every prepared card carries all of them; a Pi joins whichever is in range, and a network cable always wins.`
      : "No Wi-Fi networks yet. Wired Pis don't need one.";
    $("wifi-rows").innerHTML = nets.length ? nets.map((n) => `<tr>
      <td><strong>${esc(n.ssid)}</strong>${n.hidden ? `<div class="sub">Hidden network</div>` : ""}</td>
      <td>${esc(n.label || "")}</td>
      <td>${n.has_password ? "Saved" : `<span class="sub">None (open network)</span>`}</td>
      <td>${since(n.updated_at)}</td>
      <td class="actions"><button type="button" class="ghost" data-wifi="${n.id}">Edit</button></td></tr>`).join("")
      : `<tr><td colspan="5" class="empty-rows">None yet.</td></tr>`;
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
        const body = { action: "save", id: n?.id, label: $("w-label").value.trim(), ssid: $("w-ssid").value.trim(), hidden: $("w-hidden").checked };
        if (!body.ssid) throw new Error("Enter the network name.");
        const psk = $("w-psk").value;
        if ($("w-open").checked) body.psk = "";
        else if (psk) {
          if (psk.length < 8) throw new Error("A Wi-Fi password is at least 8 characters. For a network without one, tick Open network.");
          body.psk = psk;
        } else if (isNew || !n.has_password) throw new Error("Enter the password, or tick Open network.");
        await Auth.api("/api/networks", { method: "POST", body });
        toast("Saved. Cards prepared from now on carry it.");
        load();
      },
    });
  }

  document.addEventListener("click", async (e) => {
    const edit = e.target.closest("[data-wifi]");
    if (edit) return dialog(nets.find((n) => n.id === edit.dataset.wifi));
    if (e.target.closest("#add-wifi")) return dialog(null);
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

  return { load };
})();
