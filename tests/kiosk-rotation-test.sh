#!/usr/bin/env bash
# Checks the Pi's kiosk script: runs the real kiosk.sh (taken out of public/pi/setup-kiosk.sh) against the local test
# server, with the TV, the browser and the screen-rotation tool replaced by stand-ins, and the Pi's serial set per
# case (LOBBY_SERIAL), so a card can be "moved" between Pis.
# Run from the project folder:  bash tests/kiosk-rotation-test.sh
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=8897; BASE="http://localhost:$PORT"
WORK="$(mktemp -d)"; trap 'kill $SRV 2>/dev/null; rm -rf "$WORK"' EXIT
node tests/test-server.mjs $PORT >"$WORK/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 30); do curl -fsS -o /dev/null "$BASE/login.html" 2>/dev/null && break; sleep 0.2; done

sed -n '/cat > "\$KDIR\/kiosk.sh" <<.EOF./,/^EOF$/p' public/pi/setup-kiosk.sh | sed '1d;$d' > "$WORK/kiosk.sh"

# Stand-ins: wlr-randr lists one HDMI output, records what it was told and reports the rotation it has (or forgets
# it, as a TV powering up can, with WLR_FORGET=1); chromium records the address it was given, waits CHROME_WAIT
# seconds, then stops the kiosk loop (the real one would run until the Pi reboots).
mkdir -p "$WORK/bin"
cat > "$WORK/bin/wlr-randr" <<'S'
#!/usr/bin/env bash
if [[ $# -eq 0 ]]; then
  printf 'HDMI-A-1 "Test TV"\n  Enabled: yes\n  Transform: %s\n' "$( [[ -z "${WLR_FORGET:-}" ]] && cat "$HOME/wlr.state" 2>/dev/null || echo normal)"
else
  echo "$*" >> "$HOME/wlr.log"; echo "${@: -1}" > "$HOME/wlr.state"
fi
S
cat > "$WORK/bin/chromium" <<'S'
#!/usr/bin/env bash
for a in "$@"; do [[ "$a" == http* ]] && echo "$a" >> "$HOME/chromium.log"; done
if [[ "$*" == *"http://localhost/"* ]]; then
  exec sleep 1000   # the field-setup echo: stays up until kiosk.sh kills it directly, doesn't drive the main loop
fi
sleep "${CHROME_WAIT:-0}"
kill -TERM "$PPID"
S
cat > "$WORK/bin/lobby-wifi-setup" <<'S'
#!/usr/bin/env bash
echo "wifi-setup called: serial=$1 url=$2" >> "$HOME/wifisetup.log"
# The real one runs until a network is picked (minutes); a moment here lets the setup page's browser start before
# the kiosk closes it, as it always has time to on a Pi (without this the check races on a slow machine)
sleep 1.5
exit "${WIFISETUP_EXIT:-0}"
S
chmod +x "$WORK/bin/"*

pass=0; fail=0
# run HOME SERIAL SITE URL ROTATE: start the kiosk once, as that Pi. Returns what it told wlr-randr and chromium.
run() {
  local H="$1" serial="$2" site="$3" url="$4" setting="$5"
  mkdir -p "$H/kiosk"; rm -f "$H/wlr.log" "$H/chromium.log" "$H/wlr.state" "$H/wifisetup.log"
  printf 'SITE="%s"\nURL="%s"\nROTATE="%s"\n' "$site" "$url" "$setting" > "$H/kiosk/kiosk.conf"
  env ${EXTRA:-} HOME="$H" LOBBY_SERIAL="$serial" WAYLAND_DISPLAY=wayland-0 PATH="$WORK/bin:$PATH" timeout 120 bash "$WORK/kiosk.sh" >/dev/null 2>&1
  GOT_ROT="$(cat "$H/wlr.log" 2>/dev/null)"; GOT_URL="$(cat "$H/chromium.log" 2>/dev/null)"
}
ok() { if [[ "$2" == "$3" ]]; then echo "  ok  $1"; pass=$((pass+1)); else echo "  FAIL $1: wanted '$3', got '$2'"; fail=$((fail+1)); fi; }
T() { echo "--output HDMI-A-1 --on --transform $1"; }
OFF="http://localhost:1"   # a site that can't be reached

H="$WORK/a"; run "$H" 100000008294ba46 "$BASE" "" auto
ok "a landscape Yodeck Pi (PPI 2 South) stays upright" "$GOT_ROT" "$(T normal)"
ok "and opens its own address, built from its serial" "$GOT_URL" "$BASE/?device=100000008294ba46"
H="$WORK/b"; run "$H" 10000000a4ae272d "$BASE" "" auto
ok "a portrait Yodeck Pi (Cadence Place) turns to portrait" "$GOT_ROT" "$(T 90)"
H="$WORK/c"; run "$H" 10000000abcdef99 "$BASE" "" auto
ok "a brand-new Pi, not assigned yet, stays landscape" "$GOT_ROT" "$(T normal)"
H="$WORK/d"; run "$H" 10000000abcdef99 "$BASE" "$BASE/?site=landmark-center" auto
ok "a fixed address works too (Landmark Center is portrait)" "$GOT_ROT" "$(T 90)"
ok "and a fixed address wins over the serial" "$GOT_URL" "$BASE/?site=landmark-center"
H="$WORK/e"; run "$H" 10000000a4ae272d "$BASE" "" auto; run "$H" 10000000a4ae272d "$OFF" "" auto
ok "no internet: keeps the last answer" "$GOT_ROT" "$(T 90)"
H="$WORK/f"; run "$H" 10000000a4ae272d "$OFF" "" auto
ok "no internet and no last answer: landscape" "$GOT_ROT" "$(T normal)"
H="$WORK/g"; run "$H" 100000008294ba46 "$BASE" "" 270
ok "a fixed --rotate 270 overrides the site" "$GOT_ROT" "$(T 270)"
# The same card, moved from Cadence Place's Pi to PPI 2 South's
H="$WORK/h"; run "$H" 10000000a4ae272d "$BASE" "" auto; run "$H" 100000008294ba46 "$BASE" "" auto
ok "a card moved to another Pi opens that Pi's address" "$GOT_URL" "$BASE/?device=100000008294ba46"
ok "and turns the way that Pi's screen is set" "$GOT_ROT" "$(T normal)"
H="$WORK/i"; run "$H" 10000000a4ae272d "$BASE" "" auto; run "$H" 100000008294ba46 "$OFF" "" auto
ok "a moved card with no internet doesn't reuse the other Pi's answer" "$GOT_ROT" "$(T normal)"
# The layouts for a TV mounted the other way round, set in the console
layout() { curl -fsS -o /dev/null -X PATCH "$BASE/sb/rest/v1/screens?key=eq.$1" -H "apikey: test-service-key" \
  -H "Content-Type: application/json" -d "{\"orientation\": \"$2\"}"; }
layout ppi-3n portrait-flipped; H="$WORK/l"; run "$H" 10000000335b04b3 "$BASE" "" auto
ok "Portrait (turned the other way) turns the picture 270 degrees" "$GOT_ROT" "$(T 270)"
layout ppi-4n landscape-flipped; H="$WORK/m"; run "$H" 1000000025b7d4d6 "$BASE" "" auto
ok "Landscape (upside down) turns it 180 degrees" "$GOT_ROT" "$(T 180)"

# The watcher (every second here, 10 in real life) while the browser runs for 4 seconds
H="$WORK/j"; EXTRA="CHROME_WAIT=4 KIOSK_WATCH_SECONDS=1" run "$H" 10000000a4ae272d "$BASE" "" auto
ok "the watcher leaves a correctly turned screen alone" "$GOT_ROT" "$(T 90)"
H="$WORK/k"; EXTRA="CHROME_WAIT=4 KIOSK_WATCH_SECONDS=1 WLR_FORGET=1" run "$H" 10000000a4ae272d "$BASE" "" auto
n="$(grep -c -- "$(T 90)" "$H/wlr.log")"
ok "a TV that resets the screen gets it turned back (and switched on)" "$([[ $n -ge 3 && $(sort -u "$H/wlr.log" | wc -l) -eq 1 ]] && echo yes || echo "no: $n")" "yes"
sleep 2
ok "the watcher stops with the kiosk" "$(pgrep -f "$WORK/kiosk.sh" | wc -l)" "0"

# Field Wi-Fi setup: a Pi that's never reached the site offers it; one that has, doesn't (no surprise hotspot on a
# screen that's just lost its network). KIOSK_NET_TRIES/SLEEP shrink the 90-second wait so these run in seconds.
FAST="LOBBY_WIFI_SETUP=$WORK/bin/lobby-wifi-setup KIOSK_NET_TRIES=2 KIOSK_NET_SLEEP=1"
H="$WORK/n1"; EXTRA="$FAST" run "$H" 10000000fee1dead "$OFF" "" auto
ok "a Pi that's never reached the site, and still can't, tries field Wi-Fi setup" \
  "$(cat "$H/wifisetup.log" 2>/dev/null)" "wifi-setup called: serial=10000000fee1dead url=$OFF/?device=10000000fee1dead"
ok "and shows the setup page on its own screen while it waits" "$(head -1 "$H/chromium.log" 2>/dev/null)" "http://localhost/"
ok "but doesn't mark itself online, since it still can't reach the site" \
  "$([[ -f "$H/kiosk/ever-online-10000000fee1dead" ]] && echo yes || echo no)" "no"
H="$WORK/n2"; EXTRA="$FAST" run "$H" 10000000fee1beef "$BASE" "" auto
ok "a Pi that reaches the site right away never needs field Wi-Fi setup" \
  "$([[ -f "$H/wifisetup.log" ]] && echo called || echo not-called)" "not-called"
ok "and marks itself as having been online" "$([[ -f "$H/kiosk/ever-online-10000000fee1beef" ]] && echo yes || echo no)" "yes"
rm -f "$H/wifisetup.log"; EXTRA="$FAST" run "$H" 10000000fee1beef "$OFF" "" auto   # same Pi, later, network blips
ok "a Pi that's worked before just waits quietly through a blip (no surprise hotspot)" \
  "$([[ -f "$H/wifisetup.log" ]] && echo called || echo not-called)" "not-called"
EXTRA="$FAST" run "$H" 10000000fee1c0de "$OFF" "" auto   # the same card, moved to a Pi it's never been in
ok "the same card moved to a Pi it's new to tries setup again, even though the old Pi had worked" \
  "$(cat "$H/wifisetup.log" 2>/dev/null)" "wifi-setup called: serial=10000000fee1c0de url=$OFF/?device=10000000fee1c0de"

echo; echo "$pass/$((pass+fail)) passed"; [[ $fail -eq 0 ]]
