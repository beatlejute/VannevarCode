# QA-056 — Criterion 8 verification (PLAN-002)

Date: 2026-10-28.
Criterion 8, verbatim (PLAN-002.md:782-783): «Panic Restore command не запускается автоматически.
Проверка: `node test/activation.test.mjs` → exit 0; Task 21 содержит пять фактических UI outcomes».

## Part 1 — activation tests

Command: `node test/activation.test.mjs` (run verbatim from the project root, 2026-10-28).
Measured exit code: 0. Output: 20 `OK —` lines, no failures.
The suite drives `activate()` through first install, unchanged version, re-apply, extension
update, patcher reject path, autoPatch off and the on-demand command, asserting exact
notification counts (test/activation.test.mjs:243,353,362) and the exact spawn set
(test/activation.test.mjs:226-236,344-347); an automatic invocation of the Panic Restore
command would add a spawn or a notification outside those counted assertions and fail the run.

Part 1 status: PASS.

## Part 2 — five actual UI outcomes (QA-055 recheck, Task 21)

Source: docs/adaptation/panic-restore-manual-check.md:72-102, section «QA-055 Recheck
(2026-10-28) — interactive run»: an interactive HUMAN operator executed all five cases in a
disposable Extension Development Host with isolated HOME and a synthetic
`anthropic.claude-code-9.9.9` bundle; the earlier agent-only records (lines 41-57) are
explicitly superseded by this run (lines 74-78) and are not the outcomes verified here.

Outcomes (case → measured result and observation):

- command visible: PASS — `Vannevar: Panic restore / Safe mode` found in the Command Palette
  of the isolated host (`package.json:35`), no startup error notification
  (manual-check line 94).
- warning: PASS — confirmation text «Vannevar: Panic restore - restore from .ccx-orig backup? …»
  with `Restore` and `Cancel` actions observed (`extension.js:459-463`; manual-check line 95).
- cancel: PASS — with `Cancel` selected, no patcher entry in the extension log, bundle files
  byte-identical before/after (`extension.js:464`; manual-check line 96).
- refusal: PASS — with no `*.ccx-orig` backup, `Restore` produced the warning
  «Vannevar: panic restore failed …» with `Show log`, bundle stayed byte-identical
  (`extension.js:475-481`, `runtime/apply-patch.mjs:787-789`; manual-check line 97).
- success/reload: PASS — with valid exact backups, completion message with `Reload`; the
  operator selected it and the isolated window reloaded; files became byte-identical to their
  `*.ccx-orig` copies (`extension.js:483-489`, `runtime/apply-patch.mjs:815-824`;
  manual-check line 98).

Accounting (manual-check lines 100-102): 5 specified cases, 5 executed, 5 PASS, 0 FAIL,
0 BLOCKED.

Part 2 status: PASS.

## Verdict

Criterion 8 is confirmed by measured results: part 1 — activation tests exit code: 0;
part 2 — five actual interactive outcomes recorded in the recheck section, all PASS.
Divergences: none.
