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
  - a card carries no identity: the agent makes its own key in each Pi, keeps it across restarts, makes a new one
    if the card moves to another Pi, and keeps the key of a Pi set up before generic cards
  - Update Pi runs the latest setup as its own job (check-ins carry on), reports when it's done, then restarts the
    Pi; a failed update reports its error and doesn't restart
"""
import json, os, pwd, re, shutil, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "..", "public", "pi", "agent.py")
TICK = 2.0          # the test's "minute"
WORK = 0.6          # each check-in's slow part (vcgencmd), which must not push the schedule back

W = tempfile.mkdtemp(prefix="agent-test-")
checkins, replies, lock = [], [], threading.Lock()   # replies: list of command lists, one per check-in
FAKE_SETUP = """#!/usr/bin/env bash
# stand-in for setup-kiosk.sh --update
echo "==> Updating this Pi ($*)"; sleep 5
if [[ -f "$UPDATE_FAIL_FILE" ]]; then echo "E: Unable to fetch some archives"; exit 100; fi
echo "Updated."
"""
NEW_AGENT = re.sub(r'VERSION = "[^"]+"', 'VERSION = "9.9.9-test"', open(AGENT).read(), count=1)   # what Update agent downloads


class Site(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):  # Update agent downloads the agent; Update Pi downloads setup-kiosk.sh
        body = (FAKE_SETUP if self.path.endswith("setup-kiosk.sh") else NEW_AGENT).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with lock:
            checkins.append((time.monotonic(), data, self.headers.get("Authorization", "")))
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
    # systemd-run starts the job in the background, as the real one starts a separate service
    stub("systemd-run", f'echo "$*" >> {W}/systemd-run.log; while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done; shift; nohup "$@" >/dev/null 2>&1 &\n')
    stub("grim", 'python3 -c "import sys; from PIL import Image; Image.new(\'RGB\', (64, 36), (20, 40, 80)).save(sys.argv[1])" "${@: -1}"\n')
    agent = os.path.join(W, "agent.py")
    shutil.copy(AGENT, agent)                            # Update agent rewrites this copy, not the real one
    cfg = os.path.join(W, "agent.json")
    json.dump({"site": f"http://127.0.0.1:{srv.server_port}", "key": "k" * 43, "user": "no-such-desktop-user"}, open(cfg, "w"))
    state = os.path.join(W, "state", "pending-results.json")
    ident = os.path.join(W, "state", "identity.json")
    env = dict(os.environ, PATH=f"{W}/bin:" + os.environ["PATH"], LOBBY_AGENT_CONFIG=cfg, LOBBY_AGENT_STATE=state, LOBBY_AGENT_IDENTITY=ident, LOBBY_TV_STATE=os.path.join(W, "tv-state"), LOBBY_AGENT_UPDATE_DIR=os.path.join(W, "update"), UPDATE_FAIL_FILE=os.path.join(W, "fail"),
               LOBBY_AGENT_INTERVAL=str(TICK), LOBBY_AGENT_SERIAL="10000000abcd0001")
    log = open(os.path.join(W, "agent.log"), "a")
    start = lambda serial="10000000abcd0001": subprocess.Popen([sys.executable, agent], env=dict(env, LOBBY_AGENT_SERIAL=serial), stdout=log, stderr=log)

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

    open(os.path.join(W, "tv-state"), "w").write("standby\n")   # as lobby-tv writes it
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
    check("no automatic screenshot straight after start (the screen is still blank then)", not any(c[1].get("screenshot") for c in checkins[:3]))
    check("the TV's state goes out with the health report", checkins[0][1].get("health", {}).get("tv") == "standby", checkins[0][1].get("health", {}).get("tv"))
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

    # ── D. identity: a key per Pi, made by the agent ──
    def run_once(serial):
        with lock: n = len(checkins)
        q = start(serial); wait_for(n + 1); q.terminate()
        try: q.wait(timeout=5)
        except subprocess.TimeoutExpired: q.kill()
        return checkins[n][2], json.load(open(ident))
    auth0 = checkins[0][2]
    check("a Pi set up before generic cards keeps its key", auth0 == "Bearer " + "k" * 43, auth0[:20])
    a1, id1 = run_once("10000000abcd0001")
    check("and the same Pi keeps it on restart", a1 == auth0 and id1["serial"] == "10000000abcd0001")
    a2, id2 = run_once("10000000abcd0002")
    check("the card in another Pi makes a new key there", a2 != a1 and id2["serial"] == "10000000abcd0002" and len(id2["key"]) >= 24, id2.get("serial"))
    a3, _ = run_once("10000000abcd0002")
    check("which it keeps from then on", a3 == a2)
    json.dump({"site": f"http://127.0.0.1:{srv.server_port}", "user": "no-such-desktop-user"}, open(cfg, "w"))
    os.remove(ident)
    a4, id4 = run_once("10000000abcd0003")
    check("a prepared card (no key anywhere) makes its own", a4 not in (a1, a2, "Bearer " + "k" * 43) and a4 == "Bearer " + id4["key"] and oct(os.stat(ident).st_mode & 0o777) == "0o600", oct(os.stat(ident).st_mode & 0o777))

    # ── E. Update Pi ──
    def results_for(cid):
        with lock: return [(i, r) for i, c in enumerate(checkins) for r in c[1].get("results", []) if r.get("id") == cid]
    def wait_result(cid, timeout=25):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if results_for(cid): return results_for(cid)
            time.sleep(0.1)
        return []
    open(os.path.join(W, "systemctl.log"), "w").close()
    with lock: replies.clear(); n = len(checkins)
    p = start("10000000abcd0003"); wait_for(n + 1)
    with lock: replies.append([{"id": 5, "command": "update_pi"}]); n = len(checkins)
    got = wait_result(5)
    check("Update Pi: check-ins carry on while it runs, and the result comes when it's finished", got and got[0][0] >= n + 3, got and got[0][0] - n)
    check("and says it's done", got and got[0][1]["status"] == "done" and got[0][1]["result"] == "Updated; restarting.", got)
    ran = open(os.path.join(W, "systemd-run.log")).read()
    check("it ran the site's setup with --update for the desktop user", "--update --user" in ran and "no-such-desktop-user" in ran, ran[:200])
    try: p.wait(timeout=10)
    except subprocess.TimeoutExpired: p.kill()
    check("then the Pi restarts", "reboot" in open(os.path.join(W, "systemctl.log")).read())
    with lock: n = len(checkins)
    p = start("10000000abcd0003"); wait_for(n + 2)
    check("and the result isn't reported again after the restart", len(results_for(5)) == 1, len(results_for(5)))
    open(os.path.join(W, "fail"), "w").close(); open(os.path.join(W, "systemctl.log"), "w").close()
    with lock: replies.append([{"id": 6, "command": "update_pi"}])
    got = wait_result(6)
    check("a failed update reports its error", got and got[0][1]["status"] == "failed" and "Unable to fetch" in got[0][1]["result"], got)
    time.sleep(1)
    check("and doesn't restart the Pi", p.poll() is None and "reboot" not in open(os.path.join(W, "systemctl.log")).read())
    p.terminate()
    try: p.wait(timeout=5)
    except subprocess.TimeoutExpired: p.kill()

    # ── F. Wi-Fi from the technician page (agent 1.6.0) ──
    # A stand-in NetworkManager: one cable (unplugged unless "wired" exists), one Wi-Fi radio on OfficeNet. Joining
    # fails with "Secrets were required" if "join-fail" exists; curl reaches the site only if "site-ok" exists.
    nm = os.path.join(W, "nm.log")
    stub("nmcli", f"""echo "$*" >> {nm}
case "$*" in
  "-t -f DEVICE,TYPE device") printf 'eth0:ethernet\\nwlan0:wifi\\n' ;;
  "-t -f TYPE,STATE device") [[ -f {W}/wired ]] && s=connected || s=unavailable; printf 'ethernet:%s\\nwifi:connected\\n' "$s" ;;
  "-t -f IN-USE,SSID,SECURITY,SIGNAL device wifi list ifname wlan0 --rescan yes")
    printf '*:OfficeNet:WPA2:62\\n:Guest:--:80\\n:OfficeNet:WPA2:40\\n::WPA2:90\\n:Lobby\\\\:East:WPA2:30\\n' ;;
  "-t -f NAME,TYPE,DEVICE connection show --active") a=OfficeNet; [[ -f {W}/active-wifi ]] && a="$(cat {W}/active-wifi)"
    printf 'Wired connection 1:802-3-ethernet:eth0\\n%s:802-11-wireless:wlan0\\n' "$a" ;;
  "-g 802-11-wireless.ssid connection show preconfigured") echo OfficeNet ;;
  "-g 802-11-wireless.ssid connection show lobby-field-"*) n="$*"; echo "${{n#*show lobby-field-}}" ;;
  "-g 802-11-wireless.ssid connection show OfficeNet") echo OfficeNet ;;
  "--wait 45 connection up lobby-field-"*) [[ -f {W}/join-fail ]] && {{ echo "Error: Connection activation failed: Secrets were required, but not provided." >&2; exit 4; }} ;;
esac
exit 0
""")
    stub("curl", f'echo "$*" >> {W}/curl.log; [[ -f {W}/site-ok ]] && exit 0 || exit 7\n')
    for f in ("join-fail", "site-ok", "wired", "active-wifi"):
        if os.path.exists(os.path.join(W, f)): os.remove(os.path.join(W, f))
    with lock: replies.clear(); n = len(checkins)
    p = subprocess.Popen([sys.executable, agent], env=dict(env, LOBBY_AGENT_SERIAL="10000000abcd0003", LOBBY_AGENT_JOIN_WAIT="1"), stdout=log, stderr=log)
    wait_for(n + 1)

    def ask(cid, command, payload=None):
        c = {"id": cid, "command": command}
        if payload is not None: c["payload"] = payload
        open(nm, "w").close()
        with lock: replies.append([c])
        got = wait_result(cid)
        return got[0][1] if got else {}

    r = ask(10, "wifi_scan")
    try: listing = json.loads(r.get("result", ""))
    except ValueError: listing = {}
    names = [x["ssid"] for x in listing.get("networks", [])]
    check("Wi-Fi search: networks come back strongest first, each once, hidden ones left out", names == ["Guest", "OfficeNet", "Lobby:East"], names)
    office = next((x for x in listing.get("networks", []) if x["ssid"] == "OfficeNet"), {})
    check("and the network it's on is marked, at its strongest reading", office.get("current") is True and office.get("signal") == 62, office)
    check("open networks say so; a name with a colon in it survives", [x["open"] for x in listing.get("networks", [])] == [True, False, False], listing)
    check("and it says whether a cable is plugged in", listing.get("wired") is False, listing.get("wired"))

    open(os.path.join(W, "site-ok"), "w").close()
    r = ask(11, "wifi_join", {"ssid": "Guest", "psk": "", "hidden": False})
    log_ = open(nm).read()
    check("Wi-Fi join: it joins and confirms the site through that Wi-Fi", r.get("status") == "done" and "Joined Guest" in r.get("result", ""), r)
    check("an open network is saved without a password, above the card's own networks", "con-name lobby-field-Guest ssid Guest" in log_ and "wifi-sec" not in log_ and "autoconnect-priority 100" in log_, log_)
    check("the site is checked through the Wi-Fi itself, not a cable", "--interface wlan0" in open(os.path.join(W, "curl.log")).read())

    open(os.path.join(W, "join-fail"), "w").close()
    r = ask(12, "wifi_join", {"ssid": "PPI Lobby", "psk": "wrong password", "hidden": True})
    log_ = open(nm).read()
    check("a refused password is reported plainly, with where the Pi still is", r.get("status") == "failed" and "password was refused" in r.get("result", "") and "Still on OfficeNet" in r.get("result", ""), r)
    check("the failed network is removed and the Pi goes back to the one it had",
          "connection delete lobby-field-PPI Lobby" in log_.split("connection up lobby-field-PPI Lobby")[-1] and "--wait 45 connection up OfficeNet" in log_, log_)
    check("a hidden network is saved as hidden", "802-11-wireless.hidden yes" in log_)
    # 1.8.1: the refusal names the network the Pi is still on, not its connection ("lobby-field-…", "preconfigured")
    for i, (active, shown) in enumerate((("lobby-field-1PointUSA", "1PointUSA"), ("preconfigured", "OfficeNet"))):
        open(os.path.join(W, "active-wifi"), "w").write(active)
        r = ask(40 + i, "wifi_join", {"ssid": "PPI Lobby", "psk": "wrong password", "hidden": False})
        check(f"a refusal says 'Still on {shown}', not the connection's name '{active}'",
              f"Still on {shown}." in r.get("result", "") and active not in r.get("result", "").replace(f"Still on {shown}", ""), r)
    os.remove(os.path.join(W, "active-wifi"))
    os.remove(os.path.join(W, "join-fail")); os.remove(os.path.join(W, "site-ok"))
    r = ask(13, "wifi_join", {"ssid": "Walled Garden", "psk": "password123"})
    log_ = open(nm).read()
    check("a network that joins but can't reach the site is left, and the Pi goes back", r.get("status") == "failed" and "can't be reached" in r.get("result", "")
          and "connection delete lobby-field-Walled Garden" in log_.split("connection up lobby-field-Walled Garden")[-1] and "connection up OfficeNet" in log_, r)
    r = ask(14, "wifi_join", {})
    check("a join with no network given does nothing", r.get("status") == "failed" and not open(nm).read().strip(), r)
    shipped = re.search(r'VERSION = "([^"]+)"', open(AGENT).read()).group(1)   # section C swapped the test's copy for 9.9.9-test
    check("the agent on the site knows the Wi-Fi commands (1.6.0 or newer)", tuple(map(int, shipped.split("."))) >= (1, 6, 0), shipped)
    p.terminate()
    try: p.wait(timeout=5)
    except subprocess.TimeoutExpired: p.kill()

    # ── G. The case status light: the agent says online or offline after every check-in ──
    lit = os.path.join(W, "status-online")
    with lock: n = len(checkins)
    p = subprocess.Popen([sys.executable, agent], env=dict(env, LOBBY_AGENT_SERIAL="10000000abcd0004", LOBBY_STATUS_FILE=lit), stdout=log, stderr=log)
    wait_for(n + 1); time.sleep(0.5)
    word = open(lit).read().split()[0] if os.path.exists(lit) else ""
    check("after a good check-in the status light is told: online", word == "online", word)
    p.terminate(); p.wait(timeout=5)
    dead = os.path.join(W, "agent-dead.json")
    json.dump({"site": "http://127.0.0.1:9", "key": "k" * 43, "user": "no-such-desktop-user"}, open(dead, "w"))
    off = os.path.join(W, "status-offline")
    p = subprocess.Popen([sys.executable, agent], env=dict(env, LOBBY_AGENT_CONFIG=dead, LOBBY_AGENT_SERIAL="10000000abcd0005", LOBBY_STATUS_FILE=off), stdout=log, stderr=log)
    for _ in range(40):
        if os.path.exists(off): break
        time.sleep(0.25)
    word = open(off).read().split()[0] if os.path.exists(off) else ""
    check("when the site can't be reached: offline", word == "offline", word)
    p.terminate(); p.wait(timeout=5)

    # ── H. Remote support (agent 1.8.0; the session bus, 1.8.1): Raspberry Pi Connect on and off ──
    rc_log = os.path.join(W, "rpi-connect.log")
    # Like the real one: refuses without the desktop user's session bus (the 1.8.0 bug seen on a real Pi)
    rc_body = f"""echo "$*" >> {rc_log}
if [[ -z "$XDG_RUNTIME_DIR" || "$DBUS_SESSION_BUS_ADDRESS" != "unix:path=$XDG_RUNTIME_DIR/bus" ]]; then
  echo "✗ Cannot start Raspberry Pi Connect as no D-Bus session bus is set, please see the man page for rpi-connect-on(1)" >&2; exit 1
fi
case "$1" in
  status) [[ -f {W}/rc-signed-in ]] && echo "Signed in: yes" || echo "Signed in: no" ;;
  signin) echo "Complete sign in by visiting https://connect.raspberrypi.com/verify/ABCD-1234"; sleep 5 ;;
esac
exit 0
"""
    rc_path = os.path.join(W, "bin", "rpi-connect")
    if os.path.exists(rc_path): os.remove(rc_path)
    open(os.path.join(W, "rc-body"), "w").write("#!/usr/bin/env bash\n" + rc_body)
    stub("apt-get", f'echo "apt-get $*" >> {rc_log}; cp {W}/rc-body {rc_path}; chmod +x {rc_path}\n')
    bare = dict(os.environ); bare.pop("DBUS_SESSION_BUS_ADDRESS", None)
    check("the stand-in Connect refuses without a session bus, as the real one did", subprocess.run(["bash", os.path.join(W, "rc-body"), "on"], env=bare, capture_output=True).returncode != 0)
    me = os.path.join(W, "agent-me.json")                # a desktop user that exists, so the session is really set up
    json.dump({"site": f"http://127.0.0.1:{srv.server_port}", "key": "k" * 43, "user": pwd.getpwuid(os.getuid()).pw_name}, open(me, "w"))
    with lock: replies.clear(); n = len(checkins)
    p = subprocess.Popen([sys.executable, agent], env=dict(env, LOBBY_AGENT_CONFIG=me, LOBBY_AGENT_SERIAL="10000000abcd0006"), stdout=log, stderr=log)
    wait_for(n + 1)
    def ask2(cid, command):
        with lock: replies.append([{"id": cid, "command": command}])
        got = wait_result(cid)
        return got[0][1] if got else {}
    r = ask2(30, "remote_on")
    calls = open(rc_log).read() if os.path.exists(rc_log) else ""
    check("remote support on: Raspberry Pi Connect is installed the first time", "apt-get install -y rpi-connect" in calls, calls)
    check("then switched on and the sign-in started", "on" in calls.split() and "signin" in calls, calls)
    check("and the sign-in link comes back for the console", r.get("status") == "done" and "https://connect.raspberrypi.com/verify/ABCD-1234" in r.get("result", ""), r)
    open(os.path.join(W, "rc-signed-in"), "w").close(); open(rc_log, "w").close()
    r = ask2(31, "remote_on")
    calls = open(rc_log).read()
    check("a Pi already signed in just says so: no second install, no new sign-in", "already" not in r.get("result", "") and "signed in" in r.get("result", "") and "apt-get" not in calls and "signin" not in calls, (r, calls))
    r = ask2(32, "remote_off")
    check("remote support off switches it off", r.get("status") == "done" and "off" in open(rc_log).read().split(), r)
    check("the agent on the site is 1.8.1", re.search(r'VERSION = "([^"]+)"', open(AGENT).read()).group(1) == "1.8.1")
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
