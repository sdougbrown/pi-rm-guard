---
name: verify-pi-rm-guard
description: "Verify rm-guard inside real pi: evidence reaches the model, its verdict controls execution, and model failures escalate. Run before claiming user-facing changes work. Test actual model judgment separately from stubbed integration proofs."
---

# Verify pi-rm-guard

Drive real `pi` with this extension loaded, a scripted coding model, and either
a stubbed decision model or real weights. Unit tests cover hooks and transports;
these proofs cover extension loading, settings, tool interception, and execution.

## Gates

Run from the repository root with Node >=24 and the `pi` CLI on PATH.

1. Check the environment and unit tests:
   ```sh
   .agents/skills/verify-pi-rm-guard/helpers/doctor.sh
   ```
2. Prove routing, context delivery, and verdict handling with stubbed decisions:
   ```sh
   .agents/skills/verify-pi-rm-guard/helpers/run-suite.sh
   ```
3. Prove the registered classifier-provider route:
   ```sh
   RM_GUARD_VERIFY_BACKEND=classifier \
     .agents/skills/verify-pi-rm-guard/helpers/run-case.sh approve-var \
     'CACHE="@VICTIM@"; rm -rf "$CACHE"' \
     '{"action":"A","probabilities":{"A":0.95,"B":0.03,"C":0.02}}'
   ```
4. Evaluate the actual weights, without executing the commands in the eval:
   ```sh
   TYPESAFE_API_KEY= RM_GUARD_URL=http://grace:4000/v1/decisions \
     RM_GUARD_MODEL=gemma4 npm run eval:live
   ```
5. Prove real weights can approve cleanup through pi:
   ```sh
   RM_GUARD_VERIFY_LIVE_URL=http://grace:4000/v1/decisions \
     RM_GUARD_VERIFY_BACKEND=classifier \
     .agents/skills/verify-pi-rm-guard/helpers/run-case.sh approve-var \
     'CACHE="@VICTIM@"; rm -rf "$CACHE"' '{}'
   ```
   Substitute another reachable endpoint/model when needed; set
   `RM_GUARD_VERIFY_LIVE_MODEL` to override `gemma4`. Record which weights ran.
   Set `RM_GUARD_VERIFY_TIMEOUT_MS=1500` to exercise the production default deadline;
   the harness otherwise allows 20 seconds to isolate verdict handling.

Stubbed decisions prove the plumbing, **not model judgment**. Live evals assess
sample judgments, not universal safety. Report unavailable live weights as a
blocked gate rather than substituting stub results.

## Drive one case

```sh
.agents/skills/verify-pi-rm-guard/helpers/run-case.sh <case> '<command>' '<decision-json>'
```

`run-case.sh` creates a private agent directory and loads the extension explicitly
with discovery disabled. It writes `rmGuard` settings into that directory and
clears inherited guard overrides. The coding-model stub issues the given command.
Pi runs in print mode, where escalation blocks because there is no confirmation UI.
Interactive confirmation is covered by the hook unit tests.

`@VICTIM@` expands to a unique disposable directory containing `marker`, outside
the session workspace. Commands must reference this fixture; the harness rejects
ones that omit it before starting pi. Only use fixture paths in deletion recipes.
The harness checks pi's exit status, marker state, session entries, and the number
of decision requests. Unmapped cases are exploratory and do not count as proofs.

The `context` case first runs a command whose output contains
`generated-fixture-context`. Its assertion checks that this tool result, cwd,
and the current user request reach the decision model.

For live proofs, `RM_GUARD_VERIFY_LIVE_URL` makes the decision stub forward to real
weights and record the response. The decision-json argument is then ignored.
Do not use this mode with `run-suite.sh`: its deny/ask cases require stubbed verdicts.
`RM_GUARD_VERIFY_API_KEY` configures an endpoint token for authenticated proofs.
The stub requires that token and forwards it in live mode. The suite uses only
a fixture token and checks both backend routes.

## Evidence and cleanup

Evidence stays in `evidence/<timestamp>-<case>/` under this skill:

- `output.txt`: pi output and block reasons.
- `sessions/*.jsonl` and `entries.jsonl`: tool results and rm-guard decisions.
- `stub/chat-requests.jsonl`: coding-model traffic.
- `stub/decisions-requests.jsonl`: evidence sent to the decision backend.
- `stub/decisions-responses.jsonl`: actual model responses in live mode.
- `stub/decision.json`: the requested verdict in stubbed mode.

Use the entry **and** the expected filesystem effect. Approval of a deletion
must remove the marker; approval of an inert quoted heredoc must preserve it.
Denial, escalation, and model errors must preserve it.

Each run records its stub PID and kills only that PID on exit. If interrupted,
inspect `stub/ports.json` and stop that PID, never a process-name match. Evidence
and fixture remnants remain for inspection and are gitignored. Run cases serially.

## Maintain the map

Update [features/README.md](features/README.md) in the same change as behavior.
Keep routing/evidence/verdict proofs separate from live model evaluations.
Do not turn eval expectations into deterministic runtime safety rules.
