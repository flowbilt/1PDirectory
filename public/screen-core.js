/* What every screen does, whatever it shows (DP-11, round E1a; Scot: shared, not copied). Used by the directory
   display (display.js) and the layout page (board.js):
     - which screen this is, from the address (?device= ?screen= ?site= ?view=1 ?preview=1 ?rotate=)
     - the check-in with each once-a-minute ask (only real screens; the console's View and previews never check in)
     - the last answer kept for a restart with no internet, and the "Reconnecting…" note
     - the clock from the site's own time (the Date header), shown only once the screen has reached the site
     - turning the page to the screen's Orientation when the TV isn't driven that way
     - Identify, the touch lockdown, reloading itself when a newer display is live, the 3 a.m. reload, the offline cache
     - handing over between the directory page (/) and the layout page (/board.html) when the console changes what the
       screen shows, keeping the same address options, so a Pi's address never changes
   Classic script (no modules), so the directory display needs no other change to load it. */
(() => {
  "use strict";
  const q = new URLSearchParams(location.search);
  const DEVICE = (q.get("device") || "").toLowerCase();
  const CHOSEN = (q.get("screen") || q.get("key") || q.get("site") || "").toLowerCase();
  const PREVIEW = q.get("preview") === "1";
  const VIEW = q.get("view") === "1";
  // E1c: "See the board" on the phone menu (board.html?menu=<code>): the published layout, drawn read-only
  const MENU = /^[A-HJKMNP-Z2-9]{6}$/i.test(q.get("menu") || "") ? q.get("menu").toUpperCase() : "";
  const SITE = DEVICE ? `device-${DEVICE}` : CHOSEN || "preview";
  const SCREEN_URL = DEVICE ? `/api/screen?device=${encodeURIComponent(DEVICE)}` : `/api/screen?key=${encodeURIComponent(SITE)}`;
  const URL_ROTATE = ["90", "270"].includes(q.get("rotate")) ? Number(q.get("rotate")) : null;
  const CHECKS_IN = !PREVIEW && !VIEW && !MENU; // only a real screen records a check-in

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── Cache helpers (last good data survives a reboot with no internet). Both pages keep the screen's answer under
  // the same name, so a restart with no internet opens whichever page the last answer was for. ──
  const cache = {
    get(k) { try { return JSON.parse(localStorage.getItem(`dir:${SITE}:${k}`)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(`dir:${SITE}:${k}`, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  };

  // ── The clock ──
  // A Pi 4 has no battery-backed clock: after a power cut it starts at the last time it saved and corrects itself only
  // once it's online. So a real screen shows the time and date only after it has reached the site since it started.
  // The site's own time comes with every answer, so the clock is right even where a building's network blocks the
  // time service the Pi normally sets itself from (NTP).
  const clock = { trusted: !CHECKS_IN, offset: 0, onTrusted: null };
  const now = () => Date.now() + clock.offset;
  function timeParts(tz) {
    const at = new Date(now());
    let parts;
    try { parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).formatToParts(at); }
    catch { parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(at); }
    const hm = parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
    const ap = parts.find((p) => p.type === "dayPeriod")?.value || "";
    let date;
    try { date = at.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz }); }
    catch { date = at.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }); }
    return { hm, ap, date };
  }

  // ── Orientation and software rotation ──
  // The screen's orientation (set in the console) decides the shape. If it doesn't match the way the TV is being
  // driven, the page rotates itself 90 degrees. ?rotate= in the address overrides that.
  function rotation(wanted, vw, vh) {
    wanted = wanted || "auto";                            // portrait-flipped / landscape-flipped: the same shapes, the
    const shape = wanted.split("-")[0];                   // Pi turns the picture the other way (setup-kiosk.sh)
    const viewportPortrait = vh > vw;
    let rotate = URL_ROTATE;
    // The same direction the Pi turns its output (Wayland transform 90 is a quarter turn anticlockwise, which is
    // rotate(-90deg) here), so the picture doesn't flip between an Orientation change and the Pi's next restart.
    if (rotate === null) rotate = shape === "portrait" && !viewportPortrait ? (wanted === "portrait-flipped" ? 90 : 270) : shape === "landscape" && viewportPortrait ? 90 : 0;
    const W = rotate ? vh : vw, H = rotate ? vw : vh;
    return { rotate, W, H, landscape: W > H,
      transform: rotate === 90 ? `translateX(${vw}px) rotate(90deg)` : rotate === 270 ? `translateY(${vh}px) rotate(-90deg)` : "" };
  }

  // ── The two pages, and handing over between them ──
  const PAGE = /\/board\.html$/.test(location.pathname) ? "layout" : "directory";
  let leaving = false;
  /** If this answer is for the other page, go there (same address options) and return true. */
  function route(d) {
    if (!d || PREVIEW || leaving) return leaving;
    const want = d.kind === "layout" ? "layout" : "directory";
    if (want === PAGE) return false;
    leaving = true;
    location.replace(`${want === "layout" ? "/board.html" : "/"}${location.search}`);
    return true;
  }

  // ── The screen's answer, with the check-in ──
  /** Asks the site for this screen. extra: more check-in headers (round 15c's drive-times status). Returns
   *  { d, fromCache } (fromCache: the building's internet is down and the offline cache answered), or null if this
   *  page is handing over to the other. Throws when there's no answer at all. */
  async function fetchScreen(version, extra = {}) {
    // The size and version headers are the screen's check-in (they used to be a separate heartbeat call).
    const headers = !CHECKS_IN ? {} : { "X-Screen-Size": `${screen.width}x${screen.height}`, "X-Display-Version": version, ...extra };
    const res = await fetch(SCREEN_URL, { cache: "no-cache", headers });
    if (!res.ok) throw new Error(`screen ${res.status}`);
    const d = await res.json();
    const fromCache = res.headers.get("X-Served-From") === "offline-cache";
    if (!fromCache) {
      cache.set("directory", d);
      const siteNow = Date.parse(res.headers.get("Date") || "");
      if (siteNow) clock.offset = Math.abs(siteNow - Date.now()) > 2000 ? siteNow - Date.now() : 0;
      if (!clock.trusted) { clock.trusted = true; clock.onTrusted?.(); }
      reloadIfOutdated(d.display, version);
    }
    if (route(d)) return null;
    return { d, fromCache };
  }

  // A newer display is live (the site says which with every answer): fetch the new code fresh, then reload, once.
  // The note in localStorage stops a loop if a reload somehow still gets the old code: it tries again after 30 minutes.
  const CODE = ["/display.js", "/display.css", "/screen-core.js", "/vendor/qrcode.js", "/", "/board.html", "/board.js", "/board.css", "/layout-format.mjs"];
  async function reloadIfOutdated(live, version) {
    if (PREVIEW || !CHECKS_IN || !live || live === version || reloadIfOutdated.busy) return;
    let last = null;
    try { last = JSON.parse(localStorage.getItem("display-reload") || "null"); } catch { /* storage off: no guard needed */ }
    if (last && last.to === live && Date.now() - last.at < 30 * 60000) return;
    reloadIfOutdated.busy = true;
    try { localStorage.setItem("display-reload", JSON.stringify({ to: live, at: Date.now() })); } catch { /* ignore */ }
    console.info(`Display ${live} is live (this is ${version}): reloading`);
    await Promise.all(CODE.map((u) => fetch(u, { cache: "reload" }).catch(() => null)));
    location.reload();
  }

  // ── Daily reload at 3 a.m. picks up code updates and clears browser memory ──
  function scheduleNightlyReload() {
    const at = new Date(), next = new Date(at);
    next.setHours(3, 0, 0, 0);
    if (next <= at) next.setDate(next.getDate() + 1);
    setTimeout(() => location.reload(), next - at);
  }

  // ── Identify: the console flashes this screen's name so a tech knows which one they're standing at ──
  function showIdentify(el, d) {
    const until = Date.parse(d?.identifyUntil || "");
    const on = Number.isFinite(until) && until > Date.now();
    if (on && el.hidden) el.innerHTML = `<div class="identify-name">${esc(d.screenName || d.key || "")}</div><div class="identify-key">${esc(d.key || "")}${DEVICE ? ` · Pi ${esc(DEVICE)}` : ""}</div>`;
    el.hidden = !on;
  }

  // ── Touch lockdown (DP-08 round 13): on a touch screen nothing can be zoomed, selected, dragged or long-pressed
  // into a menu, so a passer-by can't leave the screen in a mess. On every screen (harmless without touch); the
  // styles are in each page's CSS. The touch directory opens its own taps on purpose. ──
  function lockdown() {
    for (const type of ["contextmenu", "selectstart", "dragstart", "gesturestart"]) document.addEventListener(type, (e) => e.preventDefault());
    document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });   // no pinch
    document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });                  // no pinch on a touchpad
  }

  function registerOfflineCache() {
    if (CHECKS_IN && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  // ── Weather icons (the National Weather Service's kinds, as /api/weather names them) ──
  const WX = {
    "clear-day": '<circle cx="24" cy="24" r="8" fill="#f2c14e"/><g stroke="#f2c14e" stroke-width="3" stroke-linecap="round"><path d="M24 6v5M24 37v5M6 24h5M37 24h5M11.3 11.3l3.5 3.5M33.2 33.2l3.5 3.5M11.3 36.7l3.5-3.5M33.2 14.8l3.5-3.5"/></g>',
    "clear-night": '<path d="M30 8a15 15 0 1 0 10 26A13 13 0 0 1 30 8z" fill="#c7cdd6"/>',
    "partly-day": '<circle cx="18" cy="17" r="7" fill="#f2c14e"/><g stroke="#f2c14e" stroke-width="2.6" stroke-linecap="round"><path d="M18 3v4M4 17h4M8 7l2.8 2.8M28 7l-2.8 2.8"/></g><path d="M15 38h20a8 8 0 0 0 0-16 11 11 0 0 0-20 3 6.5 6.5 0 0 0 0 13z" fill="#dfe3ea"/>',
    "partly-night": '<path d="M22 6a10 10 0 1 0 8 15A9 9 0 0 1 22 6z" fill="#c7cdd6"/><path d="M15 40h20a8 8 0 0 0 0-16 11 11 0 0 0-20 3 6.5 6.5 0 0 0 0 13z" fill="#dfe3ea"/>',
    cloud: '<path d="M13 37h22a9 9 0 0 0 0-18 12 12 0 0 0-22 3.5A7.3 7.3 0 0 0 13 37z" fill="#dfe3ea"/>',
    rain: '<path d="M13 30h22a9 9 0 0 0 0-18 12 12 0 0 0-22 3.5A7.3 7.3 0 0 0 13 30z" fill="#dfe3ea"/><g stroke="#7fb3e6" stroke-width="3" stroke-linecap="round"><path d="M17 35l-2 6M25 35l-2 6M33 35l-2 6"/></g>',
    storm: '<path d="M13 28h22a9 9 0 0 0 0-18 12 12 0 0 0-22 3.5A7.3 7.3 0 0 0 13 28z" fill="#b9c0cc"/><path d="M25 29l-6 9h5l-3 8 9-11h-5l3-6z" fill="#f2c14e"/>',
    snow: '<path d="M13 30h22a9 9 0 0 0 0-18 12 12 0 0 0-22 3.5A7.3 7.3 0 0 0 13 30z" fill="#dfe3ea"/><g fill="#ffffff"><circle cx="17" cy="37" r="2.2"/><circle cx="25" cy="41" r="2.2"/><circle cx="33" cy="37" r="2.2"/></g>',
    fog: '<g stroke="#c7cdd6" stroke-width="3.2" stroke-linecap="round"><path d="M8 18h32M12 26h28M8 34h26"/></g>',
  };

  /** A QR code as an SVG: dark modules on white with the standard quiet zone of four (public/vendor/qrcode.js, which the
   *  page loads first). Throws if the encoder can't take it. Used by the directory (Directory to Go, a place's card)
   *  and the layout page (the QR block, E1c). */
  function svgQR(url) {
    const q = window.LobbyQR(url), n = q.size, Q = 4;
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.dark(r, c)) d += `M${c + Q} ${r + Q}h1v1h-1z`;
    return `<svg viewBox="0 0 ${n + 2 * Q} ${n + 2 * Q}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#0d1b2e"/></svg>`;
  }

  window.ScreenCore = { DEVICE, CHOSEN, PREVIEW, VIEW, SITE, SCREEN_URL, URL_ROTATE, CHECKS_IN, PAGE, esc, cache, clock, now, timeParts,
    rotation, route, fetchScreen, WX, reloadIfOutdated, scheduleNightlyReload, showIdentify, lockdown, registerOfflineCache, svgQR, MENU };
})();
