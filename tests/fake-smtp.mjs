// A stand-in mail server for the tests: encrypted from the start (like port 465) or plain with STARTTLS (like 587),
// with a throwaway self-signed certificate (tests/fixtures, CN=localhost; test-only). Records what it receives.
import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";

export const CERT = readFileSync(new URL("./fixtures/smtp-test-cert.pem", import.meta.url));
const KEY = readFileSync(new URL("./fixtures/smtp-test-key.pem", import.meta.url));

/** opts: {implicit: bool, starttls: bool (offered on a plain connection), plainAuth: bool, password: string} */
export function fakeSmtp(opts = {}) {
  const got = { messages: [], commands: [], auth: [] };
  const handle = (sock, secure) => {
    sock.setEncoding("utf8");
    let buf = "", inData = false, data = "", env = { from: "", to: [] }, loginStep = 0, loginUser = "";
    const say = (s) => sock.write(s + "\r\n");
    const ehlo = () => say(["250-localhost", ...(opts.plainAuth === false ? ["250-AUTH LOGIN"] : ["250-AUTH PLAIN LOGIN"]),
      ...(!secure && opts.starttls !== false ? ["250-STARTTLS"] : []), "250 OK"].join("\r\n"));
    const onLine = (line) => {
      if (inData) {
        if (line === ".") { inData = false; got.messages.push({ ...env, data }); data = ""; return say("250 queued"); }
        data += line + "\n"; return;
      }
      got.commands.push({ line, secure });
      if (loginStep === 1) { loginUser = Buffer.from(line, "base64").toString(); loginStep = 2; return say("334 UGFzc3dvcmQ6"); }
      if (loginStep === 2) { loginStep = 0; const p = Buffer.from(line, "base64").toString(); got.auth.push({ user: loginUser, pass: p, secure });
        return say(p === (opts.password || "secret") ? "235 ok" : "535 bad credentials"); }
      const [cmd] = line.split(" ");
      switch (cmd.toUpperCase()) {
        case "EHLO": return ehlo();
        case "STARTTLS": {
          say("220 go ahead");
          sock.removeAllListeners("data");
          const t = new tls.TLSSocket(sock, { isServer: true, key: KEY, cert: CERT });
          return handle(t, true);
        }
        case "AUTH": {
          const [, mech, arg] = line.split(" ");
          if (mech === "PLAIN") { const [, u, p] = Buffer.from(arg, "base64").toString().split("\0"); got.auth.push({ user: u, pass: p, secure });
            return say(p === (opts.password || "secret") ? "235 ok" : "535 bad credentials"); }
          loginStep = 1; return say("334 VXNlcm5hbWU6");
        }
        case "MAIL": env = { from: line.match(/<(.*)>/)[1], to: [] }; return say("250 ok");
        case "RCPT": env.to.push(line.match(/<(.*)>/)[1]); return say("250 ok");
        case "DATA": inData = true; return say("354 end with .");
        case "QUIT": say("221 bye"); return sock.end();
        default: return say("502 unknown");
      }
    };
    sock.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\r\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); } });
    sock.on("error", () => {});
    if (!secure || opts.implicit) say("220 localhost fake smtp");
  };
  const server = opts.implicit
    ? tls.createServer({ key: KEY, cert: CERT }, (s) => handle(s, true))
    : net.createServer((s) => handle(s, false));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, got, close: () => server.close() })));
}
