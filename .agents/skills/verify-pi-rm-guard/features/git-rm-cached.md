# `git rm --cached` is index-only

## Sub-features

- `git rm --cached ...` only unstages paths; the files stay on disk. Segments
  containing it are inert for the gate: no rm-guard entry, no model call.
- `git rm` WITHOUT `--cached` does delete from disk (and `git rm -r` is a
  recursive delete) — those segments still defer to a human ("rm is not in
  leading position"), the fail-safe direction.

## How to get to it (user POV)

Unstaging accidentally committed files (`git rm --cached secret.pid && git
commit --amend`) used to raise the human confirm dialog because the token
`rm` appears in a non-rm-leading segment. Now the call flows through pi's
normal path.

## Driving it with run-case.sh

The `git-rm-cached` case passes the real multi-segment amend flow:

```sh
$H/run-case.sh git-rm-cached 'git rm --cached mcp.pid mcp2.pid -q && rm -f mcp.pid mcp2.pid && git commit --amend --no-edit -q && git show --stat HEAD | tail -8 && git push -f 2>&1 | tail -1' "$D"
```

## Gotchas

- The index-only carve-out requires the literal `--cached` flag anywhere in
  the segment; `git rm -f` (worktree delete) still defers.
- The command's own side effects (commit, push) are outside the gate — the
  proof is the negative: no rm-guard session entry, zero decisions calls.
