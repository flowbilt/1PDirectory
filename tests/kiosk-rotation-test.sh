#!/usr/bin/env bash
# Checks the Pi's automatic rotation: runs the real kiosk.sh (taken out of public/pi/setup-kiosk.sh) against the
# local test server, with the TV, the browser and the screen-rotation tool replaced by stand-ins.
# Run from the project folder:  bash tests/kiosk-rotation-test.sh
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=8897; BASE="http://localhost:$PORT"
WORK="$(mktemp -d)"; trap 'kill $SRV 2>/dev/null; rm -rf "$WORK"' EXIT
node --import ./tests/register-stub.mjs tests/test-server.mjs $PORT >"$WORK/server.log" 2>&1 & SRV=$!
for _ in $(seq 1 30); do curl -fsS -o /dev/null "$BASE/login.html" 2>/dev/null && break; sleep 0.2; done

# The same URL -> lookup rule setup-kiosk.sh uses
LOOKUP_RULE="$(grep -m1 '^LOOKUP=' public/pi/setup-kiosk.sh)"
sed -n '/cat > "\$KDIR\/kiosk.sh" <<.EOF./,/^EOF$/p' public/pi/setup-kiosk.sh | sed '1d;$d' > "$WORK/kiosk.sh"

# Stand-ins: wlr-randr lists one HDMI output and records what it was told; chromium records its address and
# then stops the kiosk loop (the real one would run until the Pi reboots).
mkdir -p "$WORK/bin"
cat > "$WORK/bin/wlr-randr" <<'S'
#!/usr/bin/env bash
if [[ $# -eq 0 ]]; then echo 'HDMI-A-1 "Test TV"'; else echo "$*" >> "$HOME/wlr.log"; fi
S
cat > "$WORK/bin/chromium" <<'S'
#!/usr/bin/env bash
kill -TERM "$PPID"
S
chmod +x "$WORK/bin/"*

pass=0; fail=0
check() { # name url rotate-setting expected [rotation.last before] [site reachable: yes|no]
  local name="$1" url="$2" setting="$3" want="$4" last="${5:-}" up="${6:-yes}"
  local H="$WORK/home-$pass-$fail"; mkdir -p "$H/kiosk"
  [[ -n "$last" ]] && echo "$last" > "$H/kiosk/rotation.last"
  local URL="$url"; eval "$LOOKUP_RULE"
  [[ "$up" == "no" ]] && LOOKUP="http://localhost:1/unreachable"
  printf 'URL="%s"\nLOOKUP="%s"\nROTATE="%s"\n' "$url" "$LOOKUP" "$setting" > "$H/kiosk/kiosk.conf"
  # The network wait uses the page address; make it quick when testing "no internet"
  [[ "$up" == "no" ]] && sed -i "s#^URL=.*#URL=\"http://localhost:1/\"#" "$H/kiosk/kiosk.conf"
  HOME="$H" WAYLAND_DISPLAY=wayland-0 PATH="$WORK/bin:$PATH" timeout 120 bash "$WORK/kiosk.sh" >/dev/null 2>&1
  local got; got="$(cat "$H/wlr.log" 2>/dev/null)"
  if [[ "$got" == "--output HDMI-A-1 --transform $want" ]]; then echo "  ok  $name"; pass=$((pass+1))
  else echo "  FAIL $name: wanted transform $want, got '$got'"; fail=$((fail+1)); fi
}

check "a landscape Yodeck Pi (PPI 2 South) stays upright"        "$BASE/?device=100000008294ba46" auto normal
check "a portrait Yodeck Pi (Cadence Place) turns to portrait"   "$BASE/?device=10000000a4ae272d" auto 90
check "a brand-new Pi, not assigned yet, stays landscape"        "$BASE/?device=10000000abcdef99" auto normal
check "a fixed address works too (Landmark Center is portrait)"  "$BASE/?site=landmark-center"    auto 90
check "no internet: keeps the last answer"                       "$BASE/?device=10000000a4ae272d" auto 90 90 no
check "no internet and no last answer: landscape"                "$BASE/?device=10000000a4ae272d" auto normal "" no
check "a fixed --rotate 270 overrides the site"                  "$BASE/?device=100000008294ba46" 270 270
echo; echo "$pass/$((pass+fail)) passed"; [[ $fail -eq 0 ]]
