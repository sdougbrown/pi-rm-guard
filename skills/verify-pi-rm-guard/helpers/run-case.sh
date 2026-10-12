#!/usr/bin/env bash
# Drive one rm-guard case through a real pi process.
#
# usage: run-case.sh <case-name> "<bash command>" <decision.json content>
#
# Starts a private pair of stub engines, points a disposable pi agent dir at
# them, runs `pi -p` with the extension loaded, and prints the observable
# outcome. Everything lands under skills/verify-pi-rm-guard/evidence/<stamp>-<case>/
# and survives cleanup; only the stub processes are torn down.
#
# Cases that expect the guard to block pass in print mode (fail-closed), which
# is exactly how a defer/deny behaves for non-interactive runs.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
SKILL_DIR="$REPO/skills/verify-pi-rm-guard"
EVIDENCE="$SKILL_DIR/evidence"
CASE="$1"
COMMAND="$2"
DECISION="$3"

# Create the case dir exclusively: the stamp has 1-second resolution, so a
# same-second rerun of a case must not reuse (and blend evidence with) the
# previous run's directory. Retry with a fresh stamp on collision.
mkdir -p "$EVIDENCE"
CASE_DIR=""
for _ in 1 2 3; do
	STAMP="$(date +%Y%m%d-%H%M%S)"
	CASE_DIR="$EVIDENCE/$STAMP-$CASE"
	if mkdir "$CASE_DIR" 2>/dev/null; then break; fi
	CASE_DIR=""
	sleep 1.1
done
if [ -z "$CASE_DIR" ]; then
	echo "FAIL: could not create a unique evidence dir for case $CASE"
	exit 1
fi
mkdir -p "$CASE_DIR/workspace" "$CASE_DIR/agent" "$CASE_DIR/sessions" "$CASE_DIR/stub"

# --- start stub engines (record PID; never kill by name) ---------------------
node "$SKILL_DIR/helpers/stub-servers.mjs" "$CASE_DIR/stub" > "$CASE_DIR/stub/stdout.json" &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
	[ -f "$CASE_DIR/stub/ports.json" ] && break
	sleep 0.1
done
if [ ! -f "$CASE_DIR/stub/ports.json" ]; then
	echo "FAIL: stub engines failed to start — check $CASE_DIR/stub/stdout.json"
	exit 1
fi
DEC_PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).decPort)' "$CASE_DIR/stub/ports.json")"
CHAT_PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).chatPort)' "$CASE_DIR/stub/ports.json")"

# --- deterministic engines ----------------------------------------------------
printf '{"command":%s}\n' "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$COMMAND")" > "$CASE_DIR/stub/directive.json"
printf '%s\n' "$DECISION" > "$CASE_DIR/stub/decision.json"

# --- disposable pi agent dir: stub provider only ------------------------------
cat > "$CASE_DIR/agent/models.json" <<EOF
{"providers":{"stub":{"baseUrl":"http://127.0.0.1:${CHAT_PORT}/v1","api":"openai-completions","apiKey":"dummy","models":[{"id":"stub","name":"Stub","input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":32000,"maxTokens":1000}]}}}
EOF

# --- the file the command is supposed to delete -------------------------------
mkdir -p /tmp/rmguard-verify-victim
echo data > /tmp/rmguard-verify-victim/marker

cd "$CASE_DIR/workspace"
set +e
PI_CODING_AGENT_DIR="$CASE_DIR/agent" \
RM_GUARD_BACKEND=decisions \
RM_GUARD_URL="http://127.0.0.1:${DEC_PORT}/v1/decisions" \
RM_GUARD_MODEL=stub \
RM_GUARD_TIMEOUT_MS=3000 \
pi -p --no-extensions -e "$REPO/src/index.ts" --no-mcp --offline --no-skills --no-prompt-templates \
	--session-dir "$CASE_DIR/sessions" "delete the build artifacts" \
	> "$CASE_DIR/output.txt" 2>&1
PI_EXIT=$?
set -e

MARKER_STATE="$([ -f /tmp/rmguard-verify-victim/marker ] && echo SURVIVED || echo DELETED)"
echo "case:      $CASE"
echo "command:   $COMMAND"
echo "pi exit:   $PI_EXIT"
echo "marker:    $MARKER_STATE"
echo "--- pi output tail ---"
tail -4 "$CASE_DIR/output.txt"
echo "--- rm-guard session entries ---"
node -e '
const fs = require("fs");
const files = fs.readdirSync(process.argv[1]).filter((f) => f.endsWith(".jsonl"));
const out = [];
for (const f of files) {
	for (const line of fs.readFileSync(`${process.argv[1]}/${f}`, "utf8").split("\n")) {
		if (!line) continue;
		const e = JSON.parse(line);
		if (e.type === "custom" && e.customType === "rm-guard") out.push(JSON.stringify(e.data));
	}
}
fs.writeFileSync(process.argv[2], out.length ? out.join("\n") + "\n" : "");
if (out.length) console.log(out.join("\n"));
' "$CASE_DIR/sessions" "$CASE_DIR/entries.jsonl"
DEC_CALLS=0; [ -f "$CASE_DIR/stub/decisions-requests.jsonl" ] && DEC_CALLS=$(wc -l < "$CASE_DIR/stub/decisions-requests.jsonl" | tr -d '[:space:]')
echo "--- decisions calls: $DEC_CALLS ---"
echo "evidence:  $CASE_DIR"

# --- assertions: documented end states per case (SKILL.md, features/*.md) ----
# Table: <case> → "<marker state>|<session-entry field tokens>|<decisions calls>".
# Entry tokens are simple field checks against any one rm-guard entry
# (e.g. "gate=denied", "action=approve autoApproved=true"); "absent" requires
# no rm-guard entry at all; "targets=[]" an empty, "targets=+" a non-empty list.
# glob-* cases follow features/glob-targets.md (gate-side glob expansion) —
# those expectations live on the stacked glob-expansion branch; on this branch
# every glob defers, so only glob-unbounded is asserted here.
expectation_for() {
	case "$1" in
		approve)          echo "DELETED|action=approve autoApproved=true|1" ;;
		eligible-literal) echo "DELETED|action=approve autoApproved=true|1" ;;
		low-conf)         echo "SURVIVED|gate=low-confidence autoApproved=false|1" ;;
		deny|deny-root)   echo "SURVIVED|gate=denied|0" ;;
		defer|defer-glob|defer-var|glob-unbounded) echo "SURVIVED|gate=ineligible|0" ;;
		absent)           echo "DELETED|absent|0" ;;
		*)                echo "" ;;
	esac
}

EXPECT="$(expectation_for "$CASE")"
if [ -z "$EXPECT" ]; then
	echo "assert: none (unmapped case)"
	exit 0
fi
IFS='|' read -r WANT_MARKER WANT_ENTRY WANT_CALLS <<< "$EXPECT"

ASSERT_FAIL=""
[ "$MARKER_STATE" = "$WANT_MARKER" ] || ASSERT_FAIL="marker expected $WANT_MARKER, got $MARKER_STATE"
ENTRY_OK=1
node -e '
const fs = require("fs");
const spec = process.argv[1];
const file = process.argv[2];
const entries = fs.existsSync(file)
	? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
	: [];
if (spec === "absent") process.exit(entries.length === 0 ? 0 : 1);
const want = {};
for (const tok of spec.split(" ")) {
	const eq = tok.indexOf("=");
	want[tok.slice(0, eq)] = tok.slice(eq + 1);
}
const ok = entries.some((e) =>
	Object.entries(want).every(([k, v]) =>
		v === "[]" ? Array.isArray(e[k]) && e[k].length === 0
		: v === "+" ? Array.isArray(e[k]) && e[k].length > 0
		: String(e[k]) === v));
process.exit(ok ? 0 : 1);
' "$WANT_ENTRY" "$CASE_DIR/entries.jsonl" || ENTRY_OK=0
[ "$ENTRY_OK" = 1 ] || ASSERT_FAIL="${ASSERT_FAIL:+$ASSERT_FAIL; }no rm-guard session entry matching '$WANT_ENTRY'"
[ "$DEC_CALLS" = "$WANT_CALLS" ] || ASSERT_FAIL="${ASSERT_FAIL:+$ASSERT_FAIL; }decisions calls expected $WANT_CALLS, got $DEC_CALLS"

if [ -n "$ASSERT_FAIL" ]; then
	echo "assert: FAIL ($CASE) — $ASSERT_FAIL"
	exit 1
fi
echo "assert: OK ($CASE)"
