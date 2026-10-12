# Decision model: approve / defer for eligible commands

## Sub-features

- An eligible command is sent to the configured decision backend with the
  command text and the session's recent user intent.
- Approve (>= threshold) → the tool call proceeds and the session entry has
  `autoApproved: true`.
- Anything below the threshold (or a backend error/timeout) defers: human
  confirm in interactive mode, fail-closed block in print mode.
- Model "no"/low answers defer rather than deny; deny (>=0.99) is reserved for
  near-certain unacceptability.
- Backend selection: `decisions` (direct `/v1/decisions` fetch) or `classifier`
  (pi model registry); config precedence env > settings `rmGuard` block >
  defaults (see README "Configuration").

## How to get to it (user POV)

Invisible when it works: the command simply runs, with (in interactive mode)
an info notification "rm-guard auto-approved (0.95): <command>". The user
reaches it by asking the agent to delete something build-shaped, e.g. "delete
the build artifacts".

## Driving it with run-case.sh

The stub decisions endpoint's verdict is dictated by the third argument, so
all three outcomes are drivable against the same command:

```sh
H=skills/verify-pi-rm-guard/helpers
$H/run-case.sh approve 'rm -rf /tmp/rmguard-verify-victim' '{"action":"A","probabilities":{"A":0.95,"B":0.03,"C":0.02}}'
$H/run-case.sh low-conf 'rm -rf /tmp/rmguard-verify-victim' '{"action":"B","probabilities":{"A":0.10,"B":0.80,"C":0.10}}'
```

## Gotchas

- The decision request body (`stub/decisions-requests.jsonl`) must contain the
  command and the intent string; in print mode the intent is the `-p` prompt
  ("delete the build artifacts").
- The deny branch of the model (C >= 0.99) can be driven the same way, but
  most deny-worthy commands are already caught by the static gate — use a
  target that is in-scope but model-denied (the classifier/decisions stub
  decides on intent, not path).
- Thresholds are configurable (`RM_GUARD_THRESHOLD`); if you change them, the
  probabilities used here (0.95 approve / 0.10 deny) must still straddle the
  configured threshold — adjust the stub probabilities, not the assertion.
- A backend error must defer, not block silently: point `RM_GUARD_URL` at a
  dead port (e.g. 127.0.0.1:9) and expect the fail-closed block plus a
  `model-error` gate entry.
