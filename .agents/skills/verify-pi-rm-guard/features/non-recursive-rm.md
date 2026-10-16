# Non-recursive rm: pass-through

## Sub-features

- Plain `rm file` (no `-r`/`-R`/`--recursive`) is not this extension's
  concern: no gate entry, no model call, no dialog — pi's normal tool flow.
  That holds even when targets are not statically resolvable (`rm -f
  /tmp/probe*.ts`): unresolvable targets only matter once the rm is
  recursive.
- Two exceptions keep deferring even without `-r`: targets that execute
  something (command substitution, backticks) and targets whose expansion
  could be flag-shaped — a variable (`rm $X`, since `$X` may expand to
  `-r ~`) or an expansion with no static prefix (`rm *`, which can match a
  file literally named `-rf` and turn recursive).
- Commands that merely *mention* `rm -rf` inside a quoted string are absent
  from the gate and must not trigger anything.

## How to get to it (user POV)

The agent cleans up a single file (`rm /tmp/foo.log`) or echoes a string
containing "rm -rf". Nothing intercepts the call; the command just runs.

## Driving it with run-case.sh

```sh
H=.agents/skills/verify-pi-rm-guard/helpers
$H/run-case.sh absent 'rm /tmp/rmguard-verify-victim/marker' '{"action":"A","probabilities":{"A":0.95,"B":0.03,"C":0.02}}'
$H/run-case.sh absent-glob 'rm -f /tmp/rmguard-verify-victim/marker*' '{"action":"A","probabilities":{"A":0.95,"B":0.03,"C":0.02}}'
```

## Gotchas

- The proof is a *negative*: the session log must contain **no** `rm-guard`
  entry and `stub/decisions-requests.jsonl` must be empty, while the marker
  is DELETED.
- A command mixing plain and recursive rm (`rm a && rm -rf b`) defers — the
  gate treats any mixed command as unjudgeable. That case belongs to
  static-gate.md, not here.
- A recursive rm with an unresolvable target still defers
  (`rm -rf /tmp/x*`): the pass-through here is specific to rm without a
  recursive flag.
