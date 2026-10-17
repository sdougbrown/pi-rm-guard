#!/usr/bin/env bash
# Each command can only delete its case's disposable victim.
set -euo pipefail
if [ -n "${RM_GUARD_VERIFY_LIVE_URL:-}" ]; then
	echo 'run-suite requires stubbed verdicts; use run-case for live-model proofs' >&2
	exit 2
fi
H="$(cd "$(dirname "$0")" && pwd)"
A='{"action":"A","probabilities":{"A":0.95,"B":0.03,"C":0.02}}'
B='{"action":"B","probabilities":{"A":0.05,"B":0.94,"C":0.01}}'
C='{"action":"C","probabilities":{"A":0.001,"B":0.001,"C":0.998}}'
"$H/run-case.sh" approve 'rm -rf "@VICTIM@"' "$A"
RM_GUARD_VERIFY_SETUP_COMMAND="printf 'generated-fixture-%s: disposable build artifact\\n' context" \
	"$H/run-case.sh" context 'rm -rf "@VICTIM@"' "$A"
"$H/run-case.sh" approve-var 'CACHE="@VICTIM@"; rm -rf "$CACHE"' "$A"
"$H/run-case.sh" approve-glob 'rm -rf "@VICTIM@"*' "$A"
"$H/run-case.sh" approve-redirect 'rm -rf "@VICTIM@" 2>/dev/null' "$A"
"$H/run-case.sh" heredoc-bash $'bash <<\'EOF\'\nrm -rf "@VICTIM@"\nEOF' "$A"
"$H/run-case.sh" heredoc-sub $'cat <<EOF\n$(rm -rf "@VICTIM@")\nEOF' "$A"
"$H/run-case.sh" heredoc-quoted $'cat <<\'EOF\'\nrm -rf "@VICTIM@"\nEOF' "$A"
"$H/run-case.sh" non-recursive 'rm "@VICTIM@/marker"' "$A"
"$H/run-case.sh" deny 'rm -rf "@VICTIM@"' "$C"
"$H/run-case.sh" defer 'rm -rf "@VICTIM@"' "$B"
"$H/run-case.sh" low-conf 'rm -rf "@VICTIM@"' '{"action":"A","probabilities":{"A":0.5,"B":0.49,"C":0.01}}'
"$H/run-case.sh" model-error 'rm -rf "@VICTIM@"' 'invalid-json'
"$H/run-case.sh" malformed-model 'rm -rf "@VICTIM@"' '{"action":"A","probabilities":{"A":"1","B":0,"C":0}}'
RM_GUARD_VERIFY_BACKEND=bogus-backend "$H/run-case.sh" invalid-backend 'rm -rf "@VICTIM@"' "$A"
RM_GUARD_VERIFY_API_KEY=fixture-token RM_GUARD_VERIFY_BACKEND=decisions "$H/run-case.sh" approve-auth 'rm -rf "@VICTIM@"' "$A"
RM_GUARD_VERIFY_API_KEY=fixture-token RM_GUARD_VERIFY_BACKEND=classifier "$H/run-case.sh" approve-auth 'rm -rf "@VICTIM@"' "$A"
"$H/run-case.sh" absent 'find "@VICTIM@" -name marker -delete' "$A"
