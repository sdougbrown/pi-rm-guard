# Heredoc bodies are data

## Sub-features

- An rm mention inside a heredoc body (`<<'EOF'`, `<<EOF`, `<<-EOF`, `<< EOF`)
  is absent from the gate — the body is input to the consuming command, never
  executed as shell. This removes two real-world false positives: "unbalanced
  quoting around an rm mention" and "rm is not in leading position" on plain
  `git commit -m "$(cat <<'EOF'...)"` calls.
- An UNQUOTED delimiter means bash expands the body: a command substitution
  (`$(...)`, backtick) in an unquoted body is passed through and judged when
  the line is quote-free with balanced parens (the common commit-message and
  template shapes) and defers the whole command otherwise — a quote-blind
  paren balance undercounts when a `)` hides inside a quoted string, so no
  expansion lines are ever swallowed. Parameter expansions (`${VAR}`, `$VAR`)
  expand into data for the consuming command and never run as commands, so
  their lines stay data. Quoted bodies stay data.
- An unquoted `#` at word position starts a comment: operator detection stops
  there for the line, so `echo hi # <<EOF` cannot open a phantom heredoc that
  swallows a live command on a body-position line. Word position: line start,
  a `[ \t;&|]` character, or a `)` that closed a subshell or arithmetic group
  (`(true)#`, `((1))#`) — including one nested inside a substitution — while a
  `#` glued after a substitution's own final `)` (`x=$(hi)#`) or after word
  characters is part of the word in bash, and mid-word `#` never starts one.
- A double-quoted command substitution's closing `)` does not close the outer
  `"`; consuming the `"` that immediately follows does. A `#` at word position
  inside the substitution is a comment too. A `<<` after untracked nesting
  (quotes, `[[`, `((`, backtick, standalone `case`) inside the substitution
  defers instead of opening a phantom heredoc.
- Heredocs nested inside a double-quoted command substitution are recognized
  (bash does not close the outer `"` until after the substitution's matching `)`).
- `<<` inside arithmetic (`$((...))`, `((...))`, `$[...]`) and test (`[[...]]`)
  contexts is a left shift, not a heredoc; operator detection is skipped there
  (a `]` closes a subscript, not the arithmetic context). Inside a
  double-quoted command substitution, nested constructs (quotes, `[[`, `((`,
  backticks) are not fully tracked — a `<<` seen there defers instead of
  opening a phantom heredoc. `case` patterns and `=~` are not tracked:
  heredocs are legal inside case bodies, and a `<<` in a case pattern is
  pathological.
- Delimiter quoting and escaping are dequoted the way bash does before
  matching the terminator: `<<E"OF"`, `<<'E'OF`, `<<E\OF` all terminate at a
  line reading `EOF`. Dollar-quotes dequote too (`<<$'EOF'`, `<<$"EOF"` →
  `EOF`), as do escapes inside double-quoted delimiters (`<<"E\$OF"` →
  `E$OF`). An empty quoted delimiter (`<<''`) is real: its body ends at the
  empty line. Whitespace between `<<` and the delimiter is skipped. ANSI-C
  escapes inside `$'...'` change the word (`$'\x45OF'`); the gate cannot model
  them, so such a delimiter never closes here and the command defers.
- The unquoted delimiter word is a shell word: it runs until whitespace or a
  metacharacter, so delimiters may contain `-`, `.`, `$` etc. (`<<EOF-x`,
  `<<E.OF`). The `<<-` tab-strip flag applies only when the dash immediately
  follows `<<` — with whitespace between (`<< -EOF`) the dash is part of the
  word. A delimiter word ending in a line-continuation backslash spans lines;
  the gate cannot model that, so a heredoc opened on a continued operator line
  defers (bash joins the continuation before body collection — swallowing the
  joined command as body would be unsafe). `<<<` here-strings never open
  a heredoc.
- A real rm beside a heredoc (`rm -rf dist <<'EOF'`) is still judged normally —
  expansion, scope, and the decision model all apply.
- An unterminated heredoc defers: the gate cannot know where the body ends, so
  it cannot prove the rest of the command is the only executable part.
- Known narrowing (accepted risk, maintainer decision 2026-10-13): a quoted
  body fed to an interpreter (`bash <<'EOF'`, `source /dev/stdin`) executes as
  shell while the gate treats it as data — running an evaluated `rm` inside a
  heredoc consumed by an interpreter is an unusual enough shape that consumer
  whitelisting/deferral was judged not worth the false-positive cost for this
  extension's scope.
- A command substitution inside a double-quoted segment executes in bash, so
  the segment is not strippable: an rm mention in it defers ("unbalanced
  quoting around an rm mention"); benign quoted substitutions and quoted rm
  mentions stay absent. This closes a pre-existing gap where `echo
  "$(rm -rf /)"` was judged absent on every branch.
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
(autoApproved true, marker deleted). The `arith-shift` case proves a real rm
AFTER arithmetic `<<` in the same command is still judged.

## Gotchas

- The gate strips the body before segmentation, so quote imbalance inside the
  body no longer poisons the parse — but an unterminated heredoc defers, and
  that is the safe direction.
- The decisions stub must not be consulted for the heredoc-mention case:
  `stub/decisions-requests.jsonl` empty proves the gate saw no recursive rm.
