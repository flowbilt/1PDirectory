#!/usr/bin/env python3
"""Lobby directory agent for Raspberry Pi.

Checks in with the directory site once a minute, on a fixed schedule: reports this Pi's health, sends a small
screenshot every few minutes, and runs commands queued in the console. Only the fixed commands below can run;
nothing free-form. Command results go out with the next scheduled check-in (never an extra one); results that
must survive a reboot or an agent update are kept on disk until the site has them.
The Pi always makes the connection (outbound HTTPS), so no ports are opened and nothing can connect in.

Config: /etc/lobby-agent.json  {"site": "https://...", "key": "<this Pi's secret>", "user": "<desktop user>"}
Runs as a systemd service (lobby-agent). Standard library only.
"""
import base64, json, os, pwd, re, shutil, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request

VERSION = "1.1.0"
CONFIG = os.environ.get("LOBBY_AGENT_CONFIG", "/etc/lobby-agent.json")
STATE = os.environ.get("LOBBY_AGENT_STATE", "/var/lib/lobby-agent/pending-results.json")
INTERVAL = max(1.0, float(os.environ.get("LOBBY_AGENT_INTERVAL", "60")))   # seconds; only tests change this


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


COMMANDS = {"reload": cmd_reload, "reboot": cmd_reboot, "screenshot": cmd_screenshot, "update_agent": cmd_update_agent}


# ── talking to the site ──
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
    if not cfg.get("site") or len(cfg.get("key", "")) < 24:
        log(f"missing site or key in {CONFIG}")
        sys.exit(1)
    me = serial()
    if not me:
        log("could not read this Pi's serial number")
        sys.exit(1)
    log(f"lobby agent {VERSION} starting, serial {me}, site {cfg['site']}")
    results = load_pending()          # e.g. "Rebooted." from before a reboot
    last_shot, shot_every = 0.0, 300
    force_shot, shot_results = False, []
    once = "--once" in sys.argv
    start = time.monotonic()

    while True:
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
            save_pending([])
            shot_every = max(60, int(reply.get("screenshot_every", 300)))
            reboot = False
            for c in reply.get("commands", []):
                fn = COMMANDS.get(c.get("command"))
                ok, msg = fn(cfg) if fn else (False, "Unknown command.")
                r = {"id": c.get("id"), "status": "done" if ok else "failed", "result": msg}
                results.append(r)
                log("command", c.get("command"), "->", msg)
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
        if once:
            return
        time.sleep(max(0.0, next_slot(start, time.monotonic()) - time.monotonic()))


if __name__ == "__main__":
    main()
