#!/usr/bin/env bash
# One read-only check: is this checkout worth driving?
# usage: doctor.sh   (exit 0 = ready, nonzero = fix the reported problem)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
ok=1

command -v pi >/dev/null || { echo "FAIL: pi not on PATH"; ok=0; }
pi --version >/dev/null 2>&1 || { echo "FAIL: pi does not run"; ok=0; }

[ -f "$REPO/src/index.ts" ] || { echo "FAIL: extension entry $REPO/src/index.ts missing"; ok=0; }

# Check hook and backend regressions before driving the complete pipeline.
if ! (cd "$REPO" && npm test >/dev/null 2>&1); then
	echo "FAIL: npm test does not pass; fix the regression before verifying behavior"
	ok=0
fi

# Prove the harness itself runs: the stub engines self-test both endpoints in
# one process (no leftover stubs). A broken stub would generate wrong proofs.
SELFTEST_DIR="$(mktemp -d)"
if node "$REPO/.agents/skills/verify-pi-rm-guard/helpers/stub-servers.mjs" "$SELFTEST_DIR" --selftest > /tmp/rmguard-selftest.log 2>&1; then
	echo "stub selftest: OK"
else
	echo "FAIL: stub-servers.mjs --selftest did not pass; the stub harness itself is broken"
	cat /tmp/rmguard-selftest.log
	ok=0
fi
rm -rf "$SELFTEST_DIR" /tmp/rmguard-selftest.log

# Port check is done per-case by run-case.sh (ephemeral ports); here we only
# verify no stale stub from a crashed earlier run is holding the evidence dir.
if pgrep -f "stub-servers.mjs" >/dev/null 2>&1; then
	echo "WARN: a stub-servers.mjs process is already running — a previous run may have crashed; kill the stale PID before driving"
fi

[ "$ok" -eq 1 ] && echo "doctor: OK — checkout is verifiable" || exit 1
