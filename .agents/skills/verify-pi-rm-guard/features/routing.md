# Route recursive-force rm commands

Detection routes commands whose text contains an `rm` token together with both
recursive and force flags — `rm -rf`, `rm -fr`, `rm -r -f`, `rm -Rf`,
`rm --recursive --force`, in any position — to the model; it never judges
safety. Flag matching is lexical over the whole command text: quoted mentions
of recursive-force rm route too, and a neighboring command's flags can
over-route, which costs one model call and never a missed route. Plain `rm`,
single-flag `rm`, and `git rm --cached` pass through unguarded — the same
commands run unguarded without this extension. Detection is not a shell
interpreter and does not promise to find obfuscated commands or external
scripts.

Run `../helpers/run-suite.sh` from its own directory, or use the full helper path
from the repository root. Its `approve-var`, `approve-glob`, `approve-redirect`,
`flag-split`, `heredoc-bash`, `heredoc-sub`, and `context` cases require one model
request and deletion of the fixture marker. `heredoc-quoted` requires one approving
request but preserves the marker: the body is printed, not executed.

The `non-recursive`, `recursive-only`, and `absent` cases require no model request
or rm-guard entry and remove the marker: `non-recursive` runs plain `rm`,
`recursive-only` runs `rm -r` without force, and `absent` uses
`find "@VICTIM@" -name marker -delete`. These fixtures prove routing and
execution, not the model's understanding of shell syntax.

See [decision-model.md](decision-model.md) for evidence and actual-weight checks.
