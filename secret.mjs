// Secrets kept in the database (the alert mail server's password, 19-mail.sql), encrypted with SETTINGS_KEY, a key
// held only in Netlify's environment variables. A copy of the database alone can't send mail as 1Point.
//   AES-256-GCM, a fresh 12-byte nonce per secret, stored as "v1:" + base64(nonce | tag | ciphertext).
//   SETTINGS_KEY can be any long random text (e.g. 40+ characters); it is hashed to a 256-bit key.
// Changing SETTINGS_KEY makes saved secrets unreadable: the console says so and asks for the password again.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const keyOf = (k) => createHash("sha256").update(String(k), "utf8").digest();

/** The key from Netlify, or null if it isn't set (or is too short to be safe). */
export function settingsKey(env = process.env) {
  const k = env.SETTINGS_KEY || "";
  return k.length >= 24 ? k : null;
}

export function seal(plain, key = settingsKey()) {
  if (!key) throw Object.assign(new Error("SETTINGS_KEY isn't set in Netlify (at least 24 characters), so a password can't be saved here."), { status: 409 });
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(key), iv);
  const body = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function open(sealed, key = settingsKey()) {
  if (!key) throw new Error("SETTINGS_KEY isn't set in Netlify, so the saved mail password can't be read.");
  const m = /^v1:([A-Za-z0-9+/=]+)$/.exec(String(sealed || ""));
  if (!m) throw new Error("The saved mail password is damaged. Enter it again in the console.");
  const raw = Buffer.from(m[1], "base64");
  if (raw.length < 29) throw new Error("The saved mail password is damaged. Enter it again in the console.");
  try {
    const d = createDecipheriv("aes-256-gcm", keyOf(key), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    throw new Error("The saved mail password can't be read: SETTINGS_KEY in Netlify has changed since it was saved. Enter the password again in the console.");
  }
}
