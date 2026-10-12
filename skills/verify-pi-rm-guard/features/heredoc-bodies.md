# Heredoc bodies are data

## Sub-features

- An rm mention inside a heredoc body (`<<'EOF'`, `<<EOF`, `<<-EOF`, `<< EOF`)
  is absent from the gate — the body is input to the consuming command, never
  executed as shell. This removes two real-world false positives: "unbalanced
  quoting around an rm mention" and "rm is not in leading position" on plain
  `git commit -m "$(cat <<'EOF'...)"` calls.
- Heredocs nested inside a double-quoted command substitution are recognized
  (bash does not close the outer `"` until after the substitution's matching `)`).
- `<<` inside arithmetic (`$((...))`, `((...))`, `$[...]`) and test (`[[...]]`)
  contexts is a left shift, not a heredoc; operator detection is skipped there.
  `case` patterns and `=~` are not tracked: heredocs are legal inside case
  bodies, and a `<<` in a case pattern is pathological.
- Delimiter quoting and escaping are dequoted the way bash does before
  matching the terminator: `<<E"OF"`, `<<'E'OF`, `<<E\OF` all terminate at a
  line reading `EOF`. Whitespace between `<<` and the delimiter is skipped.
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

The `heredoc-mention` and `heredoc-delete` cases pass a multi-line command (the
commit-message heredoc) as the second argument — newlines and all, JSON-encoded
by the driver. `heredoc-mention` proves absence (no rm-guard entry, zero
decisions calls, the command's own side effects only); `heredoc-delete` proves
a real rm beside a heredoc still flows through the decision model
(autoApproved true, marker deleted).

## Gotchas

- The gate strips the body before segmentation, so quote imbalance inside the
  body no longer poisons the parse — but an unterminated heredoc defers, and
  that is the safe direction.
- The decisions stub must not be consulted for the heredoc-mention case:
  `stub/decisions-requests.jsonl` empty proves the gate saw no recursive rm.
