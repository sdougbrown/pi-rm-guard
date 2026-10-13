# Auto-deny: unacceptable targets blocked outright

## Sub-features

- Filesystem root (`/`), system trees (`/etc`, `/usr`, `/var`, `/boot`, `/bin`,
  `/sbin`, `/lib`, `/lib64`, `/opt`, `/dev`, `/proc`, `/sys`, `/run`), the
  whole `$HOME`, `/tmp` itself (and any ancestor of `/tmp`), and ancestors of
  the session cwd are denied with no dialog and no model call.
- Denial is decided entirely in the static gate — the decision backend must
  never be consulted for these.

## How to get to it (user POV)

The agent proposes something like `rm -rf /` or `rm -rf /etc`. The user sees a
tool error "rm-guard: auto-denied — <reason>" and no confirm dialog, in both
interactive and print mode.

## Driving it with run-case.sh

```sh
H=.agents/skills/verify-pi-rm-guard/helpers
$H/run-case.sh deny-root 'rm -rf /' '{"action":"A","probabilities":{"A":0.95,"B":0.03,"C":0.02}}'
```

Even though the stub decision model would approve, the command is blocked.

## Gotchas

- Check the session entry, not just the tool error: the proof is
  `gate: "denied"` with the reason (e.g. "/ is the filesystem root").
- Deleting the working directory itself (cwd) defers rather than denies — it
  is in scope but treated as "whole-project deletion", a human decision. Do
  not confuse the two; the session entry distinguishes them (`gate:
  "ineligible"` vs `gate: "denied"`).
- A symlink inside cwd pointing at a system path resolves physically and is
  denied — symlink escape attempts must not reach the model.
