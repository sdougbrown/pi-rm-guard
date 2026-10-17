# Supply evidence; evaluate the weights

The model judges the whole command from its text, cwd, recent user requests,
and bounded recent tool evidence. No static target list is presented as verified.
Direct and registered-provider requests use the same structured state and question
encoder. One per-label criteria definition supplies choice options, classifier
criteria, and boolean fallback criteria. A unit test compares both wire payloads.

The `context` case in `../helpers/run-suite.sh` supplies a prior tool result whose
text does not appear verbatim in the setup command. It checks that result, cwd,
and the current user request in `stub/decisions-requests.jsonl`. Other stubbed
cases prove that variables and globs reach the backend, not that weights approve them.

Run the live gates in [../SKILL.md](../SKILL.md) to assess actual judgment:

- `npm run eval:live` presents commands to weights without executing them.
- Live `run-case.sh approve-var` sends evidence through real pi to the configured
  weights; its approving response must produce deletion of only the fixture.
- `RM_GUARD_VERIFY_BACKEND=classifier` exercises the registered pi provider.

Inspect live requests and `stub/decisions-responses.jsonl` together with session
entries and marker state. Record endpoint/model and failures; do not describe
stubbed verdicts as evidence that a real model makes useful judgments.

Invalid probability values escalate as model errors. The model's explicit choice
controls the verdict when provided; confidence determines whether to escalate it.
Registered providers normalize letter choices to names and preserve confidence;
a missing choice is an API error, not a fabricated first-option verdict.
Classifier fallback applies only to the current request. A transient failure does
not disable later three-way judgments; backend unit tests exercise recovery.
A valid fallback approval can authorize execution after a failed choice probe;
the failure itself never supplies permission.

See [verdicts.md](verdicts.md) for response handling.
