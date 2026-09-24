#!/usr/bin/env bash
# Lobby directory kiosk setup for Raspberry Pi 4.
# Target: Raspberry Pi OS with desktop (64-bit), Bookworm or newer.
#
# Usage (as the desktop user, with sudo):
#   curl -fsSLO https://1pdirectory.netlify.app/pi/setup-kiosk.sh
#   sudo bash setup-kiosk.sh
#
# The Pi then shows "New display" with its serial number until it's assigned to a screen in the console.
# Pis from the Yodeck report are recognized by serial and assign themselves.
#
# Options:
#   --site URL         The directory site. Default https://1pdirectory.netlify.app
#   --url URL          Old style: a fixed screen address instead of letting the console decide
#   --rotate 90|270|0  Portrait rotation. Default 90. If the picture is upside down, re-run with the other value.
#   --reboot HH:MM     Nightly reboot time, 24-hour. Default 03:30. Use "off" to skip.
#   --tz ZONE          Time zone. Default America/Chicago.
#   --no-1080p         Keep the TV's native resolution (4K runs slowly on a Pi 4; not recommended).
#   --connect          Also install Raspberry Pi Connect for remote screen viewing from a browser.
#   --no-agent         Don't install the remote-management agent.
set -euo pipefail

SITE="https://1pdirectory.netlify.app"; URL=""; ROTATE=90; REBOOT="03:30"; TZ_NAME="America/Chicago"; FORCE_1080=1; CONNECT=0; AGENT=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --site) SITE="${2%/}"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --no-agent) AGENT=0; shift ;;
    --rotate) ROTATE="$2"; shift 2 ;;
    --reboot) REBOOT="$2"; shift 2 ;;
    --tz) TZ_NAME="$2"; shift 2 ;;
    --no-1080p) FORCE_1080=0; shift ;;
    --connect) CONNECT=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo bash $0 --url ..."; exit 1; }
[[ "$SITE" =~ ^https?:// ]] || { echo "--site must start with https://"; exit 1; }
SERIAL="$(tr -d '\0' </proc/device-tree/serial-number 2>/dev/null || awk '/^Serial/ {print $3}' /proc/cpuinfo)"
SERIAL="$(echo "$SERIAL" | tr 'A-F' 'a-f')"
if [[ -z "$URL" ]]; then
  [[ -n "$SERIAL" ]] || { echo "Couldn't read this Pi's serial number. Use --url instead."; exit 1; }
  URL="$SITE/?device=$SERIAL"
fi
[[ "$URL" =~ ^https?:// ]] || { echo "--url must start with https://"; exit 1; }
[[ "$ROTATE" =~ ^(0|90|270)$ ]] || { echo "--rotate must be 0, 90 or 270"; exit 1; }
if [[ "$REBOOT" != "off" ]] && ! [[ "$REBOOT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then echo "--reboot must look like 03:30 or be off"; exit 1; fi

KUSER="${SUDO_USER:-}"
[[ -n "$KUSER" && "$KUSER" != "root" ]] || { echo "Run this with sudo from the desktop user's account, not as root directly."; exit 1; }
KHOME="$(getent passwd "$KUSER" | cut -d: -f6)"
KDIR="$KHOME/kiosk"

echo "==> Setting up kiosk for user $KUSER"
echo "    Pi serial: ${SERIAL:-unknown}"
echo "    Screen:   $URL"
echo "    Rotation: $ROTATE   Nightly reboot: $REBOOT   Time zone: $TZ_NAME"

echo "==> Installing packages"
apt-get update -qq
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  apt-get install -y chromium || apt-get install -y chromium-browser
fi
apt-get install -y wlr-randr x11-xserver-utils curl grim scrot python3 python3-pil >/dev/null || true
if [[ $CONNECT -eq 1 ]]; then apt-get install -y rpi-connect || echo "    rpi-connect not available on this OS image; skipping."; fi
CHROME="$(command -v chromium || command -v chromium-browser)"

echo "==> Desktop autologin, no screen blanking, SSH on, time zone"
if command -v raspi-config >/dev/null; then
  raspi-config nonint do_boot_behaviour B4   # desktop, auto login
  raspi-config nonint do_blanking 1          # disable screen blanking
  raspi-config nonint do_ssh 0               # enable SSH for remote support
fi
timedatectl set-timezone "$TZ_NAME"

if [[ $FORCE_1080 -eq 1 ]]; then
  CMDLINE=/boot/firmware/cmdline.txt; [[ -f $CMDLINE ]] || CMDLINE=/boot/cmdline.txt
  if [[ -f $CMDLINE ]] && ! grep -q "video=HDMI-A-1:" "$CMDLINE"; then
    echo "==> Forcing 1920x1080 output on HDMI 0 (a Pi 4 struggles at 4K)"
    cp "$CMDLINE" "$CMDLINE.bak-kiosk"
    sed -i '1 s/$/ video=HDMI-A-1:1920x1080@60/' "$CMDLINE"
  fi
fi

echo "==> Writing $KDIR/kiosk.sh"
mkdir -p "$KDIR"
cat > "$KDIR/kiosk.conf" <<EOF
URL="$URL"
ROTATE="$ROTATE"
EOF

cat > "$KDIR/kiosk.sh" <<'EOF'
#!/usr/bin/env bash
# Started by the desktop at login. Rotates the screen and keeps Chromium running.
source "$HOME/kiosk/kiosk.conf"
PROFILE="$HOME/kiosk/chromium-profile"
LOG="$HOME/kiosk/kiosk.log"
CHROME="$(command -v chromium || command -v chromium-browser)"
exec >>"$LOG" 2>&1
echo "$(date '+%F %T') kiosk starting"

# Rotate the screen
if [[ -n "${WAYLAND_DISPLAY:-}" ]] && command -v wlr-randr >/dev/null; then
  OUT="$(wlr-randr | awk '/^HDMI/ {print $1; exit}')"
  [[ -n "$OUT" && "$ROTATE" != "0" ]] && wlr-randr --output "$OUT" --transform "$ROTATE"
elif [[ -n "${DISPLAY:-}" ]] && command -v xrandr >/dev/null; then
  OUT="$(xrandr | awk '/ connected/ {print $1; exit}')"
  case "$ROTATE" in 90) xrandr --output "$OUT" --rotate right ;; 270) xrandr --output "$OUT" --rotate left ;; esac
  xset s off; xset -dpms; xset s noblank
fi

# Wait up to 90 seconds for the network. The page works from its saved copy if it never comes.
for _ in $(seq 1 45); do curl -fsS --max-time 3 -o /dev/null "$URL" && break; sleep 2; done

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
  # This Pi's own key. Kept if setup is run again, so the Pi stays enrolled.
  KEY="$(python3 -c 'import json;print(json.load(open("/etc/lobby-agent.json"))["key"])' 2>/dev/null || true)"
  [[ ${#KEY} -ge 24 ]] || KEY="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
  ( umask 077; printf '{"site": "%s", "key": "%s", "user": "%s"}\n' "$SITE" "$KEY" "$KUSER" > /etc/lobby-agent.json )
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
  systemctl enable --now lobby-agent.service
fi

if [[ "$REBOOT" != "off" ]]; then
  echo "==> Nightly reboot at $REBOOT"
  echo "${REBOOT#*:} ${REBOOT%%:*} * * * root /sbin/shutdown -r now" > /etc/cron.d/kiosk-reboot
  chmod 644 /etc/cron.d/kiosk-reboot
else
  rm -f /etc/cron.d/kiosk-reboot
fi

echo
echo "Done. Reboot to start the directory:  sudo reboot"
echo "Log file: $KDIR/kiosk.log"
if [[ "$URL" == *"?device="* ]]; then
  echo "This Pi (serial $SERIAL) will show up in the console. Assign it to a screen there."
else
  echo "To change the screen address later, edit $KDIR/kiosk.conf and reboot."
fi
if [[ $AGENT -eq 1 ]]; then echo "Agent log: journalctl -u lobby-agent -f"; fi
