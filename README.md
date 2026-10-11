# pi-rm-guard

A [pi](https://pi.dev) extension that auto-approves safe recursive `rm` commands using a
decision model, and defers everything else to human approval.

## How it decides

Three gates run in order. A command is auto-approved only if it passes all of them.

1. **Static gate** (`src/guard.ts`) — the command must be one or more plain recursive
   `rm` invocations (`rm -rf`, `rm -fr`, `rm -Rf`, `/bin/rm -rf`, …) with fully literal
   targets. Anything else defers: variable indirection (`$CACHE_DIR`), globs, quotes,
   command substitution, redirections, non-rm segments (`echo hi && rm -rf dist`), and
   `sudo`. Targets are resolved with `realpath` (new leaves through their existing
   ancestor) and must land strictly inside the session cwd or `/tmp` — never at the cwd
   itself, `/tmp` itself, or any ancestor. Symlinks are resolved, so a link inside the
   project pointing at `$HOME/.ssh` defers.

2. **Decision model** — one question about intent alignment, answered from the
   command and the last user messages in the session. Two backends:
   - `decisions` (default): a `/v1/decisions` endpoint, e.g. a local llama.cpp router
     running `gemma4`. Asks a 3-way approve/ask/deny choice; approve ≥0.85,
     deny ≥0.99, everything else defers.
   - `classifier`: any pi-known classifier model (`typesafe/jev-latest`,
     openrouter, cloudflare clef, llama.cpp router models) via
     `ctx.modelRegistry.classify()`. Asks the same 3-way choice (approve ≥0.6,
     deny ≥0.99, else defer) and falls back to a yes/no question for
     bool-only models (yes approves, no defers).

3. **Verdict** — three outcomes:
   - **approve** (statically eligible + model confident): the call proceeds.
   - **deny** — auto-blocked, no dialog: static targets that are the filesystem
     root, system trees (/etc, /usr, /var, …), the whole home directory, a cwd
     ancestor, or /tmp itself; or a model "deny" at ≥0.99 confidence (the
     decisions backend's 3-way approve/ask/deny question; the injected
     instruction case lands here).
   - **defer** — everything else: human confirm in interactive mode; blocked in
     print/JSON/RPC mode (fail closed). Model errors also defer.

Every decision is logged as an `rm-guard` session entry (command, backend,
intent, action, probability, targets, autoApproved).

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `RM_GUARD_BACKEND` | `decisions` | `decisions` (custom /v1/decisions endpoint) or `classifier` (pi-known classifier model) |
| `RM_GUARD_THRESHOLD` | backend default | minimum p(yes) to auto-approve (decisions 0.85, classifier 0.6) |
| `RM_GUARD_URL` | `http://localhost:4000/v1/decisions` | decisions endpoint |
| `RM_GUARD_MODEL` | `gemma4` | decisions model |
| `RM_GUARD_TIMEOUT_MS` | `1500` | decisions request timeout |
| `RM_GUARD_CLASSIFIER` | `typesafe/jev-latest` | `provider/model-id` resolved through pi's model registry |
| `RM_GUARD_JEV_KEY_FILE` | `~/.secrets/jev.key` | key file if the provider env key is unset |
| `RM_GUARD_REGISTER_PROVIDER` | unset | `1` registers the decisions endpoint as a pi classifier provider |
| `RM_GUARD_API_KEY` | unset | provider key when registering |

## Choosing a model

**Classifier backend (recommended, no extra config):** any classifier model pi
already knows — keys come from pi's credential system (`TYPESAFE_API_KEY`,
`OPENROUTER_API_KEY`, `/login`, …). Pick one with `RM_GUARD_CLASSIFIER`:

```sh
RM_GUARD_BACKEND=classifier RM_GUARD_CLASSIFIER=typesafe/jev-latest
RM_GUARD_BACKEND=classifier RM_GUARD_CLASSIFIER=openrouter/typesafe/jev-1.13
RM_GUARD_BACKEND=classifier RM_GUARD_CLASSIFIER=llama-cpp/gemma-3-4b-it  # llama.cpp router users
```

**Decisions endpoint as a pi provider:** pi has no built-in support for the
`/v1/decisions` route, but rm-guard can register it as a classifier provider
at startup, making `decisions/<model>` resolvable anywhere in pi (codemode
scripts included):

```sh
RM_GUARD_REGISTER_PROVIDER=1                     # registers provider "decisions"
RM_GUARD_BACKEND=classifier RM_GUARD_CLASSIFIER=decisions/gemma4
RM_GUARD_URL=http://grace:4000/v1/decisions      # baseUrl is derived by stripping /decisions
RM_GUARD_API_KEY=...                             # optional; provider key
```

With registration on, the direct-fetch decisions path is bypassed — the
request flows through pi's classifier machinery like any other provider.
Keep `RM_GUARD_BACKEND=decisions` if you want the standalone fetch instead.

Note the question phrasing is calibrated on the eval set; other models may need
a threshold tweak (`RM_GUARD_THRESHOLD`). Run `npm run eval:live` to check.

## Install

```sh
pi install git:github.com/sdougbrown/pi-rm-guard
# or from npm once published:
pi install npm:@dougbots/pi-rm-guard
```

## Development

```sh
npm test          # static gate + backend unit tests (offline)
npm run eval:live # calibration eval against live engines (needs the endpoints)
```

## Caveats

- The intent model reads the last user messages as data. Prompt-injected
  instructions inside those messages are framed as untrusted and rejected in
  testing, but this is a judgment model, not a security boundary. The static
  gate bounds blast radius to cwd and /tmp; run pi in a sandbox when that is
  not enough.
- Every decision is logged as an `rm-guard` session entry (command, intent,
  probability, targets, autoApproved) for audit.
