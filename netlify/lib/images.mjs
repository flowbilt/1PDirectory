// Pictures (DP-11, round E1b): what a file really is and how big it is, read from its own bytes (never trusting the
// name or what the browser says), so only real WebP, JPEG and PNG pictures of a sensible size are stored.

export const MAX_BYTES = 1024 * 1024;        // = the bucket's limit (supabase/30-layout-images.sql)
export const MAX_SIDE = 4096, MIN_SIDE = 16;

/** { mime, ext, width, height } for a WebP, JPEG or PNG file, or null. */
export function sniffImage(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const u16be = (i) => (b[i] << 8) | b[i + 1], u16le = (i) => b[i] | (b[i + 1] << 8), u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const ascii = (i, n) => String.fromCharCode(...b.slice(i, i + n));
  if (b.length < 30) return null;
  // PNG: signature, then the IHDR chunk with width and height
  if (b[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") return { mime: "image/png", ext: "png", width: u32be(16), height: u32be(20) };
  // WebP: RIFF....WEBP, then VP8 (lossy), VP8L (lossless) or VP8X (extended, e.g. with transparency)
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { mime: "image/webp", ext: "webp", width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (kind === "VP8L" && b[20] === 0x2f) { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { mime: "image/webp", ext: "webp", width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }; }
    if (kind === "VP8X") return { mime: "image/webp", ext: "webp", width: u24le(24) + 1, height: u24le(27) + 1 };
    return null;
  }
  // JPEG: walk the markers to the frame header (SOF0 to SOF15, except DHT, JPG and DAC)
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = u16be(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { mime: "image/jpeg", ext: "jpg", width: u16be(i + 7), height: u16be(i + 5) };
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

/** A picture sent as a data URL: its bytes and what it is, or a plain-words reason it can't be stored. */
export function readPicture(dataUrl) {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return { error: "Send the picture as a WebP, JPEG or PNG." };
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > MAX_BYTES) return { error: `That picture is ${Math.round(bytes.length / 1024)} KB; at most ${MAX_BYTES / 1024} KB (the console shrinks pictures before upload).` };
  const info = sniffImage(bytes);
  if (!info) return { error: "That file isn't a WebP, JPEG or PNG picture." };
  if (info.mime !== m[1]) return { error: "That picture's contents don't match its type." };
  if (info.width < MIN_SIDE || info.height < MIN_SIDE || info.width > MAX_SIDE || info.height > MAX_SIDE)
    return { error: `That picture is ${info.width} × ${info.height}; each side must be ${MIN_SIDE} to ${MAX_SIDE} pixels.` };
  return { bytes, ...info };
}

/** A picture's key from its name or file name: "Maple Bacon.webp" -> "maple-bacon". */
export const pictureKey = (s) => String(s || "").toLowerCase().replace(/\.(webp|jpe?g|png|gif)$/, "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");

/** Every "img:<key>" a layout says, anywhere in it (blocks, rotating photos, the theme's background). */
export function pictureKeys(doc) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === "string") { const m = /^img:([a-z0-9][a-z0-9-]{0,59})$/.exec(v); if (m) out.add(m[1]); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(doc);
  return [...out];
}
