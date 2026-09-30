#!/usr/bin/env python3
"""The case button and status light (lobby-button, from public/pi/setup-kiosk.sh), run for real: key events go in
through a pipe, the lights are plain files, and nmcli and systemctl are stand-ins that log what they're asked.
Hold times are scaled by 0.05 (3 s = 0.15 s, 10 s = 0.5 s, 30 s = 1.5 s). About 15 seconds.
Usage: python3 tests/button-test.py"""
import builtins, importlib.machinery, importlib.util, io, os, re, struct, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
SETUP = os.path.join(HERE, "..", "public", "pi", "setup-kiosk.sh")
W = tempfile.mkdtemp(prefix="button-test-")
src = open(SETUP).read()
code = re.search(r"cat > /usr/local/sbin/lobby-button <<'BUTTON'\n(.*?)\nBUTTON\n", src, re.S).group(1)
TOOL = os.path.join(W, "lobby-button"); open(TOOL, "w").write(code)

passed = failed = 0
def check(name, ok, detail=""):
    global passed, failed
    if ok: passed += 1; print("  ok ", name)
    else: failed += 1; print("  FAIL", name, detail)

# stand-ins
BIN = os.path.join(W, "bin"); os.makedirs(BIN)
LOG = os.path.join(W, "calls.log")
open(os.path.join(BIN, "systemctl"), "w").write(f'#!/bin/sh\necho "systemctl $*" >> {LOG}\n')
open(os.path.join(BIN, "nmcli"), "w").write(f'''#!/bin/sh
echo "nmcli $*" >> {LOG}
case "$*" in
  "-t -f NAME,TYPE connection show") printf 'Wired connection 1:802-3-ethernet\\nlobby-wifi-1:802-11-wireless\\nlobby-wifi-2:802-11-wireless\\nlobby-field-PPI Lobby:802-11-wireless\\nCaf\\\\:e Net:802-11-wireless\\nlobby-setup-ap:802-11-wireless\\n' ;;
esac
''')
for f in ("systemctl", "nmcli"): os.chmod(os.path.join(BIN, f), 0o755)
LEDS = os.path.join(W, "leds")
for led, trig in (("ACT", "none [mmc0] timer heartbeat"), ("lobby-status", "[none] timer")):
    os.makedirs(os.path.join(LEDS, led))
    open(os.path.join(LEDS, led, "trigger"), "w").write(trig)
    open(os.path.join(LEDS, led, "brightness"), "w").write("0")
STATUS = os.path.join(W, "status")
MARK = os.path.join(W, "kiosk"); os.makedirs(MARK)
EVENT = struct.Struct("llHHi")
FIFO = os.path.join(W, "event0"); os.mkfifo(FIFO)

env = dict(os.environ, PATH=f"{BIN}:{os.environ['PATH']}", LOBBY_BUTTON_SCALE="0.05", LOBBY_LEDS_DIR=LEDS, LOBBY_STATUS_FILE=STATUS,
           LOBBY_BUTTON_DEVICE=FIFO, LOBBY_MARKERS=os.path.join(MARK, "ever-online-*"))
out = open(os.path.join(W, "tool.log"), "w")
p = subprocess.Popen([sys.executable, TOOL], env=env, stdout=out, stderr=subprocess.STDOUT)
dev = open(FIFO, "wb", buffering=0)

def key(value, code=148):
    t = time.time()
    dev.write(EVENT.pack(int(t), int(t % 1 * 1e6), 1, code, value) + EVENT.pack(int(t), 0, 0, 0, 0))   # key, then SYN
def hold(seconds, code=148):
    key(1, code); time.sleep(seconds); key(0, code); time.sleep(0.3)
def calls():
    try: return open(LOG).read()
    except OSError: return ""
def clear(): open(LOG, "w").close()
def led(name, f="brightness"): return open(os.path.join(LEDS, name, f)).read().strip()
def samples(name, n=30, gap=0.05):
    vals = set()
    for _ in range(n): vals.add(led(name)); time.sleep(gap)
    return vals - {""}          # a plain file is empty for an instant while it's rewritten (real /sys/class/leds isn't)

try:
    time.sleep(0.5)
    # ── the case light, the rest of the time ──
    open(STATUS, "w").write(f"online {time.time()}\n"); time.sleep(2.3)
    check("online: the case light is steady", samples("lobby-status") == {"1"})
    open(STATUS, "w").write(f"online {time.time() - 600}\n"); time.sleep(2.3)
    check("an old 'online' (the agent stopped checking in) counts as offline: it blinks", samples("lobby-status", 50) == {"0", "1"})
    open(STATUS, "w").write(f"setup {time.time()}\n"); time.sleep(2.3)
    check("Wi-Fi setup: it blinks too (the double blink)", samples("lobby-status", 40) == {"0", "1"})
    check("the board's green light is left to its usual job", led("ACT", "trigger") == "none [mmc0] timer heartbeat")
    open(STATUS, "w").write(f"online {time.time()}\n"); time.sleep(2.3)

    # ── the button ──
    clear(); hold(0.05)
    check("a short press does nothing", "systemctl" not in calls(), calls())
    clear(); hold(0.3, code=30)
    check("other keys are ignored", "systemctl" not in calls(), calls())
    clear(); hold(0.3)
    check("held past 3 s: a safe shutdown", calls().strip() == "systemctl poweroff", calls())

    for m in ("ever-online-10000000abcd1234", "ever-online-100000005e3713aa"): open(os.path.join(MARK, m), "w").close()
    clear(); key(1); time.sleep(0.25)
    check("while held past 3 s, the board light is taken over to blink", led("ACT", "trigger") == "none")
    time.sleep(0.45)
    check("past 10 s, both lights blink fast", samples("ACT", 12, 0.02) == {"0", "1"} and samples("lobby-status", 12, 0.02) == {"0", "1"})
    key(0); time.sleep(0.5)
    c = calls()
    check("let go past 10 s: Wi-Fi joined in the field is forgotten", "connection delete lobby-field-PPI Lobby" in c and "connection delete Caf:e Net" in c, c)
    check("the card's own networks and the cable stay", "delete lobby-wifi" not in c and "Wired" not in c.replace("NAME,TYPE", ""), c)
    check("the hotspot's leftover connection goes too", "connection delete lobby-setup-ap" in c, c)
    check("the Pi forgets it has been online, so Wi-Fi setup can start", not os.listdir(MARK), os.listdir(MARK))
    check("then it restarts", c.strip().endswith("systemctl reboot"), c)
    check("the board light goes back to its usual job", led("ACT", "trigger") == "mmc0")

    clear(); hold(1.7)
    check("held 30 s or more (stuck, or leaned on): cancelled, nothing happens", "systemctl" not in calls() and "nmcli" not in calls(), calls())
    check("and the lights go back to normal", led("ACT", "trigger") == "mmc0")

    # ── finding the button on a real Pi (/proc/bus/input/devices) ──
    loader = importlib.machinery.SourceFileLoader("lobby_button", TOOL)
    spec = importlib.util.spec_from_loader("lobby_button", loader); mod = importlib.util.module_from_spec(spec)
    os.environ.pop("LOBBY_BUTTON_DEVICE", None); spec.loader.exec_module(mod)
    def found(text):
        mod.open = lambda path, *a, **k: io.StringIO(text) if path == "/proc/bus/input/devices" else builtins.open(path, *a, **k)
        return mod.find_button()
    kbd = 'N: Name="Logitech USB Keyboard"\nP: Phys=usb-0000:01:00.0-1.3/input0\nH: Handlers=sysrq kbd leds event1\nB: KEY=1000000000007 ff9f207ac14057ff febeffdfffefffff fffffffffffffffe\n'
    gpio = 'N: Name="button@3"\nP: Phys=gpio-keys/input0\nH: Handlers=kbd event0 \nB: EV=3\nB: KEY=100000 0 0\n'
    check("the gpio-key button is found among the input devices", found(kbd + "\n" + gpio) == "/dev/input/event0")
    check("a USB keyboard is never mistaken for it", found(kbd) is None)
    check("found by its gpio-keys source even under another name", found(gpio.replace("button@3", "lobby")) == "/dev/input/event0")
finally:
    dev.close(); p.terminate()
    try: p.wait(timeout=3)
    except subprocess.TimeoutExpired: p.kill()
print(f"\n{passed}/{passed + failed} passed")
sys.exit(1 if failed else 0)
