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

Terminator matching is strict (a line must be exactly the delimiter; `<<-`
allows leading tabs) — a line like `EOF; rm -rf dist` does not terminate a
heredoc and its text never executes, matching real bash. A missing terminator
consumes the rest of the command as body, also matching bash.

Heredocs inside quotes or command substitutions are not extracted; they defer
through the normal unresolvable rules.

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

## Gotchas

- `2>&1` must survive segment splitting: `&` between `>`/`<` and a digit is
  part of the redirection operator, not a command separator.
- The quoted-heredoc skip must not hide a live rm elsewhere in the same
  command: `cat > f <<'EOF' … EOF` followed by a real `rm -rf dist` is still
  judged eligible/deferred on its own merits.
- Body scanning for unquoted delimiters is quote-blind: `$(rm …)` inside
  `"…"` on a body line still expands in an unquoted heredoc and must defer.