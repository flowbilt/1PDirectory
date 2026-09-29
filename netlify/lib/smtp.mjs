// A small SMTP sender for alert emails through the company's own mail server (e.g. Rackspace), with no packages.
// Port 465: encrypted from the start. Any other port (587): upgraded with STARTTLS, which the server must offer.
// The password never crosses an unencrypted connection. Resolves true once the server accepts the message.
import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";

const addr = (s) => (String(s).match(/<([^>]+)>/)?.[1] || String(s)).trim();
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);   // non-ASCII subjects and names
const fromHeader = (s) => { const m = String(s).match(/^\s*(.*?)\s*<([^>]+)>\s*$/); return m && m[1] ? `${header(m[1].replace(/^"|"$/g, ""))} <${m[2]}>` : addr(s); };

/**
 * @param {{host: string, port?: number, user: string, pass: string, from: string, to: string[], subject: string,
 *          html: string, tlsOptions?: object, timeoutMs?: number}} m
 */
export async function sendMail(m) {
  const port = Number(m.port) || 587;
  const secure = m.secure ?? port === 465;
  const timeoutMs = m.timeoutMs || 20000;
  let sock = secure
    ? tls.connect({ host: m.host, port, servername: m.host, ...m.tlsOptions })
    : net.connect({ host: m.host, port });
  let buf = "", waiting = null;

  const attach = (s) => {
    s.setEncoding("utf8");
    s.on("data", (d) => { buf += d; pump(); });
    s.on("error", (e) => waiting?.reject(e));
    s.on("close", () => waiting?.reject(new Error("mail server closed the connection")));
  };
  function pump() {
    // A complete reply ends with a line "NNN text" (a space after the code; "NNN-" lines continue it)
    const lines = buf.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const reply = lines.slice(0, i + 1);
        buf = lines.slice(i + 1).join("\r\n");
        const w = waiting; waiting = null;
        w?.resolve({ code: Number(reply.at(-1).slice(0, 3)), text: reply.map((l) => l.slice(4)).join("\n") });
        return;
      }
    }
  }
  const reply = () => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("mail server took too long to answer")), timeoutMs);
    waiting = { resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); } };
    pump();
  });
  const expect = async (line, ok, what) => {
    if (line !== null) sock.write(line + "\r\n");
    const r = await reply();
    if (!ok.includes(r.code)) throw new Error(`${what}: ${r.code} ${r.text}`.slice(0, 300));
    return r;
  };

  attach(sock);
  try {
    if (secure) await new Promise((res, rej) => { sock.once("secureConnect", res); sock.once("error", rej); });
    await expect(null, [220], "mail server greeting");
    let ehlo = await expect("EHLO lobby-directory", [250], "EHLO");
    if (!secure) {
      if (!/^STARTTLS/im.test(ehlo.text)) throw new Error("the mail server doesn't offer encryption (STARTTLS) on this port; use port 465 or 587");
      await expect("STARTTLS", [220], "STARTTLS");
      sock.removeAllListeners("data"); sock.removeAllListeners("close"); sock.removeAllListeners("error");
      const plain = sock;
      sock = tls.connect({ socket: plain, servername: m.host, ...m.tlsOptions });
      attach(sock);
      await new Promise((res, rej) => { sock.once("secureConnect", res); sock.once("error", rej); });
      ehlo = await expect("EHLO lobby-directory", [250], "EHLO after STARTTLS");
    }
    if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) {
      await expect(`AUTH PLAIN ${b64(`\0${m.user}\0${m.pass}`)}`, [235], "sign-in");
    } else {
      await expect("AUTH LOGIN", [334], "sign-in");
      await expect(b64(m.user), [334], "sign-in (user)");
      await expect(b64(m.pass), [235], "sign-in (password)");
    }
    await expect(`MAIL FROM:<${addr(m.from)}>`, [250], "sender");
    for (const t of m.to) await expect(`RCPT TO:<${addr(t)}>`, [250, 251], `recipient ${addr(t)}`);
    await expect("DATA", [354], "DATA");
    const body = b64(m.html).replace(/.{1,76}/g, "$&\r\n");
    const msg = [
      `From: ${fromHeader(m.from)}`,
      `To: ${m.to.map(addr).join(", ")}`,
      `Subject: ${header(m.subject)}`,
      `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
      `Message-ID: <${randomUUID()}@${addr(m.from).split("@")[1] || "lobby-directory"}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      body,
    ].join("\r\n");
    await expect(`${msg}\r\n.`, [250], "message");
    sock.write("QUIT\r\n");
    return true;
  } finally {
    setTimeout(() => sock.destroy(), 200).unref?.();
  }
}
