// Pictures are made small enough for a Pi in the browser, before they're sent (DP-11 E1b; shared from DP-12 E2c by the
// console's Layouts tab and the menu editor). The site then reads each file's own bytes (netlify/lib/images.mjs).
export const MAX_SIDE = 1920, MAX_KB = 900;

/** Longest side at most 1,920 pixels, WebP (keeps a logo's transparency), under 900 KB. */
export async function shrink(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error(`${file.name} isn't a picture this browser can open (use JPEG, PNG or WebP).`); }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(16, Math.round(bmp.width * scale)), h = Math.max(16, Math.round(bmp.height * scale));
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
  for (const q of [0.86, 0.78, 0.7, 0.6, 0.5]) {
    const blob = await new Promise((res) => cv.toBlob(res, "image/webp", q));
    if (blob && blob.type === "image/webp" && blob.size <= MAX_KB * 1024) return blob;
  }
  throw new Error(`${file.name} is still too large after shrinking.`);
}
export const asDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
/** "maple_bacon-box.jpg" -> "Maple Bacon Box" */
export const niceName = (fileName) => fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
