---
name: verify-pi-rm-guard
description: "Drive the real pi process with the rm-guard extension loaded and prove its verdicts end to end — approve, defer, deny, and pass-through — before claiming user-facing changes work. Use before claiming any rm-guard behavior change is done; also use to reproduce gate verdicts against the real pipeline (the unit tests cover the gate logic, this proves the extension inside pi)."
---

# Verifying pi-rm-guard against the real app

This extension has no server and no UI of its own: its user surface is a live
`pi` process in which a model issues a `bash` tool call and the guard judges it.
Unit tests (`npm test`) cover the static gate in isolation; this skill proves
the full chain — extension loaded in pi, tool call intercepted, decision
backend consulted, tool allowed or blocked, session entry written.

The recipe replaces the two external models with deterministic stubs: a fake
OpenAI-compatible coding model that issues exactly one `bash` tool call, and a
fake `/v1/decisions` endpoint whose verdict is dictated per case. Everything
else (pi, the extension, the guard, bash, the filesystem) is real.

## Launch

No build step: the repo runs TypeScript directly under node (>= 24).

1. Run the doctor first: `.agents/skills/verify-pi-rm-guard/helpers/doctor.sh`
2. Drive a case (each invocation is self-contained — starts its own stubs,
   runs one pi process, tears the stubs down):

```sh
.agents/skills/verify-pi-rm-guard/helpers/run-case.sh <case-name> "<command>" '<decision.json>'
```

`<decision.json>` controls the stub decision model, e.g.
`{"action":"A","probabilities":{"A":0.95,"B":0.03,"C":0.02}}` (A=approve,
B=ask, C=deny).

The stub engines (`helpers/stub-servers.mjs`) stay in the foreground of their
own process; `run-case.sh` records the PID and kills exactly that PID on exit.
Never start a second pair of stubs while one is running, and never kill by
process name — a `pkill -f stub-servers` also kills any shell whose command
line mentions the script (this bit during development).

Readiness signal for a driven case: the case prints `pi exit:`, the marker
file state, and the rm-guard session entries. A run is ready to interpret as
soon as those appear; a hung run (>30s) means pi could not reach the stub —
check `evidence/<case>/stub/ports.json` and `output.txt`.

## Doctor

`helpers/doctor.sh` answers "is this checkout worth driving?": pi on PATH and
running, `src/index.ts` present, and `npm test` green. If `npm test` is red,
fix the gate before driving pi — a broken base teaches wrong conclusions.
A WARN about a stale `stub-servers.mjs` process means a previous run crashed;
kill that PID before driving.

## Drive

The harness recipe, in `run-case.sh`:

- disposable agent dir (`PI_CODING_AGENT_DIR`) with a `models.json` that
  defines provider `stub` → the chat stub; nothing from the user's real pi
  config is consulted;
- the extension is loaded explicitly with `-e <repo>/src/index.ts` together
  with `--no-extensions` (no discovery, no other extensions), plus
  `--no-mcp --offline --no-skills --no-prompt-templates`;
- `RM_GUARD_BACKEND=decisions RM_GUARD_URL=… RM_GUARD_MODEL=stub` points the
  guard at the decisions stub;
- pi runs in print mode (`-p`) from a scratch workspace, so a human-confirm
  defer fails closed with a block — that is the observable behavior for
  defers in non-interactive runs;
- the tool call the "model" issues is exactly the `<command>` argument.

The four primary mapped cases (one command each; the expectation table in the
harness also maps `eligible-literal`, `low-conf`, `deny-root`, `defer-var`, and
`glob-unbounded`):

```sh
H=.agents/skills/verify-pi-rm-guard/helpers
D='{"action":"A","probabilities":{"A":0.95,"B":0.03,"C":0.02}}'
$H/run-case.sh approve   'rm -rf /tmp/rmguard-verify-victim' "$D"   # DELETED, autoApproved:true
$H/run-case.sh deny      'rm -rf /'                          "$D"   # SURVIVED, gate:denied
$H/run-case.sh defer     'rm -rf /tmp/rmguard-verify-vic*'   "$D"   # SURVIVED, gate:ineligible
$H/run-case.sh absent    'rm /tmp/rmguard-verify-victim/marker' "$D" # DELETED, no rm-guard entry
```

Expected end states per case are in `features/`. When adding a case for a new
feature, mirror it in `features/`.

## Evidence

Everything a proof needs lands under `.agents/skills/verify-pi-rm-guard/evidence/<stamp>-<case>/`:

- `output.txt` — full pi print-mode output (block reasons, "done");
- `sessions/*.jsonl` — the session log, including the `rm-guard` custom
  entries (`command`, `gate`/`backend`, `action`, `probability`, `targets`,
  `autoApproved`) and the tool result with the block reason;
- `stub/chat-requests.jsonl` and `stub/decisions-requests.jsonl` — what the
  guard actually sent to the decision model (empty for deny/defer: the static
  gate stops before the model);
- marker-file state printed by the run shows the filesystem side effect.

Proof standards: a verdict is proven by the session entry *and* the
filesystem effect together — an "approve" whose marker survived is a failure;
a "defer" whose marker was deleted is a failure. The marker is created fresh
by each run under `/tmp/rmguard-verify-victim`, which is inside the guard's
scope by design (`/tmp` is judgeable). Never point cases at real user data.

`run-case.sh` enforces these end states: every documented case maps in its
`expectation_for` table to an expected marker state, a session-entry field
check, and an expected decisions-call count. On mismatch it prints
`assert: FAIL (<case>) — …` and exits 1; on match `assert: OK (<case>)`.
Cases not in the table run print-only and say `assert: none (unmapped case)`.

## Cleanup

`run-case.sh` kills only the stub PID it recorded (trap on EXIT) and leaves
all evidence in place. If a run is interrupted between stub start and trap,
`doctor.sh` will WARN about the stale process — kill the PID from the
stale run's `stub/ports.json`, never by name. Evidence is never cleaned up
by the scripts; prune old `evidence/` directories by hand if they accumulate
(the directory is gitignored).

## Maintaining this skill

When a change in `src/` alters how a verdict is reached — new gate rules, new
session entry fields, a renamed config key — update the matching file in
`features/` in the same change. When a new user-facing behavior ships (a new
verdict path, a new backend, a settings interaction), add a feature file and a
driven case for it. A stale feature map teaches the next agent the wrong
proof; treat the map as part of the change, not documentation debt.
