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
# Get the code in the console: Pi setup -> Get a prepare code (it lasts an hour and works once). Without --code,
# the Pi keeps whatever network it already has (fine for a wired Pi).
#
# The Pi then shows "New display" with its serial number until it's assigned to a screen in the console.
# Pis from the Yodeck report are recognized by serial; open their enrollment window in the console on install day.
#
# Options:
#   --code CODE        Download the Wi-Fi networks saved in the console (Pi setup). Every network is saved on the
#                      card; the Pi joins whichever is in range, and a network cable always wins.
#   --prepare          Bench mode: install everything, then clear everything that belongs to this Pi (machine ID,
#                      logs, browser profile, keys, the bench's own Wi-Fi) and power off, ready to copy the card.
#                      Needs --code. Run it at the Pi's own keyboard or on a cable: it drops the bench's Wi-Fi.
#   --site URL         The directory site. Default https://1pdirectory.netlify.app
#   --url URL          Old style: a fixed screen address instead of letting the console decide (not with --prepare)
#   --rotate auto|0|90|270  Default auto: at every start the Pi asks the site whether its screen is portrait
#                      or landscape (as set in the console) and turns the picture to match. Landscape, new
#                      and unassigned Pis use 0. A fixed number overrides that. If a portrait picture is
#                      upside down, re-run with --rotate 270.
#   --tz ZONE          Time zone. Default America/Chicago.
#   --wifi-country CC  Wi-Fi country code. Default US.
#   --no-1080p         Keep the TV's native resolution (4K runs slowly on a Pi 4; not recommended).
#   --connect          Also install Raspberry Pi Connect for remote screen viewing from a browser.
#   --no-agent         Don't install the remote-management agent.
#   --ssh              Leave SSH on. By default SSH is switched off (from the next restart): the Pi opens no ports,
#                      and the agent handles remote management. Re-run setup without --ssh to switch it off again.
set -euo pipefail

SITE="https://1pdirectory.netlify.app"; URL=""; ROTATE="auto"; TZ_NAME="America/Chicago"; COUNTRY="US"
FORCE_1080=1; CONNECT=0; AGENT=1; SSH=0; PREPARE=0; CODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --site) SITE="${2%/}"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --prepare) PREPARE=1; shift ;;
    --no-agent) AGENT=0; shift ;;
    --rotate) ROTATE="$2"; shift 2 ;;
    --reboot) echo "--reboot has been removed: the Pi doesn't reboot on its own. Reboots are started (and later scheduled) from the console."; exit 1 ;;
    --tz) TZ_NAME="$2"; shift 2 ;;
    --wifi-country) COUNTRY="$2"; shift 2 ;;
    --no-1080p) FORCE_1080=0; shift ;;
    --connect) CONNECT=1; shift ;;
    --ssh) SSH=1; shift ;;
    -h|--help) sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

[[ "$SITE" =~ ^https?:// ]] || { echo "--site must start with https://"; exit 1; }
[[ -z "$URL" || "$URL" =~ ^https?:// ]] || { echo "--url must start with https://"; exit 1; }
[[ "$ROTATE" =~ ^(auto|0|90|270)$ ]] || { echo "--rotate must be auto, 0, 90 or 270"; exit 1; }
[[ "$COUNTRY" =~ ^[A-Z]{2}$ ]] || { echo "--wifi-country must be two capital letters, like US"; exit 1; }
[[ -z "$CODE" || "$CODE" =~ ^[A-Za-z0-9\ -]{8,12}$ ]] || { echo "That doesn't look like a prepare code (like ABCD-EFGH)."; exit 1; }
if [[ $PREPARE -eq 1 ]]; then
  [[ -n "$CODE" ]] || { echo "--prepare needs --code: get one in the console (Pi setup -> Get a prepare code), so the card carries the saved Wi-Fi."; exit 1; }
  [[ -z "$URL" ]] || { echo "--prepare makes a card for any Pi; it can't have a fixed --url."; exit 1; }
fi
[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo bash $0 ..."; exit 1; }

KUSER="${SUDO_USER:-}"
[[ -n "$KUSER" && "$KUSER" != "root" ]] || { echo "Run this with sudo from the desktop user's account, not as root directly."; exit 1; }
KHOME="$(getent passwd "$KUSER" | cut -d: -f6)"
KDIR="$KHOME/kiosk"
SERIAL="$( { tr -d '\0' </proc/device-tree/serial-number; } 2>/dev/null || awk '/^Serial/ {print $3}' /proc/cpuinfo 2>/dev/null || true)"
SERIAL="$(echo "$SERIAL" | tr 'A-F' 'a-f')"

echo "==> $([[ $PREPARE -eq 1 ]] && echo "Preparing a card on this bench Pi" || echo "Setting up this Pi") for user $KUSER"
if [[ $PREPARE -eq 1 ]]; then
  echo "    The card will carry no identity: it takes on the serial of whichever Pi it's put in."
else
  echo "    Pi serial: ${SERIAL:-unknown}"
  echo "    Screen:   ${URL:-$SITE/?device=${SERIAL:-<serial>}} $([[ -z "$URL" ]] && echo "(built from the serial at every start)")"
fi
echo "    Rotation: $([[ "$ROTATE" == "auto" ]] && echo "automatic (asks the site at every start)" || echo "fixed at $ROTATE")"
echo "    Time zone: $TZ_NAME   No automatic reboots (reboots come from the console)"
echo "    SSH: $([[ $SSH -eq 1 ]] && echo "on (--ssh)" || echo "off from the next restart (use --ssh to keep it)")"

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

echo "==> Installing packages"
apt-get update -qq
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  apt-get install -y chromium || apt-get install -y chromium-browser
fi
apt-get install -y wlr-randr x11-xserver-utils curl grim scrot python3 python3-pil >/dev/null || true
if [[ $CONNECT -eq 1 ]]; then apt-get install -y rpi-connect || echo "    rpi-connect not available on this OS image; skipping."; fi
CHROME="$(command -v chromium || command -v chromium-browser)"

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

if [[ $FORCE_1080 -eq 1 ]]; then
  CMDLINE=/boot/firmware/cmdline.txt; [[ -f $CMDLINE ]] || CMDLINE=/boot/cmdline.txt
  if [[ -f $CMDLINE ]] && ! grep -q "video=HDMI-A-1:" "$CMDLINE"; then
    echo "==> Forcing 1920x1080 output on HDMI 0 (a Pi 4 struggles at 4K)"
    cp "$CMDLINE" "$CMDLINE.bak-kiosk"
    sed -i '1 s/$/ video=HDMI-A-1:1920x1080@60/' "$CMDLINE"
  fi
fi

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

# Wait up to 90 seconds for the network. The page works from its saved copy if it never comes.
for _ in $(seq 1 45); do curl -fsS --max-time 3 -o /dev/null "$URL" && break; sleep 2; done

# Which way to turn the picture. "auto" asks the site how this screen is set in the console:
# portrait -> 90, anything else (landscape, automatic, new or unassigned Pi) -> 0.
# If the site can't be reached, this Pi's last answer is used, so a Pi that boots without internet stays the same.
rotation_for() {
  curl -fsS --max-time 8 "$1" 2>/dev/null | python3 -c 'import json,sys; print(90 if json.load(sys.stdin).get("orientation") == "portrait" else 0)' 2>/dev/null
}
ROT="$ROTATE"
if [[ "$ROT" == "auto" ]]; then
  if ROT="$(rotation_for "$LOOKUP")" && [[ -n "$ROT" ]]; then echo "$ROT" > "$LAST"
  else ROT="$(cat "$LAST" 2>/dev/null || echo 0)"; fi
fi
echo "$(date '+%F %T') rotation $ROT (setting: $ROTATE)"

# Rotate the screen
if [[ -n "${WAYLAND_DISPLAY:-}" ]] && command -v wlr-randr >/dev/null; then
  OUT="$(wlr-randr | awk '/^HDMI/ {print $1; exit}')"
  [[ -n "$OUT" ]] && wlr-randr --output "$OUT" --transform "$([[ "$ROT" == "0" ]] && echo normal || echo "$ROT")"
elif [[ -n "${DISPLAY:-}" ]] && command -v xrandr >/dev/null; then
  OUT="$(xrandr | awk '/ connected/ {print $1; exit}')"
  case "$ROT" in 90) xrandr --output "$OUT" --rotate right ;; 270) xrandr --output "$OUT" --rotate left ;; *) xrandr --output "$OUT" --rotate normal ;; esac
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

echo "==> Starting the kiosk at login (labwc, wayfire and X11 all covered)"
# labwc: a user autostart replaces the desktop panel, which is what a kiosk wants.
mkdir -p "$KHOME/.config/labwc"
echo "$KDIR/kiosk.sh &" > "$KHOME/.config/labwc/autostart"
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
chown -R "$KUSER:$KUSER" "$KDIR" "$KHOME/.config"

if [[ $AGENT -eq 1 ]]; then
  echo "==> Installing the remote-management agent"
  mkdir -p /opt/lobby-agent
  HERE="$(cd "$(dirname "$0")" && pwd)"
  if [[ -f "$HERE/agent.py" ]]; then cp "$HERE/agent.py" /opt/lobby-agent/agent.py
  else curl -fsSL "$SITE/pi/agent.py" -o /opt/lobby-agent/agent.py; fi
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

# No automatic reboots: they're started from the console (and, later, scheduled there). Remove the nightly
# reboot an earlier version of this script installed, if this Pi has one.
rm -f /etc/cron.d/kiosk-reboot

if [[ $PREPARE -eq 1 ]]; then
  trap '' HUP     # dropping the bench's Wi-Fi below mustn't stop the rest
  echo "==> Clearing everything that belongs to this bench Pi"
  systemctl stop lobby-agent.service 2>/dev/null || true
  rm -rf /var/lib/lobby-agent                                                # the agent's key and saved results
  rm -rf "$KDIR/chromium-profile" "$KDIR/kiosk.log" "$KDIR"/rotation*.last   # browser data, log, last rotation
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

echo
echo "Done. Reboot to start the directory:  sudo reboot"
echo "Log file: $KDIR/kiosk.log"
if [[ -z "$URL" ]]; then
  echo "This Pi (serial ${SERIAL:-unknown}) will show up in the console. Assign it to a screen there."
else
  echo "To change the screen address later, edit $KDIR/kiosk.conf and reboot."
fi
if [[ $AGENT -eq 1 ]]; then echo "Agent log: journalctl -u lobby-agent -f"; fi
