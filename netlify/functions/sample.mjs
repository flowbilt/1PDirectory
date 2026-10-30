// Sample links (DP-13, round T0): one published board shown to a prospect, from 1Point, before an appointment.
//   GET /s/<name>            the page (waytugo.com forwards /s/* here, as it does /d/* and /m/*, so the visitor stays on
//                            waytugo.com): the board filling the window, with a "Sample · WayTuGo" mark. Self-contained, so
//                            it works on waytugo.com: it frames this site's board page by its full address.
//   GET /api/sample?code=    the board as a screen's answer (as the phone menu's "See the board" gets it), with the
//                            link's building; &open=1 counts an open (the page's first load). 404 for no such link,
//                            410 once it's turned off or past its date.
// Public and read-only. One database call (sample_page, supabase/36-templates.sql). The links are made, lengthened and
// turned off in the console (1Point only).
import { rpc } from "../lib/sb.mjs";
import { toLayoutPayload } from "./screen.mjs";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,39}$/i;
const json = (o, status) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function samplePage(base, slug) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Menu board sample · WayTuGo</title>
<style>html,body{margin:0;height:100%;background:#111}iframe{display:block;border:0;width:100%;height:100%}</style>
</head>
<body>
<iframe src="${esc(base)}/board.html?sample=${esc(slug)}" title="Menu board sample" allow="fullscreen"></iframe>
</body>
</html>`;
}

export default async (req) => {
  const url = new URL(req.url);
  const base = (process.env.URL || url.origin).replace(/\/+$/, "");
  if (url.pathname === "/api/sample") {
    const code = String(url.searchParams.get("code") || "");
    if (!SLUG_RE.test(code)) return json({ error: "No such sample." }, 404);
    try {
      const r = await rpc("sample_page", { p_slug: code.toLowerCase(), p_open: url.searchParams.get("open") === "1" });
      if (!r || r.missing) return json({ error: "No such sample." }, 404);
      if (r.ended) return json({ error: "This sample has ended.", ended: true, until: r.until }, 410);
      return json({ ...toLayoutPayload({ key: "sample", name: r.layout.name, orientation: "auto", hide_powered_by: false, touch: false, screen_inches: null, touch_idle_s: 45 },
        { ...r.layout, lists: r.lists }, r.prop, r.images), sample: r.sample }, 200);
    } catch { return json({ error: "The sample is unavailable right now." }, 502); }
  }
  const slug = decodeURIComponent(url.pathname.replace(/^\/s\//, "").replace(/\/+$/, ""));
  if (!SLUG_RE.test(slug)) {
    return new Response(`<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sample not found</title><body style="font:18px system-ui;padding:40px;text-align:center">This sample link isn't active. Ask WayTuGo for a new one.</body>`,
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" } });
  }
  return new Response(samplePage(base, slug.toLowerCase()), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" } });
};

export const config = { path: ["/s/*", "/api/sample"] };
