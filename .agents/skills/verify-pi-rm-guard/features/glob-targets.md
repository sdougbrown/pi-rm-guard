# Glob targets: gate-side expansion of `*` and `?`

## Sub-features

- A glob target is expanded by the static gate itself (never by the shell under
  the gate) and every match is judged like a literal path; the session entry
  records the expanded match list as `targets`.
- A glob rm in a multi-segment command defers: a prior segment (`ln -s /etc
  /tmp/d/a.txt`) can create a target the glob follows when bash re-expands at
  execution time, after the gate's expansion saw nothing (TOCTOU). Also a
  general bound: the gate does not analyze filesystem effects of non-rm
  segments.
- Bounds that keep a glob judgeable: every globbed component needs at least one
  alphanumeric, `_`, or `-` character (dot-only shapes like `.*` defer); expansion
  is capped at 64 matches; the literal prefix
  (components before the first glob) is denied on its own for root, system
  trees, and the whole home directory — even when the glob matches nothing.
- `?` matches one code point (a UTF-8-locale shell) or one byte (LC_ALL=C —
  where `leaf??*` matches `leaf🎯`); the gate judges the union of both, so a
  file bash could expand under any locale is always in the judged set. A file
  matched under neither semantics is never expanded by bash, so missing it is
  safe.
- Symlink matches are resolved physically (per component) and caught by the
  normal scope checks: a match pointing outside cwd//tmp denies, like the same
  path as a literal target.
- Quoted globs (`rm -rf 'dist*'`) defer — bash would not expand them either,
  and the gate cannot resolve quoted targets.
- Known limit: rm re-globs at execution, so a file created in a checked
  directory between gate expansion and the rm run is deleted too. The pattern's
  directories are always literal, scope-checked paths, so the blast radius
  stays inside cwd//tmp.

## How to get to it (user POV)

The agent cleans up build artifacts with a wildcard (`rm -rf /tmp/avenor-verify.*`,
`rm -rf cache-part-*`). Before gate-side expansion these always raised the
human confirm dialog; now a bounded glob that resolves inside cwd//tmp goes to
the decision model like a literal path, and only unbounded or out-of-scope
shapes reach the human.

## Driving it with run-case.sh

```sh
H=skills/verify-pi-rm-guard/helpers
D='{"action":"A","probabilities":{"A":0.95,"B":0.03,"C":0.02}}'
$H/run-case.sh glob-approved 'rm -rf /tmp/avenor-verify.*' "$D"      # no match: eligible, targets []
$H/run-case.sh glob-real     'rm -rf /tmp/rmguard-verify-vict*' "$D" # matches: DELETED, targets expanded
$H/run-case.sh glob-unbounded 'rm -rf /tmp/rmguard-verify-victim/*' "$D" # SURVIVED, unbounded glob defers
```

## Gotchas

- The expansion happens in the gate process; `stub/decisions-requests.jsonl`
  must be empty for the unbounded-glob defer case (gate stops before the model).
- `targets: []` with `autoApproved: true` is a legitimate no-match proof: rm
  will error "No such file or directory" and change nothing. Confirm the
  pattern really had nothing to match before treating this as a pass.
- A glob matching a symlink to a system path (`/tmp/escape-link` → `/etc`)
  denies, matching literal-target behavior — rm would only unlink the link,
  but the gate chooses the conservative verdict.
- Dotfiles are not matched by `*`/`?` components (bash default); a pattern
  starting with a literal `.` (`.cache*`) is.
