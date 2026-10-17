# Route possible rm commands

Detection sends possible `rm` commands to the model; it never judges safety.
Variables, globs, paths outside cwd, non-recursive `rm`, and quoted mentions
are not reasons to bypass the model or ask a human automatically.
`git rm --cached` has no static exemption. Detection is not a complete shell
interpreter and does not promise to find obfuscated commands or external scripts.

Run `../helpers/run-suite.sh` from its own directory, or use the full helper path
from the repository root. Its `approve-var`, `approve-glob`, `approve-redirect`,
`heredoc-bash`, `heredoc-sub`, and `non-recursive` cases require one model request
and deletion of the fixture marker. `heredoc-quoted` requires one approving
request but preserves the marker: the body is printed, not executed.

The `absent` case uses `find "@VICTIM@" -name marker -delete`. It requires no
model request or rm-guard entry and removes the marker. These fixtures prove
routing and execution, not the model's understanding of shell syntax.

See [decision-model.md](decision-model.md) for evidence and actual-weight checks.
