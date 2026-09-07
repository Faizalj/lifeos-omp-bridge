#!/usr/bin/env bash
# bridge-check.sh — canary for lifeos-omp-bridge.
#
# Runs one headless omp turn and asserts the LifeOS hook contract still flows
# end-to-end: extension loaded, registry parsed, real session ids, all event
# classes fired. Run this after LifeOS updates or omp upgrades — it is the
# signal for "our bridge needs fixing".
#
# Usage: ./bridge-check.sh ["optional prompt"]
set -u
LOG="$(mktemp /tmp/bridge-check.XXXXXX.log)"
PROMPT="${1:-run: echo bridge-check}"

echo "▸ headless run: omp -p --auto-approve \"$PROMPT\""
OMP_BRIDGE_LOG="$LOG" OMP_VOICE=0 omp -p --auto-approve "$PROMPT" >/dev/null 2>&1

fail() { echo "✗ $1"; echo "  audit log kept at: $LOG"; exit 1; }
pass() { echo "✓ $1"; }

grep -q '"event":"bridge_init","version":2' "$LOG" ||
  fail "bridge v2 not loaded (no bridge_init) — extension missing or omp rejected it"

hooks=$(sed -n 's/.*"event":"bridge_init","version":2,"hooks":\([0-9]*\),.*/\1/p' "$LOG" | head -1)
[ -n "$hooks" ] && [ "$hooks" -gt 0 ] ||
  fail "0 hooks loaded — settings.json format changed or registry unreadable"
pass "registry loaded: $hooks hooks"

grep -q 'registry_load_failed' "$LOG" && fail "registry_load_failed in log — settings.json schema changed"

grep -q '"session_id":"omp"' "$LOG" && fail 'placeholder session id "omp" leaked'
grep -q '"unknown"' "$LOG" && fail 'placeholder session id "unknown" leaked'
pass "no placeholder session ids"

grep -q '"transcript":true' "$LOG" || fail "transcript_path empty — getSessionFile() contract broke"
pass "transcript_path resolves"

for cc in SessionStart UserPromptSubmit PreToolUse PostToolUse Stop SessionEnd; do
  grep -q "\"cc\":\"$cc\"" "$LOG" || fail "event class never fired: $cc — omp event surface changed"
done
pass "all 6 CC event classes executed"

grep -q '"event":"session_stop"' "$LOG" || fail "session_stop missing — Stop-hook contract moved in omp"
pass "session_stop (Stop hooks) fired"

echo
echo "▸ per-event hook runs:"
for cc in SessionStart UserPromptSubmit PreToolUse PostToolUse Stop SessionEnd; do
  printf '  %-18s %s\n' "$cc" "$(grep -c "\"cc\":\"$cc\"" "$LOG")"
done
echo
echo "PASS — bridge contract intact. audit log: $LOG"