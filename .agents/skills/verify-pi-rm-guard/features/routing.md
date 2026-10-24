# Route possible rm commands

Detection sends commands containing an `rm` token with both recursive and force
flags — `rm -rf`, `rm -fr`, `rm -r -f`, `rm -Rf`, `rm --recursive --force`, and
flags after paths — to the model; it never judges safety. This mirrors pi's
built-in guard scope, so only commands pi would already halt can trigger a
decision-model call. Plain `rm`, single-flag `rm`, and `git rm --cached` pass
through unguarded, as they do without this extension. Quoted mentions of
recursive-force rm still route. Detection is not a complete shell interpreter
and does not promise to find obfuscated commands or external scripts.

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
