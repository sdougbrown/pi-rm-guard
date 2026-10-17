# pi-rm-guard

## Model-first contract

The decision model owns deletion safety judgments. Detection only routes possible
`rm` commands to the model with command and session evidence. Do not add static
path policies, shell emulation, interpreter lists, or deterministic safety verdicts.
This extension reduces approval interruptions; it is not a sandbox.

Tests must prove evidence delivery and verdict handling, not enforce a parallel
safety policy. Evaluate model judgment against real weights separately from the
stubbed integration tests.

App verification: run `.agents/skills/verify-pi-rm-guard/SKILL.md` before claiming
user-facing work is done. The feature map in
`.agents/skills/verify-pi-rm-guard/features/` must be updated in the same change that
alters gated behavior.
