// A screen that shows a layout (DP-11, round E1a). Draws the layout's published version from /api/screen on its
// canvas, scaled to the screen and turned to its Orientation; shows each block only while its schedule says so; keeps
// the clock, hours and "on now" current. What every screen does (check-in, clock, Identify, lockdown, reloads, the
// offline copy, handing back to the directory page) is screen-core.js, shared with the directory display.
//   ?preview=1   the console's Layouts preview: no check-in; the layout arrives by message, and the page reports back
//                which blocks overflow their box (a guardrail).
//   ?menu=<code> "See the board" on the phone menu (E1c): the layout's published version from /api/menu, read-only, no
//                check-in, never turned, pinch-zoom allowed.
// E2a (DP-12): a block on a list draws that list of the layout's menu (the answer's "lists": spec and content), through
// applyMenu (public/menu-format.mjs): only the entries shown, sold out today marked, and an items or chips list keeping
// the room for its full length (invisible rows), so the text stays the size it was designed at however much is filled.
import { applyMenu, menuMoment } from "/menu-format.mjs";
import { checkLayout, applyLook, canvas, blockBox, blockShows, zonedNow, hoursNow, nowNext, niceTime, niceDays, FONTS, SIZES, SURFACES, STYLE_PX, TAGS, QR_LINE, qrSide } from "/layout-format.mjs";

const VERSION = "2.22.1";   // = netlify/lib/version.mjs and display.js (a test keeps them equal)
const C = window.ScreenCore;
const { PREVIEW, CHECKS_IN, MENU, SAMPLE, cache, esc } = C;
const READ_ONLY = MENU || SAMPLE;   // drawn for a visitor (the phone menu's See the board, or a sample link): no check-in, never turned
const $ = (id) => document.getElementById(id);
const stage = $("stage"), boardEl = $("board"), blocksEl = $("blocks");
let data = null, sig = "", doc = null, drawn = null, drawnDate = "", drawnMoment = "";
// The page that's previewing this one: the console or menu editor around it, or (E2b, "Preview full size") the menu
// editor that opened it in its own window
const HOST = window.parent !== window ? window.parent : window.opener || null;
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
    // E2a: the rest of the list's room, kept as invisible rows (one line each), so adding an item never shrinks the others
    const ghosts = Math.max(0, (c.room || 0) - (c.items || []).length);
    return `${head}<ul class="items-list" style="--cols:${c.columns || 1}">${(c.items || []).map((it) => {
      const sold = (it.tags || []).includes("sold-out");
      // Sold out today takes no room (Scot, DP-12 E2c): the mark sits over the price, so ticking it never changes the fit
      return `<li class="item${sold ? " sold" : ""}"><div class="item-row"><span class="item-name">${esc(it.name || "")}${tagsHtml((it.tags || []).filter((t) => t !== "sold-out"))}</span>`
        + `${it.price ? `<span class="${c.leaders ? "leader" : "spacer"}"></span><span class="item-price">${esc(it.price)}</span>` : ""}`
        + `${sold ? `<span class="tag sold-out sold-mark">${esc(TAGS["sold-out"])}</span>` : ""}</div>`
        + `${it.line ? `<div class="item-line">${esc(it.line)}</div>` : ""}</li>`;
    }).join("")}${'<li class="item ghost" aria-hidden="true"><div class="item-row"><span class="item-name">&nbsp;</span></div></li>'.repeat(ghosts)}</ul>`;
  },
  chips(b) {
    const c = b.content;
    // E2a: a price over the whole list ("$4.99") beside the heading; the list's room kept as invisible chips of the
    // average name's length
    const items = c.items || [], ghosts = Math.max(0, (c.room || 0) - items.length);
    const avg = Math.max(6, Math.round(items.reduce((n, it) => n + String(it.name || "").length, 0) / (items.length || 1)));
    const head = c.heading || c.price ? `<div class="chips-head ${titleClass(b)}">${esc(c.heading || "")}${c.heading && c.price ? " · " : ""}${c.price ? `<span class="group-price">${esc(c.price)}</span>` : ""}</div>` : "";
    return `${head}<div class="chips">${items.map((it) => {
      const t = it.tags || [], sold = t.includes("sold-out"), special = t.some((x) => x !== "sold-out");
      return `<span class="chip${sold ? " sold" : ""}${special && !sold ? " special" : ""}">${esc(it.name || "")}</span>`;
    }).join("")}${`<span class="chip ghost" aria-hidden="true">${"n".repeat(avg)}</span>`.repeat(ghosts)}</div>`;
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
    // E2d: on the chalkboard a dark logo would vanish on the slate: its light version if the layout has one, else the
    // name written in chalk
    const chalk = doc.look?.look === "chalkboard";
    const src = chalk ? picture(b.content.chalkImage) : picture(b.content.image), text = b.content.text || data?.propertyName || "";
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
  const logoImg = b.type === "logo" && picture(doc.look?.look === "chalkboard" ? b.content.chalkImage : b.content.image);
  const cls = ["b", b.type, logoImg ? "has-img" : "", surf !== "none" ? "surfaced" : "", b.style.border ? "bordered" : "", b.style.shadow ? "shadow" : "", b.style.case === "upper" ? "upper" : ""].filter(Boolean).join(" ");
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
  // E2a: its lists, as they are today in the building (an item sold out today is marked; tomorrow it's back)
  // E2b: and its specials by their dates, days and times
  const nowHere = zonedNow(C.now(), data?.timezone || "America/Chicago");
  drawnDate = nowHere.date; drawnMoment = menuMoment(data.lists, nowHere);
  // E2d: in the look and with the options chosen for this board in the menu editor (else the layout's own)
  doc = applyMenu(applyLook(checked.doc, data.look), data.lists, nowHere, { room: true });
  drawStart = performance.now();
  const p = doc.theme.palette, f = doc.theme.fonts;
  for (const [k, v] of Object.entries(p)) stage.style.setProperty(`--p-${k}`, v);
  for (const [k, v] of Object.entries(f)) stage.style.setProperty(`--f-${k}`, FONTS[v].css);
  styleLook(doc.look);
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
  addFonts([...new Set([...Object.values(f), ...(doc.look?.item ? [doc.look.item] : [])])]).then(() => document.fonts.ready).then(() => {
    if (drawn !== sig) return;
    fitAll();
    stage.classList.remove("is-loading");
    measure();
  });
}

// ── Looks (E2d): the chalkboard's slate, chalk colours, lettering, grain and frame ──
let grainUrl = "";
/** The chalk grain: a small speckled tile made once on a canvas and laid over the lettering as a mask (no picture to
 *  load, nothing redrawn after the board is drawn; Scot chose it over a live SVG filter, DP-13). */
function grain() {
  if (grainUrl) return grainUrl;
  try {
    const n = 200, cv = document.createElement("canvas"); cv.width = cv.height = n;
    const x = cv.getContext("2d"), d = x.createImageData(n, n);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);   // the same grain every time
    for (let i = 0; i < d.data.length; i += 4) d.data[i + 3] = rnd() < 0.22 ? Math.floor(rnd() * 120) : 255;
    x.putImageData(d, 0, 0);
    grainUrl = `url(${cv.toDataURL()})`;
  } catch { grainUrl = ""; }
  return grainUrl;
}
function styleLook(look) {
  const chalk = look?.look === "chalkboard";
  stage.classList.toggle("look-chalk", chalk);
  stage.classList.toggle("lettering-hand", chalk && look.chalk.lettering === "hand");
  stage.classList.toggle("framed", chalk && !!look.chalk.frame);
  stage.classList.toggle("no-grain", chalk && grainDropped);
  if (!chalk) return;
  for (const [k, v] of Object.entries(look.colours)) stage.style.setProperty(`--chalk-${k}`, v);
  stage.style.setProperty("--f-item", FONTS[look.item].css);
  const g = grain();
  if (g) stage.style.setProperty("--grain", g); else stage.classList.add("no-grain");
}

// ── How fast the board draws (E2d): measured on a real screen after each draw and sent with the next check-in, so the
// Pi panel can say how the chalk texture runs on that Pi; if the pictures' turns run slow, the grain is dropped ──
let drawStart = 0, lastReport = null, grainDropped = false, measuring = false;
function measure() {
  const ms = Math.round(performance.now() - drawStart);
  const fit = fitAll.last || { overflow: [], shrunk: [] };
  lastReport = { ms, fps: null, slow: 0, look: doc.look?.look || "house", grain: doc.look?.look === "chalkboard" ? (grainDropped ? "dropped" : "on") : "none",
    overflow: fit.overflow.slice(0, 10), shrunk: fit.shrunk.length };
  if (PREVIEW || READ_ONLY || measuring) return;
  // Frame gaps over 20 seconds, which takes in a picture's turn or two
  measuring = true;
  const gaps = []; let last = performance.now(); const end = last + 20000;
  const step = (t) => {
    gaps.push(t - last); last = t;
    if (t < end) { requestAnimationFrame(step); return; }
    measuring = false;
    gaps.shift(); gaps.sort((a, b) => a - b);
    const med = gaps[gaps.length >> 1] || 16.7;
    lastReport = { ...lastReport, fps: Math.round(1000 / med), slow: gaps.filter((g) => g > 50).length };
    // Slow on this Pi (fewer than 25 frames a second): the grain comes off and the board says so in the Pi panel
    if (lastReport.grain === "on" && lastReport.fps < 25) { grainDropped = true; stage.classList.add("no-grain"); lastReport.grain = "dropped"; }
  };
  requestAnimationFrame(step);
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
  if (PREVIEW && HOST) HOST.postMessage({ type: "layout-report", ...report }, location.origin);
  fitAll.last = report;
  if (lastReport) lastReport = { ...lastReport, overflow: report.overflow.slice(0, 10), shrunk: report.shrunk.length };
  return report;
}

// ── Live parts: schedules, the clock, hours, on now / next ──
let lastShown = "";
function live(force) {
  if (!doc) return;
  const tz = data?.timezone || "America/Chicago";
  const now = zonedNow(C.now(), tz);
  // E2a: at the building's midnight, "sold out today" clears: draw the lists again for the new day
  // E2b: and when a special's time comes or goes, by the building's clock (no save needed)
  if (data?.lists && drawnDate && (now.date !== drawnDate || menuMoment(data.lists, now) !== drawnMoment)) { render(); return; }
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
  if (SAMPLE) {   // T0 (DP-13): a sample link: the board as the phone menu's See the board, marked; it ends on its date
    try {
      const r = await fetch(`/api/sample?code=${encodeURIComponent(SAMPLE)}${data ? "" : "&open=1"}`, { cache: "no-store" });
      if (r.ok) { $("note").hidden = true; apply({ ...(await r.json()), orientation: "auto" }); $("sample-mark").hidden = false; return; }
      if (r.status === 404 || r.status === 410) {
        data = null; sig = ""; $("blocks").innerHTML = ""; $("sample-mark").hidden = true;
        $("note").textContent = r.status === 410 ? "This sample has ended. Ask WayTuGo for a new link." : "This sample link isn't active. Ask WayTuGo for a new one.";
        $("note").hidden = false; stage.classList.remove("is-loading");
      }
    } catch { /* keep what's drawn */ }
    return;
  }
  if (MENU) {   // E1c: the phone menu's "See the board"
    try {
      const r = await fetch(`/api/menu?code=${encodeURIComponent(MENU)}`, { cache: "no-store" });
      if (r.ok) { $("note").hidden = true; apply({ ...(await r.json()), orientation: "auto" }); }
      // T1 (DP-13; Scot, after T0b): a menu that's no longer active (a sample's link turned off) takes the board away,
      // as the sample page does; any other failure keeps what's drawn
      else if (r.status === 404) { data = null; sig = ""; $("blocks").innerHTML = ""; $("note").textContent = "This menu link isn't active."; $("note").hidden = false; stage.classList.remove("is-loading"); }
      else if (!data) { $("note").textContent = "This menu isn't available right now."; $("note").hidden = false; stage.classList.remove("is-loading"); }
    } catch { /* keep what's drawn */ }
    return;
  }
  try {
    // E2d: how the board drew (time, frame rate, look, grain, anything overflowing) goes with the check-in
    const got = await C.fetchScreen(VERSION, lastReport ? { "X-Board": JSON.stringify(lastReport) } : {});    // the check-in, the site's clock, the kept copy, a newer display
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
if (!C.DEVICE && !C.CHOSEN && !PREVIEW && !READ_ONLY) location.replace("/");
if (!READ_ONLY) C.lockdown();
C.clock.onTrusted = () => { live(false); refitSoon(); };
sizeStage();
window.addEventListener("resize", () => { sizeStage(); });
if (PREVIEW) {
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    // E2a: the menu editor and the Layouts tab can show the lists' empty room (dashed), to see what's left
    if (e.data?.type === "layout-room") { stage.classList.toggle("show-room", !!e.data.on); return; }
    if (e.data?.type !== "layout-draft" || !e.data.data) return;
    sig = ""; apply({ ...e.data.data, kind: "layout" });
  });
  if (HOST) HOST.postMessage({ type: "layout-ready" }, location.origin);
} else if (READ_ONLY) {
  document.documentElement.classList.add("menu-view");   // a phone, not a lobby screen: touches and pinch-zoom work
  loadScreen();
  setInterval(loadScreen, SAMPLE ? 60 * 1000 : 5 * 60 * 1000);   // a sample shows WayTuGo's changes within a minute
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
window.LayoutBoard = { fitAll, get doc() { return doc; }, get images() { return data?.images || {}; }, get report() { return lastReport; } };   // for the browser checks
