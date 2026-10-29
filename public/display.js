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
  const VERSION = "2.21.0";   // = netlify/lib/version.mjs (a test keeps them equal)
  // What every screen does (which screen, check-in, clock, rotation, Identify, lockdown, reloads, offline cache) is in
  // screen-core.js, shared with the layout page (DP-11, round E1a).
  const C = window.ScreenCore;
  const { DEVICE, CHOSEN, PREVIEW, VIEW, SITE, CHECKS_IN, cache, esc } = C;
  const clock = C.clock;

  // Nothing chosen: no directory, no polling, no check-in. (This used to fall back to landmark-center.)
  if (!DEVICE && !CHOSEN && !PREVIEW) {
    const stage = document.getElementById("stage");
    stage.classList.remove("is-loading");
    stage.innerHTML = `<div class="no-screen"><h1>Lobby Directory</h1><p>No screen chosen. Screens open this page with their own address.</p><p><a href="/console.html">Sign in to the console</a></p></div>`;
    return;
  }

  const POLL_DIRECTORY_MS = 60 * 1000;
  const POLL_WEATHER_MS = 10 * 60 * 1000;
  const POLL_NEWS_MS = 15 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  let data = null;
  let dataSig = "";

  async function getJSON(url, opts) {
    const res = await fetch(url, { cache: "no-store", ...opts });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }

  // ── Stage sizing, orientation and software rotation ──
  // The screen's orientation (set in the console) decides the layout. If it doesn't match the way the
  // TV is being driven, the page rotates itself 90 degrees. ?rotate= in the address overrides that.
  function sizeStage() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const { W, H, transform } = C.rotation(data?.orientation, vw, vh);
    const landscape = W > H;
    const root = document.documentElement.style;
    root.setProperty("--W", `${W}px`);
    root.setProperty("--H", `${H}px`);
    // One unit (--u) sizes everything. It comes from whichever dimension is tighter, so a wide or short
    // window never squeezes out the tenant list. 10.8px on both a 1080x1920 portrait and a 1920x1080 landscape screen.
    root.setProperty("--u", `${landscape ? Math.min(W / 177.78, H / 100) : Math.min(W / 100, H / 177.78)}px`);
    stage.classList.toggle("landscape", landscape);
    stage.style.transform = transform;
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

  // Refit whenever the list's space changes size after it was fitted (round 15b, found at The Landmark Center): the top
  // band grows on its own as the clock and date get wider ("10:32", "Wednesday, September 30") and can push the
  // address onto another line, a logo or the weather can arrive late; without a refit the last name was cut off.
  let fittedAt = "";
  const frameSize = () => { const f = $("list-frame"); return `${f.clientWidth}x${f.clientHeight}`; };
  function fitTenants() { fitTenantsNow(); fittedAt = frameSize(); }
  let refitQueued = false;
  if ("ResizeObserver" in window) new ResizeObserver(() => {
    if (refitQueued || !data || frameSize() === fittedAt) return;
    refitQueued = true;
    requestAnimationFrame(() => { refitQueued = false; if (frameSize() !== fittedAt) fitTenants(); });
  }).observe($("list-frame"));

  function fitTenantsNow() {
    const list = $("tenants"), newsEl = $("news");
    const u = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--u")) || 10;
    if (data?.touch) return fitTouch(u);
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
      ? tenants.map((t, i) => `<li class="tenant" data-i="${i}"><span class="tenant-name">${esc(t.name)}${t.note ? `<span class="tenant-note">${esc(t.note)}</span>` : ""}</span><span class="tenant-suite">${esc(t.suite)}</span><span class="tenant-dir">${arrowSvg(t.dir)}</span></li>`).join("")
      : `<li class="empty">${data.newDevice ? `New display, serial ${esc(DEVICE)}.<br>Assign it to a screen in the console.` : data.assigned === false ? `This screen (${esc(data.key || SITE)}) isn't assigned to a directory yet.` : "Directory is being updated."}</li>`;

    renderTouch();

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
  /** A QR code as an SVG (also a place's card, round 18); shared with the layout page's QR block (screen-core.js). */
  const svgQR = (url) => C.svgQR(url);
  function drawQR(url) {
    if (url === qrFor) return;
    try {
      $("togo-code").innerHTML = svgQR(url);
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
      // Round 15c: the drive times' status for the console (never Google's minutes or labels: its terms forbid keeping them)
      const extra = CHECKS_IN && traffic.status ? { "X-Traffic": JSON.stringify({ ...traffic.status, shown: infoSlides().some((x) => x.kind === "times") }) } : {};
      const got = await C.fetchScreen(VERSION, extra);   // the check-in, the site's clock, the kept copy, a newer display
      if (!got) return;                                  // this screen shows a layout now: the layout page takes over
      $("offline").hidden = !got.fromCache;
      apply(got.d);
    } catch (e) {
      console.warn("Directory fetch failed", e);
      if (!data) { const c = cache.get("directory"); if (c) apply(c); }
      $("offline").hidden = !data;
    }
  }

  function apply(d) {
    if (C.route(d)) return;                     // an answer for a layout (the console changed what this screen shows)
    const sig = JSON.stringify(d);
    if (sig === dataSig) return;
    // A visitor is using the touch directory: hold the update until they're done (or the screen goes idle)
    if (touchBusy() && d.touch) { T.pending = d; return; }
    T.pending = null;
    const coordsChanged = !data || data.weather?.lat !== d.weather?.lat || data.weather?.lon !== d.weather?.lon;
    const orientationChanged = !data || data.orientation !== d.orientation;
    dataSig = sig;
    data = d;
    if (orientationChanged) sizeStage();
    render();
    if (coordsChanged) loadWeather();
  }

  // ── Clock ──
  function tick() {
    C.showIdentify($("identify"), data);
    const tz = data?.timezone || "America/Chicago";
    $("time").hidden = $("date").hidden = !clock.trusted;
    if (!clock.trusted) return;
    const t = C.timeParts(tz);
    $("time").innerHTML = `${esc(t.hm)}<small>${esc(t.ap)}</small>`;
    $("date").textContent = t.date;
  }

  // ── Weather bug ──
  const WX = C.WX;   // the weather icons (screen-core.js, shared with the layout page)

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
  /** The building's place lists as this screen shows them (empty ones dropped): the panel's slides, the Places
   *  button and the place cards all use this, so a list and an entry are the same numbers everywhere (round 18). */
  function placeLists() {
    const lists = Array.isArray(data?.placeLists) ? data.placeLists
      : (Array.isArray(data?.amenities) && data.amenities.length ? [{ heading: "Nearby", items: data.amenities }] : []);
    return lists.map((l) => ({ heading: l.heading || "Nearby", items: (l.items || []).filter((a) => a?.name) })).filter((l) => l.items.length);
  }

  /** The information slides this screen shows now, in order. */
  function infoSlides() {
    const out = [], t = data?.traffic || {};
    if (t.map && t.mapsKey && ONLINE() && traffic.mapState !== "failed") out.push({ kind: "map" });
    if (t.times && (t.destinations || []).length && (!CHECKS_IN || (ONLINE() && traffic.times && Date.now() - traffic.at < TIMES_FRESH_MS))) out.push({ kind: "times" });
    // The building's place lists, each with its own heading (DP-08 round 12); an empty list never shows. Pictures
    // take more room, so a list with any has three to a slide.
    placeLists().forEach((l, li) => {
      const items = l.items;
      const per = items.some((a) => a.image) ? 3 : AMENITIES_PER_SLIDE, pages = Math.ceil(items.length / per);
      for (let i = 0; i < items.length; i += per) out.push({ kind: "amenities", heading: l.heading, page: i / per, items: items.slice(i, i + per), pages, li, start: i });
    });
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
      el.innerHTML = `<div class="info-head">${esc(it.heading || "Nearby")}${it.pages > 1 ? ` <span>${it.page + 1} of ${it.pages}</span>` : ""}</div><ul class="info-list amenities">${it.items.map((a, k) =>
        `<li${a.image ? ' class="has-img"' : ""}${data?.touch ? ` data-l="${it.li}" data-i="${it.start + k}"` : ""}>${a.image ? `<img class="info-img" src="${esc(a.image)}" alt="">` : ""}<div class="info-body"><div class="info-row"><span class="info-name">${esc(a.name)}</span>${a.distance ? `<span class="info-value small">${esc(a.distance)}</span>` : ""}</div>${a.line ? `<div class="info-line">${esc(a.line)}</div>` : ""}</div></li>`).join("")}</ul>`;
    }
    showSlide(el);
    return it.kind;
  }

  function timesHtml() {
    const dests = data?.traffic?.destinations || [];
    const rows = CHECKS_IN && traffic.times ? traffic.times : dests.map((label) => ({ label, minutes: null }));
    const at = traffic.at && CHECKS_IN ? new Date(traffic.at + clock.offset).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: data?.timezone || "America/Chicago" }) : "";
    return `<div class="info-head">Drive times now</div><ul class="info-list">${rows.map((r) => {
      const extra = r.minutes != null && r.usualMinutes != null && r.minutes - r.usualMinutes >= 3 ? `<div class="info-line">+${r.minutes - r.usualMinutes} min for traffic</div>` : "";
      return `<li><div class="info-row"><span class="info-name">${esc(r.label)}</span><span class="info-value">${r.minutes != null ? `${r.minutes}<small> min</small>` : "—"}</span></div>${extra}</li>`;
    }).join("")}</ul><div class="info-foot">${CHECKS_IN ? `Google Maps${at ? ` · updated ${esc(at)}` : ""}` : "Google Maps · live times show on the screen"}</div>`;
  }

  // Travel times: real screens only (the console's View and the editor preview never ask), every 30 minutes; the
  // site decides whether Google may be asked now (hours, 25-minute spacing). Kept in memory only, never saved.
  async function loadTimes() {
    clearTimeout(traffic.timer);
    if (!CHECKS_IN || !data?.traffic?.times) { traffic.times = null; traffic.status = null; return; }   // not used here: nothing to report
    let next = TIMES_EVERY_MS;
    try {
      const res = await fetch(`/api/traffic?${DEVICE ? `device=${encodeURIComponent(DEVICE)}` : `key=${encodeURIComponent(SITE)}`}`, { cache: "no-store" });
      const r = await res.json().catch(() => ({}));
      if (Array.isArray(r.times)) {
        traffic.times = r.times; traffic.at = Date.now();
        traffic.status = { s: "ok", n: r.times.filter((t) => t.minutes != null).length, of: r.times.length, at: new Date(C.now()).toISOString() };
      } else if (r.wait) { next = Math.max(60, r.wait + 30) * 1000; if (traffic.status?.s !== "ok") traffic.status = { s: "wait" }; }
      else if (r.off) { traffic.times = null; traffic.status = { s: "off", why: String(r.off) }; }
      else traffic.status = { s: "error", why: String(r.error || `answer ${res.status}`) };
    } catch (e) { console.warn("Travel times unavailable", e); traffic.status = { s: "error", why: "the site couldn't be reached" }; }
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
      // A visitor looking at a place (round 18): the panel holds its slide until they're done
      if (!$("place").hidden || !$("places").hidden) { news.timer = setTimeout(step, 1000); return; }
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

  // ── The touch directory (DP-09 round 15): on a screen marked touch, a visitor taps a company for its card (suite and
  // the people the owner shows); an A to Z strip when the list is too long to fit; the customer's accessible keyboard,
  // which finds companies by name only (people are found only through their company); and back to the whole directory
  // after the screen's idle time. Display-only screens are exactly as before. ──
  const T = { pending: null, idle: null, scroll: false, query: "" };
  const touchBusy = () => !$("card").hidden || !$("kbd").hidden || !$("places").hidden || !$("place").hidden || T.scroll && $("list-frame").scrollTop > 0;
  const nameKey = (n) => String(n || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9 ]+/g, "").trim();
  const letterOf = (n) => { const c = nameKey(n).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : "#"; };

  /** About 15 mm, a fingertip, in this screen's pixels, from its size in inches (32" when not given). */
  function fingerPx() {
    const W = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--W")) || innerWidth;
    const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--H")) || innerHeight;
    const inches = Math.min(100, Math.max(7, Number(data?.screenInches) || 32));
    return 15 * Math.hypot(W, H) / (inches * 25.4);
  }

  function renderTouch() {
    const on = !!data?.touch;
    stage.classList.toggle("touch", on);
    document.documentElement.classList.toggle("show-cursor", on && (VIEW || PREVIEW));   // a mouse in View or the editor
    $("listing-tenant").textContent = on ? "Tap a company for details" : "Tenant";
    $("kbd-btn").hidden = !(on && data.keyboard);
    $("places-btn").hidden = !(on && placeLists().length);
    if (!on) { closeCard(); closeKeyboard(); closePlace(); closePlaces(); $("touchbar").hidden = true; T.scroll = false; stage.classList.remove("scrolling"); return; }
    stage.style.setProperty("--finger", `${fingerPx()}px`);
    armIdle();
  }

  // Touch screens: names never smaller than a fingertip's row; if the list can't fit at that size it scrolls, with A to Z
  function fitTouch(u) {
    const list = $("tenants"), newsEl = $("news"), f = fingerPx() / 2.06;   // a row is about 2.06 × the text size
    const lo = (x) => Math.max(x, f), max = Math.max(u * 5.2, f);
    stage.classList.remove("scrolling"); T.scroll = false; $("az").hidden = true;
    $("touchbar").hidden = $("kbd-btn").hidden && $("places-btn").hidden;
    const attempt = (min, twoCol, showNews) => {
      newsEl.hidden = !showNews;
      stage.classList.toggle("no-news", !showNews);
      list.classList.toggle("two-col", twoCol);
      document.querySelector(".listing").classList.toggle("two-col-head", twoCol);
      return fitSize(min, max);
    };
    if (newsWanted() && attempt(lo(u * 2.5), false, true)) return;
    if (attempt(lo(u * 2.3), false, false)) return;
    if (attempt(lo(u * 1.9), true, false)) return;
    // Too long for this screen at a finger's size: one column that scrolls, the A to Z strip, the panel kept
    T.scroll = true; stage.classList.add("scrolling");
    renderAZ();
    $("az").hidden = false; $("touchbar").hidden = false;
    attempt(f, false, newsWanted());
    list.style.setProperty("--tf", `${f}px`);
  }

  function renderAZ() {
    const have = new Set((data?.tenants || []).map((t) => letterOf(t.name)));
    $("az").innerHTML = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"].filter((c) => have.has(c))
      .map((c) => `<button type="button" class="az-key" data-letter="${c}">${c}</button>`).join("");
  }
  function jumpTo(letter) {
    const ts = data?.tenants || [], i = ts.findIndex((t) => letterOf(t.name) === letter);
    const li = i >= 0 && $("tenants").querySelector(`li[data-i="${i}"]`);
    if (li) $("list-frame").scrollTo({ top: li.offsetTop - $("tenants").offsetTop, behavior: "smooth" });
  }

  function openCard(t) {
    if (!t) return;
    const people = (t.people || []).filter((x) => x.first || x.last);
    const who = (x) => [x.first, x.last].filter(Boolean).join(" ");
    $("card").innerHTML = `<div class="card-panel" role="dialog" aria-label="${esc(t.name)}">
        <div class="card-head"><div class="card-name">${esc(t.name)}</div>${t.note ? `<div class="card-note">${esc(t.note)}</div>` : ""}
          ${t.suite ? `<div class="card-suite"><span>Suite</span> ${esc(t.suite)}${ARROWS[t.dir] ? `<span class="card-dir">${arrowSvg(t.dir)}</span>` : ""}</div>` : ""}</div>
        ${people.length ? `<div class="card-people-head">People</div><ul class="card-people">${people.map((x) => `<li>
          <div class="person-name">${esc(who(x))}</div>${x.title ? `<div class="person-title">${esc(x.title)}</div>` : ""}
          ${x.phone || x.email || (x.suite && x.suite !== t.suite) ? `<div class="person-lines">${[x.suite && x.suite !== t.suite ? `Suite ${esc(x.suite)}` : "", x.phone ? esc(x.phone) : "", x.email ? esc(x.email) : ""].filter(Boolean).join('<span class="dot">·</span>')}</div>` : ""}</li>`).join("")}</ul>` : ""}
        <button type="button" class="card-back" data-close>Back to the directory</button>
      </div>`;
    $("card").hidden = false;
    armIdle();
  }
  function closeCard() { if ($("card").hidden) return; $("card").hidden = true; $("card").innerHTML = ""; afterTouch(); }

  // The accessible keyboard (round 16): finds companies by name (never people). The matches sit above the keys and
  // always keep room for at least three; keys about 12 mm, in a compact block at the bottom; Show puts the keys away
  // so the matches have the whole panel (with one match, Show opens its card); the field or Keyboard brings them back.
  const KEYS = ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
  function openKeyboard() {
    T.query = "";
    $("kbd").innerHTML = `<div class="kbd-panel" role="dialog" aria-label="Find a company">
        <div class="kbd-top"><button type="button" class="kbd-field" data-kfield aria-live="polite"><span class="kbd-text"></span><span class="kbd-caret"></span><span class="kbd-hint">Type a company's name</span></button>
          <button type="button" class="kbd-again" data-kfield hidden>Keyboard</button>
          <button type="button" class="kbd-close" data-kclose>Close</button></div>
        <ul class="kbd-results"></ul>
        <div class="kbd-keys">${KEYS.map((row, r) => `<div class="kbd-row">${[...row].map((k) => `<button type="button" class="key" data-key="${k}">${k}</button>`).join("")}${r === 3 ? '<button type="button" class="key wide" data-key="back" aria-label="Delete">⌫</button>' : ""}</div>`).join("")}
          <div class="kbd-row"><button type="button" class="key wide" data-key="clear">Clear</button><button type="button" class="key wide" data-key="&amp;">&amp;</button><button type="button" class="key space" data-key=" ">Space</button><button type="button" class="key wide enter" data-key="enter">Show</button></div></div>
      </div>`;
    $("kbd").hidden = false;
    showKeys(true);
    showResults();
    armIdle();
  }
  function closeKeyboard() { if ($("kbd").hidden) return; $("kbd").hidden = true; $("kbd").innerHTML = ""; T.query = ""; afterTouch(); }
  function showKeys(on) {
    const el = $("kbd");
    el.querySelector(".kbd-panel").classList.toggle("keys-away", !on);
    el.querySelector(".kbd-again").hidden = on;
  }
  function findHits() {
    const q = nameKey(T.query).replace(/\s+/g, " "), ts = data?.tenants || [];
    return !q ? [] : ts.map((t, i) => ({ t, i, k: nameKey(t.name) })).filter((x) => x.k.includes(q) || x.k.replace(/\s+/g, "").includes(q.replace(/\s+/g, "")))
      .sort((a, b) => (b.k.startsWith(q) - a.k.startsWith(q)) || a.k.localeCompare(b.k));
  }
  function showResults() {
    const el = $("kbd"), q = nameKey(T.query), hits = findHits();
    el.querySelector(".kbd-text").textContent = T.query;
    el.querySelector(".kbd-hint").hidden = !!T.query;
    el.querySelector(".kbd-results").innerHTML = !q ? `<li class="none">Matching companies show here as you type</li>` : hits.length
      ? hits.slice(0, 30).map((x) => `<li data-i="${x.i}"><span class="r-name">${esc(x.t.name)}</span><span class="r-suite">${esc(x.t.suite)}</span></li>`).join("")
      : `<li class="none">No company matches "${esc(T.query)}"</li>`;
    el.querySelector(".kbd-results").scrollTop = 0;
  }
  function typeKey(k) {
    if (k === "enter") {
      const hits = findHits();
      if (hits.length === 1) { openCard(hits[0].t); return; }
      if (nameKey(T.query)) showKeys(false);
      return;
    }
    if (k === "back") T.query = T.query.slice(0, -1);
    else if (k === "clear") T.query = "";
    else if (T.query.length < 40) T.query += k;
    showResults();
  }

  // Drag to scroll (round 16). Some touch panels reach the browser as a mouse (the Pi's desktop can pass a finger on as
  // a pointer), and a mouse drag doesn't scroll a list, so a finger couldn't move the long list on the Beetronics while a
  // mouse wheel could in View. A drag of more than about 2 mm scrolls the list and doesn't count as a tap; a short drag
  // is still a tap. Real touch input is left to the browser's own scrolling. Works when the page itself is turned.
  const SCROLLERS = "#stage.scrolling .list-frame, .card-people, .kbd-results, .places-list";
  function dragScroll() {
    let s = null, fling = 0;
    const local = (dx, dy) => {
      const tr = getComputedStyle(stage).transform;
      if (!tr || tr === "none") return dy;
      const m = new DOMMatrix(tr).inverse(), a = m.transformPoint({ x: 0, y: 0 }), b = m.transformPoint({ x: dx, y: dy });
      return b.y - a.y;
    };
    document.addEventListener("pointerdown", (e) => {
      cancelAnimationFrame(fling); s = null;
      const el = data?.touch && e.target.closest?.(SCROLLERS);
      if (!el || e.pointerType === "touch" || e.button !== 0 || el.scrollHeight <= el.clientHeight + 1) return;
      s = { el, id: e.pointerId, x: e.clientX, y: e.clientY, top: el.scrollTop, moved: false, v: 0, ly: 0, lt: performance.now() };
    });
    document.addEventListener("pointermove", (e) => {
      if (!s || e.pointerId !== s.id) return;
      const dy = local(e.clientX - s.x, e.clientY - s.y);
      if (!s.moved && Math.abs(dy) > Math.max(8, fingerPx() * 0.14)) s.moved = true;
      if (!s.moved) return;
      const t = performance.now();
      s.v = 0.7 * ((dy - s.ly) / Math.max(1, t - s.lt)) + 0.3 * s.v; s.ly = dy; s.lt = t;
      s.el.scrollTop = s.top - dy;
      armIdle();
    });
    const end = (e) => {
      if (!s || e.pointerId !== s.id) return;
      const { el, moved } = s; let v = s.v; s = null;
      if (!moved) return;
      // The click that follows a drag isn't a tap
      const eat = (c) => { c.stopPropagation(); c.preventDefault(); };
      document.addEventListener("click", eat, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("click", eat, { capture: true }), 400);
      if (e.type === "pointercancel") return;
      let last = performance.now();
      const step = (t) => {   // a gentle glide after a quick flick
        const dt = t - last; last = t; v *= Math.pow(0.995, dt);
        if (Math.abs(v) < 0.05) return;
        el.scrollTop -= v * dt;
        fling = requestAnimationFrame(step);
      };
      fling = requestAnimationFrame(step);
    };
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
  }
  dragScroll();

  // ── Places and promotions on touch screens (DP-10 round 18; Scot: both ways in, and a QR when there's a link) ──
  // The Places button opens every list (a tab per list); a place on the panel's slide can be tapped too, and the
  // panel holds that slide while it's open. A place's card: its picture, name, distance and line, and when the
  // building gave it an address or a web link, a QR code to take it away on a phone.
  /** Where a place's QR code goes: a web address as it is, a bare domain as https, anything else as an address in maps. */
  function placeUrl(link) {
    const v = String(link || "").trim();
    if (!v) return "";
    if (/^https?:\/\/\S+$/i.test(v)) return v;
    if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(v)) return `https://${v}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v)}`;
  }
  const P = { tab: 0, fromList: false };
  const QR_LINE = "Take it with you: scan with your phone's camera";   // a place's own line replaces it (round 18b)
  function openPlaces(tab = 0) {
    const lists = placeLists();
    if (!lists.length) return;
    P.tab = Math.min(Math.max(0, tab), lists.length - 1);
    const l = lists[P.tab];
    $("places").innerHTML = `<div class="kbd-panel places-panel" role="dialog" aria-label="Places and events">
        <div class="kbd-top"><div class="places-tabs">${lists.map((x, i) => `<button type="button" class="places-tab${i === P.tab ? " on" : ""}" data-tab="${i}">${esc(x.heading)}</button>`).join("")}</div>
          <button type="button" class="kbd-close" data-pclose>Close</button></div>
        <ul class="places-list">${l.items.map((a, i) => `<li data-l="${P.tab}" data-i="${i}">${a.image ? `<img src="${esc(a.image)}" alt="">` : l.items.some((x) => x.image) ? '<span class="pl-noimg"></span>' : ""}
          <span class="pl-body"><span class="pl-name">${esc(a.name)}</span>${a.line ? `<span class="pl-line">${esc(a.line)}</span>` : ""}</span>${a.distance ? `<span class="pl-dist">${esc(a.distance)}</span>` : ""}</li>`).join("")}</ul>
      </div>`;
    $("places").hidden = false;
    $("places").querySelector(".places-list").scrollTop = 0;
    armIdle();
  }
  function closePlaces() { if ($("places").hidden) return; $("places").hidden = true; $("places").innerHTML = ""; afterTouch(); }
  function openPlace(li, ii, fromList) {
    const a = placeLists()[li]?.items?.[ii];
    if (!a) return;
    P.fromList = !!fromList;
    const url = placeUrl(a.link);
    let qr = "";
    if (url) { try { qr = `<div class="place-qr"><div class="place-qr-code">${svgQR(url)}</div><div class="place-qr-line">${esc(a.qrline || QR_LINE)}</div></div>`; } catch (e) { console.warn("QR failed", e); } }
    $("place").innerHTML = `<div class="card-panel place-panel" role="dialog" aria-label="${esc(a.name)}">
        <div class="place-top">${a.image ? `<img class="place-img" src="${esc(a.image)}" alt="">` : ""}
          <div class="card-head"><div class="card-name">${esc(a.name)}</div>${a.distance ? `<div class="place-dist">${esc(a.distance)}</div>` : ""}${a.line ? `<div class="place-line">${esc(a.line)}</div>` : ""}</div></div>
        ${qr}
        <button type="button" class="card-back" data-close>${P.fromList ? "Back to the list" : "Back to the directory"}</button>
      </div>`;
    $("place").hidden = false;
    armIdle();
  }
  function closePlace() { if ($("place").hidden) return; $("place").hidden = true; $("place").innerHTML = ""; afterTouch(); }
  $("places-btn").addEventListener("click", () => openPlaces(0));
  $("places").addEventListener("click", (e) => {
    if (e.target.closest("[data-pclose]") || e.target === $("places")) { closePlaces(); return; }
    const t = e.target.closest("[data-tab]"); if (t) { openPlaces(Number(t.dataset.tab)); return; }
    const r = e.target.closest("li[data-i]"); if (r) openPlace(Number(r.dataset.l), Number(r.dataset.i), true);
  });
  $("place").addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === $("place")) closePlace(); });
  $("news-slides").addEventListener("click", (e) => {
    if (!data?.touch) return;
    const r = e.target.closest("li[data-l]"); if (r) openPlace(Number(r.dataset.l), Number(r.dataset.i), false);
  });

  // Back to the whole directory after the screen's idle time with no touch
  function armIdle() {
    clearTimeout(T.idle);
    if (!data?.touch) return;
    T.idle = setTimeout(goIdle, Math.min(300, Math.max(15, Number(data.touchIdle) || 45)) * 1000);
  }
  function goIdle() {
    closeCard(); closeKeyboard(); closePlace(); closePlaces();
    $("list-frame").scrollTop = 0;
    if (T.pending) { const d = T.pending; T.pending = null; apply(d); }
  }
  function afterTouch() { if (T.pending && !touchBusy()) { const d = T.pending; T.pending = null; apply(d); } }

  $("tenants").addEventListener("click", (e) => {
    if (!data?.touch) return;
    const li = e.target.closest("li[data-i]");
    if (li) openCard((data.tenants || [])[Number(li.dataset.i)]);
  });
  $("az").addEventListener("click", (e) => { const b = e.target.closest("[data-letter]"); if (b) jumpTo(b.dataset.letter); });
  $("kbd-btn").addEventListener("click", () => openKeyboard());
  $("card").addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === $("card")) closeCard(); });
  $("kbd").addEventListener("click", (e) => {
    const k = e.target.closest("[data-key]"); if (k) { typeKey(k.dataset.key); return; }
    if (e.target.closest("[data-kclose]")) { closeKeyboard(); return; }
    if (e.target.closest("[data-kfield]")) { showKeys(true); return; }
    const r = e.target.closest("li[data-i]"); if (r) openCard((data.tenants || [])[Number(r.dataset.i)]);
  });
  // Any touch keeps the screen awake for another idle period
  document.addEventListener("pointerdown", () => { if (data?.touch) armIdle(); }, true);
  $("list-frame").addEventListener("scroll", () => { if (data?.touch) armIdle(); }, { passive: true });

  // ── Touch lockdown (DP-08 round 13; screen-core.js): nothing can be zoomed, selected, dragged or long-pressed ──
  C.lockdown();

  // ── Boot ──
  clock.onTrusted = tick;   // the first answer from the site: show the time and date
  sizeStage();
  window.addEventListener("resize", () => { sizeStage(); fitTenants(); if (data) placeBackground(); });
  const cached = cache.get("directory");
  if (cached) apply(cached);
  loadDirectory().then(() => { loadNews(); loadTimes(); if (!data) setTimeout(() => location.reload(), 30000); });
  setInterval(loadDirectory, POLL_DIRECTORY_MS);
  setInterval(loadWeather, POLL_WEATHER_MS);
  setInterval(loadNews, POLL_NEWS_MS);
  setInterval(tick, 1000);
  C.scheduleNightlyReload();

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

  C.registerOfflineCache();
})();
