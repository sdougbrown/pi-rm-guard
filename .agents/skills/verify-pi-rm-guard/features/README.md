# Feature map — pi-rm-guard

Each file describes one user-facing feature: what it is, how the user reaches
it, how to drive it with the harness (see `../SKILL.md`), and the observable
end state that proves it works. This map is the maintained verification
source — update a file in the same change that alters the behavior.

- `static-gate.md` — literal recursive rm under cwd//tmp is judged; anything
  unresolvable defers
- `decision-model.md` — eligible commands are judged by the decision backend
  (approve / defer, with thresholds)
- `auto-deny.md` — unacceptable targets are blocked with no dialog and no
  model call
- `non-recursive-rm.md` — plain rm passes through untouched (pi's normal flow)
