# Static gate: recursive rm with resolvable targets

## Sub-features

- Literal targets (`rm -rf dist`, `rm -rf /tmp/foo/build-123`) are eligible and
  go to the decision model.
- Variable indirection resolved from literal assignments in the same command
  (`WT=/tmp/x; rm -rf $WT`) behaves like a literal target.
- Anything the gate cannot resolve — `$VAR` with no literal assignment, globs
  (`*`, `?`), quoted targets, command substitution, backticks — defers to a
  human (in print mode: fails closed with a block).
- Scope: targets must resolve (physically, per path component) inside the
  session cwd or `/tmp`; symlink escapes (`leak` → `$HOME/.ssh`,
  `link/../etc`) cannot pass.
- Heredoc bodies are data, not commands: an rm mention inside
  `<<'EOF'`/`<<EOF`/`<<-EOF` (including inside a double-quoted command
  substitution, the `git commit -m "$(cat <<'EOF'...)"` shape) is absent from
  the gate; a real rm beside a heredoc is still judged; an unterminated
  heredoc defers (the gate cannot know where the body ends). See
  `heredoc-bodies.md`.
- Mixed commands (recursive plus plain rm, rm behind `sudo`/`xargs`/pipes, rm
  inside a command substitution that is not a heredoc consumer) defer.

## How to get to it (user POV)

Any `bash` tool call in a pi session. The user sees nothing for non-recursive
rm; for an unresolvable recursive rm in an interactive session a confirm
dialog appears titled "rm-guard: approve recursive delete?" with the command
and the defer reason; in print/JSON/RPC mode the call is blocked (fail-closed).

## Driving it with run-case.sh

```sh
H=skills/verify-pi-rm-guard/helpers
D='{"action":"A","probabilities":{"A":0.95,"B":0.03,"C":0.02}}'
$H/run-case.sh eligible-literal 'rm -rf /tmp/rmguard-verify-victim' "$D"
$H/run-case.sh defer-glob       'rm -rf /tmp/rmguard-verify-vic*'   "$D"
$H/run-case.sh defer-var        'rm -rf $SOME_VAR'                  "$D"
```

## Gotchas

- The defer happens in the static gate *before* the decision model is
  consulted — `stub/decisions-requests.jsonl` must be empty for defer cases.
  If the stub got a request, the gate let the command through and the case is
  a regression.
- The command the stub issues is exactly the literal `<command>` string; the
  guard reads the same string, so cases are reproducible.
- A quoted glob (`rm -rf '/tmp/x*'`) still defers — quotes make the target
  unresolvable, which is correct (bash would not expand it either).
- In print mode a defer is a hard block, not a dialog; do not interpret the
  block message as a deny. Denies carry `gate: "denied"`, defers
  `gate: "ineligible"` in the session entry.
