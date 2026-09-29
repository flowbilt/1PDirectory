#!/usr/bin/env bash
# Lobby directory kiosk setup for Raspberry Pi 4.
# Target: Raspberry Pi OS with desktop (64-bit), Bookworm or newer.
#
# A card set up by this script carries no identity: it works in whichever Pi it's in. At every start the Pi builds
# its screen address from its own serial, the agent makes its own key for that Pi, and the Pi names itself after
# its serial (e.g. lobby-a4ae272d). So one prepared card can be copied to every card (README: Preparing cards).
#
# Usage (as the desktop user, with sudo):
#   curl -fsSLO https://1pdirectory.netlify.app/pi/setup-kiosk.sh
#   sudo bash setup-kiosk.sh --code XXXX-XXXX             set up this Pi, with the saved Wi-Fi networks
#   sudo bash setup-kiosk.sh --prepare --code XXXX-XXXX   bench Pi: prepare a card to copy, then power off
#   (The console's Update Pi runs it with --update on a Pi in the field.)
# Get the code in the console: Pi setup -> Get a prepare code (it lasts an hour and works once). Without --code,
# the Pi keeps whatever network it already has (fine for a wired Pi).
#
# The Pi then shows "New display" with its serial number until it's assigned to a screen in the console.
# Pis from the Yodeck report are recognized by serial; open their enrollment window in the console on install day.
#
# A Pi that has never reached the site (wrong or missing Wi-Fi, no cable yet) offers field Wi-Fi setup on its own
# screen instead of sitting blank: join the hotspot it shows from a phone (or use a keyboard on the Pi itself) and
# pick a network. No card or console visit needed. See README: Field Wi-Fi setup.
#
# Options:
#   --code CODE        Download the Wi-Fi networks saved in the console (Pi setup). Every network is saved on the
#                      card; the Pi joins whichever is in range, and a network cable always wins.
#   --update           Update this Pi in place (the console's Update Pi runs this): re-apply the latest setup with the
#                      options this Pi was set up with (saved in /etc/lobby-setup.conf), install Raspberry Pi OS
#                      updates, keep its identity, key and Wi-Fi. The agent restarts the Pi afterwards.
#   --user NAME        The desktop user, when not run with sudo from that user (--update from the agent).
#   --prepare          Bench mode: install everything, then clear everything that belongs to this Pi (machine ID,
#                      logs, browser profile, keys, the bench's own Wi-Fi) and power off, ready to copy the card.
#                      Needs --code. Run it at the Pi's own keyboard or on a cable: it drops the bench's Wi-Fi.
#   --site URL         The directory site. Default https://1pdirectory.netlify.app
#   --url URL          Old style: a fixed screen address instead of letting the console decide (not with --prepare)
#   --rotate auto|0|90|180|270  Default auto: at every start the Pi asks the site how its screen is set in the
#                      console (portrait 90, portrait turned the other way 270, landscape upside down 180) and turns
#                      the picture to match. Landscape, new and unassigned Pis use 0. A fixed number overrides
#                      the console for good; for a TV mounted the other way round, use the console's Layout instead.
#   --tz ZONE          Time zone. Default America/Chicago.
#   --wifi-country CC  Wi-Fi country code. Default US.
#   --no-1080p         Keep the TV's native resolution (4K runs slowly on a Pi 4; not recommended).
#   --no-tv            Don't control the TV. By default the Pi keeps the TV switched on and showing this Pi, over HDMI-CEC
#                      (the TV's CEC setting must be on: Anynet+, SimpLink, Bravia Sync...); use this for a TV that
#                      misbehaves with it.
#   --connect          Also install Raspberry Pi Connect for remote screen viewing from a browser.
#   --no-agent         Don't install the remote-management agent.
#   --ssh              Leave SSH on. By default SSH is switched off (from the next restart): the Pi opens no ports,
#                      and the agent handles remote management. Re-run setup without --ssh to switch it off again.
set -euo pipefail

SITE="https://1pdirectory.netlify.app"; URL=""; ROTATE="auto"; TZ_NAME="America/Chicago"; COUNTRY="US"
FORCE_1080=1; CONNECT=0; AGENT=1; SSH=0; PREPARE=0; CODE=""; TV=1; UPDATE=0; KUSER_OPT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --site) SITE="${2%/}"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --prepare) PREPARE=1; shift ;;
    --update) UPDATE=1; shift ;;
    --user) KUSER_OPT="$2"; shift 2 ;;
    --no-agent) AGENT=0; shift ;;
    --rotate) ROTATE="$2"; shift 2 ;;
    --reboot) echo "--reboot has been removed: the Pi doesn't reboot on its own. Reboots are started (and later scheduled) from the console."; exit 1 ;;
    --tz) TZ_NAME="$2"; shift 2 ;;
    --wifi-country) COUNTRY="$2"; shift 2 ;;
    --no-1080p) FORCE_1080=0; shift ;;
    --connect) CONNECT=1; shift ;;
    --no-tv) TV=0; shift ;;
    --ssh) SSH=1; shift ;;
    -h|--help) sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

[[ "$SITE" =~ ^https?:// ]] || { echo "--site must start with https://"; exit 1; }
[[ -z "$URL" || "$URL" =~ ^https?:// ]] || { echo "--url must start with https://"; exit 1; }
[[ "$ROTATE" =~ ^(auto|0|90|180|270)$ ]] || { echo "--rotate must be auto, 0, 90, 180 or 270"; exit 1; }
[[ "$COUNTRY" =~ ^[A-Z]{2}$ ]] || { echo "--wifi-country must be two capital letters, like US"; exit 1; }
[[ -z "$CODE" || "$CODE" =~ ^[A-Za-z0-9\ -]{8,12}$ ]] || { echo "That doesn't look like a prepare code (like ABCD-EFGH)."; exit 1; }
if [[ $UPDATE -eq 1 ]]; then
  [[ $PREPARE -eq 0 && -z "$CODE" ]] || { echo "--update keeps this Pi's settings and Wi-Fi; it can't be combined with --prepare or --code."; exit 1; }
fi
if [[ $PREPARE -eq 1 ]]; then
  [[ -n "$CODE" ]] || { echo "--prepare needs --code: get one in the console (Pi setup -> Get a prepare code), so the card carries the saved Wi-Fi."; exit 1; }
  [[ -z "$URL" ]] || { echo "--prepare makes a card for any Pi; it can't have a fixed --url."; exit 1; }
fi
[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo bash $0 ..."; exit 1; }

SETUP_CONF="${LOBBY_SETUP_CONF:-/etc/lobby-setup.conf}"
if [[ $UPDATE -eq 1 && -f "$SETUP_CONF" ]]; then
  source "$SETUP_CONF"                       # the options this Pi was set up (or its card prepared) with
fi
KUSER="${KUSER_OPT:-${SUDO_USER:-}}"
if [[ -z "$KUSER" && $UPDATE -eq 1 ]]; then
  KUSER="$(python3 -c 'import json; print(json.load(open("/etc/lobby-agent.json")).get("user", ""))' 2>/dev/null || true)"
fi
[[ -n "$KUSER" && "$KUSER" != "root" ]] || { echo "Run this with sudo from the desktop user's account, not as root directly."; exit 1; }
KHOME="$(getent passwd "$KUSER" | cut -d: -f6)"
KDIR="$KHOME/kiosk"
SERIAL="$( { tr -d '\0' </proc/device-tree/serial-number; } 2>/dev/null || awk '/^Serial/ {print $3}' /proc/cpuinfo 2>/dev/null || true)"
SERIAL="$(echo "$SERIAL" | tr 'A-F' 'a-f')"

echo "==> $([[ $PREPARE -eq 1 ]] && echo "Preparing a card on this bench Pi" || { [[ $UPDATE -eq 1 ]] && echo "Updating this Pi" || echo "Setting up this Pi"; }) for user $KUSER"
if [[ $PREPARE -eq 1 ]]; then
  echo "    The card will carry no identity: it takes on the serial of whichever Pi it's put in."
else
  echo "    Pi serial: ${SERIAL:-unknown}"
  echo "    Screen:   ${URL:-$SITE/?device=${SERIAL:-<serial>}} $([[ -z "$URL" ]] && echo "(built from the serial at every start)")"
fi
echo "    Rotation: $([[ "$ROTATE" == "auto" ]] && echo "automatic (asks the site at every start)" || echo "fixed at $ROTATE")"
echo "    Time zone: $TZ_NAME   No automatic reboots (reboots come from the console)"
echo "    SSH: $([[ $SSH -eq 1 ]] && echo "on (--ssh)" || echo "off from the next restart (use --ssh to keep it)")"
echo "    TV: $([[ $TV -eq 1 ]] && echo "kept on and showing this Pi (HDMI-CEC)" || echo "left alone (--no-tv)")"

# The saved Wi-Fi first, so a bad or used code stops setup before anything is installed
NETS=""
if [[ -n "$CODE" ]]; then
  echo "==> Downloading the saved Wi-Fi networks"
  NETS="$(mktemp)"; chmod 600 "$NETS"; trap 'rm -f "$NETS"' EXIT
  HTTP="$(curl -sS --max-time 20 -o "$NETS" -w '%{http_code}' -H 'Content-Type: application/json' \
    -d "{\"action\":\"prepare\",\"code\":\"$CODE\"}" "$SITE/api/networks" || echo 000)"
  if [[ "$HTTP" != "200" ]]; then
    echo "    $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("error",""))' "$NETS" 2>/dev/null || true)"
    echo "Couldn't download the Wi-Fi networks (HTTP $HTTP). Get a new code in the console and run setup again."; exit 1
  fi
  echo "    $(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["networks"]))' "$NETS") network(s) to save"
fi

# The agent too, now: saving Wi-Fi below can drop a Pi's network for a few seconds (it may be on one of those networks)
AGENT_PY=""
if [[ $AGENT -eq 1 ]]; then
  AGENT_PY="$(mktemp)"
  HERE="$(cd "$(dirname "$0")" && pwd)"
  if [[ -f "$HERE/agent.py" ]]; then cp "$HERE/agent.py" "$AGENT_PY"
  else curl -fsSL "$SITE/pi/agent.py" -o "$AGENT_PY" || { echo "Couldn't download the agent from $SITE. Check the network and run setup again."; exit 1; }; fi
fi

echo "==> Installing packages"
apt-get update -qq
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  apt-get install -y chromium || apt-get install -y chromium-browser
fi
apt-get install -y wlr-randr x11-xserver-utils curl grim scrot python3 python3-pil v4l-utils swaybg >/dev/null || true
if [[ $CONNECT -eq 1 ]]; then apt-get install -y rpi-connect || echo "    rpi-connect not available on this OS image; skipping."; fi
CHROME="$(command -v chromium || command -v chromium-browser)"
if [[ $UPDATE -eq 1 ]]; then
  echo "==> Installing Raspberry Pi OS updates"
  DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade
fi

echo "==> Desktop autologin, no screen blanking, Wi-Fi country $COUNTRY, time zone, SSH $([[ $SSH -eq 1 ]] && echo on || echo off)"
if command -v raspi-config >/dev/null; then
  raspi-config nonint do_boot_behaviour B4   # desktop, auto login
  raspi-config nonint do_blanking 1          # disable screen blanking
  raspi-config nonint do_wifi_country "$COUNTRY" || true
fi
timedatectl set-timezone "$TZ_NAME"
# SSH: off unless --ssh. Only disabled here, not stopped, so a setup run over SSH isn't cut off halfway;
# it stays off from the restart that finishes setup. (The imager may have switched it on.)
if [[ $SSH -eq 1 ]]; then
  systemctl enable --now ssh.service 2>/dev/null || echo "    Couldn't switch SSH on (is openssh-server installed?)"
else
  systemctl disable ssh.service >/dev/null 2>&1 || true
  systemctl disable ssh.socket >/dev/null 2>&1 || true
fi

# HDMI 0 always sends a picture, even when no TV is detected at start (a TV that powers up after the Pi then just
# shows it), at 1920x1080 unless --no-1080p (a Pi 4 struggles at 4K). "D" = keep the output on regardless.
CMDLINE=/boot/firmware/cmdline.txt; [[ -f $CMDLINE ]] || CMDLINE=/boot/cmdline.txt
if [[ -f $CMDLINE ]]; then
  VIDEO="video=HDMI-A-1:$([[ $FORCE_1080 -eq 1 ]] && echo 1920x1080@60)D"
  echo "==> HDMI 0 always on$([[ $FORCE_1080 -eq 1 ]] && echo ", 1920x1080")"
  [[ -f "$CMDLINE.bak-kiosk" ]] || cp "$CMDLINE" "$CMDLINE.bak-kiosk"
  sed -i -E '1 s/ ?video=HDMI-A-1:[^ ]*//g; 1 s/$/ '"$VIDEO"'/' "$CMDLINE"
fi
# A quiet start: no rainbow square, no Raspberry Pi logo splash, no scrolling boot text or cursor. The TV stays
# black until the directory appears. (Company branding can replace the black later.)
CONFIG_TXT="${LOBBY_CONFIG_TXT:-/boot/firmware/config.txt}"; [[ -f $CONFIG_TXT ]] || CONFIG_TXT=/boot/config.txt
if [[ -f $CMDLINE ]]; then
  echo "==> A quiet start (no splash, logo or boot text)"
  sed -i -E '1 s/(^| )splash( |$)/\1\2/g; 1 s/  +/ /g; 1 s/ +$//' "$CMDLINE"
  for t in quiet loglevel=3 logo.nologo vt.global_cursor_default=0; do
    grep -qE "(^| )$t( |\$)" "$CMDLINE" || sed -i "1 s/\$/ $t/" "$CMDLINE"
  done
fi
if [[ -f $CONFIG_TXT ]] && ! grep -q '^disable_splash=1' "$CONFIG_TXT"; then echo 'disable_splash=1' >> "$CONFIG_TXT"; fi
# (end of the quiet start)

echo "==> Saving the Wi-Fi tools and the start-up naming"
cat > /usr/local/sbin/lobby-wifi-import <<'PY'
#!/usr/bin/env python3
"""Saves Wi-Fi networks downloaded from the console (setup-kiosk.sh --code) into NetworkManager, replacing any this
script saved before. Usage: lobby-wifi-import networks.json. Every network is kept; the Pi joins whichever is in
range, earlier ones in the console's list first, and a network cable always wins."""
import json, subprocess, sys

nets = json.load(open(sys.argv[1]))["networks"]
shown = subprocess.run(["nmcli", "-t", "-f", "NAME", "connection", "show"], capture_output=True, text=True)
if shown.returncode != 0:
    sys.exit("NetworkManager isn't running on this Pi, so Wi-Fi can't be saved. Use Raspberry Pi OS Bookworm or newer.")
for name in shown.stdout.splitlines():
    if name.startswith("lobby-wifi-"):
        subprocess.run(["nmcli", "connection", "delete", name], capture_output=True)
failed = 0
for i, n in enumerate(nets, 1):
    args = ["nmcli", "connection", "add", "type", "wifi", "ifname", "*", "con-name", f"lobby-wifi-{i}", "ssid", n["ssid"],
            "connection.autoconnect", "yes", "connection.autoconnect-priority", str(max(0, 100 - i)),
            "802-11-wireless.hidden", "yes" if n.get("hidden") else "no"]
    if n.get("psk"):
        args += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", n["psk"]]
    r = subprocess.run(args, capture_output=True, text=True)
    name = n["ssid"] + (f" ({n['label']})" if n.get("label") else "")
    if r.returncode == 0:
        print(f"    saved {name}")
    else:
        failed += 1
        print(f"    couldn't save {name}: {r.stderr.strip()[:200]}")
sys.exit(1 if failed else 0)
PY
chmod 755 /usr/local/sbin/lobby-wifi-import

echo "==> Saving the field Wi-Fi setup tool"
cat > /usr/local/sbin/lobby-wifi-setup <<'WIFISETUP'
#!/usr/bin/env python3
"""Field Wi-Fi setup: run by kiosk.sh when this Pi has no network and has never reached the site. Starts a short-
lived hotspot carrying a small setup page, so a network can be picked from a phone that joins it (or from this Pi's
own screen, with a keyboard) without a new card or a console visit. Serves until the site can be reached, then
tears the hotspot down and exits 0. Usage: lobby-wifi-setup <serial> <site-url>"""
import http.server, os, secrets, signal, string, subprocess, sys, threading, time, urllib.parse

SERIAL, URL = sys.argv[1], sys.argv[2]
CONNECT_TRIES = int(os.environ.get("LOBBY_WIFI_SETUP_TRIES", "10"))   # for tests only; production keeps the default
CONNECT_SLEEP = float(os.environ.get("LOBBY_WIFI_SETUP_SLEEP", "2"))
AP_SSID = f"Directory-Setup-{SERIAL[-4:]}"
AP_PASSWORD = "".join(secrets.choice(string.digits) for _ in range(8))  # a TV-friendly numeric code
AP_CONN = "lobby-setup-ap"


def run(*args, timeout=20):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except Exception as e:
        return subprocess.CompletedProcess(args, 1, "", str(e))


def hotspot_up():
    run("nmcli", "connection", "delete", AP_CONN)  # a stale one from an earlier attempt
    r = run("nmcli", "device", "wifi", "hotspot", "con-name", AP_CONN, "ssid", AP_SSID, "password", AP_PASSWORD, timeout=30)
    return r.returncode == 0


def hotspot_down():
    run("nmcli", "connection", "down", AP_CONN)
    run("nmcli", "connection", "delete", AP_CONN)


def site_reachable():
    return run("curl", "-fsS", "--max-time", "4", "-o", "/dev/null", URL, timeout=6).returncode == 0


def scan_networks():
    run("nmcli", "device", "wifi", "rescan", timeout=15)
    r = run("nmcli", "-t", "-f", "SSID,SECURITY,SIGNAL", "device", "wifi", "list", timeout=15)
    seen, nets = set(), []
    for line in r.stdout.splitlines():
        parts = line.split(":")
        if len(parts) < 3:
            continue
        ssid, security, signal = parts[0], parts[1], parts[2]
        if not ssid or ssid == AP_SSID or ssid in seen:
            continue
        seen.add(ssid)
        nets.append({"ssid": ssid, "open": security in ("", "--"), "signal": signal or "0"})
    nets.sort(key=lambda n: -int(n["signal"]))
    return nets


def try_connect(ssid, password):
    args = ["nmcli", "device", "wifi", "connect", ssid]
    if password:
        args += ["password", password]
    r = run(*args, timeout=30)
    if r.returncode != 0:
        return False, (r.stderr.strip()[:200] or "Couldn't join that network.")
    for _ in range(CONNECT_TRIES):
        if site_reachable():
            return True, ""
        time.sleep(CONNECT_SLEEP)
    return False, "Joined, but can't reach the directory site from there."


PAGE = """<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up this screen's Wi-Fi</title><style>
body{{font-family:sans-serif;background:#111;color:#eee;padding:24px;max-width:480px;margin:0 auto}}
h1{{font-size:1.3em}}
.code{{font-size:1.6em;letter-spacing:2px;background:#222;padding:8px 12px;border-radius:8px;display:inline-block}}
label{{display:block;margin:14px 0 4px}}
input,select{{width:100%;padding:10px;font-size:1em;border-radius:6px;border:1px solid #444;background:#1a1a1a;color:#eee;box-sizing:border-box}}
button{{margin-top:18px;width:100%;padding:12px;font-size:1.1em;border-radius:8px;border:0;background:#eee;color:#111}}
.err{{color:#f88;margin-top:10px}}
</style></head><body>
<h1>This screen needs Wi-Fi</h1>
<p>From a phone: join <b>{ap_ssid}</b>, code <span class="code">{ap_password}</span>, then open this page again.
Or use a keyboard here.</p>
{message}
<form method="post" action="/connect">
<label>Network</label>
<select name="ssid">{options}</select>
<label>Hidden network name (only if it's not in the list above)</label>
<input type="text" name="hidden_ssid" autocapitalize="off" autocorrect="off">
<label>Password (leave blank for an open network)</label>
<input type="password" name="password">
<button type="submit">Connect</button>
</form>
</body></html>"""

CONNECTED = """<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:sans-serif;background:#111;color:#8f8;padding:24px;text-align:center">
<h1>Connected</h1><p>The screen will start in a moment.</p></body></html>"""


def render(message=""):
    opts = "".join(
        f'<option value="{n["ssid"]}">{n["ssid"]} ({"open" if n["open"] else "locked"}, {n["signal"]}%)</option>'
        for n in scan_networks()
    )
    return PAGE.format(ap_ssid=AP_SSID, ap_password=AP_PASSWORD, message=message, options=opts).encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # keep the kiosk log to what matters

    def _send(self, body, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._send(render())
        else:
            self._send(b"Not found", 404)

    def do_POST(self):
        if self.path != "/connect":
            self._send(b"Not found", 404)
            return
        length = int(self.headers.get("Content-Length", 0))
        form = urllib.parse.parse_qs(self.rfile.read(length).decode())
        ssid = ((form.get("hidden_ssid") or [""])[0] or (form.get("ssid") or [""])[0]).strip()
        password = (form.get("password") or [""])[0]
        ok, err = try_connect(ssid, password) if ssid else (False, "Choose or type a network name.")
        if ok:
            self._send(CONNECTED.encode())
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            self._send(render(f'<p class="err">{err}</p>'))


def watch_for_network(server):
    # Covers a cable plugged in mid-setup, without waiting for the form: the site becoming reachable ends setup
    # even if no one ever submits the picker.
    while True:
        time.sleep(15)
        if site_reachable():
            server.shutdown()
            return


def main():
    if not hotspot_up():
        print(f"{time.strftime('%F %T')} couldn't start the setup hotspot; the picker is still reachable locally.", file=sys.stderr)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 80), Handler)
    # shutdown() must run on a thread other than the one in serve_forever(), or it deadlocks against itself.
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    threading.Thread(target=watch_for_network, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    finally:
        hotspot_down()


if __name__ == "__main__":
    main()
WIFISETUP
chmod 755 /usr/local/sbin/lobby-wifi-setup
# Runs as root (it manages Wi-Fi and binds port 80), started by kiosk.sh (which runs as the desktop user).
cat > /etc/sudoers.d/lobby-wifi-setup <<SUDOERS
$KUSER ALL=(root) NOPASSWD: /usr/local/sbin/lobby-wifi-setup
SUDOERS
chmod 440 /etc/sudoers.d/lobby-wifi-setup
visudo -cf /etc/sudoers.d/lobby-wifi-setup >/dev/null || { echo "lobby-wifi-setup's sudoers rule didn't check out; removing it."; rm -f /etc/sudoers.d/lobby-wifi-setup; }

cat > /usr/local/sbin/lobby-identity <<'ID'
#!/usr/bin/env bash
# Runs at every start, before the network comes up: names this Pi after its serial (e.g. lobby-a4ae272d), so each
# Pi shows up on the building's network as itself, and makes SSH host keys if a prepared card has none.
set -u
SERIAL="${LOBBY_SERIAL:-$( { tr -d '\0' </proc/device-tree/serial-number; } 2>/dev/null || awk '/^Serial/ {print $3}' /proc/cpuinfo 2>/dev/null)}"
SERIAL="$(echo "$SERIAL" | tr 'A-F' 'a-f')"
[[ -n "$SERIAL" ]] || exit 0
NAME="lobby-${SERIAL: -8}"
HOSTS="${LOBBY_HOSTS_FILE:-/etc/hosts}"
if [[ "$(hostname)" != "$NAME" ]]; then
  echo "$NAME" > "${LOBBY_HOSTNAME_FILE:-/etc/hostname}"
  hostname "$NAME"
  if grep -q '^127\.0\.1\.1' "$HOSTS"; then sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$NAME/" "$HOSTS"
  else printf '127.0.1.1\t%s\n' "$NAME" >> "$HOSTS"; fi
fi
ssh-keygen -A >/dev/null 2>&1 || true
ID
chmod 755 /usr/local/sbin/lobby-identity
cat > /etc/systemd/system/lobby-identity.service <<'UNIT'
[Unit]
Description=Lobby directory: name this Pi after its serial
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target NetworkManager.service
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/lobby-identity

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable lobby-identity.service >/dev/null 2>&1
[[ $PREPARE -eq 1 ]] || /usr/local/sbin/lobby-identity

if [[ -n "$NETS" ]]; then
  echo "==> Saving the Wi-Fi networks"
  /usr/local/sbin/lobby-wifi-import "$NETS" || { echo "Some networks couldn't be saved (see above)."; exit 1; }
  # If this Pi was on one of those networks, it reconnects now; wait for it (up to a minute)
  for _ in $(seq 1 30); do curl -fsS --max-time 3 -o /dev/null "$SITE/login.html" && break; sleep 2; done
fi

echo "==> Writing $KDIR/kiosk.sh"
mkdir -p "$KDIR"
# Only settings live here, never an identity: the address is worked out from the serial at every start.
cat > "$KDIR/kiosk.conf" <<EOF
SITE="$SITE"
URL="$URL"
ROTATE="$ROTATE"
EOF

cat > "$KDIR/kiosk.sh" <<'EOF'
#!/usr/bin/env bash
# Started by the desktop at login. Works out this Pi's screen address, rotates the screen and keeps Chromium running.
# Nothing here belongs to one Pi: the address comes from the live serial at every start, so a card works in any Pi.
# tests/kiosk-rotation-test.sh runs this very script against the local test server.
source "$HOME/kiosk/kiosk.conf"
PROFILE="$HOME/kiosk/chromium-profile"
LOG="$HOME/kiosk/kiosk.log"
CHROME="$(command -v chromium || command -v chromium-browser)"
exec >>"$LOG" 2>&1
SERIAL="${LOBBY_SERIAL:-$( { tr -d '\0' </proc/device-tree/serial-number; } 2>/dev/null || awk '/^Serial/ {print $3}' /proc/cpuinfo 2>/dev/null)}"
SERIAL="$(echo "$SERIAL" | tr 'A-F' 'a-f')"
[[ -n "${URL:-}" ]] || URL="${SITE:-https://1pdirectory.netlify.app}/?device=$SERIAL"   # a fixed --url wins
LOOKUP="${URL/\/\?//api/screen?}"          # where to ask which way the screen faces: /api/screen in front of the "?"
LAST="$HOME/kiosk/rotation-${SERIAL:-unknown}.last"   # per Pi, so a card moved to another Pi doesn't reuse its answer
echo "$(date '+%F %T') kiosk starting, Pi ${SERIAL:-unknown}, $URL"

# Wait up to 90 seconds for the network (tests shrink this with KIOSK_NET_TRIES/KIOSK_NET_SLEEP). The page works
# from its saved copy if it never comes back later.
MARKER="$HOME/kiosk/ever-online-${SERIAL:-unknown}"    # per Pi, like the rotation LAST file below
ONLINE=0
for _ in $(seq 1 "${KIOSK_NET_TRIES:-45}"); do curl -fsS --max-time 3 -o /dev/null "$URL" && { ONLINE=1; break; }; sleep "${KIOSK_NET_SLEEP:-2}"; done
if [[ $ONLINE -eq 1 ]]; then
  touch "$MARKER"
elif [[ ! -f "$MARKER" ]]; then
  # This Pi has never reached the site: offer field Wi-Fi setup (a phone-joinable hotspot) instead of sitting on a
  # blank screen. A Pi that's worked before and just lost its network keeps the old, quieter "Reconnecting..." wait.
  echo "$(date '+%F %T') no network and this Pi has never reached the site: starting field Wi-Fi setup"
  SETUP_CHROME_PID=""
  if [[ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" && -n "$CHROME" ]]; then
    "$CHROME" --kiosk "http://localhost/" --user-data-dir="$HOME/kiosk/setup-profile" \
      --ozone-platform-hint=auto --noerrdialogs --disable-infobars --no-first-run >>"$LOG" 2>&1 &
    SETUP_CHROME_PID=$!
  fi
  ${LOBBY_WIFI_SETUP:-sudo -n /usr/local/sbin/lobby-wifi-setup} "${SERIAL:-unknown}" "$URL" >>"$LOG" 2>&1
  [[ -n "$SETUP_CHROME_PID" ]] && kill "$SETUP_CHROME_PID" 2>/dev/null
  curl -fsS --max-time 3 -o /dev/null "$URL" && touch "$MARKER"
fi

# Which way to turn the picture. "auto" asks the site how this screen is set in the console:
# portrait -> 90, anything else (landscape, automatic, new or unassigned Pi) -> 0.
# If the site can't be reached, this Pi's last answer is used, so a Pi that boots without internet stays the same.
rotation_for() {
  curl -fsS --max-time 8 "$1" 2>/dev/null | python3 -c 'import json,sys; print({"portrait": 90, "portrait-flipped": 270, "landscape-flipped": 180}.get(json.load(sys.stdin).get("orientation"), 0))' 2>/dev/null
}
ROT="$ROTATE"
if [[ "$ROT" == "auto" ]]; then
  if ROT="$(rotation_for "$LOOKUP")" && [[ -n "$ROT" ]]; then echo "$ROT" > "$LAST"
  else ROT="$(cat "$LAST" 2>/dev/null || echo 0)"; fi
fi
echo "$(date '+%F %T') rotation $ROT (setting: $ROTATE)"

# Rotate the screen. On Wayland a watcher keeps it that way: a TV that powers up after the Pi (or is switched off
# and on) can come back with the output reset or switched off, which would leave a portrait screen sideways or dark.
if [[ -n "${WAYLAND_DISPLAY:-}" ]] && command -v wlr-randr >/dev/null; then
  WANT="$([[ "$ROT" == "0" ]] && echo normal || echo "$ROT")"
  turn() {
    local out; out="$(wlr-randr 2>/dev/null | awk '/^HDMI/ {print $1; exit}')"
    [[ -n "$out" ]] && wlr-randr --output "$out" --on --transform "$WANT"
  }
  turn
  (
    while sleep "${KIOSK_WATCH_SECONDS:-10}"; do
      kill -0 $$ 2>/dev/null || exit 0                     # the kiosk has stopped
      now="$(wlr-randr 2>/dev/null | awk '/^[^[:space:]]/ {h = !seen && $1 ~ /^HDMI/; if (h) seen = 1}
                                        h && /Enabled:/ {e = $2} h && /Transform:/ {t = $2} END {print e " " t}')"
      if [[ "$now" != "yes $WANT" ]]; then echo "$(date '+%F %T') screen was '$now'; setting it back to $WANT"; turn; fi
    done
  ) &
elif [[ -n "${DISPLAY:-}" ]] && command -v xrandr >/dev/null; then
  OUT="$(xrandr | awk '/ connected/ {print $1; exit}')"
  # Same directions as Wayland above (transform 90 = a quarter turn anticlockwise = xrandr "left")
  case "$ROT" in 90) xrandr --output "$OUT" --rotate left ;; 270) xrandr --output "$OUT" --rotate right ;; 180) xrandr --output "$OUT" --rotate inverted ;; *) xrandr --output "$OUT" --rotate normal ;; esac
  xset s off; xset -dpms; xset s noblank
fi

# Keep the log small
[[ $(wc -c <"$LOG") -gt 1000000 ]] && tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

while true; do
  # After a power cut Chromium thinks it crashed and shows a "Restore pages?" bar. Clear that.
  PREFS="$PROFILE/Default/Preferences"
  if [[ -f "$PREFS" ]]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PREFS"
  fi
  "$CHROME" \
    --kiosk "$URL" \
    --user-data-dir="$PROFILE" \
    --ozone-platform-hint=auto \
    --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
    --no-first-run --password-store=basic \
    --disable-features=Translate,TranslateUI \
    --overscroll-history-navigation=0 --disable-pinch \
    --check-for-update-interval=31536000 \
    --autoplay-policy=no-user-gesture-required
  rc=$?
  echo "$(date '+%F %T') chromium exited ($rc), restarting in 5s"
  sleep 5
done
EOF
chmod +x "$KDIR/kiosk.sh"

echo "==> Hiding the mouse pointer"
# An invisible pointer theme, so no arrow sits on the screen at start (with or without a mouse). The page hides the
# pointer too, but only once it has moved over the page, which never happens without a mouse.
python3 - "$KHOME/.icons/lobby-hidden" <<'PY'
import os, struct, sys
d = os.path.join(sys.argv[1], "cursors"); os.makedirs(d, exist_ok=True)
img = struct.pack("<9I", 36, 0xFFFD0002, 24, 1, 1, 1, 0, 0, 0) + struct.pack("<I", 0)   # one transparent pixel
blob = b"Xcur" + struct.pack("<3I", 16, 0x10000, 1) + struct.pack("<3I", 0xFFFD0002, 24, 28) + img
with open(os.path.join(d, "left_ptr"), "wb") as f:
    f.write(blob)
for name in ("default", "arrow", "top_left_arrow", "text", "xterm", "pointer", "hand1", "hand2", "watch", "wait",
             "progress", "left_ptr_watch", "crosshair", "move", "grab", "grabbing", "all-scroll", "not-allowed"):
    link = os.path.join(d, name)
    if not os.path.lexists(link):
        os.symlink("left_ptr", link)
with open(os.path.join(sys.argv[1], "index.theme"), "w") as f:
    f.write("[Icon Theme]\nName=lobby-hidden\nComment=No visible pointer (lobby kiosk)\n")
PY
mkdir -p "$KHOME/.config/labwc"
LENV="$KHOME/.config/labwc/environment"
touch "$LENV"; sed -i '/^XCURSOR_THEME=/d; /^XCURSOR_SIZE=/d' "$LENV"
printf 'XCURSOR_THEME=lobby-hidden\nXCURSOR_SIZE=24\n' >> "$LENV"

if [[ $TV -eq 1 ]]; then
  echo "==> Keeping the TV on (HDMI-CEC)"
  cat > /usr/local/sbin/lobby-tv <<'TVS'
#!/usr/bin/env bash
# Keeps the TV switched on and showing this Pi, over HDMI-CEC: at start (after a power cut the TV often comes back in
# standby, or later than the Pi) and from then on, so a TV that lost power on its own comes back too. Every 15 seconds
# for the first 5 minutes after the Pi starts, then every 2 minutes. Needs the TV's CEC setting on (Anynet+ on
# Samsung, SimpLink on LG, Bravia Sync on Sony). Nothing to do without a CEC device (logged once).
DEV="${LOBBY_CEC_DEV:-}"
if [[ -z "$DEV" ]]; then for d in /dev/cec0 /dev/cec1; do [[ -e "$d" ]] && { DEV="$d"; break; }; done; fi
STATE="${LOBBY_TV_STATE:-/run/lobby-tv/state}"; mkdir -p "$(dirname "$STATE")"
report() { echo "$1" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"; }   # the agent reports it to the console
if [[ -z "$DEV" || ! -e "$DEV" ]]; then
  echo "no HDMI-CEC device on this Pi; not controlling the TV"
  while true; do report no-cec; sleep 120; done
fi
FAST="${LOBBY_TV_FAST:-15}"; SLOW="${LOBBY_TV_SLOW:-120}"; FAST_FOR="${LOBBY_TV_FAST_FOR:-300}"
cec() { cec-ctl -d "$DEV" "$@" 2>&1; }
cec --playback --osd-name "Lobby" >/dev/null           # join the TV's CEC network as a player
sourced=0; last=""
while true; do
  st="$(cec --to 0 --give-device-power-status | grep -o 'pwr-state: [a-z-]*' | head -1 | cut -d' ' -f2)"
  case "$st" in on|to-on) report on ;; standby|to-standby) report standby ;; *) report not-answering ;; esac
  if [[ "$st" == "on" || "$st" == "to-on" ]]; then
    if [[ $sourced -eq 0 ]]; then                        # make sure it's showing this Pi's input
      pa="$(cec | awk -F': *' '/Physical Address/ {print $2; exit}')"
      [[ -n "$pa" && "$pa" != "f.f.f.f" ]] && cec --to 15 --active-source phys-addr="$pa" >/dev/null
      echo "TV is on; switched it to this Pi ($pa)"; sourced=1
    fi
  else
    [[ "$st" != "$last" ]] && echo "TV is ${st:-not answering}; turning it on"
    cec --to 0 --image-view-on >/dev/null; sourced=0
  fi
  last="$st"
  if (( SECONDS < FAST_FOR )); then sleep "$FAST"; else sleep "$SLOW"; fi
done
TVS
  chmod 755 /usr/local/sbin/lobby-tv
  cat > /etc/systemd/system/lobby-tv.service <<'UNIT'
[Unit]
Description=Lobby directory: keep the TV on and showing this Pi (HDMI-CEC)

[Service]
ExecStart=/usr/local/sbin/lobby-tv
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  if [[ $PREPARE -eq 1 ]]; then systemctl enable lobby-tv.service >/dev/null 2>&1
  else systemctl enable --now lobby-tv.service >/dev/null 2>&1; systemctl restart lobby-tv.service; fi
else
  systemctl disable --now lobby-tv.service >/dev/null 2>&1 || true
fi

echo "==> Starting the kiosk at login (labwc, wayfire and X11 all covered)"
# labwc: a user autostart replaces the desktop panel, which is what a kiosk wants.
mkdir -p "$KHOME/.config/labwc"
# A plain black desktop behind the browser, instead of the Raspberry Pi wallpaper, while it starts
printf '%s\n' "swaybg -c '#000000' >/dev/null 2>&1 &" "$KDIR/kiosk.sh &" > "$KHOME/.config/labwc/autostart"
# wayfire (older Bookworm images)
WF="$KHOME/.config/wayfire.ini"
touch "$WF"
if ! grep -q "kiosk.sh" "$WF"; then
  grep -q "^\[autostart\]" "$WF" || printf '\n[autostart]\n' >> "$WF"
  sed -i "/^\[autostart\]/a kiosk = $KDIR/kiosk.sh\npanel = false\nbackground = false" "$WF"
fi
# X11 / LXDE
mkdir -p "$KHOME/.config/lxsession/LXDE-pi"
printf '@xset s off\n@xset -dpms\n@%s\n' "$KDIR/kiosk.sh" > "$KHOME/.config/lxsession/LXDE-pi/autostart"
chown -R "$KUSER:$KUSER" "$KDIR" "$KHOME/.config" "$KHOME/.icons"

if [[ $AGENT -eq 1 ]]; then
  echo "==> Installing the remote-management agent"
  mkdir -p /opt/lobby-agent
  cp "$AGENT_PY" /opt/lobby-agent/agent.py; rm -f "$AGENT_PY"   # downloaded at the start
  python3 -m py_compile /opt/lobby-agent/agent.py
  chmod 755 /opt/lobby-agent/agent.py
  # The agent makes its own key for the Pi it's in (/var/lib/lobby-agent/identity.json). A Pi set up before
  # generic cards has its key in the config file; hand that to the agent so the Pi stays enrolled.
  if [[ $PREPARE -eq 0 && ! -f /var/lib/lobby-agent/identity.json ]] && [[ -n "$SERIAL" ]]; then
    python3 - "$SERIAL" <<'PY' || true
import json, os, sys
key = json.load(open("/etc/lobby-agent.json")).get("key", "")
if len(key) >= 24:
    os.makedirs("/var/lib/lobby-agent", exist_ok=True)
    fd = os.open("/var/lib/lobby-agent/identity.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"serial": sys.argv[1], "key": key}, f)
PY
  fi
  ( umask 077; printf '{"site": "%s", "user": "%s"}\n' "$SITE" "$KUSER" > /etc/lobby-agent.json )
  cat > /etc/systemd/system/lobby-agent.service <<'UNIT'
[Unit]
Description=Lobby directory agent (health, screenshots, remote commands)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 /opt/lobby-agent/agent.py
Restart=always
RestartSec=20

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  if [[ $PREPARE -eq 1 ]]; then systemctl enable lobby-agent.service; systemctl stop lobby-agent.service 2>/dev/null || true
  else systemctl enable --now lobby-agent.service; systemctl restart lobby-agent.service; fi
fi

# The options this Pi was set up with, so the console's Update Pi (--update) re-applies them the same way
{ for v in SITE URL ROTATE TZ_NAME COUNTRY FORCE_1080 CONNECT AGENT SSH TV; do printf '%s=%q\n' "$v" "${!v}"; done; } > "$SETUP_CONF"

# No automatic reboots: they're started from the console (and, later, scheduled there). Remove the nightly
# reboot an earlier version of this script installed, if this Pi has one.
rm -f /etc/cron.d/kiosk-reboot

if [[ $PREPARE -eq 1 ]]; then
  trap '' HUP     # dropping the bench's Wi-Fi below mustn't stop the rest
  echo "==> Clearing everything that belongs to this bench Pi"
  systemctl stop lobby-agent.service 2>/dev/null || true
  rm -rf /var/lib/lobby-agent                                                # the agent's key and saved results
  rm -rf "$KDIR/chromium-profile" "$KDIR/setup-profile" "$KDIR/kiosk.log" "$KDIR"/rotation*.last "$KDIR"/ever-online-*  # browser data, log, last rotation, last online marker
  rm -f /var/lib/NetworkManager/*.lease /var/lib/NetworkManager/*lease*       # the bench's network addresses
  : > /etc/machine-id                                                        # made fresh in each Pi at first start
  [[ -L /var/lib/dbus/machine-id ]] || rm -f /var/lib/dbus/machine-id
  rm -f /etc/ssh/ssh_host_* /var/lib/systemd/random-seed
  journalctl --rotate >/dev/null 2>&1 || true; journalctl --vacuum-time=1s >/dev/null 2>&1 || true
  find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' \) -delete 2>/dev/null || true
  find /var/log -type f -name '*.log' -exec truncate -s 0 {} + 2>/dev/null || true
  rm -f /root/.bash_history "$KHOME/.bash_history"
  apt-get clean
  echo lobby-new > /etc/hostname                                             # renamed from its serial at first start
  # Last: the bench's own Wi-Fi (the saved directory networks stay)
  if command -v nmcli >/dev/null; then
    nmcli -t -f NAME,TYPE connection show 2>/dev/null | while IFS=: read -r name type; do
      if [[ "$type" == "802-11-wireless" && "$name" != lobby-wifi-* ]]; then
        nmcli connection delete "$name" >/dev/null 2>&1 && echo "    removed the bench's network: $name"
      fi
    done
  fi
  sync
  echo
  echo "Card prepared. Powering off now."
  echo "Next: copy this card to an image file (README: Preparing cards). Don't start it in this Pi again first."
  systemctl poweroff
  exit 0
fi

if [[ $UPDATE -eq 1 ]]; then
  echo "Updated."                            # the agent reports this, then restarts the Pi
  exit 0
fi

echo
echo "Done. Reboot to start the directory:  sudo reboot"
echo "Log file: $KDIR/kiosk.log"
if [[ -z "$URL" ]]; then
  echo "This Pi (serial ${SERIAL:-unknown}) will show up in the console. Assign it to a screen there."
else
  echo "To change the screen address later, edit $KDIR/kiosk.conf and reboot."
fi
if [[ $AGENT -eq 1 ]]; then echo "Agent log: journalctl -u lobby-agent -f"; fi
