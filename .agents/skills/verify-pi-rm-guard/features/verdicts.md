# Honor the model's verdict

Run `../helpers/run-suite.sh` using the launch instructions in [../SKILL.md](../SKILL.md).
The approve, deny, defer, low-confidence, and error cases all use the same harmless
fixture deletion. Only the model response changes the outcome.

| Case | Stub response | Expected effect |
|---|---|---|
| `approve` | Approve, p=0.95 | Marker deleted; `action=approve`, `autoApproved=true` |
| `deny` | Deny, p=0.998 | Marker preserved; `action=deny`, `autoApproved=false` |
| `defer` | Ask, p=0.94 | Marker preserved; `gate=model-ask` |
| `low-conf` | Approve below threshold, p=0.5 | Marker preserved; `gate=model-ask` |
| `model-error` | Invalid stub JSON produces HTTP 500 | Marker preserved; `gate=model-error` |

Every case requires one decision request. No path determines a verdict.
A model error or request for confirmation asks the user when a UI exists;
without a UI it blocks. The real-pi harness proves the no-UI behavior; hook unit
tests cover accepting and rejecting interactive confirmation.
