#!/usr/bin/env bash
# Checks the Pi's kiosk script: runs the real kiosk.sh (taken out of public/pi/setup-kiosk.sh) against the local test
# server, with the TV, the browser and the screen-rotation tool replaced by stand-ins, and the Pi's serial set per
# case (LOBBY_SERIAL), so a card can be "moved" between Pis.
# Run from the project folder:  bash tests/kiosk-rotation-test.sh
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=8897; BASE="http://localhost:$PORT"
WORK="$(mktemp -d)"; trap 'kill $SRV 2>/dev/null; rm -rf "$WORK"' EXIT
node --import ./tests/register-stub.mjs tests/test-server.mjs $PORT >"$WORK/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 30); do curl -fsS -o /dev/null "$BASE/login.html" 2>/dev/null && break; sleep 0.2; done

sed -n '/cat > "\$KDIR\/kiosk.sh" <<.EOF./,/^EOF$/p' public/pi/setup-kiosk.sh | sed '1d;$d' > "$WORK/kiosk.sh"

# Stand-ins: wlr-randr lists one HDMI output and records what it was told; chromium records the address it was
# given and then stops the kiosk loop (the real one would run until the Pi reboots).
mkdir -p "$WORK/bin"
cat > "$WORK/bin/wlr-randr" <<'S'
#!/usr/bin/env bash
if [[ $# -eq 0 ]]; then echo 'HDMI-A-1 "Test TV"'; else echo "$*" >> "$HOME/wlr.log"; fi
S
cat > "$WORK/bin/chromium" <<'S'
#!/usr/bin/env bash
for a in "$@"; do [[ "$a" == http* ]] && echo "$a" >> "$HOME/chromium.log"; done
kill -TERM "$PPID"
S
chmod +x "$WORK/bin/"*

pass=0; fail=0
# run HOME SERIAL SITE URL ROTATE: start the kiosk once, as that Pi. Returns what it told wlr-randr and chromium.
run() {
  local H="$1" serial="$2" site="$3" url="$4" setting="$5"
  mkdir -p "$H/kiosk"; rm -f "$H/wlr.log" "$H/chromium.log"
  printf 'SITE="%s"\nURL="%s"\nROTATE="%s"\n' "$site" "$url" "$setting" > "$H/kiosk/kiosk.conf"
  HOME="$H" LOBBY_SERIAL="$serial" WAYLAND_DISPLAY=wayland-0 PATH="$WORK/bin:$PATH" timeout 120 bash "$WORK/kiosk.sh" >/dev/null 2>&1
  GOT_ROT="$(cat "$H/wlr.log" 2>/dev/null)"; GOT_URL="$(cat "$H/chromium.log" 2>/dev/null)"
}
ok() { if [[ "$2" == "$3" ]]; then echo "  ok  $1"; pass=$((pass+1)); else echo "  FAIL $1: wanted '$3', got '$2'"; fail=$((fail+1)); fi; }
T() { echo "--output HDMI-A-1 --transform $1"; }
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
echo; echo "$pass/$((pass+fail)) passed"; [[ $fail -eq 0 ]]
