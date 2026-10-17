# Honor the model's verdict

Run `../helpers/run-suite.sh` using the launch instructions in [../SKILL.md](../SKILL.md).
The approve, deny, defer, low-confidence, and error cases all use the same harmless
fixture deletion. Only the model response changes the outcome.

| Case | Stub response | Expected effect |
|---|---|---|
| `approve` | Approve, p=0.95 | Marker deleted; `action=approve`, `autoApproved=true` |
| `approve-auth` | Approve behind a token-protected endpoint, both backend routes | Marker deleted; one authenticated request |
| `deny` | Deny, p=0.998 | Marker preserved; `action=deny`, `autoApproved=false` |
| `defer` | Ask, p=0.94 | Marker preserved; `gate=model-ask` |
| `low-conf` | Approve below threshold, p=0.5 | Marker preserved; `gate=model-ask` |
| `model-error` | Invalid stub JSON produces HTTP 500 | Marker preserved; `gate=model-error` |
| `malformed-model` | Approval probability is a string, not a number | Marker preserved; `gate=model-error` |

Each model-response case requires one decision request. The `invalid-backend`
case uses a misspelled backend setting: it preserves the marker, records
`gate=model-error`, and makes no model request. It must not select another engine.
No path determines a verdict.
A model error or request for confirmation asks the user when a UI exists;
without a UI it blocks. The real-pi harness proves the no-UI behavior; hook unit
tests cover accepting and rejecting interactive confirmation.
Escalation entries (`gate=model-ask`, `gate=model-error`) retain `userRequests`
and `evidence` alongside the command and reason. This preserves the collected
input context when the model asks or fails. Confirmation prompts still show
the command and escalation reason.
