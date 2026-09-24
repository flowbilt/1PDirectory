/* Directory display.
   URL options:
     ?site=landmark-center   which directory to show (default: landmark-center)
     ?rotate=90 | 270        rotate in software if the Pi can't rotate the screen itself
     ?preview=1              used by the admin page; skips heartbeat and service worker
*/
(() => {
  "use strict";
  const VERSION = "1.0.0";
  const q = new URLSearchParams(location.search);
  const SITE = (q.get("site") || "landmark-center").toLowerCase();
  const ROTATE = ["90", "270"].includes(q.get("rotate")) ? Number(q.get("rotate")) : 0;
  const PREVIEW = q.get("preview") === "1";

  const POLL_DIRECTORY_MS = 60 * 1000;
  const POLL_WEATHER_MS = 10 * 60 * 1000;
  const POLL_NEWS_MS = 15 * 60 * 1000;
  const HEARTBEAT_MS = 5 * 60 * 1000;

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

  // ── Stage sizing and optional software rotation ──
  function sizeStage() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const W = ROTATE ? vh : vw, H = ROTATE ? vw : vh;
    const root = document.documentElement.style;
    root.setProperty("--W", `${W}px`);
    root.setProperty("--H", `${H}px`);
    // Size from whichever dimension is tighter, so a wide or short window never squeezes out the tenant list.
    // On a 1080x1920 portrait screen both give 10.8px, so the portrait design is unchanged.
    root.setProperty("--u", `${Math.min(W / 100, H / 177.78)}px`);
    stage.style.transform = ROTATE === 90 ? `translateX(${vw}px) rotate(90deg)` : ROTATE === 270 ? `translateY(${vh}px) rotate(-90deg)` : "";
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

  function newsWanted() { return !!(data?.news?.enabled && news.items.length); }

  function fitTenants() {
    const list = $("tenants"), newsEl = $("news");
    const u = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--u")) || 10;
    const max = u * 5.2;
    const attempt = (min, twoCol, showNews) => {
      newsEl.hidden = !showNews;
      list.classList.toggle("two-col", twoCol);
      document.querySelector(".listing").classList.toggle("two-col-head", twoCol);
      return fitSize(min, max);
    };
    if (newsWanted() && attempt(u * 2.5, false, true)) return;
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

    const logo = $("logo");
    const wordmark = !!(data.logo && data.logoReplacesName);
    if (data.logo) { if (logo.src !== data.logo) logo.src = data.logo; logo.hidden = false; logo.alt = wordmark ? data.propertyName : ""; }
    else { logo.hidden = true; logo.removeAttribute("src"); }
    stage.classList.toggle("wordmark", wordmark);
    $("property").hidden = wordmark;

    const list = $("tenants");
    const tenants = data.tenants || [];
    const anyArrow = tenants.some((t) => ARROWS[t.dir]);
    list.classList.toggle("no-arrows", !anyArrow);
    list.innerHTML = tenants.length
      ? tenants.map((t) => `<li class="tenant"><span class="tenant-name">${esc(t.name)}</span><span class="tenant-suite">${esc(t.suite)}</span><span class="tenant-dir">${arrowSvg(t.dir)}</span></li>`).join("")
      : `<li class="empty">Directory is being updated.</li>`;

    const m = contactHtml("Managed by", data.managedBy), l = contactHtml("Leased by", data.leasedBy);
    $("managed").innerHTML = m; $("managed").hidden = !m;
    $("leased").innerHTML = l; $("leased").hidden = !l;
    document.querySelector(".contacts").classList.toggle("single", !(m && l));
    document.querySelector(".contacts").hidden = !(m || l);

    const w = $("welcome");
    w.textContent = data.welcome || "";
    w.hidden = !data.welcome;

    if (data.weather?.enabled === false) $("weather").hidden = true;

    tick();
    // Fit after fonts are ready so measurements use the real typeface.
    document.fonts.ready.then(() => { fitTenants(); stage.classList.remove("is-loading"); });
  }

  let draftMode = false; // admin preview: show unsaved edits instead of polling

  async function loadDirectory() {
    if (draftMode) return;
    try {
      const res = await fetch(`/api/directory?site=${encodeURIComponent(SITE)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`directory ${res.status}`);
      const d = await res.json();
      const fromCache = res.headers.get("X-Served-From") === "offline-cache";
      if (!fromCache) cache.set("directory", d);
      $("offline").hidden = !fromCache;
      apply(d);
    } catch (e) {
      console.warn("Directory fetch failed", e);
      if (!data) { const c = cache.get("directory"); if (c) apply(c); }
      $("offline").hidden = !data;
    }
  }

  function apply(d) {
    const sig = JSON.stringify(d);
    if (sig === dataSig) return;
    const coordsChanged = !data || data.weather?.lat !== d.weather?.lat || data.weather?.lon !== d.weather?.lon;
    dataSig = sig;
    data = d;
    render();
    if (coordsChanged) loadWeather();
  }

  // ── Clock ──
  function tick() {
    const tz = data?.timezone || "America/Chicago";
    const now = new Date();
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

  async function nextSlide() {
    if (!news.items.length) return;
    news.idx = (news.idx + 1) % news.items.length;
    const it = news.items[news.idx];
    const hasImg = await preload(it.image);
    const box = $("news-slides");
    const el = document.createElement("div");
    el.className = `slide${hasImg ? "" : " text-only"}`;
    const meta = [it.source, ago(it.published)].filter(Boolean).join(", ");
    el.innerHTML = `${hasImg ? `<img src="${esc(it.image)}" alt="">` : ""}<div class="slide-text"><div class="slide-headline">${esc(it.title)}</div>${meta ? `<div class="slide-meta">${esc(meta)}</div>` : ""}</div>`;
    box.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("on")));
    // Remove older slides once the new one has faded in.
    setTimeout(() => { while (box.children.length > 1) box.removeChild(box.firstChild); }, 1500);
  }

  function startRotation() {
    clearInterval(news.timer);
    const secs = Math.max(5, Number(data?.news?.rotateSeconds) || 12);
    nextSlide();
    news.timer = setInterval(nextSlide, secs * 1000);
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
    const wasEmpty = !news.items.length;
    news.items = items;
    fitTenants(); // decides whether news fits alongside the tenants
    if (newsWanted() && wasEmpty) startRotation();
  }

  // ── Heartbeat so the admin page shows when this screen last checked in ──
  function heartbeat() {
    if (PREVIEW) return;
    fetch("/api/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site: SITE, screen: { w: screen.width, h: screen.height }, version: VERSION }),
    }).catch(() => {});
  }

  // ── Daily reload at 3 a.m. picks up code updates and clears browser memory ──
  function scheduleNightlyReload() {
    const now = new Date(), next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => location.reload(), next - now);
  }

  // ── Boot ──
  sizeStage();
  window.addEventListener("resize", () => { sizeStage(); fitTenants(); });
  const cached = cache.get("directory");
  if (cached) apply(cached);
  loadDirectory().then(() => { loadNews(); if (!data) setTimeout(() => location.reload(), 30000); });
  setInterval(loadDirectory, POLL_DIRECTORY_MS);
  setInterval(loadWeather, POLL_WEATHER_MS);
  setInterval(loadNews, POLL_NEWS_MS);
  setInterval(tick, 1000);
  heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS);
  scheduleNightlyReload();

  // When settings change (rotation time, news on/off), restart the rotator.
  let lastRotate = null, lastNewsOn = null;
  setInterval(() => {
    const r = data?.news?.rotateSeconds, on = data?.news?.enabled;
    if (lastRotate !== null && (r !== lastRotate || on !== lastNewsOn)) {
      fitTenants();
      if (on && news.items.length) startRotation(); else clearInterval(news.timer);
    }
    lastRotate = r; lastNewsOn = on;
  }, 5000);

  if (PREVIEW) {
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin || e.data?.type !== "draft" || !e.data.data) return;
      draftMode = true;
      apply({ site: SITE, ...e.data.data });
    });
  }

  if (!PREVIEW && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
