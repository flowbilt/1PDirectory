#!/usr/bin/env bash
# Checks the parts of public/pi/setup-kiosk.sh that can run off a Pi: its option checks, the Wi-Fi import
# (lobby-wifi-import, against a stand-in nmcli) and the start-up naming (lobby-identity). Nothing is installed:
# every setup run here stops at its option checks, and SUDO_USER is unset so it could go no further anyway.
# Run from the project folder:  bash tests/setup-test.sh   (a few seconds)
set -uo pipefail
cd "$(dirname "$0")/.."
SETUP=public/pi/setup-kiosk.sh
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
pass=0; fail=0
ok() { if [[ "$2" == "$3" ]]; then echo "  ok  $1"; pass=$((pass+1)); else echo "  FAIL $1: wanted '$3', got '$2'"; fail=$((fail+1)); fi; }
has() { if grep -qF -- "$3" <<<"$2"; then echo "  ok  $1"; pass=$((pass+1)); else echo "  FAIL $1: '$3' not in: $2"; fail=$((fail+1)); fi; }

# ── option checks ──
setup() { env -u SUDO_USER bash "$SETUP" "$@" 2>&1; echo "exit=$?"; }
has "--prepare needs a code" "$(setup --prepare)" "--prepare needs --code"
has "--prepare can't have a fixed address" "$(setup --prepare --code ABCD-EFGH --url https://x.test/?screen=a)" "can't have a fixed --url"
has "a malformed code is refused" "$(setup --code 'x"; rm -rf /')" "doesn't look like a prepare code"
has "--reboot explains it's gone" "$(setup --reboot 03:30)" "--reboot has been removed"
has "--help lists --prepare" "$(bash "$SETUP" --help)" "--prepare"
has "a good command gets past the checks (and stops at the sudo checks)" "$(setup --prepare --code abcd-efgh)" "sudo"

# ── Wi-Fi import ──
awk '/^cat > \/usr\/local\/sbin\/lobby-wifi-import <</{f=1;next} /^PY$/{f=0} f' "$SETUP" > "$W/lobby-wifi-import"
mkdir -p "$W/bin"
cat > "$W/bin/nmcli" <<'S'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NMLOG"
if [[ "$*" == "-t -f NAME connection show" ]]; then printf 'preconfigured\nlobby-wifi-1\nWired connection 1\n'; fi
exit 0
S
chmod +x "$W/bin/nmcli"
cat > "$W/nets.json" <<'J'
{"networks": [{"label": "1Point office", "ssid": "1Point Guest", "psk": "", "hidden": true},
              {"label": "Perimeter Park One", "ssid": "PPI-Lobby", "psk": "correct horse; \"quoted\"", "hidden": false}]}
J
NMLOG="$W/nm.log" PATH="$W/bin:$PATH" python3 "$W/lobby-wifi-import" "$W/nets.json" > "$W/import.out"; rc=$?
LOG="$(cat "$W/nm.log")"
ok "Wi-Fi import succeeds" "$rc" "0"
has "it removes networks it saved before" "$LOG" "connection delete lobby-wifi-1"
ok "and leaves others alone (the bench's, a cable's)" "$(grep -c 'delete preconfigured\|delete Wired' "$W/nm.log")" "0"
has "an open, hidden network is saved without a password" "$LOG" "con-name lobby-wifi-1 ssid 1Point Guest connection.autoconnect yes connection.autoconnect-priority 99 802-11-wireless.hidden yes"
ok "and without WPA settings" "$(grep '1Point Guest' "$W/nm.log" | grep -c wifi-sec)" "0"
has "a WPA network keeps its password exactly, quotes and all" "$LOG" "wifi-sec.key-mgmt wpa-psk wifi-sec.psk correct horse; \"quoted\""
has "the first network in the console's list is tried first" "$(grep 'lobby-wifi-2' "$W/nm.log")" "autoconnect-priority 98"
has "it says what it saved" "$(cat "$W/import.out")" "saved PPI-Lobby (Perimeter Park One)"

# ── start-up naming ──
awk "/^cat > \/usr\/local\/sbin\/lobby-identity <</{f=1;next} /^ID\$/{f=0} f" "$SETUP" > "$W/lobby-identity"
cat > "$W/bin/hostname" <<'S'
#!/usr/bin/env bash
if [[ $# -eq 0 ]]; then cat "$LOBBY_HOSTNAME_FILE"; else echo "$1" > "$LOBBY_HOSTNAME_FILE"; echo "set $1" >> "$NMLOG"; fi
S
printf '#!/usr/bin/env bash\necho keygen >> "$NMLOG"\n' > "$W/bin/ssh-keygen"
chmod +x "$W/bin/"*
echo "lobby-new" > "$W/hostname"; printf '127.0.0.1\tlocalhost\n127.0.1.1\tlobby-new\n' > "$W/hosts"; : > "$W/nm.log"
id_run() { NMLOG="$W/nm.log" LOBBY_SERIAL="$1" LOBBY_HOSTNAME_FILE="$W/hostname" LOBBY_HOSTS_FILE="$W/hosts" PATH="$W/bin:$PATH" bash "$W/lobby-identity"; }
id_run 10000000A4AE272D
ok "a prepared card names itself after the Pi's serial" "$(cat "$W/hostname")" "lobby-a4ae272d"
ok "and the hosts file agrees" "$(grep '^127.0.1.1' "$W/hosts")" "$(printf '127.0.1.1\tlobby-a4ae272d')"
has "SSH host keys are made if missing" "$(cat "$W/nm.log")" "keygen"
: > "$W/nm.log"; id_run 10000000a4ae272d
ok "the next start changes nothing" "$(grep -c '^set' "$W/nm.log")" "0"
id_run 100000008294ba46
ok "the card moved to another Pi takes that Pi's name" "$(cat "$W/hostname")" "lobby-8294ba46"

# ── keeping the TV on (lobby-tv, against a stand-in TV) ──
awk "/^  cat > \/usr\/local\/sbin\/lobby-tv <</{f=1;next} /^TVS\$/{f=0} f" "$SETUP" > "$W/lobby-tv"
cat > "$W/bin/cec-ctl" <<'S'
#!/usr/bin/env bash
shift 2                                             # -d <device>
echo "$*" >> "$CECLOG"
case "$*" in
  "--to 0 --give-device-power-status") echo "    pwr-state: $(cat "$TVSTATE") (0x00)" ;;
  "--to 0 --image-view-on") echo on > "$TVSTATE" ;;
  "") printf 'Driver Info:\n\tPhysical Address           : 1.0.0.0\n' ;;
esac
S
chmod +x "$W/bin/cec-ctl"; touch "$W/cec0"
tv_run() {  # run the keeper for $1 seconds with the TV starting in state $2
  echo "$2" > "$W/tv"; : > "$W/cec.log"
  CECLOG="$W/cec.log" TVSTATE="$W/tv" LOBBY_CEC_DEV="$W/cec0" LOBBY_TV_FAST=0.3 LOBBY_TV_SLOW=0.3 PATH="$W/bin:$PATH" \
    timeout "$1" bash "$W/lobby-tv" > "$W/tv.out" 2>&1
}
tv_run 2 standby
C="$(cat "$W/cec.log")"
has "a TV in standby is turned on" "$C" "--to 0 --image-view-on"
has "and switched to this Pi's input" "$C" "--to 15 --active-source phys-addr=1.0.0.0"
ok "the input is switched once, not every check" "$(grep -c active-source "$W/cec.log")" "1"
has "it says what it did" "$(cat "$W/tv.out")" "TV is standby; turning it on"
tv_run 2 on
ok "a TV that's already on isn't sent 'turn on'" "$(grep -c image-view-on "$W/cec.log")" "0"
has "but is switched to this Pi once" "$(cat "$W/cec.log")" "active-source"
( sleep 1; echo standby > "$W/tv" ) & tv_run 2.5 on
ok "a TV that goes off later is turned back on" "$(grep -c image-view-on "$W/cec.log")" "1"
ok "and switched back to this Pi" "$(grep -c active-source "$W/cec.log")" "2"
CECLOG="$W/cec.log" LOBBY_CEC_DEV="$W/no-such-cec" PATH="$W/bin:$PATH" timeout 1 bash "$W/lobby-tv" > "$W/tv.out" 2>&1
has "no CEC device: says so and does nothing" "$(cat "$W/tv.out")" "not controlling the TV"

# ── the invisible pointer ──
awk "/^python3 - \"\\\$KHOME\/.icons\/lobby-hidden\" <<'PY'/{f=1;next} /^PY\$/{f=0} f" "$SETUP" > "$W/pointer.py"
python3 "$W/pointer.py" "$W/icons/lobby-hidden"
ok "the pointer theme is a valid, fully transparent cursor" "$(python3 - "$W/icons/lobby-hidden/cursors/left_ptr" <<'PY'
import struct, sys
b = open(sys.argv[1], "rb").read()
magic, hsize, ver, ntoc = b[:4], *struct.unpack("<3I", b[4:16])
typ, sub, pos = struct.unpack("<3I", b[16:28])
h = struct.unpack("<9I", b[pos:pos + 36]); px = struct.unpack("<I", b[pos + 36:pos + 40])[0]
print("ok" if (magic, hsize, ntoc, typ, h[0], h[1], h[4], h[5], px, len(b)) == (b"Xcur", 16, 1, 0xFFFD0002, 36, 0xFFFD0002, 1, 1, 0, pos + 40) else "bad")
PY
)" "ok"
ok "every common pointer name is covered" "$(ls "$W/icons/lobby-hidden/cursors" | wc -l)" "19"

# ── the boot line: HDMI 0 always on ──
awk '/^if \[\[ -f \$CMDLINE \]\]; then/{f=1} f{print} f&&/^fi$/{exit}' "$SETUP" > "$W/video.sh"
printf 'console=tty1 root=PARTUUID=abc rootwait video=HDMI-A-1:1920x1080@60 quiet\n' > "$W/cmdline.txt"
CMDLINE="$W/cmdline.txt" FORCE_1080=1 bash -c "source '$W/video.sh'" >/dev/null
ok "an older 1080p setting is replaced by 1080p + always on" "$(cat "$W/cmdline.txt")" "console=tty1 root=PARTUUID=abc rootwait quiet video=HDMI-A-1:1920x1080@60D"
CMDLINE="$W/cmdline.txt" FORCE_1080=1 bash -c "source '$W/video.sh'" >/dev/null
ok "running setup again doesn't add it twice" "$(grep -o 'video=' "$W/cmdline.txt" | wc -l)" "1"
CMDLINE="$W/cmdline.txt" FORCE_1080=0 bash -c "source '$W/video.sh'" >/dev/null
ok "--no-1080p keeps the output on at the TV's own resolution" "$(grep -o 'video=[^ ]*' "$W/cmdline.txt")" "video=HDMI-A-1:D"

echo; echo "$pass/$((pass+fail)) passed"; [[ $fail -eq 0 ]]
