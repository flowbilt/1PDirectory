/* Directory display.
   URL options:
     ?screen=ppi-2s          which screen this is (older screens use ?site=landmark-center; same thing)
     ?device=<serial>        set by the agent's setup: the console decides which screen this Pi shows
     ?rotate=90 | 270        force software rotation; otherwise the screen's orientation setting decides
     ?preview=1              used by the editor; skips the check-in and service worker
     ?view=1                 used by the console's View button: a person looking at the screen, so no check-in
                             (only real screens check in) and no service worker
   The bare address (no screen chosen) shows a short note instead of any directory.
*/
(() => {
  "use strict";
  const VERSION = "2.12.0";   // = netlify/lib/version.mjs (a test keeps them equal)
  const q = new URLSearchParams(location.search);
  const DEVICE = (q.get("device") || "").toLowerCase();
  const CHOSEN = (q.get("screen") || q.get("key") || q.get("site") || "").toLowerCase();
  const PREVIEW = q.get("preview") === "1";
  const VIEW = q.get("view") === "1";

  // Nothing chosen: no directory, no polling, no check-in. (This used to fall back to landmark-center.)
  if (!DEVICE && !CHOSEN && !PREVIEW) {
    const stage = document.getElementById("stage");
    stage.classList.remove("is-loading");
    stage.innerHTML = `<div class="no-screen"><h1>Lobby Directory</h1><p>No screen chosen. Screens open this page with their own address.</p><p><a href="/console.html">Sign in to the console</a></p></div>`;
    return;
  }

  const SITE = DEVICE ? `device-${DEVICE}` : CHOSEN || "preview";
  const SCREEN_URL = DEVICE ? `/api/screen?device=${encodeURIComponent(DEVICE)}` : `/api/screen?key=${encodeURIComponent(SITE)}`;
  const URL_ROTATE = ["90", "270"].includes(q.get("rotate")) ? Number(q.get("rotate")) : null;
  const CHECKS_IN = !PREVIEW && !VIEW; // only a real screen records a check-in
  // A Pi 4 has no battery-backed clock: after a power cut it starts at the last time it saved and corrects itself only
  // once it's online. So a real screen shows the time and date only after it has reached the site since it started.
  let clockTrusted = !CHECKS_IN;
  // The site's own time comes with every answer, so the clock is right even where a building's network blocks the
  // time service the Pi normally sets itself from (NTP).
  let clockOffset = 0;

  const POLL_DIRECTORY_MS = 60 * 1000;
  const POLL_WEATHER_MS = 10 * 60 * 1000;
  const POLL_NEWS_MS = 15 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  let data = null;
  let dataSig = "";

  // ── Cache helpers (last good data survives a reboot with no internet) ──
  const cache = {
    get(k) { try { return JSON.parse(localStorage.getItem(`dir:${SITE}:${k}`)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(`dir:${SITE}:${k}`, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  };

  async function getJSON(url, opts) {
    const res = await fetch(url, { cache: "no-store", ...opts });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── Stage sizing, orientation and software rotation ──
  // The screen's orientation (set in the console) decides the layout. If it doesn't match the way the
  // TV is being driven, the page rotates itself 90 degrees. ?rotate= in the address overrides that.
  function sizeStage() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const wanted = data?.orientation || "auto";           // portrait-flipped / landscape-flipped: the same layouts, the
    const shape = wanted.split("-")[0];                   // Pi turns the picture the other way (setup-kiosk.sh)
    const viewportPortrait = vh > vw;
    let rotate = URL_ROTATE;
    // The same direction the Pi turns its output (Wayland transform 90 is a quarter turn anticlockwise, which is
    // rotate(-90deg) here), so the picture doesn't flip between a Layout change and the Pi's next restart.
    if (rotate === null) rotate = shape === "portrait" && !viewportPortrait ? (wanted === "portrait-flipped" ? 90 : 270) : shape === "landscape" && viewportPortrait ? 90 : 0;
    const W = rotate ? vh : vw, H = rotate ? vw : vh;
    const landscape = W > H;
    const root = document.documentElement.style;
    root.setProperty("--W", `${W}px`);
    root.setProperty("--H", `${H}px`);
    // One unit (--u) sizes everything. It comes from whichever dimension is tighter, so a wide or short
    // window never squeezes out the tenant list. 10.8px on both a 1080x1920 portrait and a 1920x1080 landscape screen.
    root.setProperty("--u", `${landscape ? Math.min(W / 177.78, H / 100) : Math.min(W / 100, H / 177.78)}px`);
    stage.classList.toggle("landscape", landscape);
    stage.style.transform = rotate === 90 ? `translateX(${vw}px) rotate(90deg)` : rotate === 270 ? `translateY(${vh}px) rotate(-90deg)` : "";
  }

  // ── Tenant list layout ──
  // Tries, in order: one column with news, one column without news, two columns.
  // Each step has a minimum type size so names stay readable from across the lobby.
  function fitSize(min, max) {
    const frame = $("list-frame"), list = $("tenants");
    const fits = () => list.scrollHeight <= frame.clientHeight && list.scrollWidth <= frame.clientWidth + 1;
    list.style.setProperty("--tf", `${min}px`);
    if (!fits()) return false;
    let lo = min, hi = max;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      list.style.setProperty("--tf", `${mid}px`);
      if (fits()) lo = mid; else hi = mid;
    }
    list.style.setProperty("--tf", `${lo}px`);
    return true;
  }

  // The panel (the news box) shows when there's news or any of the information slides (DP-08 round 11)
  function newsWanted() { return !!((data?.news?.enabled && news.items.length) || infoSlides().length); }

  function fitTenants() {
    const list = $("tenants"), newsEl = $("news");
    const u = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--u")) || 10;
    const max = u * 5.2;
    const attempt = (min, twoCol, showNews) => {
      newsEl.hidden = !showNews;
      stage.classList.toggle("no-news", !showNews);
      list.classList.toggle("two-col", twoCol);
      document.querySelector(".listing").classList.toggle("two-col-head", twoCol);
      return fitSize(min, max);
    };
    const size = () => parseFloat($("tenants").style.getPropertyValue("--tf")) || 0;
    if (newsWanted() && attempt(u * 2.5, false, true)) {
      // In landscape the news takes a whole column. Move it aside only if that makes names clearly bigger.
      if (!stage.classList.contains("landscape")) return;
      const withNews = size();
      if (attempt(u * 2.3, false, false) && size() > withNews * 1.15) return;
      attempt(u * 2.5, false, true);
      return;
    }
    if (attempt(u * 2.3, false, false)) return;
    if (attempt(u * 1.9, true, false)) return;
    attempt(u * 1.9, true, false); // over capacity: smallest two-column size, overflow clipped
    list.style.setProperty("--tf", `${u * 1.9}px`);
  }

  const ARROWS = {
    right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    left: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M18 13l-6 6-6-6"/>',
  };
  const arrowSvg = (d) =>
    ARROWS[d] ? `<svg viewBox="0 0 24 24" fill="none" stroke="#c7cdd6" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">${ARROWS[d]}</svg>` : "";

  function contactHtml(role, c) {
    if (!c || !(c.name || c.company || c.phone)) return "";
    return `<div class="contact-role">${role}</div>
      ${c.name ? `<div class="contact-name">${esc(c.name)}</div>` : ""}
      ${c.company ? `<div class="contact-line">${esc(c.company)}</div>` : ""}
      ${c.phone ? `<div class="contact-line contact-phone">${esc(c.phone)}</div>` : ""}`;
  }

  function render() {
    if (!data) return;
    document.title = `${data.propertyName} directory`;
    $("property").textContent = data.propertyName;
    const label = $("label");
    label.textContent = data.buildingLabel || "";
    label.hidden = !data.buildingLabel;

    // Two logos: the building's, and the owner's or manager's (companyLogo). Normally the building's sits at the top
    // and the company's in a strip at the bottom; logoSwap puts the company's on top and the building's at the bottom.
    const swap = !!(data.logoSwap && data.companyLogo);
    const top = swap ? data.companyLogo : data.logo, bottom = swap ? data.logo : data.companyLogo;
    const logo = $("logo");
    const wordmark = !swap && !!(data.logo && data.logoReplacesName);   // only the building's own logo replaces its name
    if (top) { if (logo.getAttribute("src") !== top) logo.src = top; logo.hidden = false; logo.alt = wordmark ? data.propertyName : ""; }
    else { logo.hidden = true; logo.removeAttribute("src"); }
    const brand = $("brand-logo");
    if (bottom) { if (brand.getAttribute("src") !== bottom) brand.src = bottom; } else brand.removeAttribute("src");
    $("brand").hidden = !bottom;
    stage.classList.toggle("wordmark", wordmark);
    $("property").hidden = wordmark;

    const list = $("tenants");
    const tenants = data.tenants || [];
    const anyArrow = tenants.some((t) => ARROWS[t.dir]);
    list.classList.toggle("no-arrows", !anyArrow);
    list.innerHTML = tenants.length
      ? tenants.map((t) => `<li class="tenant"><span class="tenant-name">${esc(t.name)}${t.note ? `<span class="tenant-note">${esc(t.note)}</span>` : ""}</span><span class="tenant-suite">${esc(t.suite)}</span><span class="tenant-dir">${arrowSvg(t.dir)}</span></li>`).join("")
      : `<li class="empty">${data.newDevice ? `New display, serial ${esc(DEVICE)}.<br>Assign it to a screen in the console.` : data.assigned === false ? `This screen (${esc(data.key || SITE)}) isn't assigned to a directory yet.` : "Directory is being updated."}</li>`;

    const m = contactHtml("Managed by", data.managedBy), l = contactHtml("Leased by", data.leasedBy);
    $("managed").innerHTML = m; $("managed").hidden = !m;
    $("leased").innerHTML = l; $("leased").hidden = !l;
    document.querySelector(".contacts").classList.toggle("single", !(m && l));
    // Directory to Go (DP-08 round 12): the QR code sits at the end of the contacts band
    const tg = data.togo || {}, showTogo = !!(tg.enabled && tg.url && window.LobbyQR);
    $("togo").hidden = !showTogo;
    if (showTogo) { $("togo-line").textContent = tg.line || "Take this directory with you!"; drawQR(tg.url); }
    document.querySelector(".contacts").classList.toggle("has-togo", showTogo);
    document.querySelector(".contacts").classList.toggle("togo-only", showTogo && !(m || l));
    document.querySelector(".contacts").hidden = !(m || l || showTogo);
    $("powered").hidden = data.poweredBy === false;           // "Powered by WayTuGo"; 1Point can hide it per screen

    renderBackground();
    const sz = applySizes(data.sizes);

    const w = $("welcome");
    w.textContent = data.welcome || "";
    w.hidden = !data.welcome;
    w.classList.toggle("wrap", sz.welcome > 100);

    if (data.weather?.enabled === false) $("weather").hidden = true;

    tick();
    // Fit after fonts are ready so measurements use the real typeface.
    document.fonts.ready.then(() => { fitTenants(); stage.classList.remove("is-loading"); });
  }

  // The QR code, drawn here (public/vendor/qrcode.js): dark modules on white with the standard quiet zone of four
  let qrFor = "";
  function drawQR(url) {
    if (url === qrFor) return;
    try {
      const q = window.LobbyQR(url), n = q.size, Q = 4;
      let d = "";
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.dark(r, c)) d += `M${c + Q} ${r + Q}h1v1h-1z`;
      $("togo-code").innerHTML = `<svg viewBox="0 0 ${n + 2 * Q} ${n + 2 * Q}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#0d1b2e"/></svg>`;
      qrFor = url;
    } catch (e) { console.warn("QR failed", e); $("togo").hidden = true; }
  }

  // This screen's sizes, each a percentage of the standard (missing = 100). Ranges match supabase/18-sizes.sql and
  // 22-widget-sizes.sql (news, clock, weather, contacts: DP-08 round 10); a test keeps them all equal.
  const SIZE_RANGES = { title: [50, 120], logo: [60, 200], brand: [60, 250], welcome: [80, 160],
    news: [70, 150], clock: [70, 150], weather: [70, 150], contacts: [70, 150], qr: [70, 150] };
  function applySizes(sizes) {
    const out = {};
    for (const [name, [lo, hi]] of Object.entries(SIZE_RANGES)) {
      const v = Number(sizes?.[name]);
      out[name] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 100;
      stage.style.setProperty(`--${name}-scale`, String(out[name] / 100));
    }
    return out;
  }

  let draftMode = false; // admin preview: show unsaved edits instead of polling

  function renderBackground() {
    const bg = data.background || {};
    const el = $("bg");
    const on = !!(bg.enabled && bg.image);
    el.hidden = !on;
    stage.classList.toggle("has-bg", on);
    if (!on) { el.innerHTML = ""; return; }
    let photo = el.querySelector(".bg-photo");
    if (!photo) {
      el.innerHTML = '<img class="bg-photo" alt=""><div class="bg-tint"></div>';
      photo = el.querySelector(".bg-photo");
    }
    if (photo.getAttribute("src") !== bg.image) photo.src = bg.image;
    stage.style.setProperty("--bg-show", String(Math.min(40, Math.max(5, Number(bg.visibility) || 15)) / 100));
    placeBackground();
  }

  // Width is a % of the screen width; position slides the photo left/right to center the subject.
  function placeBackground() {
    const bg = data?.background || {};
    const W = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--W")) || window.innerWidth;
    const width = W * (Math.min(400, Math.max(100, Number(bg.size) || 190)) / 100);
    const left = (W - width) * (Math.min(100, Math.max(0, Number(bg.position ?? 50))) / 100);
    stage.style.setProperty("--bg-width", `${width}px`);
    stage.style.setProperty("--bg-left", `${left}px`);
    const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--H")) || window.innerHeight;
    stage.style.setProperty("--bg-top", `${H * (Math.min(60, Math.max(-20, Number(bg.offset) || 0)) / 100)}px`);
  }

  async function loadDirectory() {
    if (draftMode) return;
    try {
      // The size and version headers are the screen's check-in (they used to be a separate heartbeat call).
      const headers = !CHECKS_IN ? {} : { "X-Screen-Size": `${screen.width}x${screen.height}`, "X-Display-Version": VERSION };
      const res = await fetch(SCREEN_URL, { cache: "no-cache", headers });
      if (!res.ok) throw new Error(`directory ${res.status}`);
      const d = await res.json();
      const fromCache = res.headers.get("X-Served-From") === "offline-cache";
      if (!fromCache) {
        cache.set("directory", d);
        const siteNow = Date.parse(res.headers.get("Date") || "");
        if (siteNow) clockOffset = Math.abs(siteNow - Date.now()) > 2000 ? siteNow - Date.now() : 0;
        if (!clockTrusted) { clockTrusted = true; tick(); }
      }
      $("offline").hidden = !fromCache;
      if (!fromCache) reloadIfOutdated(d.display);
      apply(d);
    } catch (e) {
      console.warn("Directory fetch failed", e);
      if (!data) { const c = cache.get("directory"); if (c) apply(c); }
      $("offline").hidden = !data;
    }
  }

  // A newer display is live (the site says which with every directory): fetch the new code fresh, then reload, once.
  // The note in localStorage stops a loop if a reload somehow still gets the old code: it tries again after 30 minutes.
  async function reloadIfOutdated(live) {
    if (PREVIEW || !CHECKS_IN || !live || live === VERSION || reloadIfOutdated.busy) return;
    let last = null;
    try { last = JSON.parse(localStorage.getItem("display-reload") || "null"); } catch { /* storage off: no guard needed */ }
    if (last && last.to === live && Date.now() - last.at < 30 * 60000) return;
    reloadIfOutdated.busy = true;
    try { localStorage.setItem("display-reload", JSON.stringify({ to: live, at: Date.now() })); } catch { /* ignore */ }
    console.info(`Display ${live} is live (this is ${VERSION}): reloading`);
    await Promise.all(["/display.js", "/display.css", "/vendor/qrcode.js", "/"].map((u) => fetch(u, { cache: "reload" }).catch(() => null)));
    location.reload();
  }

  function apply(d) {
    const sig = JSON.stringify(d);
    if (sig === dataSig) return;
    const coordsChanged = !data || data.weather?.lat !== d.weather?.lat || data.weather?.lon !== d.weather?.lon;
    const orientationChanged = !data || data.orientation !== d.orientation;
    dataSig = sig;
    data = d;
    if (orientationChanged) sizeStage();
    render();
    if (coordsChanged) loadWeather();
  }

  // ── Identify: the console flashes this screen's name so a tech knows which one they're standing at ──
  function showIdentify() {
    const until = Date.parse(data?.identifyUntil || "");
    const on = Number.isFinite(until) && until > Date.now();
    const el = $("identify");
    if (on && el.hidden) el.innerHTML = `<div class="identify-name">${esc(data.screenName || data.key || "")}</div><div class="identify-key">${esc(data.key || "")}${DEVICE ? ` · Pi ${esc(DEVICE)}` : ""}</div>`;
    el.hidden = !on;
  }

  // ── Clock ──
  function tick() {
    showIdentify();
    const tz = data?.timezone || "America/Chicago";
    $("time").hidden = $("date").hidden = !clockTrusted;
    if (!clockTrusted) return;
    const now = new Date(Date.now() + clockOffset);
    let timeParts;
    try { timeParts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).formatToParts(now); }
    catch { timeParts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(now); }
    const hm = timeParts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
    const ap = timeParts.find((p) => p.type === "dayPeriod")?.value || "";
    $("time").innerHTML = `${esc(hm)}<small>${esc(ap)}</small>`;
    try { $("date").textContent = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz }); }
    catch { $("date").textContent = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }); }
  }

  // ── Weather bug ──
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

  function showWeather(w) {
    if (!w || typeof w.tempF !== "number" || data?.weather?.enabled === false) return;
    $("wx-icon").innerHTML = `<svg viewBox="0 0 48 48">${WX[w.icon] || WX.cloud}</svg>`;
    $("wx-temp").textContent = `${w.tempF}°`;
    $("wx-text").textContent = w.text || "";
    $("weather").hidden = false;
  }

  async function loadWeather() {
    const wx = data?.weather;
    if (!wx || wx.enabled === false) { $("weather").hidden = true; return; }
    try {
      const w = await getJSON(`/api/weather?lat=${wx.lat}&lon=${wx.lon}`, { cache: "default" });
      cache.set("weather", w);
      showWeather(w);
    } catch (e) {
      console.warn("Weather fetch failed", e);
      const c = cache.get("weather");
      // Old weather is worse than none; only reuse a reading under 3 hours old.
      if (c && Date.now() - Date.parse(c.at) < 3 * 3600 * 1000) showWeather(c);
      else $("weather").hidden = true;
    }
  }

  // ── News rotator ──
  const news = { items: [], idx: -1, timer: null };

  const ago = (iso) => {
    if (!iso) return "";
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!Number.isFinite(mins) || mins < 0) return "";
    if (mins < 60) return `${Math.max(mins, 1)} min ago`;
    const h = Math.round(mins / 60);
    return h < 24 ? `${h} hr ago` : "";
  };

  function preload(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(false);
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth >= 300);
      img.onerror = () => resolve(false);
      img.src = src;
      setTimeout(() => resolve(false), 10000);
    });
  }

  // ── The information panel (DP-08 round 11): news, a live traffic map, travel times and nearby amenities take turns
  // in the one box, so the tenant list keeps its space. Each is switched on per directory. ──
  const ONLINE = () => $("offline").hidden;                       // no live map or times while reconnecting
  const TIMES_EVERY_MS = 30 * 60000, TIMES_FRESH_MS = 40 * 60000;
  const traffic = { times: null, at: 0, timer: null, mapState: "", map: null, mapEl: null, mapCenter: "" };
  const AMENITIES_PER_SLIDE = 4;

  /** The information slides this screen shows now, in order. */
  function infoSlides() {
    const out = [], t = data?.traffic || {};
    if (t.map && t.mapsKey && ONLINE() && traffic.mapState !== "failed") out.push({ kind: "map" });
    if (t.times && (t.destinations || []).length && (!CHECKS_IN || (ONLINE() && traffic.times && Date.now() - traffic.at < TIMES_FRESH_MS))) out.push({ kind: "times" });
    // The building's place lists, each with its own heading (DP-08 round 12); an empty list never shows. Pictures
    // take more room, so a list with any has three to a slide.
    const lists = Array.isArray(data?.placeLists) ? data.placeLists
      : (Array.isArray(data?.amenities) && data.amenities.length ? [{ heading: "Nearby", items: data.amenities }] : []);
    for (const l of lists) {
      const items = (l.items || []).filter((a) => a?.name);
      const per = items.some((a) => a.image) ? 3 : AMENITIES_PER_SLIDE, pages = Math.ceil(items.length / per);
      for (let i = 0; i < items.length; i += per) out.push({ kind: "amenities", heading: l.heading || "Nearby", page: i / per, items: items.slice(i, i + per), pages });
    }
    return out;
  }

  // Turn order: when there's news, every third turn is the next information slide; otherwise the information slides alone.
  const turns = { n: 0, info: -1 };
  function nextItem() {
    const info = infoSlides(), hasNews = !!(data?.news?.enabled && news.items.length);
    turns.n++;
    if (info.length && (!hasNews || turns.n % 3 === 1)) { turns.info = (turns.info + 1) % info.length; return info[turns.info]; }
    if (!hasNews) return null;
    news.idx = (news.idx + 1) % news.items.length;
    return { kind: "news", item: news.items[news.idx] };
  }

  function showSlide(el) {
    const box = $("news-slides");
    if (!el.parentNode) box.appendChild(el);
    for (const other of box.children) if (other !== el) other.classList.remove("on");
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("on")));
    // Remove older slides once the new one has faded in (the map is kept: it's loaded once per page)
    setTimeout(() => { for (const c of [...box.children]) if (c !== el && !c.classList.contains("keep")) c.remove(); }, 1500);
  }

  async function nextSlide() {
    const it = nextItem();
    if (!it) return null;
    if (it.kind === "map") { showMap(); return "map"; }
    const el = document.createElement("div");
    if (it.kind === "news") {
      const n = it.item, hasImg = await preload(n.image);
      el.className = `slide${hasImg ? "" : " text-only"}`;
      const meta = [n.source, ago(n.published)].filter(Boolean).join(", ");
      el.innerHTML = `${hasImg ? `<img src="${esc(n.image)}" alt="">` : ""}<div class="slide-text"><div class="slide-headline">${esc(n.title)}</div>${meta ? `<div class="slide-meta">${esc(meta)}</div>` : ""}</div>`;
    } else if (it.kind === "times") {
      el.className = "slide info-slide";
      el.innerHTML = timesHtml();
    } else {
      el.className = "slide info-slide";
      el.innerHTML = `<div class="info-head">${esc(it.heading || "Nearby")}${it.pages > 1 ? ` <span>${it.page + 1} of ${it.pages}</span>` : ""}</div><ul class="info-list amenities">${it.items.map((a) =>
        `<li${a.image ? ' class="has-img"' : ""}>${a.image ? `<img class="info-img" src="${esc(a.image)}" alt="">` : ""}<div class="info-body"><div class="info-row"><span class="info-name">${esc(a.name)}</span>${a.distance ? `<span class="info-value small">${esc(a.distance)}</span>` : ""}</div>${a.line ? `<div class="info-line">${esc(a.line)}</div>` : ""}</div></li>`).join("")}</ul>`;
    }
    showSlide(el);
    return it.kind;
  }

  function timesHtml() {
    const dests = data?.traffic?.destinations || [];
    const rows = CHECKS_IN && traffic.times ? traffic.times : dests.map((label) => ({ label, minutes: null }));
    const at = traffic.at && CHECKS_IN ? new Date(traffic.at + clockOffset).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: data?.timezone || "America/Chicago" }) : "";
    return `<div class="info-head">Drive times now</div><ul class="info-list">${rows.map((r) => {
      const extra = r.minutes != null && r.usualMinutes != null && r.minutes - r.usualMinutes >= 3 ? `<div class="info-line">+${r.minutes - r.usualMinutes} min for traffic</div>` : "";
      return `<li><div class="info-row"><span class="info-name">${esc(r.label)}</span><span class="info-value">${r.minutes != null ? `${r.minutes}<small> min</small>` : "—"}</span></div>${extra}</li>`;
    }).join("")}</ul><div class="info-foot">${CHECKS_IN ? `Google Maps${at ? ` · updated ${esc(at)}` : ""}` : "Google Maps · live times show on the screen"}</div>`;
  }

  // Travel times: real screens only (the console's View and the editor preview never ask), every 30 minutes; the
  // site decides whether Google may be asked now (hours, 25-minute spacing). Kept in memory only, never saved.
  async function loadTimes() {
    clearTimeout(traffic.timer);
    if (!CHECKS_IN || !data?.traffic?.times) { traffic.times = null; return; }
    let next = TIMES_EVERY_MS;
    try {
      const r = await getJSON(`/api/traffic?${DEVICE ? `device=${encodeURIComponent(DEVICE)}` : `key=${encodeURIComponent(SITE)}`}`);
      if (Array.isArray(r.times)) { traffic.times = r.times; traffic.at = Date.now(); }
      else if (r.wait) next = Math.max(60, r.wait + 30) * 1000;
      else if (r.off) traffic.times = null;
    } catch (e) { console.warn("Travel times unavailable", e); }
    traffic.timer = setTimeout(loadTimes, next);
    fitTenants(); ensureRotation();
  }

  // The live traffic map: Google Maps with its traffic layer, loaded once per page (Google bills per map load) and
  // kept, shown and hidden as its turn comes. The traffic layer refreshes itself.
  function showMap() {
    const t = data.traffic;
    if (!traffic.mapEl) {
      traffic.mapEl = document.createElement("div");
      traffic.mapEl.className = "slide keep map-slide";
      traffic.mapEl.innerHTML = '<div class="map-canvas"></div><div class="map-pin" aria-hidden="true"></div><div class="info-head map-head">Traffic now</div>';
      $("news-slides").appendChild(traffic.mapEl);
    }
    showSlide(traffic.mapEl);
    const center = `${t.lat},${t.lon}`;
    if (traffic.map && traffic.mapCenter !== center) { traffic.map.setCenter({ lat: Number(t.lat), lng: Number(t.lon) }); traffic.mapCenter = center; }
    if (traffic.mapState) return;
    traffic.mapState = "loading";
    window.gm_authFailure = () => { traffic.mapState = "failed"; traffic.mapEl?.remove(); traffic.mapEl = null; console.warn("Google Maps refused the key"); };
    window.__lobbyMapReady = () => {
      try {
        const g = window.google.maps;
        traffic.map = new g.Map(traffic.mapEl.querySelector(".map-canvas"), {
          center: { lat: Number(t.lat), lng: Number(t.lon) }, zoom: 12, disableDefaultUI: true, gestureHandling: "none",
          keyboardShortcuts: false, clickableIcons: false, backgroundColor: "#0d1b2e", styles: MAP_STYLE,
        });
        new g.TrafficLayer({ autoRefresh: true }).setMap(traffic.map);
        traffic.mapCenter = center; traffic.mapState = "ready";
      } catch (e) { traffic.mapState = "failed"; console.warn("Map failed", e); }
    };
    const sc = document.createElement("script");
    sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(t.mapsKey)}&callback=__lobbyMapReady&loading=async&v=weekly`;
    sc.async = true;
    sc.onerror = () => { traffic.mapState = ""; };                // offline: try again at its next turn
    document.head.appendChild(sc);
  }
  // A quiet navy map so the traffic colours stand out (raster styles: no map ID needed)
  const MAP_STYLE = [
    { elementType: "geometry", stylers: [{ color: "#13233a" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#9fb0c6" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#0d1b2e" }] },
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a3b55" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3a4d6b" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#081322" }] },
  ];

  function startRotation() {
    clearTimeout(news.timer);
    const secs = Math.max(5, Number(data?.news?.rotateSeconds) || 12);
    const step = async () => {
      const kind = await nextSlide();
      // The map and the travel times stay up half again as long as a headline
      news.timer = setTimeout(step, secs * 1000 * (kind === "map" || kind === "times" ? 1.5 : 1));
    };
    news.running = true;
    step();
  }
  function stopRotation() { clearTimeout(news.timer); news.running = false; }
  function ensureRotation() {
    if (newsWanted()) { if (!news.running) startRotation(); } else stopRotation();
  }

  async function loadNews() {
    let items = [];
    try {
      const n = await getJSON("/api/news", { cache: "default" });
      items = Array.isArray(n.items) ? n.items : [];
      if (items.length) cache.set("news", items);
    } catch (e) {
      console.warn("News fetch failed", e);
      items = cache.get("news") || [];
    }
    news.items = items;
    fitTenants(); // decides whether news fits alongside the tenants
    ensureRotation();
  }

  // ── Daily reload at 3 a.m. picks up code updates and clears browser memory ──
  function scheduleNightlyReload() {
    const now = new Date(), next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => location.reload(), next - now);
  }

  // ── Touch lockdown (DP-08 round 13): on a touch screen nothing can be zoomed, selected, dragged or long-pressed
  // into a menu, so a passer-by can't leave the directory in a mess. On every screen (harmless without touch);
  // the styles are in display.css. The touch directory (a later round) opens its own taps on purpose.
  for (const type of ["contextmenu", "selectstart", "dragstart", "gesturestart"]) document.addEventListener(type, (e) => e.preventDefault());
  document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });   // no pinch
  document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });                  // no pinch on a touchpad

  // ── Boot ──
  sizeStage();
  window.addEventListener("resize", () => { sizeStage(); fitTenants(); if (data) placeBackground(); });
  const cached = cache.get("directory");
  if (cached) apply(cached);
  loadDirectory().then(() => { loadNews(); loadTimes(); if (!data) setTimeout(() => location.reload(), 30000); });
  setInterval(loadDirectory, POLL_DIRECTORY_MS);
  setInterval(loadWeather, POLL_WEATHER_MS);
  setInterval(loadNews, POLL_NEWS_MS);
  setInterval(tick, 1000);
  scheduleNightlyReload();

  // When settings change (rotation time, news, map, travel times or amenities on/off), restart the rotator.
  let lastPanel = null;
  setInterval(() => {
    const t = data?.traffic || {};
    const sig = JSON.stringify([data?.news?.rotateSeconds, data?.news?.enabled, t.map, t.times, t.destinations, data?.placeLists ?? data?.amenities, ONLINE()]);
    if (lastPanel !== null && sig !== lastPanel) {
      const timesChanged = JSON.stringify(JSON.parse(lastPanel).slice(3, 5)) !== JSON.stringify([t.times, t.destinations]);
      if (timesChanged) loadTimes();
      fitTenants(); stopRotation(); ensureRotation();
    }
    lastPanel = sig;
  }, 5000);

  if (PREVIEW) {
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin || e.data?.type !== "draft" || !e.data.data) return;
      draftMode = true;
      apply({ site: SITE, ...e.data.data });
    });
  }

  if (CHECKS_IN && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
