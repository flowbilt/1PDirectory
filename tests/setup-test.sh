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

echo; echo "$pass/$((pass+fail)) passed"; [[ $fail -eq 0 ]]
