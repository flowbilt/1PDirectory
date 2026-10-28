#!/usr/bin/env bash
# Runs every numbered SQL file in supabase/ from scratch on a local PostgreSQL 16, with each check file right after
# its file, then every check again at the end, and the newest files a second time (they must be safe to rerun).
# A stand-in for Supabase's roles and auth schema comes first (tests/sql/supabase-standin.sql).
#
#   bash tests/sql-test.sh                 # uses PGHOST/PGPORT/PGUSER from the environment (default: local socket)
#   PGHOST=/path/to/socket PGPORT=5433 bash tests/sql-test.sh
#
# Needs: psql, and a server where PGUSER may create databases (a throwaway database "lobby_sqltest" is made and
# dropped). Ends with "N/N passed" like the other suites. Added in DP-11 (E1a); before that the stand-in was rebuilt
# by hand in each chat.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SQL="$HERE/../supabase"
DB=lobby_sqltest
export PGUSER=${PGUSER:-postgres}
pass=0; total=0
ok()   { pass=$((pass+1)); total=$((total+1)); echo "  ok  $1"; }
bad()  { total=$((total+1)); echo "  FAIL $1"; [ -n "${2:-}" ] && echo "$2" | sed 's/^/       /' | head -8; }

psql -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null 2>&1 || { echo "Can't reach PostgreSQL (PGHOST=${PGHOST:-} PGPORT=${PGPORT:-})"; exit 2; }
psql -X -q -d $DB -v ON_ERROR_STOP=1 -f "$HERE/sql/supabase-standin.sql" >/dev/null 2>&1 && ok "the Supabase stand-in" || { bad "the Supabase stand-in"; exit 1; }

# Which check file follows which numbered file, and what it should read
declare -A CHECK=([04]=agent [05]=tuning [06]=trust [07]=uptime [08]=networks [09]=update [10]=refused [11]=layouts [12]=alerts
  [13]=tech [14]=saved-wifi [15]=logos [16]=remote [17]=hardening [18]=sizes [19]=mail [20]=save-wifi [21]=no-cec [22]=widget-sizes
  [23]=info-panel [24]=directory-to-go [25]=touch [26]=people [27]=new-directory [28]=touch-directory [29]=layout-engine [30]=layout-images [31]=menu-to-go)

check() {   # a check passes when it says ALL N CHECKS PASSED, or (the older true/false ones) every value is true
  local name=$1 out
  out=$(psql -X -A -t -d $DB -f "$SQL/check-$name.sql" 2>&1)
  if echo "$out" | grep -q "CHECKS PASSED"; then ok "check-$name: $(echo "$out" | grep -o 'ALL [0-9]* CHECKS PASSED' | head -1)"
  elif echo "$out" | grep -qE "FAILED|ERROR"; then bad "check-$name" "$out"
  elif [ "$name" = agent ]; then
    echo "$out" | grep -q "15" && ok "check-agent: the device tables and 15 registered Pis" || bad "check-agent" "$out"
  elif echo "$out" | tr '|' '\n' | grep -vE '^\s*$' | grep -qv '^t$'; then bad "check-$name: not every value true" "$out"
  else ok "check-$name: every value true"; fi
}

for f in $(ls "$SQL"/[0-9][0-9]-*.sql | sort); do
  n=$(basename "$f" | cut -c1-2)
  if out=$(psql -X -q -d $DB -v ON_ERROR_STOP=1 -f "$f" 2>&1); then ok "$(basename "$f") runs"; else bad "$(basename "$f") runs" "$out"; exit 1; fi
  [ -n "${CHECK[$n]:-}" ] && check "${CHECK[$n]}"
done
echo "-- every check again, after the last file"
for n in $(printf '%s\n' "${!CHECK[@]}" | sort); do check "${CHECK[$n]}"; done
echo "-- the newest files run a second time"
for f in $(ls "$SQL"/[0-9][0-9]-*.sql | sort | tail -3); do
  psql -X -q -d $DB -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 && ok "$(basename "$f") runs again" || bad "$(basename "$f") runs again"
done
for f in $(ls "$SQL"/[0-9][0-9]-*.sql | sort | tail -3); do n=$(basename "$f" | cut -c1-2); [ -n "${CHECK[$n]:-}" ] && check "${CHECK[$n]}"; done

psql -X -q -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
echo
echo "$pass/$total passed"
[ "$pass" = "$total" ]
