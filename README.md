# @dougbots/pi-rm-guard

Let routine cleanup run without another approval dialog. This [pi](https://pi.dev)
extension sends possible `rm` commands and session evidence to a decision model.
The model judges whether to proceed, ask you, or deny the command.

## How it works

1. A small text detector routes possible `rm` calls, including variables, globs,
   quoted mentions, scripts, and paths outside cwd. Commands without candidate
   `rm` text pass through.
2. The model receives the raw command, cwd, recent user requests, and bounded
   recent tool calls/results. No parser claims that deletion targets are verified.
3. A confident approval runs the command. A confident denial blocks it. An ask,
   low confidence, or model error opens confirmation when a UI is available;
   otherwise it blocks.

There are no static path allowlists, system-path denials, or literal-only
eligibility rules. Non-recursive `rm` and harmless mentions can also reach the
model. It decides whether the command is harmless or the cleanup is appropriate.

**This is an autonomy aid, not a sandbox.** Detection does not interpret arbitrary
shell programs or inspect external scripts. The model can make mistakes. Use OS
permissions or a sandbox for isolation, rather than treating approval as proof
that a command cannot damage data.

## Configure a reachable model

The default backend is `classifier`, using `typesafe/jev-latest`. It needs pi
credentials or `TYPESAFE_API_KEY`; without a reachable model, commands escalate.

For a decisions endpoint registered as a pi classifier, put this `rmGuard` block
in global or project pi settings:

```json
{
  "rmGuard": {
    "backend": "classifier",
    "registerProvider": true,
    "classifier": "decisions/gemma4",
    "url": "http://localhost:4000/v1/decisions",
    "model": "gemma4",
    "timeoutMs": 1500
  }
}
```

Set `backend` to `decisions` to call that endpoint directly instead.
Direct requests and the registered `decisions` provider share state and question
encoding. Other pi-known classifier models use `provider/model-id`, such as
`openrouter/typesafe/jev-1.13`.

| Setting | Environment override | Default |
|---|---|---|
| `backend` | `RM_GUARD_BACKEND` | `classifier` |
| `classifier` | `RM_GUARD_CLASSIFIER` | `typesafe/jev-latest` |
| `url` | `RM_GUARD_URL` | `http://localhost:4000/v1/decisions` |
| `model` | `RM_GUARD_MODEL` | `gemma4` |
| `timeoutMs` | `RM_GUARD_TIMEOUT_MS` | `1500` |
| `threshold` | `RM_GUARD_THRESHOLD` | Backend default |
| `registerProvider` | `RM_GUARD_REGISTER_PROVIDER` (`1`/`0`) | `false` |
| `keyFile` | `RM_GUARD_JEV_KEY_FILE` | `~/.secrets/jev.key` |

Environment overrides settings. Unknown backend values are configuration errors,
not aliases for another engine. Config and provider registration resolve on the
first routed command. `RM_GUARD_API_KEY` supplies an optional registered-provider
key; classifier credentials otherwise come from pi. `keyFile` is a legacy
fallback: keep it private, since this extension does not enforce file modes.

The decisions backend approves at p≥0.85; the classifier backend defaults to
p≥0.6. `threshold` overrides the approval threshold. Both require p≥0.99 for denial.
Bool-only classifiers can approve or ask, but cannot deny. Calibrate your chosen
weights rather than assuming these defaults suit every model.

Command text, recent requests, and tool excerpts are sent to your configured model
and recorded in rm-guard session entries. Choose an endpoint appropriate for the
data in your sessions.

## Install

```sh
pi install git:github.com/sdougbrown/pi-rm-guard
# or
pi install npm:@dougbots/pi-rm-guard
```

## Verify

```sh
npm test
RM_GUARD_URL=http://localhost:4000/v1/decisions npm run eval:live
```

Unit tests prove routing, evidence delivery, transport handling, and execution of
model verdicts. Live evals present commands to actual weights without executing
them; their expected outcomes are not runtime rules.

Before shipping, follow the [real-pi verification procedure](.agents/skills/verify-pi-rm-guard/SKILL.md).
Its real-pi fixtures prove settings loading, model calls, and filesystem outcomes.
Stubbed approvals alone do not prove that a real model makes useful judgments.
