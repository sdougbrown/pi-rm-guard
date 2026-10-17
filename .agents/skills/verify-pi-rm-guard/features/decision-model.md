# Supply evidence; evaluate the weights

The model judges the whole command from its text, cwd, recent user requests,
and bounded recent tool evidence. No static target list is presented as verified.
Direct and registered-provider requests use the same HTTP client, structured
state, question encoder, and choice-label decoder. `RM_GUARD_API_KEY` supplies an
optional Bearer token on both routes; protected-service tests cover missing,
incorrect, and valid tokens. The standalone live eval forwards the token too. The decision stub rejects incorrect endpoint
paths, so real-pi cases also check URL construction during valid provider setup.
Each case loads the default export in real pi with `registerProvider: true`.
Classifier cases use the real registry; skipping registration cannot produce
the expected request and verdict.
One per-label criteria definition supplies choice options, classifier
criteria, and boolean fallback criteria. A unit test compares both wire payloads.

The `context` case in `../helpers/run-suite.sh` supplies a prior tool result whose
text does not appear verbatim in the setup command. It checks that result, cwd,
and the current user request in `stub/decisions-requests.jsonl`. Other stubbed
cases prove that variables and globs reach the backend, not that weights approve them.

Run the live gates in [../SKILL.md](../SKILL.md) to assess actual judgment:

- `npm run eval:live` presents commands to weights without executing them.
  Its Jev credential comes from the runtime's environment/key-file resolver,
  including `RM_GUARD_JEV_KEY_FILE`. The standalone CLI is environment-driven;
  mirror pi settings through environment overrides when comparing configurations.
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
If the branch snapshot fails, the current request and raw command still reach
the model; a hook test exercises this recovery without inventing session evidence.

The configured deadline reaches the registered provider's fetch and the live
harness forwarder, without a shorter fixed cap. `provider-request.test.ts` checks
both delayed success and expiry with virtual time. A slow local forwarding proof
must also approve after more than 15 seconds when configured for 20 seconds:
`node .agents/skills/verify-pi-rm-guard/helpers/slow-forward-proof.mjs` delays a
fixture verdict for 16 seconds through the live forwarder. This is a transport
proof, not a weights evaluation.

See [verdicts.md](verdicts.md) for response handling.
