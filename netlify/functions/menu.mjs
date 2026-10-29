// "Take this menu with you" (DP-11, round E1c): a layout's menu on a phone, opened from the QR code on its screen.
//   GET /m/<code>         the phone page (waytugo.com forwards /m/* here, as it does /d/* for Directory to Go, so the
//                         visitor stays on waytugo.com). Each open is counted; nothing about the visitor is kept.
//   GET /api/menu?code=   the same layout as a screen's answer, for "See the board" (board.html?menu=<code>); not counted.
// Public and read-only: only the layout's published version, as designed (its colours, fonts, pictures and words), laid
// out for a phone: the blocks on now by the building's clock, in reading order (each column of the board top to bottom), with no clock, weather or
// QR code. Items, text, photos and a rotator's pictures with a link open it in a new tab. The page is self-contained
// (styles inline); fonts, pictures and the board come from this site by full address, since the page is shown on
// waytugo.com. One database call (menu_page, supabase/31-menu-to-go.sql; from 32-menus.sql it carries the layout's menu,
// whose lists fill the blocks that show them: E2a, DP-12).
import { rpc } from "../lib/sb.mjs";
import { applyMenu } from "../../public/menu-format.mjs";
import { checkLayout, applyLook, blockShows, zonedNow, hoursNow, nowNext, niceTime, niceDays, blockColours, readingOrder, FONTS, TAGS } from "../../public/layout-format.mjs";
import { toLayoutPayload, cleanLists, cleanBoard } from "./screen.mjs";

const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/i;
const LINK_RE = /^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/i;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const HEX_RE = /^#[0-9a-fA-F]{3,6}$/;

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",                       // every open is counted, and a new version shows at once
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const SKIP = new Set(["clock", "weather", "qr", "logo"]);   // the logo heads the page; the rest belong to the screen
const FOCUS_POS = { center: "50% 50%", top: "50% 15%", bottom: "50% 85%", left: "15% 50%", right: "85% 50%" };

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--ink);font:16px/1.45 var(--f-body);min-height:100vh;display:flex;flex-direction:column}
main{flex:1;width:100%;max-width:640px;margin:0 auto;padding:20px 16px 8px}
a{color:inherit}
header{text-align:center;padding:4px 0 14px}
.logo{display:block;max-width:82%;max-height:110px;object-fit:contain;margin:0 auto}
h1{font-family:var(--f-display);font-size:30px;line-height:1.1;text-wrap:balance}
.where{color:var(--muted);font-size:14px;margin-top:6px}
.blk{border-radius:16px;margin:12px 0;color:var(--b-ink);background:var(--b-back)}
.blk.surf{padding:16px}
.disp{font-family:var(--f-display)}
.acc{font-family:var(--f-accent)}
.kicker{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.8;font-weight:700}
.title{font-size:24px;line-height:1.15;margin:2px 0 4px;text-wrap:balance}
.body{white-space:pre-line}
.note{font-size:13px;opacity:.8;margin-top:6px}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:22px;line-height:1.15;padding-bottom:6px;margin-bottom:4px;border-bottom:2px solid var(--line)}
.surf .head{border-bottom-color:currentColor;border-bottom-color:color-mix(in srgb,currentColor 30%,transparent)}
.head .gp{font-size:16px;white-space:nowrap;font-family:var(--f-body);font-weight:700}
ul{list-style:none}
.item{padding:9px 0;border-bottom:1px solid var(--line)}
.surf .item{border-bottom-color:color-mix(in srgb,currentColor 18%,transparent)}
.item:last-child{border-bottom:0}
.row{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.name{font-weight:700;font-size:17px}
.price{font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums}
.line{font-size:14px;opacity:.8;margin-top:1px}
.sold .name,.sold .price{text-decoration:line-through;opacity:.55}
.tag{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:999px;margin-left:6px;vertical-align:2px;background:var(--highlight);color:var(--onHighlight)}
.tag.sold-out{background:var(--muted);color:var(--bg)}
.go{text-decoration:none}
.go .name::after,.more::after{content:" \\2197";font-weight:400;opacity:.7}
.more{display:inline-block;margin-top:10px;padding:8px 14px;border-radius:999px;background:var(--accent);color:var(--onAccent);text-decoration:none;font-weight:700;font-size:15px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.chip{padding:6px 12px;border-radius:999px;background:var(--panel);color:var(--onPanel);font-weight:600;font-size:15px}
.chip.special{background:var(--highlight);color:var(--onHighlight)}
.chip.sold{text-decoration:line-through;opacity:.55}
.sticker{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.sticker .amount{font-size:30px;font-weight:700}
figure{position:relative;border-radius:16px;overflow:hidden;background:var(--panel)}
figure img{display:block;width:100%;height:auto;max-height:420px;object-fit:cover}
figure.contain img{object-fit:contain;background:var(--panel)}
figcaption{padding:10px 14px 12px;background:var(--panel);color:var(--onPanel)}
figcaption b{display:block;font-size:19px;font-family:var(--f-display);line-height:1.15}
.fprice{position:absolute;right:10px;top:10px;background:var(--highlight);color:var(--onHighlight);font-weight:700;padding:4px 10px;border-radius:8px}
.strip{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:6px;-webkit-overflow-scrolling:touch}
.strip .slide{flex:0 0 82%;scroll-snap-align:start}
.strip figure img{aspect-ratio:4/3;height:auto}
.fig{display:block;text-decoration:none}
.fig figcaption b::after{content:" \\2197";font-weight:400;opacity:.7}
.hint{font-size:12px;opacity:.65;text-align:right;margin-top:2px}
.open{font-size:22px;line-height:1.15;margin:2px 0 6px}
.open.closed{opacity:.8}
.week{font-size:15px}
table{width:100%;border-collapse:collapse;font-size:15px;margin-top:6px}
th,td{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line)}
tr.today td{font-weight:700}
.nn .lbl{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.75;font-weight:700;margin-top:8px}
.nn .val{font-size:20px}
.board{margin:22px 0 6px;border-top:1px solid var(--line);padding-top:14px}
.board summary{cursor:pointer;font-weight:700;list-style:none;display:inline-block;padding:9px 16px;border-radius:999px;background:var(--panel);color:var(--onPanel)}
.board summary::-webkit-details-marker{display:none}
.board iframe{display:block;width:100%;border:0;border-radius:12px;margin-top:12px;background:var(--bg)}
.board p{font-size:13px;color:var(--muted);margin-top:6px}
.addr{color:var(--muted);text-align:center;font-size:14px;margin:18px 0 0}
.addr a{color:var(--ink);font-weight:600}
footer{margin-top:22px;padding:20px 16px 26px;text-align:center;background:var(--panel);color:var(--onPanel)}
footer a{color:inherit;text-decoration:none;display:inline-block}
footer img{display:block;width:150px;height:auto;margin:0 auto 6px}
footer .by{font-size:13px;opacity:.8}
`;

/** The phone page for a layout's published version (menu_page's answer), as the building's clock says now. */
export function renderMenu(r, base, code, nowMs = Date.now()) {
  const checked = checkLayout(r?.layout?.doc);
  if (!checked.doc) return null;
  const tz = r.prop?.timezone || "America/Chicago";
  const now = zonedNow(nowMs, tz);
  // E2d: in the look and with the options chosen for the board (the chalkboard's colours on a phone too)
  const doc = applyMenu(applyLook(checked.doc, cleanBoard(r.lists, r.layout?.id)), cleanLists(r.lists), now);   // E2b: specials by their dates, days and times too   // E2a: the lists as they are today (no empty room on a phone)
  const p = doc.theme.palette, f = doc.theme.fonts;
  const images = r.images || {};
  const pic = (ref) => { const m = /^img:(.+)$/.exec(ref || ""); const i = m && images[m[1]]; return i && /^[0-9a-f-]{36}\/[a-z0-9-]+\.(webp|jpg|png)$/.test(i.path) ? `${base}/img/${i.path}` : ""; };
  const href = (u) => (typeof u === "string" && LINK_RE.test(u) ? u : "");
  const go = (u, inner, cls = "go") => (href(u) ? `<a class="${cls}" href="${esc(href(u))}" target="_blank" rel="noopener">${inner}</a>` : inner);
  const fontCls = (b) => ({ display: "disp", accent: "acc", body: "" }[b.style.font || "display"]);
  const tags = (t) => (t || []).filter((x) => TAGS[x]).map((x) => `<span class="tag ${x}">${esc(TAGS[x])}</span>`).join("");

  const R = {
    text(b) {
      const c = b.content;
      return `${c.kicker ? `<div class="kicker">${esc(c.kicker)}</div>` : ""}${c.title ? `<div class="title ${fontCls(b)}">${esc(c.title)}</div>` : ""}`
        + `${c.body ? `<div class="body">${esc(c.body)}</div>` : ""}${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}`
        + `${href(c.link) ? `<a class="more" href="${esc(c.link)}" target="_blank" rel="noopener">More information</a>` : ""}`;
    },
    items(b) {
      const c = b.content;
      const head = c.heading || c.price ? `<div class="head ${fontCls(b)}"><span>${esc(c.heading || "")}</span>${c.price ? `<span class="gp">${esc(c.price)}</span>` : ""}</div>` : "";
      return head + `<ul>${(c.items || []).filter((it) => it.name).map((it) => {
        const sold = (it.tags || []).includes("sold-out");
        const inner = `<div class="row"><span class="name">${esc(it.name)}${tags(it.tags)}</span>${it.price ? `<span class="price">${esc(it.price)}</span>` : ""}</div>${it.line ? `<div class="line">${esc(it.line)}</div>` : ""}`;
        return `<li class="item${sold ? " sold" : ""}">${go(it.link, inner)}</li>`;
      }).join("")}</ul>`;
    },
    chips(b) {
      const c = b.content;
      return `${c.heading || c.price ? `<div class="head ${fontCls(b)}"><span>${esc(c.heading || "")}</span>${c.price ? `<span class="gp">${esc(c.price)}</span>` : ""}</div>` : ""}<div class="chips">${(c.items || []).filter((it) => it.name).map((it) => {
        const t = it.tags || [], sold = t.includes("sold-out"), special = t.some((x) => x !== "sold-out");
        return `<span class="chip${sold ? " sold" : ""}${special && !sold ? " special" : ""}">${esc(it.name)}</span>`;
      }).join("")}</div>`;
    },
    price(b) {
      const c = b.content;
      return `<div class="sticker">${c.label ? `<span>${esc(c.label)}</span>` : ""}<span class="amount ${fontCls(b)}">${esc(c.price || "")}</span>${c.note ? `<span class="note">${esc(c.note)}</span>` : ""}</div>`;
    },
    photo(b) {
      const c = b.content, src = pic(c.image);
      if (!src && !c.caption) return "";
      const fig = `<figure class="${c.fit === "contain" ? "contain" : ""}">${src ? `<img src="${esc(src)}" alt="${esc(c.alt || c.caption || "")}" loading="lazy" style="object-position:${FOCUS_POS[c.focus || "center"]}">` : ""}`
        + `${c.price ? `<span class="fprice">${esc(c.price)}</span>` : ""}${c.caption || c.line ? `<figcaption>${c.caption ? `<b>${esc(c.caption)}</b>` : ""}${c.line ? `<span class="line">${esc(c.line)}</span>` : ""}</figcaption>` : ""}</figure>`;
      return go(c.link, fig, "go fig");
    },
    rotator(b) {
      const c = b.content, items = (c.items || []).filter((it) => pic(it.image) || it.caption);
      if (!items.length) return "";
      const slides = items.map((it) => {
        const src = pic(it.image);
        const fig = `<figure class="${c.fit === "contain" ? "contain" : ""}">${src ? `<img src="${esc(src)}" alt="${esc(it.alt || it.caption || "")}" loading="lazy" style="object-position:${FOCUS_POS[c.focus || "center"]}">` : ""}`
          + `${it.price ? `<span class="fprice">${esc(it.price)}</span>` : ""}${it.caption || it.line ? `<figcaption>${it.caption ? `<b>${esc(it.caption)}</b>` : ""}${it.line ? `<span class="line">${esc(it.line)}</span>` : ""}</figcaption>` : ""}</figure>`;
        return `<div class="slide">${go(it.link, fig, "go fig")}</div>`;
      });
      return `<div class="strip">${slides.join("")}</div>${items.length > 1 ? `<div class="hint">Swipe for more →</div>` : ""}`;
    },
    hours(b) {
      const c = b.content, h = hoursNow(c.hours, now);
      return `${c.heading ? `<div class="kicker">${esc(c.heading)}</div>` : ""}<div class="open ${fontCls(b)}${h.open ? "" : " closed"}">${esc(h.line)}</div>`
        + `<div class="week">${h.week.map(esc).join("<br>")}</div>${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}`;
    },
    timetable(b) {
      const c = b.content;
      return `${c.heading ? `<div class="head ${fontCls(b)}"><span>${esc(c.heading)}</span></div>` : ""}<table>`
        + `${(c.columns || []).length ? `<tr><th></th>${c.columns.map((x) => `<th>${esc(x)}</th>`).join("")}</tr>` : ""}`
        + `${(c.rows || []).map((row) => `<tr class="${(row.days || []).includes(now.dow) ? "today" : ""}"><td>${esc(row.label || niceDays(row.days || []))}</td>${(row.cells || []).map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</table>`;
    },
    nownext(b) {
      const c = b.content, nn = nowNext(c.sessions, now);
      const one = (s, lbl) => `<div class="lbl">${esc(lbl)}</div>${s ? `<div class="val ${fontCls(b)}">${esc(s.name || "")}</div><div class="line">${esc([s.day, `${niceTime(s.from)} – ${niceTime(s.to)}`].filter(Boolean).join(" · "))}${s.line ? ` · ${esc(s.line)}` : ""}</div>` : `<div class="line">${esc(c.empty || "Nothing on right now")}</div>`}`;
      return `<div class="nn">${one(nn.now, c.now || "On now")}${one(nn.next, c.next || "Next")}</div>`;
    },
  };

  const shown = doc.blocks.filter((b) => b.on !== false && blockShows(b, now));
  const logoBlock = shown.find((b) => b.type === "logo");
  const logoSrc = logoBlock && pic(logoBlock.content.image);
  const title = r.layout?.name || r.prop?.name || "Menu";
  const brand = logoBlock?.content.text || r.prop?.name || "";
  const order = readingOrder(shown.filter((b) => !SKIP.has(b.type) && R[b.type]));   // each column of the board top to bottom
  const blocks = order.map((b) => {
    const inner = R[b.type](b);
    if (!inner) return "";
    const surf = b.style.surface || (b.type === "price" ? "highlight" : "none");
    const { back, ink } = blockColours(doc, { ...b, style: { ...b.style, surface: surf } });
    const plain = surf === "none" || ["photo", "rotator"].includes(b.type);
    return `<section class="blk t-${b.type}${plain ? "" : " surf"}" style="--b-back:${plain ? "transparent" : back};--b-ink:${plain ? p.ink : ink}">${inner}</section>`;
  }).join("");

  const fonts = [...new Set(Object.values(f))].filter((n) => FONTS[n]).flatMap((n) => FONTS[n].files.map(([file, w]) =>
    `@font-face{font-family:"${n}";src:url("${base}/fonts/${file}") format("truetype");font-weight:${w};font-display:swap}`)).join("");
  const vars = `:root{${Object.entries(p).filter(([, v]) => HEX_RE.test(v)).map(([k, v]) => `--${k}:${v}`).join(";")};`
    + `--f-display:${FONTS[f.display]?.css || "system-ui"};--f-body:${FONTS[f.body]?.css || "system-ui"};--f-accent:${FONTS[f.accent || f.display]?.css || "system-ui"}}`;
  const maps = r.prop?.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.prop.address)}` : "";
  const ratio = doc.orientation === "landscape" ? "16 / 9" : "9 / 16";
  const body = `<main>
<header>${logoSrc ? `<img class="logo" src="${esc(logoSrc)}" alt="${esc(brand)}">` : `<h1>${esc(brand || title)}</h1>`}</header>
${blocks}
${r.prop?.address ? `<p class="addr">${esc(r.prop.address)}${maps ? ` · <a href="${esc(maps)}" target="_blank" rel="noopener">Open in Maps</a>` : ""}</p>` : ""}
<details class="board"><summary>See the board</summary><iframe title="The menu board" loading="lazy" style="aspect-ratio:${ratio}${doc.orientation === "portrait" ? ";max-height:80vh;width:auto;margin-inline:auto" : ""}" data-src="${esc(base)}/board.html?menu=${esc(code)}"></iframe><p>As it shows on the screen in the shop now. <a href="${esc(base)}/board.html?menu=${esc(code)}" target="_blank" rel="noopener">Open it full screen</a>${doc.orientation === "landscape" ? " (turn your phone sideways)" : ""}, then pinch to zoom.</p></details>
</main>
<script>(function(){var d=document.querySelector(".board");if(!d)return;d.addEventListener("toggle",function(){var f=d.querySelector("iframe");if(d.open&&!f.src)f.src=f.getAttribute("data-src");});})();</script>`;
  return page(base, title, body, `${fonts}${vars}`, p.bg);
}

function page(base, title, body, head = "", theme = "#0d1b2e") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${esc(HEX_RE.test(theme) ? theme : "#0d1b2e")}"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${head}${STYLE}</style></head>
<body>${body}<footer><a href="https://waytugo.com" rel="noopener"><img src="${esc(base)}/waytugo-logo.png" alt="waytugo" width="150" height="59"><span class="by">Powered by <b>WayTuGo</b> · waytugo.com</span></a></footer></body></html>`;
}
const PLAIN = ":root{--bg:#0d1b2e;--ink:#fff;--muted:#9fb0c6;--panel:#13233a;--onPanel:#fff;--line:rgba(199,205,214,.16);--f-display:Georgia,serif;--f-body:system-ui,sans-serif}";

export default async (req) => {
  const url = new URL(req.url);
  const base = (process.env.URL || url.origin).replace(/\/+$/, "");   // this site: fonts, pictures, the board, the logo
  // "See the board": the layout as a screen's answer, for board.html?menu=<code>
  if (url.pathname === "/api/menu") {
    const code = String(url.searchParams.get("code") || "");
    const json = (o, status) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    if (!CODE_RE.test(code)) return json({ error: "No such menu." }, 404);
    try {
      const r = await rpc("menu_page", { p_code: code.toUpperCase(), p_count: false });
      if (!r || r.missing) return json({ error: "No such menu." }, 404);
      return json(toLayoutPayload({ key: "menu", name: r.layout.name, orientation: "auto", hide_powered_by: false, touch: false, screen_inches: null, touch_idle_s: 45 },
        { ...r.layout, lists: r.lists }, r.prop, r.images), 200);
    } catch { return json({ error: "The menu is unavailable right now." }, 502); }
  }
  const code = decodeURIComponent(url.pathname.replace(/^\/m\//, "").replace(/\/+$/, ""));
  const notFound = () => new Response(page(base, "Menu not found", `<main><header><h1>This menu link isn't active</h1><p class="where">The shop may have changed its menu board. The QR code on the screen in the shop always opens the current menu.</p></header></main>`, PLAIN), { status: 404, headers: HEADERS });
  if (!CODE_RE.test(code)) return notFound();
  try {
    const r = await rpc("menu_page", { p_code: code.toUpperCase(), p_count: true });
    if (!r || r.missing) return notFound();
    const html = renderMenu(r, base, code.toUpperCase());
    if (!html) return notFound();
    return new Response(html, { status: 200, headers: HEADERS });
  } catch {
    return new Response(page(base, "Menu unavailable", `<main><header><h1>The menu is unavailable right now</h1><p class="where">Please try again in a minute.</p></header></main>`, PLAIN), { status: 502, headers: HEADERS });
  }
};

export const config = { path: ["/m/*", "/api/menu"] };
