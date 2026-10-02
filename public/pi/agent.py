#!/usr/bin/env python3
"""Lobby directory agent for Raspberry Pi.

Checks in with the directory site once a minute, on a fixed schedule: reports this Pi's health, sends a small
screenshot every few minutes, and runs commands queued in the console. Only the fixed commands below can run;
nothing free-form. Command results go out with the next scheduled check-in (never an extra one); results that
must survive a reboot or an agent update are kept on disk until the site has them.
The Pi always makes the connection (outbound HTTPS), so no ports are opened and nothing can connect in.

Config: /etc/lobby-agent.json  {"site": "https://...", "user": "<desktop user>"}. It holds no identity, so a prepared
card works in any Pi. The agent makes its own key the first time it starts in a given Pi, and records which serial it
belongs to (/var/lib/lobby-agent/identity.json); if the card turns up in a different Pi, it makes a new key there.
Runs as a systemd service (lobby-agent). Standard library only.
"""
import base64, json, os, pwd, re, secrets, shutil, socket, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request

VERSION = "1.8.0"
CONFIG = os.environ.get("LOBBY_AGENT_CONFIG", "/etc/lobby-agent.json")
STATE = os.environ.get("LOBBY_AGENT_STATE", "/var/lib/lobby-agent/pending-results.json")
IDENTITY = os.environ.get("LOBBY_AGENT_IDENTITY", "/var/lib/lobby-agent/identity.json")
TV_STATE = os.environ.get("LOBBY_TV_STATE", "/run/lobby-tv/state")   # written by lobby-tv (setup-kiosk.sh)
UPDATE_DIR = os.environ.get("LOBBY_AGENT_UPDATE_DIR", "/var/lib/lobby-agent/update")
FIRST_SHOT = 120           # seconds after start before the first automatic screenshot (the browser is up by then)
UPDATE_LIMIT = 45 * 60      # an update still running after this long is stopped and reported as failed
INTERVAL = max(1.0, float(os.environ.get("LOBBY_AGENT_INTERVAL", "60")))   # seconds; only tests change this
JOIN_WAIT = float(os.environ.get("LOBBY_AGENT_JOIN_WAIT", "60"))   # how long a newly joined network has to reach the site


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


def run(cmd, timeout=20, **kw):
    try:
        return subprocess.run(cmd, capture_output=True, timeout=timeout, **kw)
    except (OSError, subprocess.TimeoutExpired) as e:
        return subprocess.CompletedProcess(cmd, 1, b"", str(e).encode())


# ── identity ──
def serial():
    s = os.environ.get("LOBBY_AGENT_SERIAL") or read("/proc/device-tree/serial-number").strip("\x00\n ")
    if not s:
        m = re.search(r"^Serial\s*:\s*([0-9a-fA-F]+)", read("/proc/cpuinfo"), re.M)
        s = m.group(1) if m else ""
    return s.lower()


def identity(cfg, me):
    """This Pi's key: made the first time the agent starts in this Pi, and remade if the card is now in another Pi.
    A Pi set up before generic cards has its key in the config file; that one is kept, so it stays enrolled."""
    try:
        with open(IDENTITY) as f:
            known = json.load(f)
    except (OSError, ValueError):
        known = {}
    if known.get("serial") == me and len(known.get("key", "")) >= 24:
        return known["key"]
    if not known and len(cfg.get("key", "")) >= 24:
        key = cfg["key"]
    else:
        key = secrets.token_urlsafe(32)
        if known.get("serial"):
            log(f"this card was in Pi {known['serial']}; made a new key for Pi {me} (1Point enrolls it in the console)")
            save_pending([])                     # results from the other Pi aren't this one's to report
    try:
        os.makedirs(os.path.dirname(IDENTITY), exist_ok=True)
        fd = os.open(IDENTITY + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"serial": me, "key": key}, f)
        os.replace(IDENTITY + ".tmp", IDENTITY)
    except OSError as e:
        log("couldn't save this Pi's key:", e)
    return key


def model():
    return read("/proc/device-tree/model").strip("\x00\n ") or "unknown"


# ── health ──
def health():
    h = {}
    t = read("/sys/class/thermal/thermal_zone0/temp").strip()
    if t.isdigit():
        h["temp_c"] = round(int(t) / 1000, 1)
    up = read("/proc/uptime").split()
    if up:
        h["uptime_s"] = int(float(up[0]))
    try:
        h["load"] = round(os.getloadavg()[0], 2)
    except OSError:
        pass
    mem = dict(re.findall(r"^(\w+):\s+(\d+)", read("/proc/meminfo"), re.M))
    if "MemTotal" in mem and "MemAvailable" in mem:
        h["mem_used_pct"] = round(100 * (1 - int(mem["MemAvailable"]) / int(mem["MemTotal"])))
    du = shutil.disk_usage("/")
    h["disk_used_pct"] = round(100 * du.used / du.total)
    # Power and heat: vcgencmd reports under-voltage and throttling as bit flags
    r = run(["vcgencmd", "get_throttled"])
    m = re.search(r"0x([0-9a-fA-F]+)", r.stdout.decode(errors="ignore"))
    if m:
        v = int(m.group(1), 16)
        h.update(throttled=hex(v), under_voltage_now=bool(v & 0x1), throttled_now=bool(v & 0x4), under_voltage_seen=bool(v & 0x10000))
    h["browser_running"] = run(["pgrep", "-f", "chromium"]).returncode == 0
    try:   # the TV's power state, if the TV keeper has checked in the last 5 minutes
        if time.time() - os.path.getmtime(TV_STATE) < 300:
            h["tv"] = read(TV_STATE).strip()
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("1.1.1.1", 80))
        h["ip"] = s.getsockname()[0]
        s.close()
    except OSError:
        pass
    m = re.search(r'^PRETTY_NAME="?([^"\n]+)', read("/etc/os-release"), re.M)
    if m:
        h["os"] = m.group(1)
    return h


# ── running things in the desktop session (screenshots, restarting the browser) ──
def session_env(user):
    try:
        pw = pwd.getpwnam(user)
    except KeyError:
        return None, {}
    runtime = f"/run/user/{pw.pw_uid}"
    env = dict(os.environ, HOME=pw.pw_dir, XDG_RUNTIME_DIR=runtime, DISPLAY=":0")
    for name in ("wayland-0", "wayland-1"):
        if os.path.exists(os.path.join(runtime, name)):
            env["WAYLAND_DISPLAY"] = name
            break
    return pw, env


def as_user(cfg, cmd, timeout=20):
    pw, env = session_env(cfg.get("user", ""))
    if not pw:
        return run(cmd, timeout)
    if os.geteuid() == 0:
        cmd = ["runuser", "-u", pw.pw_name, "--"] + cmd
    return run(cmd, timeout, env=env)


def screenshot(cfg):
    """A small JPEG of what's on the TV, as a data URL (about 30-60 KB)."""
    with tempfile.TemporaryDirectory() as d:
        os.chmod(d, 0o777)
        png, jpg = os.path.join(d, "s.png"), os.path.join(d, "s.jpg")
        if as_user(cfg, ["grim", "-s", "0.35", png]).returncode != 0:          # Wayland (labwc, wayfire)
            if as_user(cfg, ["scrot", "-o", png]).returncode != 0:              # X11
                return None
        # shrink and convert with whatever is available
        if shutil.which("convert"):
            run(["convert", png, "-resize", "640x640>", "-quality", "70", jpg])
        else:
            try:
                from PIL import Image  # python3-pil is on Raspberry Pi OS desktop
                im = Image.open(png).convert("RGB")
                im.thumbnail((640, 640))
                im.save(jpg, "JPEG", quality=70)
            except Exception:
                return None
        if not os.path.exists(jpg):
            return None
        with open(jpg, "rb") as f:
            return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()


# ── commands (the complete list) ──
def cmd_reload(cfg):
    # kiosk.sh restarts Chromium within a few seconds of it closing
    r = run(["pkill", "-f", "chromium"])
    return True, "Browser restarted." if r.returncode == 0 else "Browser wasn't running; kiosk will start it."


def cmd_reboot(cfg):
    return True, "Rebooted."    # reported on the first check-in after the restart (see main)


def cmd_screenshot(cfg):
    return True, "Taking a screenshot…"   # taken on the next check-in, and this is replaced with the outcome


def cmd_update_agent(cfg):
    url = cfg["site"].rstrip("/") + "/pi/agent.py"
    try:
        new = urllib.request.urlopen(url, timeout=30).read()
        compile(new, "agent.py", "exec")                          # refuse anything that isn't valid Python
        if b"def main(" not in new or b"lobby" not in new.lower():
            return False, "Downloaded file didn't look like the agent."
        me = os.path.abspath(__file__)
        tmp = me + ".new"
        with open(tmp, "wb") as f:
            f.write(new)
        os.chmod(tmp, 0o755)
        os.replace(tmp, me)
        cfg["_restart"] = True
        m = re.search(rb'VERSION = "([^"]+)"', new)
        return True, f"Updated to {m.group(1).decode() if m else 'latest'}; restarting."
    except Exception as e:
        return False, f"Update failed: {e}"


# ── Update Pi: the latest setup (setup-kiosk.sh --update) run as its own job, so check-ins carry on meanwhile ──
def _upd(name):
    return os.path.join(UPDATE_DIR, name)


def start_update(cfg, cid):
    try:
        with open(_upd("update.json")) as f:
            if not os.path.exists(_upd("update.rc")) and time.time() - json.load(f).get("started", 0) < UPDATE_LIMIT:
                return False, "An update is already running."
    except (OSError, ValueError):
        pass
    try:
        os.makedirs(UPDATE_DIR, exist_ok=True)
        script = urllib.request.urlopen(cfg["site"].rstrip("/") + "/pi/setup-kiosk.sh", timeout=30).read()
        if b"--update" not in script:
            return False, "The downloaded setup doesn't support updates."
        with open(_upd("setup-kiosk.sh"), "wb") as f:
            f.write(script)
        if run(["bash", "-n", _upd("setup-kiosk.sh")]).returncode != 0:
            return False, "The downloaded setup didn't check out; nothing was changed."
        for name in ("update.rc", "update.log"):
            if os.path.exists(_upd(name)):
                os.remove(_upd(name))
        with open(_upd("update.json"), "w") as f:
            json.dump({"id": cid, "started": time.time()}, f)
        job = f'bash "{_upd("setup-kiosk.sh")}" --update --user "{cfg.get("user", "")}" > "{_upd("update.log")}" 2>&1; echo $? > "{_upd("update.rc")}"'
        r = run(["systemd-run", "--unit", "lobby-update", "--collect", "--quiet", "--", "bash", "-c", job])
        if r.returncode != 0:
            os.remove(_upd("update.json"))
            return False, "Couldn't start the update: " + (r.stderr or b"").decode(errors="ignore")[:200]
        return True, None
    except Exception as e:
        return False, f"Update failed to start: {e}"


def update_outcome():
    """The finished update's result for the site, and whether to restart; None while there's nothing to report."""
    try:
        with open(_upd("update.json")) as f:
            job = json.load(f)
    except (OSError, ValueError):
        return None
    tail = [l.strip() for l in read(_upd("update.log")).splitlines() if l.strip()][-3:]
    if os.path.exists(_upd("update.rc")):
        ok = read(_upd("update.rc")).strip() == "0"
        msg = "Updated; restarting." if ok else "Update failed: " + " / ".join(tail)[-300:]
        return {"id": job.get("id"), "status": "done" if ok else "failed", "result": msg}, ok
    if time.time() - job.get("started", 0) > UPDATE_LIMIT:
        run(["systemctl", "stop", "lobby-update"])
        return {"id": job.get("id"), "status": "failed", "result": "Update timed out after 45 minutes: " + " / ".join(tail)[-200:]}, False
    return None


def clear_update():
    for name in ("update.json", "update.rc"):
        try:
            os.remove(_upd(name))
        except OSError:
            pass


# ── Wi-Fi from the technician page (agent 1.6.0) ──
def nm_fields(line):
    r"""One line of `nmcli -t` output, split on ':' the way nmcli means it (it writes a ':' inside a value as '\:')."""
    out, cur, i = [], "", 0
    while i < len(line):
        ch = line[i]
        if ch == "\\" and i + 1 < len(line):
            cur += line[i + 1]; i += 2
        elif ch == ":":
            out.append(cur); cur = ""; i += 1
        else:
            cur += ch; i += 1
    out.append(cur)
    return out


def nm_rows(*args, timeout=30):
    r = run(["nmcli", "-t"] + list(args), timeout)
    return r.returncode, [nm_fields(l) for l in r.stdout.decode(errors="replace").splitlines() if l], r.stderr.decode(errors="replace").strip()


def wifi_device():
    _, rows, _ = nm_rows("-f", "DEVICE,TYPE", "device")
    return next((r[0] for r in rows if len(r) > 1 and r[1] == "wifi"), None)


def wired_up():
    _, rows, _ = nm_rows("-f", "TYPE,STATE", "device")
    return any(len(r) > 1 and r[0] == "ethernet" and r[1].startswith("connected") for r in rows)


def cmd_wifi_scan(cfg, payload=None):
    """The networks this Pi can see, strongest first, as JSON for the technician page (up to 4,000 characters)."""
    dev = wifi_device()
    if not dev:
        return False, "This Pi has no Wi-Fi."
    rc, rows, err = nm_rows("-f", "IN-USE,SSID,SECURITY,SIGNAL", "device", "wifi", "list", "ifname", dev, "--rescan", "yes", timeout=45)
    if rc != 0:
        return False, "Couldn't search for networks: " + err[:200]
    best = {}
    for r in rows:
        if len(r) < 4 or not r[1]:
            continue                                      # hidden networks have no name to list
        sig = int(r[3]) if r[3].isdigit() else 0
        n = {"ssid": r[1], "open": r[2].strip() in ("", "--"), "signal": sig, "current": r[0].strip() == "*"}
        if r[1] not in best or sig > best[r[1]]["signal"] or n["current"]:
            n["current"] = n["current"] or best.get(r[1], {}).get("current", False)
            best[r[1]] = n
    nets = sorted(best.values(), key=lambda n: -n["signal"])[:30]
    out = lambda: json.dumps({"networks": nets, "wired": wired_up()}, ensure_ascii=False, separators=(",", ":"))
    while len(out()) > 3900 and nets:
        nets.pop()                                        # the weakest go first if the list is too long to send
    return True, out()


def _reaches_site(cfg, dev):
    """Whether the site can be reached through this Wi-Fi device itself (not through a cable that's also plugged in)."""
    end = time.monotonic() + JOIN_WAIT
    while True:
        r = run(["curl", "--interface", dev, "-fsS", "--max-time", "6", "-o", "/dev/null", cfg["site"].rstrip("/") + "/login.html"], 10)
        if r.returncode == 0:
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(min(3.0, max(0.1, end - time.monotonic())))


def cmd_wifi_join(cfg, payload=None):
    """Joins one network. If it can't be joined, or doesn't reach the site within a minute, it's removed and the Pi goes
    back to the connection it had, so a wrong password or a network that blocks the site never strands a Pi."""
    p = payload or {}
    ssid, psk, hidden = p.get("ssid"), p.get("psk") or "", p.get("hidden") is True
    if not isinstance(ssid, str) or not ssid or len(ssid.encode()) > 32 or not isinstance(psk, str):
        return False, "No network was given."
    dev = wifi_device()
    if not dev:
        return False, "This Pi has no Wi-Fi."
    _, rows, _ = nm_rows("-f", "NAME,TYPE,DEVICE", "connection", "show", "--active")
    prev = next((r[0] for r in rows if len(r) > 2 and r[2] == dev and r[1] == "802-11-wireless"), None)
    name = "lobby-field-" + ssid
    if prev == name:
        prev = None                                       # re-joining the same network: nothing else to go back to
    run(["nmcli", "connection", "delete", name])
    args = ["nmcli", "connection", "add", "type", "wifi", "ifname", dev, "con-name", name, "ssid", ssid,
            "connection.autoconnect", "yes", "connection.autoconnect-priority", "100",   # above the card's saved networks
            "802-11-wireless.hidden", "yes" if hidden else "no"]
    if psk:
        args += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", psk]
    r = run(args)
    if r.returncode != 0:
        return False, f"Couldn't save {ssid}: " + r.stderr.decode(errors="replace").strip()[:200]
    back = f"Still on {prev}." if prev else ("Still on its network cable." if wired_up() else "")

    def undo():
        run(["nmcli", "connection", "delete", name])
        if prev:
            run(["nmcli", "--wait", "45", "connection", "up", prev], 60)

    r = run(["nmcli", "--wait", "45", "connection", "up", name], 60)
    if r.returncode != 0:
        err = r.stderr.decode(errors="replace")
        why = ("the password was refused" if re.search(r"[Ss]ecrets were required|802-1[xX]|psk", err)
               else "it isn't in range" if re.search(r"[Nn]o network with SSID|not found", err)
               else err.strip().replace("Error: ", "")[:160] or "it didn't connect")
        undo()
        return False, f"Couldn't join {ssid}: {why}. {back}".strip()
    if not _reaches_site(cfg, dev):
        undo()
        return False, f"Joined {ssid}, but the directory site can't be reached through it, so the Pi left it. {back}".strip()
    note = " A network cable is plugged in too, and is used first; this Wi-Fi is the backup." if wired_up() else ""
    return True, f"Joined {ssid}; the directory site is reachable through it.{note}"


# ── Remote support (agent 1.8.0): Raspberry Pi Connect, on only while 1Point asks for it ──
CONNECT_LINK = re.compile(r"https://connect\.raspberrypi\.com/\S+")


def cmd_remote_on(cfg):
    """Installs Raspberry Pi Connect if it isn't there, switches it on for the desktop user, and returns the link to
    sign it in to 1Point's Raspberry Pi account (or says it's already signed in). Connect only ever connects outward,
    like the agent: the Pi opens no ports."""
    if not shutil.which("rpi-connect"):
        r = run(["apt-get", "install", "-y", "rpi-connect"], 900, env=dict(os.environ, DEBIAN_FRONTEND="noninteractive"))
        if r.returncode != 0 or not shutil.which("rpi-connect"):
            return False, "Couldn't install Raspberry Pi Connect: " + (r.stderr or r.stdout).decode(errors="replace").strip()[-200:]
    r = as_user(cfg, ["rpi-connect", "on"], 60)
    if r.returncode != 0:
        return False, "Couldn't switch Raspberry Pi Connect on: " + (r.stderr or r.stdout).decode(errors="replace").strip()[-200:]
    st = as_user(cfg, ["rpi-connect", "status"], 20).stdout.decode(errors="replace")
    if re.search(r"^\s*signed in:\s*yes", st, re.I | re.M):
        return True, "Remote support is on and this Pi is signed in: open connect.raspberrypi.com."
    # Signing in waits until someone finishes it in a browser, so it runs on in the background; its link is read here
    pw, env = session_env(cfg.get("user", ""))
    cmd = ["rpi-connect", "signin"]
    if pw and os.geteuid() == 0:
        cmd = ["runuser", "-u", pw.pw_name, "--"] + cmd
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env or None, text=True, start_new_session=True)
    except OSError as e:
        return False, f"Couldn't start the sign-in: {e}"
    seen, found = [], []
    def reader():
        for line in p.stdout:
            seen.append(line)
            m = CONNECT_LINK.search(line)
            if m:
                found.append(m.group(0).rstrip(".,)"))
                return
    t = threading.Thread(target=reader, daemon=True); t.start(); t.join(30)
    if found:
        return True, f"Remote support is on. Sign this Pi in (link valid for a while): {found[0]}"
    p.kill()
    return False, "Remote support is on, but no sign-in link came back: " + "".join(seen).strip()[-200:]


def cmd_remote_off(cfg):
    if not shutil.which("rpi-connect"):
        return True, "Remote support is off (Raspberry Pi Connect isn't installed)."
    r = as_user(cfg, ["rpi-connect", "off"], 60)
    if r.returncode != 0:
        return False, "Couldn't switch Raspberry Pi Connect off: " + (r.stderr or r.stdout).decode(errors="replace").strip()[-200:]
    return True, "Remote support is off."


COMMANDS = {"reload": cmd_reload, "reboot": cmd_reboot, "screenshot": cmd_screenshot, "update_agent": cmd_update_agent,
            "wifi_scan": cmd_wifi_scan, "wifi_join": cmd_wifi_join, "remote_on": cmd_remote_on, "remote_off": cmd_remote_off}
WITH_PAYLOAD = {"wifi_scan", "wifi_join"}


# ── talking to the site ──
STATUS_FILE = os.environ.get("LOBBY_STATUS_FILE", "/run/lobby-status")


def set_status(word):
    """For the case status light (lobby-button): online or offline, with the time, after every check-in."""
    try:
        with open(STATUS_FILE, "w") as f:
            f.write(f"{word} {time.time()}\n")
    except OSError:
        pass


def post(cfg, body):
    req = urllib.request.Request(
        cfg["site"].rstrip("/") + "/api/agent",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["key"], "User-Agent": f"lobby-agent/{VERSION}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


# ── results that must outlive this process (a reboot, an agent update) ──
def load_pending():
    try:
        with open(STATE) as f:
            got = json.load(f)
        return [r for r in got if isinstance(r, dict) and "id" in r][:20]
    except (OSError, ValueError):
        return []


def save_pending(results):
    try:
        if not results:
            if os.path.exists(STATE):
                os.remove(STATE)
            return
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(results, f)
        os.replace(tmp, STATE)
    except OSError as e:
        log("couldn't save command results:", e)


def next_slot(start, now, interval=INTERVAL):
    """The next tick of a fixed schedule that began at `start`, strictly after `now`. Time spent on the work
    itself never pushes the schedule back, so the Pi checks in once a minute, not once every 61-62 seconds;
    if a check-in overruns a whole minute (a slow network), the missed tick is skipped, not made up."""
    return start + (int((now - start) // interval) + 1) * interval


def main():
    cfg = json.loads(read(CONFIG, "{}"))
    if not cfg.get("site"):
        log(f"missing site in {CONFIG}")
        sys.exit(1)
    me = serial()
    if not me:
        log("could not read this Pi's serial number")
        sys.exit(1)
    cfg["key"] = identity(cfg, me)
    log(f"lobby agent {VERSION} starting, serial {me}, site {cfg['site']}")
    results = load_pending()          # e.g. "Rebooted." from before a reboot
    shot_every = 300
    last_shot = time.time() - shot_every + FIRST_SHOT   # not straight away: at start the screen is still blank
    force_shot, shot_results = False, []
    once = "--once" in sys.argv
    start = time.monotonic()

    while True:
        done = update_outcome()                      # an Update Pi that has finished since the last check-in
        restart_after = False
        if done:
            if not any(r.get("id") == done[0]["id"] for r in results):
                results.append(done[0])
            restart_after = done[1]
        body = {"serial": me, "model": model(), "hostname": socket.gethostname(), "version": VERSION, "health": health(), "results": results}
        if force_shot or time.time() - last_shot >= shot_every:
            shot = screenshot(cfg)
            if shot:
                body["screenshot"] = shot
                last_shot = time.time()
            for r in shot_results:                  # the console's "Take screenshot": report what actually happened
                r.update(status="done" if shot else "failed",
                         result="Screenshot taken." if shot else "Couldn't capture the screen (is grim installed?).")
        force_shot, shot_results = False, []
        try:
            reply = post(cfg, body)
            results = []
            set_status("online")
            save_pending([])
            if done:
                clear_update()
                if restart_after:
                    log("update finished; restarting")
                    run(["systemctl", "reboot"])
            shot_every = max(60, int(reply.get("screenshot_every", 300)))
            reboot = False
            for c in reply.get("commands", []):
                if c.get("command") == "update_pi":          # its result comes when the update finishes
                    ok, msg = start_update(cfg, c.get("id"))
                    log("command update_pi ->", "started" if ok else msg)
                    if not ok:
                        results.append({"id": c.get("id"), "status": "failed", "result": msg})
                    continue
                fn = COMMANDS.get(c.get("command"))
                if not fn:
                    ok, msg = False, "Unknown command."
                elif c.get("command") in WITH_PAYLOAD:
                    ok, msg = fn(cfg, c.get("payload") or {})
                else:
                    ok, msg = fn(cfg)
                r = {"id": c.get("id"), "status": "done" if ok else "failed", "result": msg}
                results.append(r)
                log("command", c.get("command"), "->", "(network list)" if c.get("command") == "wifi_scan" and ok else msg)
                if c.get("command") == "wifi_join":
                    save_pending(results)            # the network changed under this check-in: keep the result until it's sent
                if c.get("command") == "screenshot" and ok:
                    force_shot = True
                    shot_results.append(r)
                reboot = reboot or (c.get("command") == "reboot" and ok)
            # Results go out with the next scheduled check-in. Before a reboot or an update restart, keep them
            # on disk so the first check-in afterwards reports them.
            if reboot or cfg.get("_restart"):
                save_pending(results)
            if reboot:
                log("rebooting")
                r = run(["systemctl", "reboot"])
                if r.returncode != 0:                # still here: the reboot didn't happen
                    for x in results:
                        if x["result"] == "Rebooted.":
                            x.update(status="failed", result="Reboot failed: " + (r.stderr or b"").decode(errors="ignore")[:200])
                    save_pending(results)
            if cfg.pop("_restart", False):
                log("restarting after update")
                os.execv(sys.executable, [sys.executable] + sys.argv)
        except urllib.error.HTTPError as e:
            log("site refused check-in:", e.code, e.read()[:200])
        except Exception as e:
            log("check-in failed:", e)
            set_status("offline")
        if once:
            return
        time.sleep(max(0.0, next_slot(start, time.monotonic()) - time.monotonic()))


if __name__ == "__main__":
    main()
