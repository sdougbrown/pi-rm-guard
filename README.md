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

2. **Decision model** — one yes/no question about intent alignment: *"Did the user ask
   the agent to delete these paths?"* The model sees the command and the last user
   messages from the session. Two backends:
   - `decisions` (default): a `/v1/decisions` endpoint, e.g. a local llama.cpp router
     running `gemma4`. Threshold 0.85.
   - `jev`: TypeSafe's Jev classifier via `ctx.modelRegistry.classify()`. Threshold 0.6.

3. **Fallback** — below threshold, on model error, or with no UI (print/JSON/RPC
   mode), the command is **blocked, never silently run**. In interactive mode a
   confirmation dialog asks; print mode fails closed.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `RM_GUARD_BACKEND` | `decisions` | `decisions` or `jev` |
| `RM_GUARD_THRESHOLD` | backend default | minimum p(yes) to auto-approve |
| `RM_GUARD_URL` | `http://localhost:4000/v1/decisions` | decisions endpoint |
| `RM_GUARD_MODEL` | `gemma4` | decisions model |
| `RM_GUARD_TIMEOUT_MS` | `1500` | decisions request timeout |
| `RM_GUARD_JEV_MODEL` | `jev-latest` | classifier model id |
| `RM_GUARD_JEV_KEY_FILE` | `~/.secrets/jev.key` | key file if `TYPESAFE_API_KEY` is unset |

## Install

```sh
pi install npm:pi-rm-guard        # once published
# or locally:
pi install ~/Code/pi-rm-guard
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
