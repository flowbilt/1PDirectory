#!/usr/bin/env python3
"""Checks the Pi agent (public/pi/agent.py): runs the real agent against a stand-in site, with the Pi's tools
(vcgencmd, grim, systemctl) replaced by stand-ins, and a 2-second "minute" so it finishes in under a minute.
Run from the project folder:  python3 tests/agent-test.py

What it proves:
  - check-ins stay on a fixed schedule even when each one takes a while (the old agent drifted a second a minute)
  - running commands never adds an extra check-in; results go out with the next scheduled one
  - "Take screenshot" sends the picture with that next check-in and reports what happened
  - a reboot's result survives the reboot and is reported by the first check-in afterwards
  - Update agent installs the new agent, restarts it, and the new one reports the result
"""
import json, os, re, shutil, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "public", "pi", "agent.py")
TICK = 2.0          # the test's "minute"
WORK = 0.6          # each check-in's slow part (vcgencmd), which must not push the schedule back

W = tempfile.mkdtemp(prefix="agent-test-")
checkins, replies, lock = [], [], threading.Lock()   # replies: list of command lists, one per check-in
NEW_AGENT = re.sub(r'VERSION = "[^"]+"', 'VERSION = "9.9.9-test"', open(AGENT).read(), count=1)   # what Update agent downloads


class Site(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):  # Update agent downloads this
        body = NEW_AGENT.encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with lock:
            checkins.append((time.monotonic(), data))
            cmds = replies.pop(0) if replies else []
        body = json.dumps({"screen": "test", "commands": cmds, "screenshot_every": 300}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)


def stub(name, text):
    p = os.path.join(W, "bin", name)
    with open(p, "w") as f:
        f.write("#!/usr/bin/env bash\n" + text)
    os.chmod(p, 0o755)


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    os.makedirs(os.path.join(W, "bin"))
    stub("vcgencmd", f"sleep {WORK}; echo throttled=0x0\n")
    # "Rebooting" stops the agent (its parent), as a real reboot would
    stub("systemctl", f'echo "$*" >> {W}/systemctl.log; [[ "$1" == reboot ]] && kill -TERM $PPID; exit 0\n')
    stub("grim", 'python3 -c "import sys; from PIL import Image; Image.new(\'RGB\', (64, 36), (20, 40, 80)).save(sys.argv[1])" "${@: -1}"\n')
    agent = os.path.join(W, "agent.py")
    shutil.copy(AGENT, agent)                            # Update agent rewrites this copy, not the real one
    cfg = os.path.join(W, "agent.json")
    json.dump({"site": f"http://127.0.0.1:{srv.server_port}", "key": "k" * 43, "user": "no-such-desktop-user"}, open(cfg, "w"))
    state = os.path.join(W, "state", "pending-results.json")
    env = dict(os.environ, PATH=f"{W}/bin:" + os.environ["PATH"], LOBBY_AGENT_CONFIG=cfg, LOBBY_AGENT_STATE=state,
               LOBBY_AGENT_INTERVAL=str(TICK), LOBBY_AGENT_SERIAL="10000000abcd0001")
    log = open(os.path.join(W, "agent.log"), "a")
    start = lambda: subprocess.Popen([sys.executable, agent], env=env, stdout=log, stderr=log)

    passed, failed = 0, 0

    def check(name, ok, detail=""):
        nonlocal passed, failed
        if ok: passed += 1; print(f"  ok  {name}")
        else: failed += 1; print(f"  FAIL {name}" + (f": {detail}" if detail else ""))

    def wait_for(n, timeout=30):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            with lock:
                if len(checkins) >= n: return True
            time.sleep(0.05)
        return False

    # ── A. schedule, and commands without an extra check-in ──
    replies.extend([[], [], [{"id": 1, "command": "reload"}, {"id": 2, "command": "screenshot"}], [], [], [], [], []])
    p = start()
    wait_for(8)
    t = [c[0] for c in checkins[:8]]
    off = [round(t[i] - t[0] - i * TICK, 2) for i in range(8)]
    check("check-ins stay on a fixed schedule though each takes a while", max(abs(x) for x in off) < 0.35, f"off the schedule by {off} s")
    gaps = [round(t[i + 1] - t[i], 2) for i in range(7)]
    check("no extra check-in after running commands", min(gaps) > TICK - 0.35, f"gaps {gaps}")
    after = checkins[3][1]
    res = {r["id"]: r for r in after.get("results", [])}
    check("command results go out with the next scheduled check-in", res.get(1, {}).get("status") == "done", after.get("results"))
    check("Take screenshot sends the picture then, and says so",
          after.get("screenshot", "").startswith("data:image/jpeg;base64,") and res.get(2, {}).get("result") == "Screenshot taken.", res.get(2))
    check("results are sent once", not checkins[4][1].get("results"), checkins[4][1].get("results"))

    # ── B. a reboot's result survives the reboot ──
    with lock:
        replies.clear(); replies.append([{"id": 3, "command": "reboot"}]); n = len(checkins)
    wait_for(n + 1)
    try: p.wait(timeout=10)
    except subprocess.TimeoutExpired: p.kill()
    saved = json.load(open(state)) if os.path.exists(state) else []
    check("reboot: the result is kept on disk before rebooting",
          p.returncode is not None and saved and saved[0].get("id") == 3 and saved[0].get("status") == "done", saved)
    check("reboot: systemctl was asked to reboot", "reboot" in open(os.path.join(W, "systemctl.log")).read())
    with lock: n = len(checkins)
    p = start()
    wait_for(n + 2)
    first = checkins[n][1]
    check("the first check-in after the reboot reports it", [r.get("result") for r in first.get("results", [])] == ["Rebooted."], first.get("results"))
    check("and the saved result is cleared once the site has it", not os.path.exists(state))

    # ── C. Update agent: installs, restarts, and the new agent reports the result ──
    with lock:
        replies.clear(); replies.append([{"id": 4, "command": "update_agent"}]); n = len(checkins)
    wait_for(n + 3)
    new = [c[1] for c in checkins[n + 1:]]
    check("the updated agent is the one checking in", all(b.get("version") == "9.9.9-test" for b in new), [b.get("version") for b in new])
    got = new[0].get("results", []) if new else []
    check("and it reports the update", got and got[0].get("id") == 4 and got[0].get("status") == "done" and "9.9.9-test" in got[0].get("result", ""), got)

    p.terminate()
    try: p.wait(timeout=5)
    except subprocess.TimeoutExpired: p.kill()
    srv.shutdown()
    print(f"\n{passed}/{passed + failed} passed")
    if failed:
        print(f"(agent log: {W}/agent.log)")
    else:
        shutil.rmtree(W, ignore_errors=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
