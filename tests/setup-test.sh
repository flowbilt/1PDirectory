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
has "--update keeps the Wi-Fi: no --code with it" "$(setup --update --code ABCD-EFGH)" "can't be combined"
has "--update can't prepare a card" "$(setup --update --prepare)" "can't be combined"
has "--rotate takes 180 now" "$(setup --rotate 180 --prepare)" "--prepare needs --code"
has "but not other numbers" "$(setup --rotate 45)" "must be auto, 0, 90, 180 or 270"
has "--help lists --update" "$(bash "$SETUP" --help)" "--update"

# ── the saved setup options (what Update Pi re-applies) ──
grep -F "printf '%s=%q" "$SETUP" > "$W/save-opts.sh"
( SITE="https://1pdirectory.netlify.app"; URL="https://x.test/?site=a b&c=\$d"; ROTATE=270; TZ_NAME="America/Chicago"; COUNTRY=US
  FORCE_1080=0; CONNECT=1; AGENT=1; SSH=1; TV=0; SETUP_CONF="$W/lobby-setup.conf"; source "$W/save-opts.sh" )
( source "$W/lobby-setup.conf"; echo "$URL|$ROTATE|$FORCE_1080|$SSH|$TV" ) > "$W/opts.out"
ok "the options a Pi was set up with come back exactly (odd characters too)" "$(cat "$W/opts.out")" 'https://x.test/?site=a b&c=$d|270|0|1|0'
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
  CECLOG="$W/cec.log" TVSTATE="$W/tv" LOBBY_TV_STATE="$W/tvstate" LOBBY_CEC_DEV="$W/cec0" LOBBY_TV_FAST=0.3 LOBBY_TV_SLOW=0.3 PATH="$W/bin:$PATH" \
    timeout "$1" bash "$W/lobby-tv" > "$W/tv.out" 2>&1
}
tv_run 2 standby
C="$(cat "$W/cec.log")"
has "a TV in standby is turned on" "$C" "--to 0 --image-view-on"
has "and switched to this Pi's input" "$C" "--to 15 --active-source phys-addr=1.0.0.0"
ok "the input is switched once, not every check" "$(grep -c active-source "$W/cec.log")" "1"
has "it says what it did" "$(cat "$W/tv.out")" "TV is standby; turning it on"
ok "and reports the TV's state for the console (on, once woken)" "$(cat "$W/tvstate")" "on"
tv_run 2 on
ok "a TV that's already on isn't sent 'turn on'" "$(grep -c image-view-on "$W/cec.log")" "0"
has "but is switched to this Pi once" "$(cat "$W/cec.log")" "active-source"
( sleep 1; echo standby > "$W/tv" ) & tv_run 2.5 on
ok "a TV that goes off later is turned back on" "$(grep -c image-view-on "$W/cec.log")" "1"
ok "and switched back to this Pi" "$(grep -c active-source "$W/cec.log")" "2"
CECLOG="$W/cec.log" LOBBY_TV_STATE="$W/tvstate" LOBBY_CEC_DEV="$W/no-such-cec" PATH="$W/bin:$PATH" timeout 1 bash "$W/lobby-tv" > "$W/tv.out" 2>&1
has "no CEC device: says so and does nothing" "$(cat "$W/tv.out")" "not controlling the TV"
ok "and reports that to the console" "$(cat "$W/tvstate")" "no-cec"
printf '#!/usr/bin/env bash\nshift 2; exit 0\n' > "$W/bin/cec-ctl.silent"
cp "$W/bin/cec-ctl" "$W/bin/cec-ctl.keep"; cp "$W/bin/cec-ctl.silent" "$W/bin/cec-ctl"
tv_run 1 standby
ok "a TV that doesn't answer is reported as not answering" "$(cat "$W/tvstate")" "not-answering"
cp "$W/bin/cec-ctl.keep" "$W/bin/cec-ctl"

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

# ── a quiet start ──
awk '/^# A quiet start/{f=1} f{print} /^# \(end of the quiet start\)/{exit}' "$SETUP" > "$W/quiet.sh"
printf 'console=serial0,115200 console=tty1 root=PARTUUID=abc rootfstype=ext4 fsck.repair=yes rootwait quiet splash plymouth.ignore-serial-consoles cfg80211.ieee80211_regdom=US video=HDMI-A-1:1920x1080@60D\n' > "$W/cmdline.txt"
printf '[all]\ndtoverlay=vc4-kms-v3d\n' > "$W/config.txt"
quiet() { CMDLINE="$W/cmdline.txt" LOBBY_CONFIG_TXT="$W/config.txt" bash -c "source '$W/quiet.sh'" >/dev/null; }
quiet
C="$(cat "$W/cmdline.txt")"
ok "the Raspberry Pi logo splash is off" "$(grep -cE '(^| )splash( |$)' "$W/cmdline.txt")" "0"
has "the rest of the boot line is untouched" "$C" "rootwait quiet plymouth.ignore-serial-consoles cfg80211.ieee80211_regdom=US video=HDMI-A-1:1920x1080@60D"
has "no boot text, logo or blinking cursor" "$C" "loglevel=3 logo.nologo vt.global_cursor_default=0"
ok "'quiet' isn't added twice" "$(grep -o ' quiet' "$W/cmdline.txt" | wc -l)" "1"
ok "no rainbow square" "$(grep -c '^disable_splash=1' "$W/config.txt")" "1"
quiet; ok "running setup again changes nothing" "$(cat "$W/cmdline.txt")|$(grep -c disable_splash "$W/config.txt")" "$C|1"
ok "still one line" "$(wc -l < "$W/cmdline.txt")" "1"
has "the desktop behind the browser is lobby-background (the start-up picture, or black)" "$(grep -F 'labwc/autostart' "$SETUP")" "/usr/local/bin/lobby-background >/dev/null 2>&1 &"


# ── the case button and status light ──
awk '/^# The case button and status light: the kernel/{f=1} f{print} /^# \(end of the case button lines\)/{exit}' "$SETUP" > "$W/button.sh"
printf '[all]\ndtoverlay=vc4-kms-v3d\n' > "$W/bconfig.txt"
btn() { LOBBY_CONFIG_TXT="$W/bconfig.txt" CONFIG_TXT="$W/bconfig.txt" BUTTON="$1" LED_GPIO="$2" bash -c "source '$W/button.sh'" >/dev/null; }
btn 1 17; btn 1 17
ok "the button and light go in the boot config once, however often setup runs" "$(grep -c '^dtoverlay=gpio-key,gpio=3,active_low=1,gpio_pull=up,keycode=148' "$W/bconfig.txt")|$(grep -c '^dtoverlay=gpio-led,gpio=17,label=lobby-status' "$W/bconfig.txt")" "1|1"
has "the rest of the boot config is untouched" "$(cat "$W/bconfig.txt")" "dtoverlay=vc4-kms-v3d"
btn 1 22; ok "a new --led-gpio replaces the old light" "$(grep -c 'gpio-led,gpio=17' "$W/bconfig.txt")|$(grep -c 'gpio-led,gpio=22' "$W/bconfig.txt")" "0|1"
btn 1 none; ok "--led-gpio none: the button without a light" "$(grep -c gpio-led "$W/bconfig.txt")|$(grep -c gpio-key "$W/bconfig.txt")" "0|1"
btn 0 17; ok "--no-button takes both out again" "$(grep -c 'lobby-button\|gpio-key\|gpio-led' "$W/bconfig.txt")" "0"
has "--led-gpio 3 is refused (that's the button)" "$(setup --led-gpio 3)" "must be a GPIO number"
has "--help lists --no-button and --led-gpio" "$(bash "$SETUP" --help)" "--led-gpio N|none"
has "Update Pi keeps the button and light settings" "$(grep -F "printf '%s=%q" "$SETUP")" "TV BUTTON LED_GPIO"
has "the button's service restarts it if it stops" "$(sed -n '/lobby-button.service <</,/^UNIT$/p' "$SETUP")" "Restart=always"
awk "/^cat > \/usr\/local\/sbin\/lobby-button <<'BUTTON'\$/{f=1;next} /^BUTTON\$/{f=0} f" "$SETUP" > "$W/lobby-button.py"
python3 -c "import ast; ast.parse(open('$W/lobby-button.py').read())" 2>/dev/null && { echo "  ok  lobby-button is valid Python"; pass=$((pass+1)); } || { echo "  FAIL lobby-button doesn't parse"; fail=$((fail+1)); }

# Every browser the kiosk starts skips the desktop's password keyring, or it asks for a keyring password on screen
ok "all three kiosk browsers (the directory, the Wi-Fi setup page and the start-up animation) skip the keyring prompt" \
  "$(grep -c -- '--password-store=basic' "$SETUP")" "3"

# ── field Wi-Fi setup (lobby-wifi-setup): the hotspot + picker a never-online Pi offers ──
has "the sudoers rule is scoped to exactly this script, for the desktop user, no password" "$(sed -n '/^cat > \/etc\/sudoers.d\/lobby-wifi-setup/,/^SUDOERS$/p' "$SETUP")" 'NOPASSWD: /usr/local/sbin/lobby-wifi-setup'
has "the sudoers file is checked with visudo before being trusted" "$(cat "$SETUP")" "visudo -cf /etc/sudoers.d/lobby-wifi-setup"
has "it's installed read-only (0440), like a real sudoers drop-in" "$(cat "$SETUP")" "chmod 440 /etc/sudoers.d/lobby-wifi-setup"

awk "/^cat > \/usr\/local\/sbin\/lobby-wifi-setup <<'WIFISETUP'\$/{f=1;next} /^WIFISETUP\$/{f=0} f" "$SETUP" > "$W/lobby-wifi-setup.py"
python3 -c "import ast; ast.parse(open('$W/lobby-wifi-setup.py').read())" && echo "  ok  lobby-wifi-setup is valid Python" && pass=$((pass+1)) || { echo "  FAIL lobby-wifi-setup doesn't parse"; fail=$((fail+1)); }

cat > "$W/bin/nmcli" <<'S'
#!/usr/bin/env bash
echo "nmcli $*" >> "$NMLOG"
case "$*" in
  "device wifi hotspot con-name lobby-setup-ap ssid Directory-Setup-1234 password "*) [[ "${HOTSPOT_RC:-0}" == 0 ]] && touch "$AP_FLAG"; exit "${HOTSPOT_RC:-0}" ;;
  "connection down lobby-setup-ap"|"connection delete lobby-setup-ap") rm -f "$AP_FLAG"; exit 0 ;;
  "-t -f NAME connection show --active") [[ -f "$AP_FLAG" ]] && echo lobby-setup-ap; exit 0 ;;
  "-t -f NAME connection show") echo "lobby-wifi-1"; [[ -f "$AP_FLAG" ]] && echo lobby-setup-ap; [[ -f "$W_PROFILE" ]] && cat "$W_PROFILE"; exit 0 ;;
  "connection delete id "*) [[ "${*#connection delete id }" == "$(cat "$W_PROFILE" 2>/dev/null)" ]] && rm -f "$W_PROFILE"; exit 0 ;;
  "device wifi rescan") exit 0 ;;
  "-t -f SSID,SECURITY,SIGNAL device wifi list")
    if [[ -f "${SCAN_ONCE:-/nonexistent}" ]]; then rm -f "$SCAN_ONCE"; elif [[ -f "${SCAN_EMPTY:-/nonexistent}" ]]; then exit 0; fi
    printf 'Strong:WPA2:70\nWeak:WPA2:20\nOpenNet::40\nStrong:WPA2:70\nDirectory-Setup-1234:WPA2:99\nLobby\\:East:WPA2:10\n'; exit 0 ;;
  "device wifi connect BadNet"*) rm -f "$AP_FLAG"; echo BadNet > "$W_PROFILE"; echo "Error: Connection activation failed: Secrets were required, but not provided." >&2; exit 4 ;;
  "-g IP4.ADDRESS connection show lobby-setup-ap") echo "10.42.0.1/24" ;;
  "device wifi connect GoodNet password rightpass") rm -f "$AP_FLAG"; echo GoodNet > "$W_PROFILE"; exit 0 ;;
  "device wifi connect OpenNet") rm -f "$AP_FLAG"; echo OpenNet > "$W_PROFILE"; exit 0 ;;
esac
exit 0
S
cat > "$W/bin/curl" <<'S'
#!/usr/bin/env bash
[[ -f "$SITE_UP_FLAG" ]] && exit 0 || exit 7
S
chmod +x "$W/bin/nmcli" "$W/bin/curl"

NMLOG="$W/wifisetup-nm.log"
wifisetup_run() {
  # Starts lobby-wifi-setup in the background, waits for it to listen, runs "$@" against it, then stops it and
  # waits for it to actually exit (the port must be free before the next case starts).
  : > "$NMLOG"
  rm -f "$W/ap-up" "$W/profile"
  ( PATH="$W/bin:$PATH" NMLOG="$NMLOG" AP_FLAG="$W/ap-up" W_PROFILE="$W/profile" LOBBY_HOTSPOT_CHECK="${CHECK_S:-0.3}" SITE_UP_FLAG="$SITE_UP_FLAG" LOBBY_STATUS_FILE="$W/lstatus" LOBBY_SETUP_CODE_FILE="$W/setup-code" SCAN_ONCE="$W/scan-once" SCAN_EMPTY="$W/scan-empty" LOBBY_WIFI_SETUP_TRIES="${TRIES:-2}" LOBBY_WIFI_SETUP_SLEEP="${SLEEP_S:-0.2}" LOBBY_WIFI_SETUP_RECORD="$W/wifi-setup.json" LOBBY_WIFI_SETUP_LINGER=0.5 \
      timeout 40 python3 "$W/lobby-wifi-setup.py" 10000000abcd1234 "http://x.test/site" > "$W/wifisetup.out" 2>&1 & echo $! > "$W/wifisetup.pid" )
  for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:80/ 2>/dev/null && break; sleep 0.2; done
  "$@"
  kill -TERM "$(cat "$W/wifisetup.pid")" 2>/dev/null
  for _ in $(seq 1 30); do kill -0 "$(cat "$W/wifisetup.pid")" 2>/dev/null || break; sleep 0.2; done
}
SITE_UP_FLAG="$W/site-up"; rm -f "$SITE_UP_FLAG"
# DP-10 round 16b: Connect answers at once ("Trying…") and the try runs on its own; the page that comes back says how
# it went. post_wait sends the form, waits for the try to end, then prints the page a phone would see on its return.
post_wait() {
  curl -s -X POST -d "$1" http://127.0.0.1:80/connect > "$W/post-first.html"
  for _ in $(seq 1 60); do curl -s http://127.0.0.1:80/status 2>/dev/null | grep -q '"state": "trying"' || break; sleep 0.2; done
  curl -s http://127.0.0.1:80/ || true
}

rm -f "$W/wifisetup.out"; wifisetup_run true
has "it brings up a hotspot named after the Pi's own serial" "$(cat "$NMLOG")" "device wifi hotspot con-name lobby-setup-ap ssid Directory-Setup-1234"
ok "the hotspot password is a TV-readable 8-digit code" "$(grep -oE 'password [0-9]{8}$' "$NMLOG" | grep -c .)" "1"
ok "it clears any hotspot left over from an earlier attempt before starting its own" \
  "$(grep -nE 'connection delete lobby-setup-ap|device wifi hotspot' "$NMLOG" | head -2 | cut -d: -f2 | cut -c1-36 | tr '\n' '|')" \
  "nmcli connection delete lobby-setup-|nmcli device wifi hotspot con-name l|"
ok "and tears the hotspot down again once it's done" "$(tail -2 "$NMLOG" | tr '\n' '|')" "nmcli connection down lobby-setup-ap|nmcli connection delete lobby-setup-ap|"

PAGE="$(wifisetup_run curl -s http://127.0.0.1:80/)"
has "the picker lists nearby networks, strongest first (a name with a colon in it intact)" "$PAGE" "<option value=\"Strong\">Strong (locked, 70%)</option><option value=\"OpenNet\">OpenNet (open, 40%)</option><option value=\"Weak\">Weak (locked, 20%)</option><option value=\"Lobby:East\">Lobby:East (locked, 10%)</option>"
ok "a network seen twice in a scan is listed once" "$(grep -c 'value=\"Strong\"' <<<"$PAGE")" "1"
ok "the hotspot's own network never appears as something to join" "$(grep -c 'value=\"Directory-Setup-1234\"' <<<"$PAGE")" "0"
has "the hotspot name and its code are shown for a phone to join" "$PAGE" "join the Wi-Fi network <b>Directory-Setup-1234</b> with the code"

ERR="$(TRIES=1 SLEEP_S=0.1 wifisetup_run post_wait 'ssid=BadNet&password=x')"
FIRST="$(cat "$W/post-first.html")"
has "Connect answers straight away, before the hotspot drops (16b)" "$FIRST" "Trying BadNet…"
has "and says the setup network drops while it tries" "$FIRST" "This setup network drops while the screen tries"
has "a network that refuses the password says so, large, at the top of the page that comes back" "$ERR" '<div class="result failed" role="alert"><b>BadNet didn'"'"'t work.</b>'
has "and the form is still there to retry" "$ERR" "<form method=\"post\""

ERR2="$(TRIES=1 SLEEP_S=0.1 wifisetup_run post_wait 'ssid=GoodNet&password=rightpass')"
has "joining but still not reaching the site is reported, not silently retried forever" "$ERR2" "can't reach the directory site"

touch "$SITE_UP_FLAG"
OK1="$(TRIES=2 SLEEP_S=0.1 wifisetup_run bash -c "curl -s -X POST -d 'ssid=OpenNet&password=' http://127.0.0.1:80/connect >/dev/null; for i in \$(seq 1 40); do curl -s http://127.0.0.1:80/status | grep -q '\"ok\"' && break; sleep 0.1; done; curl -s http://127.0.0.1:80/")"
has "an open network needs no password, and the TV's page says Connected" "$OK1" "<b>Connected to OpenNet.</b>"
rm -f "$SITE_UP_FLAG"

: > "$NMLOG"
wifisetup_run post_wait 'ssid=Strong&hidden_ssid=HiddenNet&password=secretpw' >/dev/null
has "a typed hidden-network name wins over the dropdown selection" "$(cat "$NMLOG")" "device wifi connect HiddenNet password secretpw"

DURING="$(wifisetup_run bash -c "cut -d' ' -f1 '$W/lstatus'")"
ok "while it runs, the case light is told: Wi-Fi setup" "$DURING" "setup"
ok "and afterwards: offline, until the agent's next check-in says online" "$(cut -d' ' -f1 "$W/lstatus")" "offline"
# The code stays the same for a Pi, so a phone that joined before still has the right one
rm -f "$W/setup-code"; wifisetup_run true; C1="$(grep -oE 'password [0-9]{8}$' "$NMLOG")"
wifisetup_run true; C2="$(grep -oE 'password [0-9]{8}$' "$NMLOG")"
ok "the hotspot keeps the same code from one run to the next" "$([[ -n "$C1" && "$C1" == "$C2" ]] && echo same || echo "$C1 / $C2")" "same"
ok "and it's kept where only root can read it" "$(stat -c %a "$W/setup-code")" "600"
# The first scan is taken before the hotspot starts; a page whose own scan comes up empty shows that one
touch "$W/scan-once"; FALLBACK="$(wifisetup_run curl -s http://127.0.0.1:80/)"
has "a scan that comes up empty while hosting falls back to the one from before the hotspot" "$FALLBACK" '<option value="Strong">'
touch "$W/scan-empty"; EMPTY="$(wifisetup_run curl -s http://127.0.0.1:80/)"; rm -f "$W/scan-empty"
has "nothing found at all: it says so" "$EMPTY" "No networks found yet"
has "and the page searches again by itself" "$EMPTY" '<meta http-equiv="refresh" content="15">'
has "a Search again link is always there" "$PAGE" '<a href="/"'
# A phone joining the hotspot checks a known address (Apple, Google): it gets the setup page and opens it by itself
SIGNIN="$(wifisetup_run bash -c "curl -s -H 'Host: captive.apple.com' http://127.0.0.1:80/hotspot-detect.html; printf '|'; curl -s -o /dev/null -w '%{http_code}' -H 'Host: connectivitycheck.gstatic.com' http://127.0.0.1:80/generate_204")"
has "an iPhone's online check gets the setup page" "$SIGNIN" "This screen needs Wi-Fi"
has "an Android phone's check gets a page, not the 204 that would mean 'online'" "$SIGNIN" "|200"
has "the page says where it is, for a phone that doesn't open it by itself" "$PAGE" "open <b>http://10.42.0.1</b>"
has "the hotspot answers every name with the Pi (setup hotspot only)" "$(grep -A1 'mkdir -p /etc/NetworkManager/dnsmasq-shared.d' "$SETUP")" "address=/#/10.42.0.1"
: > "$NMLOG"
LOCKED="$(wifisetup_run bash -c "curl -s http://127.0.0.1:80/ >/dev/null; curl -s -X POST -d 'ssid=Strong&password=' http://127.0.0.1:80/connect")"
has "and the network stays chosen" "$LOCKED" '<option value="Strong" selected>'

has "a locked network with no password says it needs one" "$LOCKED" "Strong needs its password"
ok "and doesn't even try to join it" "$(grep -c 'device wifi connect Strong' "$NMLOG")" "0"
has "a refused password is said plainly, not as nmcli's message" "$ERR" "BadNet refused that password"


# ── DP-05: the hotspot is kept up, and a join that didn't work is undone ──
: > "$NMLOG"
wifisetup_run bash -c "sleep 0.8; rm -f '$W/ap-up'; sleep 1.5"
N_AP="$(grep -c 'device wifi hotspot con-name lobby-setup-ap' "$NMLOG")"
ok "a hotspot that disappears (as after a phone typed a wrong code) is started again within seconds" "$([[ $N_AP -ge 2 ]] && echo again || echo "$N_AP")" "again"
has "and the kiosk log says so" "$(cat "$W/wifisetup.out")" "the setup hotspot was down; starting it again"
ok "a hotspot that stays up is left alone" "$( : > "$NMLOG"; wifisetup_run sleep 1.5; grep -c 'device wifi hotspot' "$NMLOG")" "1"
: > "$NMLOG"
ERR3="$(TRIES=1 SLEEP_S=0.1 wifisetup_run post_wait 'ssid=BadNet&password=wrongpass')"
has "a refused password still says so" "$ERR3" "BadNet refused that password"
has "the profile the failed join saved is deleted (a saved wrong password makes NetworkManager ask again later)" "$(cat "$NMLOG")" "connection delete id BadNet"
ok "and the hotspot is back straight away, so the phone can try again" \
  "$(sed -n '/device wifi connect BadNet/,$p' "$NMLOG" | grep -c 'device wifi hotspot con-name lobby-setup-ap')" "1"
has "the card's own networks are never deleted" "$(grep -c 'connection delete id lobby-wifi-1' "$NMLOG")" "0"
: > "$NMLOG"
ERR4="$(TRIES=1 SLEEP_S=0.1 wifisetup_run post_wait 'ssid=GoodNet&password=rightpass')"
has "joined but no site: the new profile is removed and the hotspot comes back too" "$(cat "$NMLOG")" "connection delete id GoodNet"
touch "$SITE_UP_FLAG"; : > "$NMLOG"
TRIES=2 SLEEP_S=0.1 wifisetup_run bash -c "curl -s -X POST -d 'ssid=OpenNet&password=' http://127.0.0.1:80/connect >/dev/null; sleep 1.2"
rm -f "$SITE_UP_FLAG"
ok "after a join that worked, the hotspot is never brought back to take the radio" \
  "$(sed -n '/device wifi connect OpenNet/,$p' "$NMLOG" | grep -c 'device wifi hotspot')" "0"
has "and the joined network is kept" "$(grep -c 'connection delete id OpenNet' "$NMLOG")" "0"

# ── DP-10 round 16b: the chosen network is kept, and every try is recorded ──
rm -f "$W/wifi-setup.json"; : > "$NMLOG"
KEPT="$(TRIES=1 SLEEP_S=0.1 wifisetup_run bash -c "curl -s -X POST -d 'ssid=Weak&password=wrongpw' http://127.0.0.1:80/connect >/dev/null; for i in \$(seq 1 60); do curl -s http://127.0.0.1:80/status | grep -q trying || break; sleep 0.2; done; curl -s -H 'Host: captive.apple.com' http://127.0.0.1:80/hotspot-detect.html")"
has "the phone's page after a failed try (what the tech saw) keeps that network chosen, not the top one" "$KEPT" '<option value="Weak" selected>'
ok "and only that one" "$(grep -c ' selected>' <<<"$KEPT")" "1"
has "it says why, at the top" "$KEPT" '<b>Weak didn'"'"'t work.</b>'
has "and that the network is still chosen" "$KEPT" "Weak is still chosen below"
has "and the kiosk log says each try" "$(cat "$W/wifisetup.out")" "field Wi-Fi setup: 'Weak' didn't work: Joined, but can't reach the directory site from there."
ok "the password box comes back empty (never sent back to a phone)" "$(grep -c 'wrongpw' <<<"$KEPT")" "0"
HID="$(TRIES=1 SLEEP_S=0.1 wifisetup_run post_wait 'ssid=Strong&hidden_ssid=BadNet&password=x')"
has "a hidden network that failed stays typed in its box" "$HID" 'name="hidden_ssid" autocapitalize="off" autocorrect="off" value="BadNet"'
ST="$(TRIES=1 SLEEP_S=0.1 wifisetup_run bash -c "curl -s http://127.0.0.1:80/status; curl -s -X POST -d 'ssid=BadNet&password=x' http://127.0.0.1:80/connect >/dev/null; curl -s http://127.0.0.1:80/status")"
has "the page can ask how a try is going (the TV's page reloads itself when it ends)" "$ST" '{"state": "idle", "stamp": 0}{"state": "trying", "stamp": 1}'
has "and the page carries the check" "$KEPT" 'fetch("/status"'
REC="$(cat "$W/wifi-setup.json" 2>/dev/null)"
has "every try is kept on the Pi for the console: network, worked or not, why" "$REC" '"ssid": "BadNet", "ok": false, "why": "BadNet refused that password. Check it and try again."'
ok "the last five only" "$(python3 -c "import json;print(len(json.load(open('$W/wifi-setup.json'))['tries']))")" "3"
ok "never the password" "$(grep -c 'wrongpw\|\"x\"' "$W/wifi-setup.json")" "0"
: > "$NMLOG"
wifisetup_run bash -c "for i in 1 2 3 4 5 6; do curl -s http://127.0.0.1:80/ >/dev/null; done"
ok "the page checking every few seconds doesn't rescan the radio each time" "$(grep -c 'device wifi rescan' "$NMLOG")" "1"
ESC="$(cd "$W" && python3 - <<PY
import importlib.util, sys
sys.argv = ["x", "10000000abcd1234", "http://x.test"]
spec = importlib.util.spec_from_file_location("ws", "$W/lobby-wifi-setup.py"); ws = importlib.util.module_from_spec(spec)
import os; os.environ["LOBBY_SETUP_CODE_FILE"] = "$W/setup-code"
spec.loader.exec_module(ws)
ws.scan_networks = lambda fresh=False: [{"ssid": 'Say "hi" <b>', "open": False, "signal": "30"}]
ws.set_try(state="failed", ssid='Say "hi" <b>', why="x <i>", hidden=False, at=0)
print(ws.render().decode())
PY
)"
has "a network name with quotes or brackets can't break the page (escaped)" "$ESC" '<option value="Say &quot;hi&quot; &lt;b&gt;" selected>'
ok "nor the message" "$(grep -c '<i>' <<<"$ESC")" "0"

# ── DP-05: no desktop pop-ups on a lobby screen ──
KS="$(sed -n "/^cat > \"\$KDIR\/kiosk.sh\" <<'EOF'\$/,/^EOF\$/p" "$SETUP")"
has "kiosk.sh stops the desktop panel's respawner (lwrespawn) first" "$KS" "pkill -u \"\$(id -u)\" -f '^/bin/sh /usr/bin/lwrespawn /usr/bin/(wf-panel-pi|pcmanfm-pi)'"
has "and keeps it stopped every 10 seconds" "$KS" 'while sleep "${KIOSK_QUIET_SECONDS:-10}"; do kill -0 $$ 2>/dev/null || exit 0; quiet_desktop; done'
cp "$(command -v sleep)" "$W/wf-panel-pi"; cp "$(command -v sleep)" "$W/pcmanfm-pi"; cp "$(command -v sleep)" "$W/chromium"
"$W/wf-panel-pi" 30 & P1=$!; "$W/pcmanfm-pi" 30 & P2=$!; "$W/chromium" 30 & P3=$!
QD="$(awk '/^quiet_desktop\(\) \{$/{f=1} f; f&&/^\}$/{exit}' <<<"$KS")"
bash -c "$QD"$'\n'"quiet_desktop" >/dev/null; sleep 0.3
ok "the panel and the desktop's file manager are stopped" "$(kill -0 $P1 2>/dev/null; echo $?)$(kill -0 $P2 2>/dev/null; echo $?)" "11"
ok "the browser and everything else are left alone" "$(kill -0 $P3 2>/dev/null && echo running)" "running"
kill $P3 2>/dev/null; wait 2>/dev/null
AUTO="$(sed -n '/^mkdir -p "$KHOME\/.config\/autostart"/,/^done$/p' "$SETUP")"
has "the polkit password prompts and pprompt are switched off for the desktop user (Hidden=true)" "$AUTO" 'for a in polkit-mate-authentication-agent-1 lxpolkit pprompt; do'
has "in the standard way" "$AUTO" 'Hidden=true'

# ── DP-07 round 9: the start-up picture ──
PNG=public/pi/startup.png
ok "the site serves a start-up picture that's a real PNG" "$(head -c 8 "$PNG" | od -An -tx1 | tr -d ' \n')" "89504e470d0a1a0a"
ok "and under setup's 5 MB limit" "$(( $(stat -c %s "$PNG") <= 5242880 ))" "1"
ok "setup fetches it before the Wi-Fi is touched (saving Wi-Fi can drop the network)" \
  "$(( $(grep -n 'pi/startup.png' "$SETUP" | head -1 | cut -d: -f1) < $(grep -n '/usr/local/sbin/lobby-wifi-import "$NETS"' "$SETUP" | cut -d: -f1) ))" "1"
has "a failed download isn't fatal" "$(grep -F 'pi/startup.png' "$SETUP")" '-o "$STARTUP_PNG"; then : > "$STARTUP_PNG"; fi'
INST="$(sed -n '/^STARTUP_DIR=\/usr\/local\/share\/lobby$/,/^rm -f "\$STARTUP_PNG"$/p' "$SETUP" | sed "s|^STARTUP_DIR=.*|STARTUP_DIR=\"$W/share\"|")"
inst() { cp "$1" "$W/dl"; STARTUP_PNG="$W/dl" bash -c "$INST" 2>&1; }
O="$(inst "$PNG")"
ok "a good picture is installed" "$(cmp -s "$PNG" "$W/share/startup.png" && echo same)" "same"
has "and setup says so" "$O" "start-up picture installed"
printf '<html>404 Not Found</html>' > "$W/notpng"
O="$(inst "$W/notpng")"
ok "a download that isn't a PNG (an error page) never replaces it" "$(cmp -s "$PNG" "$W/share/startup.png" && echo same)" "same"
has "and the Pi keeps the one it has" "$O" "keeping the one this Pi has"
{ head -c 8 "$PNG"; head -c 6000000 /dev/zero; } > "$W/big"
inst "$W/big" >/dev/null
ok "nor does one over 5 MB" "$(cmp -s "$PNG" "$W/share/startup.png" && echo same)" "same"
rm -rf "$W/share"; : > "$W/empty"
has "with no picture at all, the background stays black" "$(inst "$W/empty")" "stays black"
ok "the bench's clean-up (--prepare) leaves the picture on the card" "$(sed -n '/Clearing everything that belongs to this bench Pi/,/^fi$/p' "$SETUP" | grep -c 'share/lobby')" "0"
awk "/^cat > \/usr\/local\/bin\/lobby-background <<'BACKGROUND'\$/{f=1;next} /^BACKGROUND\$/{f=0} f" "$SETUP" > "$W/lobby-background"
mkdir -p "$W/sbg"
cat > "$W/sbg/swaybg" <<'S'
#!/usr/bin/env bash
echo "$*" >> "$SBLOG"
case "$*" in *" -i "*) [[ -n "${SB_FAIL:-}" ]] && exit 1 ;; esac
exit 0
S
chmod +x "$W/sbg/swaybg"
bg() { : > "$W/sb.log"; SBLOG="$W/sb.log" PATH="$W/sbg:$PATH" LOBBY_STARTUP_PNG="$1" SB_FAIL="${2:-}" LOBBY_STARTUP_ANIM="${3:-$W/no-anim.html}" sh "$W/lobby-background"; cat "$W/sb.log"; }
ok "with a picture it's fitted and centred on black (centred in portrait too)" "$(bg "$PNG")" "-c #000000 -i $PNG -m fit"
ok "without one, plain black" "$(bg "$W/none.png")" "-c #000000"
ok "if swaybg can't show the picture, it falls back to plain black at once" "$(bg "$PNG" fail | tail -1)" "-c #000000"

# ── DP-07 round 9c: the start-up animation ──
A=public/pi/startup
ok "the site serves the animation's two pictures as real PNGs" \
  "$(for f in road mark; do head -c 8 "$A/$f.png" | od -An -tx1 | tr -d ' \n'; echo; done | sort -u)" "89504e470d0a1a0a"
ok "and a page that's ours, with its font inside it (no network needed)" "$(grep -q 'waytugo start-up animation' "$A/startup.html" && echo ours) $(grep -c 'data:font/ttf;base64' "$A/startup.html")" "ours 1"
ok "the page is under setup's 1 MB limit" "$(( $(stat -c %s "$A/startup.html") <= 1048576 ))" "1"
ok "setup fetches it before the Wi-Fi is touched" \
  "$(( $(grep -n 'pi/startup/\$f' "$SETUP" | head -1 | cut -d: -f1) < $(grep -n '/usr/local/sbin/lobby-wifi-import "$NETS"' "$SETUP" | cut -d: -f1) ))" "1"
AN="$(sed -n '/^png_ok() {/,/^rm -rf "\$STARTUP_ANIM"$/p' "$SETUP")"
anim() { rm -rf "$W/dl"; mkdir -p "$W/dl"; cp "$@" "$W/dl/" 2>/dev/null; STARTUP_ANIM="$W/dl" STARTUP_DIR="$W/share" bash -c "$AN" 2>&1; }
rm -rf "$W/share"; mkdir -p "$W/share"
has "a good animation is installed whole" "$(anim "$A/startup.html" "$A/road.png" "$A/mark.png")" "start-up animation installed"
ok "all three files" "$(ls "$W/share/startup" | tr '\n' ' ')" "mark.png road.png startup.html "
cp "$W/notpng" "$W/road.png"
has "one bad picture (an error page) and nothing is replaced" "$(anim "$A/startup.html" "$W/road.png" "$A/mark.png")" "keeping the one this Pi has"
ok "the installed one is untouched" "$(cmp -s "$A/road.png" "$W/share/startup/road.png" && echo same)" "same"
echo '<html>something else</html>' > "$W/startup.html"
has "a page that isn't ours is refused" "$(anim "$W/startup.html" "$A/road.png" "$A/mark.png")" "keeping the one this Pi has"
rm -rf "$W/share"; mkdir -p "$W/share"
has "a failed download (some files missing) leaves a Pi without one on the still picture" "$(anim "$A/startup.html")" "the still picture is used"
ok "with the animation installed, the desktop behind it is plain black (it sweeps in from black)" "$(bg "$PNG" "" "$A/startup.html")" "-c #000000"
ok "the bench's clean-up (--prepare) clears the animation's browser data, keeps the animation" \
  "$(grep -c 'startup-profile' <<<"$(sed -n '/Clearing everything that belongs to this bench Pi/,/^fi$/p' "$SETUP")")|$(sed -n '/Clearing everything that belongs to this bench Pi/,/^fi$/p' "$SETUP" | grep -c 'share/lobby')" "1|0"

echo; echo "$pass/$((pass+fail)) passed"; [[ $fail -eq 0 ]]
