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
STAMP="$(date +%Y%m%d-%H%M%S)"
CASE="$1"
COMMAND="$2"
DECISION="$3"
CASE_DIR="$EVIDENCE/$STAMP-$CASE"

mkdir -p "$CASE_DIR/workspace" "$CASE_DIR/agent" "$CASE_DIR/sessions" "$CASE_DIR/stub"

# --- start stub engines (record PID; never kill by name) ---------------------
node "$SKILL_DIR/helpers/stub-servers.mjs" "$CASE_DIR/stub" > "$CASE_DIR/stub/stdout.json" &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
	[ -f "$CASE_DIR/stub/ports.json" ] && break
	sleep 0.1
done
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

echo "case:      $CASE"
echo "command:   $COMMAND"
echo "pi exit:   $PI_EXIT"
echo "marker:    $([ -f /tmp/rmguard-verify-victim/marker ] && echo SURVIVED || echo DELETED)"
echo "--- pi output tail ---"
tail -4 "$CASE_DIR/output.txt"
echo "--- rm-guard session entries ---"
node -e '
const fs = require("fs");
const files = fs.readdirSync(process.argv[1]).filter((f) => f.endsWith(".jsonl"));
for (const f of files) {
	for (const line of fs.readFileSync(`${process.argv[1]}/${f}`, "utf8").split("\n")) {
		if (!line) continue;
		const e = JSON.parse(line);
		if (e.type === "custom" && e.customType === "rm-guard") console.log(JSON.stringify(e.data));
	}
}
' "$CASE_DIR/sessions"
DEC_CALLS=0; [ -f "$CASE_DIR/stub/decisions-requests.jsonl" ] && DEC_CALLS=$(wc -l < "$CASE_DIR/stub/decisions-requests.jsonl")
echo "--- decisions calls: $DEC_CALLS ---"
echo "evidence:  $CASE_DIR"
