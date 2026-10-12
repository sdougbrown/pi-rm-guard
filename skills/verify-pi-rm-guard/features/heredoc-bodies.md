# Heredoc bodies are data

## Sub-features

- An rm mention inside a heredoc body (`<<'EOF'`, `<<EOF`, `<<-EOF`) is absent
  from the gate — the body is input to the consuming command, never executed as
  shell. This removes two real-world false positives: "unbalanced quoting
  around an rm mention" and "rm is not in leading position" on plain
  `git commit -m "$(cat <<'EOF'...)"` calls.
- Heredocs nested inside a double-quoted command substitution are recognized
  (bash does not close the outer `"` until after the substitution's matching `)`).
- A real rm beside a heredoc (`rm -rf dist <<'EOF'`) is still judged normally —
  expansion, scope, and the decision model all apply.
- An unterminated heredoc defers: the gate cannot know where the body ends, so
  it cannot prove the rest of the command is the only executable part.
- The delimiter must be a whole line (leading tabs allowed for `<<-`); bodies
  accumulate FIFO when a line declares several heredocs.

## How to get to it (user POV)

Before this change, any agent command containing a commit-message heredoc that
mentioned `rm -rf` (extremely common: commit messages describing build
cleanup) raised the human confirm dialog. Now the call flows through pi's
normal path unless a real recursive rm is present.

## Driving it with run-case.sh

```sh
H=skills/verify-pi-rm-guard/helpers
D='{"action":"A","probabilities":{"A":0.95,"B":0.03,"C":0.02}}'
$H/run-case.sh heredoc-mention 'git commit -m "$(cat <<'"'"'EOF'"'"'
message mentioning rm -rf artifacts
