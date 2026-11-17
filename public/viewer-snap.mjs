// V5 (DP-15): Save / Share's picture, made in the visitor's own browser from the real screen in the preview frame
// (the directory page or the board page, same site). Nothing is uploaded: the screen's page is copied, its styles,
// fonts and pictures (the visitor's own logo and photo included, already in the page) folded into one SVG image, drawn
// at the screen's true size (1920 × 1080 or 1080 × 1920) and framed with "Concept preview" above and "Preview created
// with WayTuGo · waytugo.com" below, outside the screen. No outside library (package installs are off), so it's this
// file: the same idea as html-to-image.
//
//   snapScreen(frameDocument, W, H)   → a canvas of the screen exactly as it shows now
//   framePicture(screenCanvas, opts)  → a canvas with the WayTuGo frame around it
//   makePicture(frameDocument, opts)  → a PNG Blob
//
// Moving parts (news turning, fades) are caught as they are at that moment; a list scrolled by hand shows from the top.

const cache = new Map();   // address → data: URL (a promise), so a second picture is quick
const toDataUrl = (abs) => {
  if (!abs || abs.startsWith("data:")) return Promise.resolve(abs || "");
  if (!cache.has(abs)) {
    cache.set(abs, fetch(abs, { credentials: "same-origin" }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(b); }))
      .catch(() => ""));
  }
  return cache.get(abs);
};
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** A style sheet's text with its url(...)s folded in and the screen's own vw/vh/vmin sizes made exact */
async function inlineCss(css, base, W, H) {
  const urls = [...new Set([...css.matchAll(URL_RE)].map((m) => m[2]).filter((u) => !u.startsWith("data:") && !u.startsWith("#")))];
  const map = new Map(await Promise.all(urls.map(async (u) => { let abs = ""; try { abs = new URL(u, base).href; } catch { /* not an address */ } return [u, abs ? await toDataUrl(abs) : ""]; })));
  const unit = { vw: W / 100, vh: H / 100, vmin: Math.min(W, H) / 100, vmax: Math.max(W, H) / 100 };
  return css.replace(URL_RE, (m, q, u) => (map.get(u) ? `url("${map.get(u)}")` : m))
    .replace(/(-?\d*\.?\d+)(vw|vh|vmin|vmax)\b/g, (m, n, u) => `${(Number(n) * unit[u]).toFixed(3)}px`);
}

/** Shown on the screen now (not display:none, not see-through) */
function shown(el, win) {
  if (!el.getClientRects().length) return false;
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    const cs = win.getComputedStyle(e);
    if (cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
  }
  return true;
}

const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/** The screen as it shows now, drawn on a canvas W × H */
export async function snapScreen(doc, W, H) {
  const win = doc.defaultView;
  try { await doc.fonts?.ready; } catch { /* drawn with what's loaded */ }
  // every style rule the page has (its files and the styles its code added), with fonts and pictures folded in
  const parts = [];
  for (const sheet of [...doc.styleSheets]) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }   // (all of the screen's are this site's)
    if (!rules) continue;
    parts.push(inlineCss([...rules].map((r) => r.cssText).join("\n"), sheet.href || doc.baseURI, W, H));
  }
  const css = (await Promise.all(parts)).join("\n")
    // frozen: what's moving is caught where it is (below), nothing animates or blinks inside the picture
    + "\n*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";

  const root = doc.documentElement.cloneNode(true);
  const src = [doc.documentElement, ...doc.documentElement.querySelectorAll("*")], dst = [root, ...root.querySelectorAll("*")];
  const drop = [], waits = [];
  src.forEach((s, i) => {
    const d = dst[i]; if (!d) return;
    const tag = s.tagName;
    if (tag === "SCRIPT" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "STYLE" || (tag === "LINK" && /stylesheet|preload|icon/i.test(s.rel))) { drop.push(d); return; }
    if (tag === "IFRAME" || tag === "VIDEO" || tag === "OBJECT" || tag === "EMBED") { const r = s.getBoundingClientRect(); const b = doc.createElement("div"); b.style.cssText = `width:${r.width}px;height:${r.height}px`; d.replaceWith(b); return; }
    if (tag === "CANVAS") { const im = doc.createElement("img"); try { im.src = s.toDataURL(); } catch { im.src = BLANK; } im.style.cssText = s.style.cssText; im.width = s.width; im.height = s.height; im.className = s.className; d.replaceWith(im); return; }
    if (tag === "IMG") {
      d.removeAttribute("srcset"); d.removeAttribute("loading");
      if (!shown(s, win)) d.setAttribute("src", BLANK);   // hidden slides' pictures aren't carried
      else { const abs = s.currentSrc || s.src; waits.push(toDataUrl(abs).then((u) => d.setAttribute("src", u || BLANK))); }
    }
    if (tag === "image" && s.getAttribute("href")) waits.push(toDataUrl(new URL(s.getAttribute("href"), doc.baseURI).href).then((u) => d.setAttribute("href", u || "")));
    if (tag === "INPUT") d.setAttribute("value", s.value);
    const inline = s.getAttribute("style");
    if (inline && inline.includes("url(")) waits.push(inlineCss(inline, doc.baseURI, W, H).then((t) => d.setAttribute("style", t)));
    // moving now (a fade, a slide turning): kept where it is at this moment
    if (s.getAnimations?.().length) {
      const cs = win.getComputedStyle(s);
      waits.push(Promise.resolve().then(() => { d.style.setProperty("opacity", cs.opacity, "important"); if (cs.transform && cs.transform !== "none") d.style.setProperty("transform", cs.transform, "important"); d.style.setProperty("visibility", cs.visibility, "important"); }));
    }
  });
  await Promise.all(waits);
  drop.forEach((d) => d.remove());
  let head = root.querySelector("head"); if (!head) { head = doc.createElement("head"); root.prepend(head); }
  head.innerHTML = "";
  const style = doc.createElement("style"); style.textContent = css; head.appendChild(style);
  root.style.setProperty("width", `${W}px`); root.style.setProperty("height", `${H}px`); root.style.setProperty("overflow", "hidden");
  const body = root.querySelector("body"); if (body) { body.style.setProperty("width", `${W}px`); body.style.setProperty("height", `${H}px`); body.style.setProperty("margin", "0"); }

  const xhtml = new XMLSerializer().serializeToString(root);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">${xhtml}</foreignObject></svg>`;
  const img = new Image(); img.decoding = "sync";
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("The screen couldn't be drawn as a picture.")); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; });
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  // Safari sometimes paints an SVG's fonts and pictures only on the second draw: draw, wait, draw again
  g.drawImage(img, 0, 0, W, H); await new Promise((r) => setTimeout(r, 120)); g.clearRect(0, 0, W, H); g.drawImage(img, 0, 0, W, H);
  return cv;
}

const roundRect = (g, x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
let logoImg = null;
const loadLogo = () => (logoImg ||= new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = "/waytugo-logo.png"; }));

/** The screen in WayTuGo's frame: "Concept preview" above it, the logo and "Preview created with WayTuGo ·
 *  waytugo.com" below it, all outside the screen */
export async function framePicture(screen, { font = "Instrument Sans" } = {}) {
  const W = screen.width, H = screen.height, land = W >= H;
  const pad = 64, bez = 18, top = land ? 132 : 170, bottom = land ? 150 : 190;
  const cv = document.createElement("canvas"); cv.width = W + pad * 2; cv.height = H + top + bottom;
  const g = cv.getContext("2d");
  try { await Promise.all([document.fonts?.load(`700 30px "${font}"`), document.fonts?.load(`400 30px "${font}"`)]); } catch { /* the system font */ }
  g.fillStyle = "#0e2021"; g.fillRect(0, 0, cv.width, cv.height);
  // above: the label
  const fs = land ? 28 : 30;
  g.font = `700 ${fs}px "${font}", system-ui, sans-serif`; g.textBaseline = "middle";
  const tag = "CONCEPT PREVIEW", tw = g.measureText(tag).width, ty = (top - bez) / 2;
  g.fillStyle = "#ff7a1a"; roundRect(g, pad, ty - fs * 0.95, tw + fs * 1.4, fs * 1.9, fs * 0.95); g.fill();
  g.fillStyle = "#1b1206"; g.fillText(tag, pad + fs * 0.7, ty + 1);
  g.font = `400 ${fs}px "${font}", system-ui, sans-serif`; g.fillStyle = "#a9bcbc";
  const note = "Sample content · not a photo of an installed display", nx = pad + tw + fs * 2.2;
  if (nx + g.measureText(note).width <= cv.width - pad) g.fillText(note, nx, ty + 1);
  else { g.fillText("Sample content", nx, ty + 1); }
  // the screen in its bezel
  g.fillStyle = "#050b0c"; roundRect(g, pad - bez, top - bez, W + bez * 2, H + bez * 2, 22); g.fill();
  g.drawImage(screen, pad, top, W, H);
  // below: the logo and the address
  const by = top + H + bez + (bottom - bez) / 2, logo = await loadLogo();
  let lx = pad;
  if (logo) { const lh = land ? 70 : 76, lw = (logo.naturalWidth * lh) / logo.naturalHeight; g.drawImage(logo, pad, by - lh / 2, lw, lh); lx = pad + lw + 28; }
  g.font = `700 ${fs}px "${font}", system-ui, sans-serif`; g.fillStyle = "#ffffff"; g.textAlign = "right";
  g.fillText("Preview created with WayTuGo · waytugo.com", cv.width - pad, by);
  g.textAlign = "left"; void lx;
  return cv;
}

/** The picture, as a PNG */
export async function makePicture(doc, W, H) {
  const framed = await framePicture(await snapScreen(doc, W, H));
  const blob = await new Promise((res, rej) => { try { framed.toBlob((b) => (b ? res(b) : rej(new Error("No picture."))), "image/png"); } catch (e) { rej(e); } });
  return blob;
}
