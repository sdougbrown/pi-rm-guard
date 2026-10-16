# Redirections and heredocs: inert shell constructs around rm

## What it is

Two shell constructs that do not affect what an `rm` deletes:

- **Redirection operators** (`2>/dev/null`, `> log`, `>> log`, `</dev/null`,
  fd duplication `2>&1`, bash `&>file`, and the separated form `> /dev/null`)
  never enter rm's argv. A redirection with a clean word is inert for the gate;
  a word with expansions (`2>$(mktemp)`) still defers, because its text could
  hide a command substitution that executes.
- **Heredoc bodies** are data written to stdin, never commands. A quoted
  delimiter (`<<'EOF'`, `<<"EOF"`) makes the body fully literal — even a line
  reading `rm -rf /` in the body never executes, so the body is skipped. An
  unquoted delimiter keeps expansion in the body: `$(rm -rf /tmp/x)` on a body
  line executes, so unquoted bodies are still scanned and defer when a
  substitution invokes rm.
- **The exception is a heredoc consumed by a stdin script interpreter** —
  `bash`, `sh`, `python`, `node`, `awk`, `ssh`, and their family, anywhere in
  the opening line (so `cat <<EOF | bash` counts), or a consumer that cannot
  be resolved statically: a variable expansion (`I=bash; $I <<EOF`) or a
  function defined in the command (`I() { bash; }; I <<EOF`). That body
  executes as a script, so it is extracted and judged on its own, in its own
  child-shell scope: `bash <<'EOF'` with an `rm -rf /` body auto-denies, a
  benign script body stays absent, an in-scope `rm -rf /tmp/x` body goes to
  the model, and assignments inside the body never reach the parent
  command's variable timeline. A bare unassigned name is not a variable —
  bash looks it up as a command and fails — so `I=bash; I <<EOF` stays a data
  heredoc. **Here-strings** (`<<<`) follow the same rule: the word fed to an
  interpreter executes (`bash <<< 'rm -rf /'` auto-denies), while a
  data-consumer here-string stays inert (`cat <<< 'rm -rf /etc'` absent).

Terminator matching is strict (a line must be exactly the delimiter; `<<-`
allows leading tabs) — a line like `EOF; rm -rf dist` does not terminate a
heredoc and its text never executes, matching real bash. A missing terminator
consumes the rest of the command as body, also matching bash. A delimiter
containing `$`, a backtick, or a backslash is not extracted at all: bash's
terminator differs from the literal word, so every line is judged as live
shell, which can only over-gate.

Heredocs inside quotes or `$(...)`/backtick substitutions are not extracted;
their text is judged through the normal rules (mostly a conservative defer,
though a backtick-wrapped body line can be over-gated as live rm text).

## How to get to it (user POV)

Any `bash` tool call in a pi session. The common payoff: cleanup lines like
`rm -rf dist 2>/dev/null` and `cat > script <<'EOF' … EOF` no longer bounce to
the human with a misleading "target is not statically resolvable: 2>/dev/null"
or "unbalanced quoting around an rm mention" when the command is actually
safe or contains no rm at all.

## Driving it with run-case.sh

```sh
H=.agents/skills/verify-pi-rm-guard/helpers
D='{"action":"A","probabilities":{"A":0.95,"B":0.03,"C":0.02}}'
$H/run-case.sh approve-redirect 'rm -rf /tmp/rmguard-verify-victim 2>/dev/null' "$D"
$H/run-case.sh heredoc-quoted "$(printf 'cat > /tmp/rmguard-verify-victim/probe.txt <<%sEOF%s\nrm -rf /tmp/rmguard-verify-victim/marker\nEOF' "'" "'")" "$D"
$H/run-case.sh heredoc-sub    "$(printf 'cat <<EOF\n$(rm -rf /tmp/rmguard-verify-victim/marker)\nEOF')" "$D"
$H/run-case.sh heredoc-bash   "$(printf 'bash <<%sEOF%s\nrm -rf /tmp/rmguard-verify-victim/marker\nEOF' "'" "'")" "$D"
```

Expected end states (all mapped in run-case.sh's expectation table):

- `approve-redirect` — marker DELETED, session entry `action=approve
  autoApproved=true`, 1 decisions call: the gate judged the rm eligible
  despite the trailing redirection.
- `heredoc-quoted` — marker SURVIVED, no rm-guard session entry, 0 decisions
  calls: the `rm -rf` line is heredoc data, so nothing was gated; the probe
  file was written by `cat`.
- `heredoc-sub` — marker SURVIVED, session entry `gate=ineligible`, 0
  decisions calls: the substitution inside the unquoted body is real and
  executes, so it must defer.
- `heredoc-bash` — marker DELETED, session entry `action=approve
  autoApproved=true`, 1 decisions call: the interpreter-fed body is judged
  as live rm, not skipped as data. A `rm -rf /` body variant would deny.

## Gotchas

- `2>&1` must survive segment splitting: `&` between `>`/`<` and a digit is
  part of the redirection operator, not a command separator.
- The quoted-heredoc skip must not hide a live rm elsewhere in the same
  command: `cat > f <<'EOF' … EOF` followed by a real `rm -rf dist` is still
  judged eligible/deferred on its own merits.
- The skip never applies when the heredoc feeds a script interpreter: that
  body is extracted and judged as a script. The consumer window is the
  statement that opens the heredoc — joined across continuation lines
  ending in `\`, `|`, or `&&` — but a background boundary (`&` alone) ends
  it: `cat <<'EOF'; node build` keeps the body as data because the tail is
  a separate command, while `cat <<EOF | bash` still counts (pipelines
  feed the body onward).
- Body scanning for unquoted delimiters is quote-blind at the body's top
  level (quotes are literal data there), but a `$(...)` span is matched with
  full shell grammar — quotes and nesting count inside a substitution, so
  `$(echo ')' && rm …)` spans to the true closing paren. Subshell grouping
  is handled too: `$( (rm -rf …) )` defers.