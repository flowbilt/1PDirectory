#!/usr/bin/env python3
"""Lobby directory agent for Raspberry Pi.

Checks in with the directory site every minute: reports this Pi's health, sends a small screenshot every few
minutes, and runs commands queued in the console. Only the fixed commands below can run; nothing free-form.
The Pi always makes the connection (outbound HTTPS), so no ports are opened and nothing can connect in.

Config: /etc/lobby-agent.json  {"site": "https://...", "key": "<this Pi's secret>", "user": "<desktop user>"}
Runs as a systemd service (lobby-agent). Standard library only.
"""
import base64, json, os, pwd, re, shutil, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request

VERSION = "1.0.0"
CONFIG = os.environ.get("LOBBY_AGENT_CONFIG", "/etc/lobby-agent.json")
INTERVAL = 60


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
    return True, "Rebooting."   # the reboot itself happens after the result is reported


def cmd_screenshot(cfg):
    cfg["_force_shot"] = True
    return True, "Taking a screenshot…"   # replaced with the real outcome once it's been taken


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
    results, last_shot, shot_every = [], 0.0, 300
    once = "--once" in sys.argv

    while True:
        body = {"serial": me, "model": model(), "hostname": socket.gethostname(), "version": VERSION, "health": health(), "results": results}
        if cfg.pop("_force_shot", False) or time.time() - last_shot >= shot_every:
            shot = screenshot(cfg)
            if shot:
                body["screenshot"] = shot
                last_shot = time.time()
        try:
            reply = post(cfg, body)
            results = []
            shot_every = max(60, int(reply.get("screenshot_every", 300)))
            reboot = False
            for c in reply.get("commands", []):
                fn = COMMANDS.get(c.get("command"))
                ok, msg = fn(cfg) if fn else (False, "Unknown command.")
                results.append({"id": c.get("id"), "status": "done" if ok else "failed", "result": msg})
                log("command", c.get("command"), "->", msg)
                reboot = reboot or (c.get("command") == "reboot" and ok)
            if results and (reboot or cfg.get("_restart") or cfg.get("_force_shot")):
                if cfg.get("_force_shot"):                          # send the fresh screenshot right away
                    cfg.pop("_force_shot")
                    shot = screenshot(cfg)
                    extra = {"screenshot": shot} if shot else {}
                    last_shot = time.time() if shot else last_shot
                    for r in results:                               # report what actually happened
                        if r["result"].startswith("Taking a screenshot"):
                            r.update(status="done" if shot else "failed",
                                     result="Screenshot taken." if shot else "Couldn't capture the screen (is grim installed?).")
                else:
                    extra = {}
                post(cfg, {"serial": me, "model": model(), "hostname": socket.gethostname(), "version": VERSION, "health": health(), "results": results, **extra})
                results = []
            if reboot:
                log("rebooting")
                run(["systemctl", "reboot"])
            if cfg.get("_restart"):
                log("restarting after update")
                os.execv(sys.executable, [sys.executable] + sys.argv)
        except urllib.error.HTTPError as e:
            log("site refused check-in:", e.code, e.read()[:200])
        except Exception as e:
            log("check-in failed:", e)
        if once:
            return
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
