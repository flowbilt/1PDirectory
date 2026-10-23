// GET /d/<code>  -> Directory to Go: a phone-sized page of one directory, opened from the QR code on its screen
// (DP-08 round 12). waytugo.com forwards /d/* here (a rewrite on the waytugo.com site), so the visitor stays on
// waytugo.com. Public and read-only: it shows only what the screen shows (building, address, tenants and suites,
// contacts, and the place lists when the directory shows them). One database call (togo_page,
// supabase/24-directory-to-go.sql) gets the content and counts the open; nothing about the visitor is kept.
// The page is self-contained (styles and script inline); the WayTuGo logo is an image from this site.
import { rpc } from "../lib/sb.mjs";

const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/i;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const IMAGE_RE = /^data:image\/(jpeg|png|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const img = (src) => (typeof src === "string" && IMAGE_RE.test(src) ? src : "");
const tel = (p) => String(p || "").replace(/[^0-9+]/g, "");

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",                       // every open is counted, and edits show at once
  "X-Robots-Tag": "noindex",                         // a lobby's own page, not something for search engines
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const STYLE = `
:root{--navy:#0d1b2e;--deep:#081322;--card:#13233a;--ink:#fff;--muted:#9fb0c6;--steel:#c7cdd6;--rule:rgba(199,205,214,.16);--accent:#2f8cff}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--navy);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh;display:flex;flex-direction:column}
main{flex:1;width:100%;max-width:640px;margin:0 auto;padding:22px 18px 8px}
header{padding-bottom:18px;border-bottom:2px solid var(--steel);margin-bottom:18px}
.logo{display:block;max-width:100%;max-height:84px;object-fit:contain;object-position:left center;margin-bottom:12px}
h1{font-family:Georgia,"Times New Roman",serif;font-size:30px;line-height:1.1;letter-spacing:-.01em;text-wrap:balance}
.sub{color:var(--muted);margin-top:6px}
.addr{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:999px;background:var(--card);color:var(--ink);text-decoration:none;font-weight:600;font-size:15px;border:1px solid var(--rule)}
.search{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--rule);background:var(--deep);color:var(--ink);font-size:16px;margin:4px 0 10px}
.search::placeholder{color:var(--muted)}
h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:22px 0 8px;font-weight:600}
ul{list-style:none}
.tenant{display:flex;justify-content:space-between;gap:14px;align-items:baseline;padding:12px 0;border-bottom:1px solid var(--rule)}
.tenant b{font-size:17px}
.tenant .note{display:block;color:var(--muted);font-size:13px;font-style:italic;margin-top:2px}
.suite{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--steel)}
.suite small{font-weight:400;color:var(--muted);font-size:12px;margin-right:4px}
.none{color:var(--muted);padding:14px 0;display:none}
.contacts{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.contact{background:var(--card);border-radius:12px;padding:12px 14px}
.contact .role{color:var(--muted);font-size:13px}
.contact b{display:block;margin-top:2px}
.contact a{color:var(--ink)}
.place{display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--rule)}
.place img{width:64px;height:64px;border-radius:10px;object-fit:cover;flex:none;background:var(--card)}
.place .dist{color:var(--steel);font-size:14px;white-space:nowrap;margin-left:auto;padding-left:10px}
.place .line{color:var(--muted);font-size:14px}
.welcome{color:var(--muted);text-align:center;margin:22px 0 4px}
.owner{display:block;max-width:60%;max-height:56px;object-fit:contain;margin:16px auto 0}
footer{background:var(--deep);border-top:1px solid var(--rule);margin-top:26px;padding:22px 18px 26px;text-align:center}
footer a{color:var(--ink);text-decoration:none;display:inline-block}
footer img{display:block;width:170px;height:auto;margin:0 auto 6px}
footer .by{color:var(--muted);font-size:13px}
footer .by b{color:var(--ink)}
@media (max-width:420px){.contacts{grid-template-columns:1fr}h1{font-size:26px}}
`;

function contactCard(role, c) {
  if (!c || !(c.name || c.company || c.phone)) return "";
  return `<div class="contact"><div class="role">${esc(role)}</div>${c.name ? `<b>${esc(c.name)}</b>` : ""}${c.company ? `<div>${esc(c.company)}</div>` : ""}${c.phone ? `<div><a href="tel:${esc(tel(c.phone))}">${esc(c.phone)}</a></div>` : ""}</div>`;
}

function footer(base) {
  return `<footer><a href="https://waytugo.com" rel="noopener"><img src="${esc(base)}/waytugo-logo.png" alt="waytugo" width="170" height="67"><span class="by">Powered by <b>WayTuGo</b> · waytugo.com</span></a></footer>`;
}

function page(base, title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1b2e"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body>${body}${footer(base)}</body></html>`;
}

export function renderTogo(data, base) {
  const d = data.dir || {}, p = data.prop || {};
  const swap = !!(p.logo_swap && p.company_logo);
  const topLogo = img(swap ? p.company_logo : p.logo), ownerLogo = img(swap ? p.logo : p.company_logo);
  const wordmark = !swap && !!(topLogo && p.logo_replaces_name);
  const tenants = Array.isArray(data.tenants) ? data.tenants : [];
  const lists = d.amenities_enabled && Array.isArray(p.place_lists) ? p.place_lists.filter((l) => Array.isArray(l?.items) && l.items.some((a) => a?.name)) : [];
  const welcome = d.footer_override ?? p.footer ?? "";
  const maps = p.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}` : "";
  const contacts = contactCard("Managed by", p.managed_by) + contactCard("Leased by", p.leased_by);
  const body = `<main>
<header>
  ${topLogo ? `<img class="logo" src="${topLogo}" alt="${esc(p.name || d.title)}">` : ""}
  ${wordmark ? `<h1 class="sr" style="position:absolute;left:-9999px">${esc(d.title)}</h1>` : `<h1>${esc(d.title || p.name)}</h1>`}
  ${d.subtitle ? `<div class="sub">${esc(d.subtitle)}</div>` : ""}
  ${p.address ? `<div class="addr"><span class="sub" style="margin:0">${esc(p.address)}</span>${maps ? `<a class="btn" href="${esc(maps)}" rel="noopener">Open in Maps</a>` : ""}</div>` : ""}
</header>
${tenants.length > 6 ? `<input class="search" type="search" placeholder="Find a tenant or suite" aria-label="Find a tenant or suite" autocomplete="off">` : ""}
<h2>Directory</h2>
<ul class="tenants">${tenants.map((t) => `<li class="tenant" data-q="${esc(`${t.name} ${t.suite} ${t.note || ""}`.toLowerCase())}"><span><b>${esc(t.name)}</b>${t.note ? `<span class="note">${esc(t.note)}</span>` : ""}</span>${t.suite ? `<span class="suite"><small>Suite</small>${esc(t.suite)}</span>` : ""}</li>`).join("")}</ul>
<p class="none">No tenant matches that.</p>
${contacts ? `<h2>Contacts</h2><div class="contacts">${contacts}</div>` : ""}
${lists.map((l) => `<h2>${esc(l.heading || "Nearby")}</h2><ul>${l.items.filter((a) => a?.name).map((a) => `<li class="place">${img(a.image) ? `<img src="${img(a.image)}" alt="">` : ""}<div><b>${esc(a.name)}</b>${a.line ? `<div class="line">${esc(a.line)}</div>` : ""}</div>${a.distance ? `<span class="dist">${esc(a.distance)}</span>` : ""}</li>`).join("")}</ul>`).join("")}
${welcome ? `<p class="welcome">${esc(welcome)}</p>` : ""}
${ownerLogo ? `<img class="owner" src="${ownerLogo}" alt="">` : ""}
</main>
<script>(function(){var s=document.querySelector(".search");if(!s)return;var rows=[].slice.call(document.querySelectorAll(".tenant")),none=document.querySelector(".none");
s.addEventListener("input",function(){var q=s.value.trim().toLowerCase(),n=0;rows.forEach(function(r){var on=!q||r.getAttribute("data-q").indexOf(q)>=0;r.style.display=on?"":"none";if(on)n++;});none.style.display=n?"none":"block";});})();</script>`;
  return page(base, d.title || p.name || "Directory", body);
}

export default async (req) => {
  const url = new URL(req.url);
  const base = (process.env.URL || url.origin).replace(/\/+$/, "");   // this site, where the logo lives
  const code = decodeURIComponent(url.pathname.replace(/^\/d\//, "").replace(/\/+$/, ""));
  const notFound = () => new Response(page(base, "Directory not found", `<main><header><h1>This directory link isn't active</h1><div class="sub">The code may have been replaced, or the building has switched it off. The directory on the lobby screen shows the current code.</div></header></main>`), { status: 404, headers: HEADERS });
  if (!CODE_RE.test(code)) return notFound();
  try {
    const r = await rpc("togo_page", { p_code: code.toUpperCase() });
    if (!r || r.missing) return notFound();
    return new Response(renderTogo(r, base), { status: 200, headers: HEADERS });
  } catch (e) {
    return new Response(page(base, "Directory unavailable", `<main><header><h1>The directory is unavailable right now</h1><div class="sub">Please try again in a minute.</div></header></main>`), { status: 502, headers: HEADERS });
  }
};

export const config = { path: "/d/*" };
