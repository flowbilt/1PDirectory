// A screen that shows a layout (DP-11, round E1a). Draws the layout's published version from /api/screen on its
// canvas, scaled to the screen and turned to its Orientation; shows each block only while its schedule says so; keeps
// the clock, hours and "on now" current. What every screen does (check-in, clock, Identify, lockdown, reloads, the
// offline copy, handing back to the directory page) is screen-core.js, shared with the directory display.
//   ?preview=1   the console's Layouts preview: no check-in; the layout arrives by message, and the page reports back
//                which blocks overflow their box (a guardrail).
//   ?menu=<code> "See the board" on the phone menu (E1c): the layout's published version from /api/menu, read-only, no
//                check-in, never turned, pinch-zoom allowed.
import { checkLayout, canvas, blockBox, blockShows, zonedNow, hoursNow, nowNext, niceTime, niceDays, FONTS, SIZES, SURFACES, STYLE_PX, TAGS, QR_LINE, qrSide } from "/layout-format.mjs";

const VERSION = "2.18.0";   // = netlify/lib/version.mjs and display.js (a test keeps them equal)
const C = window.ScreenCore;
const { PREVIEW, CHECKS_IN, MENU, cache, esc } = C;
const $ = (id) => document.getElementById(id);
const stage = $("stage"), boardEl = $("board"), blocksEl = $("blocks");
let data = null, sig = "", doc = null, drawn = null;
const MIN_FIT = 0.55;   // text shrinks to fit its box down to this share of its size; past that the block overflows

// ── Size and turn ──
function sizeStage() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = C.rotation(data?.orientation, vw, vh);
  stage.style.setProperty("--W", `${r.W}px`);
  stage.style.setProperty("--H", `${r.H}px`);
  stage.style.transform = r.transform;
  if (!doc) return;
  const cv = canvas(doc.orientation);
  const s = Math.min(r.W / cv.w, r.H / cv.h);
  boardEl.style.width = `${cv.w}px`; boardEl.style.height = `${cv.h}px`;
  boardEl.style.transform = `translate(${(r.W - cv.w * s) / 2}px, ${(r.H - cv.h * s) / 2}px) scale(${s})`;
}

// ── Fonts: only the ones this layout uses, from the curated list ──
const fontsAdded = new Set();
function addFonts(names) {
  const css = [];
  for (const n of names) {
    if (fontsAdded.has(n) || !FONTS[n] || n === "Instrument Sans") continue;
    fontsAdded.add(n);
    for (const [file, weight] of FONTS[n].files) css.push(`@font-face{font-family:"${n}";src:url("/fonts/${file}") format("truetype");font-weight:${weight};font-display:block}`);
  }
  if (css.length) { const st = document.createElement("style"); st.textContent = css.join("\n"); document.head.appendChild(st); }
  return Promise.all(names.filter((n) => FONTS[n]).flatMap((n) => FONTS[n].files.map(([, w]) => document.fonts.load(`${String(w).split(" ")[0]} 40px "${n}"`).catch(() => null))));
}

// ── Drawing ──
const tagsHtml = (tags) => (tags || []).map((t) => `<span class="tag ${t}">${esc(TAGS[t])}</span>`).join("");
const titleClass = (b) => `t-${b.style.font || "display"}`;
// E1b: a layout's pictures, from the screen's answer (key -> { url, w, h }); "img:maple-bacon" -> its address on this site
const picture = (ref) => { const m = /^img:(.+)$/.exec(ref || ""); return m ? data?.images?.[m[1]]?.url || "" : ""; };
const FOCUS_POS = { center: "50% 50%", top: "50% 15%", bottom: "50% 85%", left: "15% 50%", right: "85% 50%" };
const BODY = {
  text(b) {
    const c = b.content;
    return `${c.kicker ? `<div class="b-kicker">${esc(c.kicker)}</div>` : ""}${c.title ? `<div class="b-title ${titleClass(b)}">${esc(c.title)}</div>` : ""}`
      + `${c.body ? `<div class="b-body${c.title ? "" : " alone"}">${esc(c.body)}</div>` : ""}${c.note ? `<div class="b-note">${esc(c.note)}</div>` : ""}`;
  },
  items(b) {
    const c = b.content;
    const head = c.heading || c.price ? `<div class="items-head ${titleClass(b)}"><span>${esc(c.heading || "")}</span>${c.price ? `<span class="group-price">${esc(c.price)}</span>` : ""}</div>` : "";
    return `${head}<ul class="items-list" style="--cols:${c.columns || 1}">${(c.items || []).map((it) => {
      const sold = (it.tags || []).includes("sold-out");
      return `<li class="item${sold ? " sold" : ""}"><div class="item-row"><span class="item-name">${esc(it.name || "")}${tagsHtml(it.tags)}</span>`
        + `${it.price ? `<span class="${c.leaders ? "leader" : "spacer"}"></span><span class="item-price">${esc(it.price)}</span>` : ""}</div>`
        + `${it.line ? `<div class="item-line">${esc(it.line)}</div>` : ""}</li>`;
    }).join("")}</ul>`;
  },
  chips(b) {
    const c = b.content;
    return `${c.heading ? `<div class="chips-head ${titleClass(b)}">${esc(c.heading)}</div>` : ""}<div class="chips">${(c.items || []).map((it) => {
      const t = it.tags || [], sold = t.includes("sold-out"), special = t.some((x) => x !== "sold-out");
      return `<span class="chip${sold ? " sold" : ""}${special && !sold ? " special" : ""}">${esc(it.name || "")}</span>`;
    }).join("")}</div>`;
  },
  price(b) {
    const c = b.content;
    return `<div class="b-price">${c.label ? `<div class="label">${esc(c.label)}</div>` : ""}<div class="amount ${titleClass(b)}">${esc(c.price || "")}</div>${c.note ? `<div class="pnote">${esc(c.note)}</div>` : ""}</div>`;
  },
  photo(b) {
    const c = b.content, src = picture(c.image);
    const cap = c.caption || c.line ? `<div class="photo-cap">${c.caption ? `<div class="b-title ${titleClass(b)}">${esc(c.caption)}</div>` : ""}${c.line ? `<div class="b-body">${esc(c.line)}</div>` : ""}</div>` : "";
    // E1b: the picture itself; until it's uploaded (or if it's missing), the quiet panel as in E1a
    const pic = src ? `<img class="photo-img" src="${esc(src)}" alt="${esc(c.alt || c.caption || "")}" style="object-fit:${c.fit || "cover"};object-position:${FOCUS_POS[c.focus || "center"]}">`
      : `<div class="photo-fill" role="img" aria-label="${esc(c.alt || c.caption || "")}"></div>`;
    return `${pic}${cap}${c.price ? `<div class="photo-price">${esc(c.price)}</div>` : ""}`;
  },
  rotator(b) {
    // E1b: several pictures taking turns (cross-fading), each with its own caption, line and price
    const c = b.content, items = (c.items || []).length ? c.items : [{}];
    return items.map((it, i) => {
      const src = picture(it.image);
      const cap = it.caption || it.line ? `<div class="photo-cap">${it.caption ? `<div class="b-title ${titleClass(b)}">${esc(it.caption)}</div>` : ""}${it.line ? `<div class="b-body">${esc(it.line)}</div>` : ""}</div>` : "";
      const pic = src ? `<img class="photo-img" src="${esc(src)}" alt="${esc(it.alt || it.caption || "")}" style="object-fit:${c.fit || "cover"};object-position:${FOCUS_POS[c.focus || "center"]}">` : `<div class="photo-fill"></div>`;
      return `<div class="rot-slide${i === 0 ? " on" : ""}" data-slide="${i}">${pic}${cap}${it.price ? `<div class="photo-price">${esc(it.price)}</div>` : ""}</div>`;
    }).join("");
  },
  logo(b) {
    const src = picture(b.content.image), text = b.content.text || data?.propertyName || "";
    return src ? `<img class="logo-img" src="${esc(src)}" alt="${esc(text)}">` : `<div class="b-logo ${titleClass(b)}">${esc(text)}</div>`;
  },
  clock(b) { return `<div class="b-clock" data-live="clock" data-show="${b.content.show || "both"}"></div>`; },
  weather(b) { return `<div data-live="weather">${b.content.label ? `<span class="wlabel">${esc(b.content.label)}</span>` : ""}<div class="b-weather"></div></div>`; },
  hours(b) {
    const c = b.content;
    return `${c.heading ? `<div class="hours-head">${esc(c.heading)}</div>` : ""}<div class="hours-now ${titleClass(b)}" data-live="hours"></div>`
      + `<div class="hours-week">${hoursNow(c.hours, { dow: 1, hm: "00:00", date: "" }).week.map(esc).join("<br>")}</div>${c.note ? `<div class="hours-note">${esc(c.note)}</div>` : ""}`;
  },
  timetable(b) {
    const c = b.content;
    return `${c.heading ? `<div class="tt-head ${titleClass(b)}">${esc(c.heading)}</div>` : ""}<table class="tt">`
      + `${(c.columns || []).length ? `<tr><th></th>${c.columns.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>` : ""}`
      + `${(c.rows || []).map((r) => `<tr data-days="${(r.days || []).join(",")}"><td class="day">${esc(r.label || niceDays(r.days || []))}</td>${(r.cells || []).map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</table>`;
  },
  nownext(b) { return `<div class="nn" data-live="nownext"></div>`; },
  // E1c: "Take this menu with you": the layout's own code (waytugo.com/m/<code>), drawn here, exactly the size the
  // guardrail measured; until the layout has a code (a preview of a new one) a quiet square
  qr(b) {
    const side = Math.max(0, qrSide(doc, b)), url = data?.menu?.url || "";
    let code = "";
    if (url) { try { code = C.svgQR(url); } catch (e) { console.warn("QR failed", e); } }
    return `<div class="b-qr"><div class="qr-code${code ? "" : " qr-empty"}" style="width:${side}px;height:${side}px">${code}</div><div class="qr-line">${esc(b.content.line || QR_LINE)}</div></div>`;
  },
};

function blockHtml(b) {
  const p = doc.theme.palette, surf = b.style.surface || (b.type === "price" ? "highlight" : "none");
  const back = surf === "none" ? "transparent" : p[surf];
  const ink = b.style.ink ? p[b.style.ink] : surf === "none" ? p.ink : p[SURFACES[surf]];
  const box = blockBox(doc, b);
  const radius = STYLE_PX.RADII[b.style.radius || (b.type === "price" ? "round" : "none")];
  // A round price sticker is a circle: the largest square that fits its cells, centred in them
  if (b.type === "price" && radius === STYLE_PX.RADII.round) {
    const side = Math.min(box.width, box.height);
    Object.assign(box, { left: box.left + (box.width - side) / 2, top: box.top + (box.height - side) / 2, width: side, height: side });
  }
  const pad = STYLE_PX.PADS[b.style.pad || (surf === "none" ? "none" : "m")];
  const align = b.style.align || (b.type === "price" ? "center" : "left");
  const styles = [`left:${box.left}px`, `top:${box.top}px`, `width:${box.width}px`, `height:${box.height}px`, `z-index:${1 + b.layer}`,
    `--back:${back}`, `--ink:${ink}`, `--radius:${Math.min(radius, Math.min(box.width, box.height) / 2)}px`, `--pad:${pad}px`,
    `--align:${align}`, `--logo-pos:${{ left: "left center", center: "center", right: "right center" }[align]}`, `--chip-justify:${{ left: "flex-start", center: "center", right: "flex-end" }[align]}`,
    `--valign:${{ top: "flex-start", middle: "center", bottom: "flex-end" }[b.style.valign || "top"]}`, `--fs:${SIZES[b.style.size || "m"]}px`];
  if (b.style.border) styles.push(`--border:${p[b.style.border]}`);
  if (b.style.tilt) styles.push(`transform:rotate(${b.style.tilt}deg)`);
  const cls = ["b", b.type, b.type === "logo" && picture(b.content.image) ? "has-img" : "", b.style.border ? "bordered" : "", b.style.shadow ? "shadow" : "", b.style.case === "upper" ? "upper" : ""].filter(Boolean).join(" ");
  return `<div class="${cls}" data-id="${esc(b.id)}" style="${styles.join(";")}"><div class="b-in">${BODY[b.type](b)}</div></div>`;
}

function render() {
  const note = $("note");
  if (!data) return;
  document.title = data.layout?.name ? `${data.layout.name}` : "Layout";
  const raw = data.layout?.doc;
  if (!raw) {
    note.innerHTML = data.assigned === false ? `This screen (${esc(data.key || "")}) isn't showing anything yet.` : `The layout "${esc(data.layout?.name || "")}" hasn't been published yet.`;
    note.hidden = false; stage.classList.remove("is-loading"); return;
  }
  const checked = checkLayout(raw);   // fills in defaults; published layouts were checked already
  if (!checked.doc) { note.textContent = "This layout can't be shown."; note.hidden = false; stage.classList.remove("is-loading"); return; }
  note.hidden = true;
  doc = checked.doc;
  const p = doc.theme.palette, f = doc.theme.fonts;
  for (const [k, v] of Object.entries(p)) stage.style.setProperty(`--p-${k}`, v);
  for (const [k, v] of Object.entries(f)) stage.style.setProperty(`--f-${k}`, FONTS[v].css);
  sizeStage();
  // E1b: the background picture, dimmed by the palette's bg colour
  const bg = doc.theme.background, bgSrc = bg && picture(bg.image);
  $("bgpic").hidden = !bgSrc;
  if (bgSrc) { $("bgpic").innerHTML = `<img src="${esc(bgSrc)}" alt=""><div class="bg-dim" style="opacity:${bg.dim / 100}"></div>`; }
  blocksEl.innerHTML = [...doc.blocks].sort((a, b) => a.layer - b.layer).map(blockHtml).join("");
  startRotators();
  drawn = sig;
  $("powered").hidden = data.poweredBy === false;           // "Powered by WayTuGo"; 1Point can hide it per screen
  live(true);
  addFonts([...new Set(Object.values(f))]).then(() => document.fonts.ready).then(() => {
    if (drawn !== sig) return;
    fitAll();
    stage.classList.remove("is-loading");
  });
}

// ── Rotating photos (E1b): each rotator turns on its own clock; every slide's picture is fetched when the board is drawn, so each is ready when its turn comes ──
let rotTimers = [];
function startRotators() {
  rotTimers.forEach(clearInterval); rotTimers = [];
  for (const b of doc.blocks.filter((x) => x.type === "rotator" && (x.content.items || []).length > 1)) {
    const el = blocksEl.querySelector(`[data-id="${CSS.escape(b.id)}"]`);
    let i = 0;
    rotTimers.push(setInterval(() => {
      if (!el || el.hidden) return;
      const slides = el.querySelectorAll(".rot-slide");
      slides[i].classList.remove("on");
      i = (i + 1) % slides.length;
      slides[i].classList.add("on");
    }, (b.content.seconds || 8) * 1000));
  }
}

// ── Fitting: each block's text shrinks until it fits its box; one that still doesn't is an overflow ──
function fits(el) { const inner = el.firstElementChild; return inner.scrollHeight <= el.clientHeight - 2 * (parseFloat(getComputedStyle(el).paddingTop) || 0) + 1 && inner.scrollWidth <= inner.clientWidth + 1; }
function fitBlock(el) {
  const inner = el.firstElementChild;
  inner.style.setProperty("--fit", "1");
  if (fits(el)) return 1;
  let lo = MIN_FIT, hi = 1;
  inner.style.setProperty("--fit", String(lo));
  if (!fits(el)) return 0;
  for (let i = 0; i < 9; i++) { const mid = (lo + hi) / 2; inner.style.setProperty("--fit", String(mid)); if (fits(el)) lo = mid; else hi = mid; }
  inner.style.setProperty("--fit", String(lo));
  return lo;
}
function fitAll() {
  const report = { overflow: [], shrunk: [] };
  for (const el of blocksEl.children) {
    if (el.hidden) continue;
    const r = fitBlock(el);
    el.classList.toggle("overflow-mark", PREVIEW && r === 0);
    if (r === 0) report.overflow.push(el.dataset.id); else if (r < 1) report.shrunk.push({ id: el.dataset.id, scale: Math.round(r * 100) / 100 });
  }
  if (PREVIEW && window.parent !== window) window.parent.postMessage({ type: "layout-report", ...report }, location.origin);
  return report;
}

// ── Live parts: schedules, the clock, hours, on now / next ──
let lastShown = "";
function live(force) {
  if (!doc) return;
  const tz = data?.timezone || "America/Chicago";
  const now = zonedNow(C.now(), tz);
  // Which blocks show now (their schedules, in the building's time zone)
  const shown = doc.blocks.map((b) => (blockShows(b, now) ? 1 : 0)).join("");
  if (force || shown !== lastShown) {
    doc.blocks.forEach((b) => { const el = blocksEl.querySelector(`[data-id="${CSS.escape(b.id)}"]`); if (el) el.hidden = !blockShows(b, now); });
    if (!force && lastShown) fitAll();
    lastShown = shown;
  }
  for (const el of blocksEl.querySelectorAll("[data-live]")) {
    const b = doc.blocks.find((x) => x.id === el.closest(".b").dataset.id);
    if (el.dataset.live === "clock") {
      if (!C.clock.trusted) { el.innerHTML = ""; continue; }
      const t = C.timeParts(tz), show = el.dataset.show;
      el.innerHTML = `${show !== "date" ? `<div class="time ${titleClass(b)}">${esc(t.hm)}<small>${esc(t.ap)}</small></div>` : ""}${show !== "time" ? `<div class="${show === "date" ? "time" : "date"}">${esc(t.date)}</div>` : ""}`;
    } else if (el.dataset.live === "hours") {
      const h = hoursNow(b.content.hours, now);
      el.textContent = h.line; el.classList.toggle("closed", !h.open);
    } else if (el.dataset.live === "nownext") {
      const nn = nowNext(b.content.sessions, now), c = b.content;
      const one = (s, lbl, isNow) => `<div class="${isNow && s ? "live" : ""}"><div class="lbl">${esc(lbl)}</div>${s
        ? `<div class="val ${titleClass(b)}">${esc(s.name || "")}</div><div class="sub">${esc([s.day, `${niceTime(s.from)} – ${niceTime(s.to)}`].filter(Boolean).join(" · "))}${s.line ? ` · ${esc(s.line)}` : ""}</div>`
        : `<div class="sub">${esc(c.empty || "Nothing on right now")}</div>`}</div>`;
      el.innerHTML = one(nn.now, c.now || "On now", true) + one(nn.next, c.next || "Next", false);
    }
  }
  for (const tr of blocksEl.querySelectorAll(".tt tr[data-days]")) tr.classList.toggle("today", tr.dataset.days.split(",").map(Number).includes(now.dow));
}

// ── Weather (the building's location; the same source and cache rules as the directory) ──
function showWeather(w) {
  let changed = false;
  for (const el of blocksEl.querySelectorAll('[data-live="weather"] .b-weather')) {
    const html = w && typeof w.tempF === "number" ? `<span class="wnow"><svg viewBox="0 0 48 48">${C.WX[w.icon] || C.WX.cloud}</svg><span class="temp">${w.tempF}°</span></span><span class="wtext">${esc(w.text || "")}</span>` : "";
    if (el.innerHTML !== html) { el.innerHTML = html; changed = true; }
  }
  if (changed) refitSoon();
}
// Text that arrives after the first fit (the weather, the clock once the site has answered) gets the block fitted again
let refitTimer = null;
function refitSoon() { clearTimeout(refitTimer); refitTimer = setTimeout(() => { if (doc) fitAll(); }, 50); }
async function loadWeather() {
  const wx = data?.weather;
  if (!wx?.enabled || !doc?.blocks.some((b) => b.type === "weather")) return;
  try {
    const res = await fetch(`/api/weather?lat=${wx.lat}&lon=${wx.lon}`, { cache: "default" });
    if (!res.ok) throw new Error(String(res.status));
    const w = await res.json();
    cache.set("weather", w); showWeather(w);
  } catch {
    const c = cache.get("weather");
    showWeather(c && Date.now() - Date.parse(c.at) < 3 * 3600 * 1000 ? c : null);   // old weather is worse than none
  }
}

// ── The screen's answer ──
function apply(d) {
  if (C.route(d)) return;                       // the console chose a directory for this screen: hand back
  const s = JSON.stringify(d);
  if (s === sig) { C.showIdentify($("identify"), data); return; }
  const coords = !data || data.weather?.lat !== d.weather?.lat || data.weather?.lon !== d.weather?.lon;
  sig = s; data = d;
  render();
  C.showIdentify($("identify"), data);
  if (coords) loadWeather(); else showWeather(cache.get("weather"));
}

async function loadScreen() {
  if (PREVIEW) return;
  if (MENU) {   // E1c: the phone menu's "See the board"
    try {
      const r = await fetch(`/api/menu?code=${encodeURIComponent(MENU)}`, { cache: "no-store" });
      if (r.ok) apply({ ...(await r.json()), orientation: "auto" });
      else if (!data) { $("note").textContent = "This menu isn't available right now."; $("note").hidden = false; stage.classList.remove("is-loading"); }
    } catch { /* keep what's drawn */ }
    return;
  }
  try {
    const got = await C.fetchScreen(VERSION);    // the check-in, the site's clock, the kept copy, a newer display
    if (!got) return;
    $("offline").hidden = !got.fromCache;
    apply(got.d);
  } catch (e) {
    console.warn("Screen fetch failed", e);
    if (!data) { const c = cache.get("directory"); if (c) apply(c); }
    $("offline").hidden = !data;
  }
}

// ── Boot ──
if (!C.DEVICE && !C.CHOSEN && !PREVIEW && !MENU) location.replace("/");
if (!MENU) C.lockdown();
C.clock.onTrusted = () => { live(false); refitSoon(); };
sizeStage();
window.addEventListener("resize", () => { sizeStage(); });
if (PREVIEW) {
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || e.data?.type !== "layout-draft" || !e.data.data) return;
    sig = ""; apply({ ...e.data.data, kind: "layout" });
  });
  if (window.parent !== window) window.parent.postMessage({ type: "layout-ready" }, location.origin);
} else if (MENU) {
  loadScreen();
  setInterval(loadScreen, 5 * 60 * 1000);
} else {
  const cached = cache.get("directory");
  if (cached) apply(cached);
  loadScreen().then(() => { if (!data) setTimeout(() => location.reload(), 30000); });
  setInterval(loadScreen, 60 * 1000);
  setInterval(loadWeather, 10 * 60 * 1000);
  C.scheduleNightlyReload();
  C.registerOfflineCache();
}
setInterval(() => { C.showIdentify($("identify"), data); live(false); }, 1000);
window.LayoutBoard = { fitAll, get doc() { return doc; }, get images() { return data?.images || {}; } };   // for the browser checks
