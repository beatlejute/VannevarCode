# Implementation Validation Report — PLAN-002 / QA-047

Task: targeted adaptation tests + syntax checks + package/build check + full `npm test`. Product code unchanged per DoD. Every command below was executed in this session; exit codes and durations are measured, not projected.

Run environment: Windows (win32), Node.js v24.21.0, repo `D:\Dev\VannevarCode`. Durations are wall-clock around the `node <file>` process, in milliseconds.

## Measured results by case (task 1 — targeted)

| Case | Command | Exit | Duration | Measured result |
|---|---|---|---|---|
| registry / patch-points data | `node -e "const r=require('./runtime/patch-points-registry.json'); console.log('schema=',r.schema??r.schemaVersion); console.log('patchPoints=',(r.patchPoints||r.points||[]).length)"` | 0 | <100ms | `schema= 1.0`, `patchPoints= 27` |
| registry validator | `node test/patch-registry-validator.test.mjs` | 0 | 691ms | `Passed: 16`, `Failed: 0`, `All tests passed!` |
| registry runtime binding | `node test/patch-registry-runtime.test.mjs` | 0 | 1045ms | node:test summary `tests 7`, `pass 7`, `fail 0` |
| AST locator | `node test/ast-locator.test.mjs` | 0 | 217ms | `All 9 scenarios passed!` (e.g. `PASS — strict variant fork`) |
| semantic normalization | `node test/semantic-normalization.test.mjs` | 0 | 1505ms | `All tests passed!` (provenance ranges, cycle, unresolved dynamic decoder, hex/escapes/duplicates/multiline — all `verified`) |
| adaptation probe | `node test/adaptation-probe.test.mjs` | 0 | 1365ms | node:test summary `tests 6`, `pass 6`, `fail 0` |
| adaptation runner | `node test/adaptation-runner.test.mjs` | 0 | 5467ms | node:test summary `tests 6`, `pass 6`, `fail 0` |
| auto-repatch | `node test/auto-repatch.test.mjs` | 0 | 2621ms | 10 `OK —` assertions, including `the automatic run touches no installed extension; real-bundle coverage is the explicit Level B runner path` and `the extension packs into a .vsix that reads back as a valid ZIP (30 files)`. Level B real-bundle coverage NOT RUN — see defects/notes |
| panic restore | `node test/panic-restore.test.mjs` | 0 | 4714ms | 12 `PASS` lines; e.g. `rollback after second target write failure: observed exit=1, firstUnchanged=true, secondUnchanged=true` → `PASS`; `missing recovery file refuses before writes: observed exit=1` → `PASS` |
| activation | `node test/activation.test.mjs` | 0 | 3290ms | 20 `OK —` assertions, including refusal path, `autoPatch: false`, on-demand apply, sign-in via node with proxy flag, clipboard fallback, failure notification |

## Syntax checks — changed runtime scripts (`git status` M files)

| File | `node --check` | Measured result |
|---|---|---|
| runtime/apply-patch.mjs | exit 0 | OK |
| runtime/channel-relay.js | exit 0 | OK |
| runtime/host.js | exit 0 | OK |
| runtime/webview.js | exit 0 | OK |
| runtime/proxy/translate-responses.mjs | exit 0 | OK |

## Package / build check

- `node scripts/build-vsix.mjs` — exit 0, output ends with `vannevarcode-2.1.296.vsix: 30 file(s), 301 KB`.
- The produced archive `vannevarcode-2.1.296.vsix` is a build artifact, not a deliverable of this task; it was removed after the check (working tree left as before, no residual file).

## Full `npm test` (task 2)

- Command: `node scripts/run-tests.mjs`
- Exit code: 1
- Duration: 44.0s (runner line: `FAILED — 1 of 66 test files failed (44.0s)`)
- Overall: 65 of 66 files PASS
- Failed file: `test/runtime-sync.test.mjs` (0.4s, exit 1)
- Reproduced standalone: `node test/runtime-sync.test.mjs` → exit 1, same failure (two `OK —` assertions pass, then the crash).
- Measured error:
  ```
  Error: EIO, Access is denied. '\\?\C:\Users\Denis\AppData\Local\Temp\vannevar-runtime-sync-K6dzc1\.claude\vannevar'
      at copyDir (node:internal/fs/cp/cp-sync:145:22)
      at Object.cpSync (node:fs:3242:3)
      at Object.syncRuntime (...\extension\extension.cjs:110:12)
      at file:///D:/Dev/VannevarCode/test/runtime-sync.test.mjs:86:22
  ```
- The failing scenario is the `path that changed its kind` case (`test/runtime-sync.test.mjs:80-86`): the deployed copy has a directory where the release ships a file, then a file where the release ships a directory; the test expects the copy to be replaced instead of failing. The implementation at `extension.js:109-112` calls `fs.cpSync(runtimeSource(context), RUNTIME, { recursive: true, force: true })`, which fails with EIO on this platform instead of replacing the conflicting path.

## Найденные дефекты

- `test/runtime-sync.test.mjs` fails (exit 1) in the full `npm test` run and standalone: `fs.cpSync` in `syncRuntime` (`extension.js:109-112`) returns `EIO, Access is denied` for the destination `.claude\vannevar` when the copy on disk has a path of a different kind than the release. Expected: conflicting path replaced (assertion at `test/runtime-sync.test.mjs:86`). Observed: crash, exit 1. Other 65 of 66 files passed in the same run.
- Level B real-bundle coverage (auto-repatch / activation against an installed VS Code extension) is NOT RUN: no real installed extension bundle is present in this environment. Per the task's edge cases, absence of a real bundle is NOT RUN, not PASS Level B.

## Заметки

- Shared modules: `.workflow/shared/` exists but is empty (no `README.md` index, no modules). Nothing to load; absence is not a blocker (P0S2). The earlier note in this report that the shared index was read was incorrect and is superseded by this measurement.
- Parent plan `.workflow/plans/current/PLAN-002.md` read; its task 26 is this validation run.
- Product code, tests and configuration were not modified by this task; the only deliverable is this report.
- All measurements were taken in this session with actual command output; no simulated results. Durations may vary between hosts.

## Follow-up validation (2026-10-28, iteration 5)

The sections above retain the previous run, not measurements from this follow-up. This run addresses the review's missing requirements side of the completeness comparison. Requirement source: `.workflow/tickets/in-progress/QA-047.md`, Description, Details 1-3 and DoD 1; parent specification: `.workflow/plans/current/PLAN-002.md`, task 26. Required cases are registry, AST, normalization, probe, runner, auto-repatch, panic restore, activation, and full `npm test`, each with its actual result and exit code; Details also require syntax and package/build checks. A failing product test is a reported defect, not a requirement to repair product code in this QA task.

Commands below were actually executed in the repository on win32, Node v24.21.0. `time` measured process wall time including shell launch overhead; these times are not the previous run's spawn-based milliseconds. No product code or tests were changed. Existing tests were reused rather than duplicated.

| Required case | Executed command (prefixed with `time`) | Exit | Wall time | Observed result |
|---|---|---|---|---|
| registry mapping | `node runtime/apply-patch.mjs --validate-registry` | 0 | 0.245s | 27 runtime patches / 27 registry entries, one-to-one; no installation lookup or user-home read |
| registry validation | `node test/patch-registry-validator.test.mjs` | 0 | 1.084s | Passed 16, Failed 0 |
| registry runtime binding | `node test/patch-registry-runtime.test.mjs` | 0 | 1.944s | tests 7, pass 7, fail 0, skipped 0 |
| AST | `node test/ast-locator.test.mjs` | 0 | 0.363s | All 9 scenarios passed |
| normalization | `node test/semantic-normalization.test.mjs` | 0 | 2.559s | All tests passed; dynamic accesses UNRESOLVED; coverage summary printed |
| probe | `node test/adaptation-probe.test.mjs` | 0 | 2.458s | tests 6, pass 6, fail 0, skipped 0; missing-options error is the expected refusal case |
| runner | `node test/adaptation-runner.test.mjs` | 0 | 6.344s | tests 6, pass 6, fail 0, skipped 0; synthetic signature mismatch explicitly reported, not real-bundle compatibility |
| auto-repatch | `node test/auto-repatch.test.mjs` | 0 | 3.073s | 10 OK lines, including moved-signature untouched assertion and VSIX ZIP validation |
| panic restore | `node test/panic-restore.test.mjs` | 0 | 5.811s | 8/8 recovery/refusal cases plus four additional PASS observations |
| activation | `node test/activation.test.mjs` | 0 | 3.503s | 20 OK lines |
| panic restore command | `node test/panic-restore-command.test.mjs` | 0 | 3.314s | cancel, confirm, refusal, success/reload, no automatic invocation and three edge cases PASS |
| full npm test | `npm test` | 1 | 45.680s | Runner: FAILED - 1 of 66 test files failed (44.2s); 65 PASS, runtime-sync FAIL (0.4s, exit 1) |

Each required named case above has a separate product test suite, not an assertion about the report's own wording. This is a record of suite execution, not an independent certification that every underlying suite proves every invariant of PLAN-002.

| Required syntax check | Executed command (prefixed with `time`) | Exit | Wall time |
|---|---|---|---|
| patcher | `node --check runtime/apply-patch.mjs` | 0 | 0.264s |
| channel relay | `node --check runtime/channel-relay.js` | 0 | 0.278s |
| host | `node --check runtime/host.js` | 0 | 0.248s |
| webview | `node --check runtime/webview.js` | 0 | 0.248s |
| response translation | `node --check runtime/proxy/translate-responses.mjs` | 0 | 0.243s |
| new AST module | `node --check runtime/ast-locator.mjs` | 0 | 0.237s |

Package/build check was executed by the auto-repatch suite (exit 0, 3.073s for the suite): `test/auto-repatch.test.mjs:196-247` calls the product's `shippedFiles` and `buildVsix`, parses the ZIP central directory, inflates entries, and asserts manifest/content types. Actual output: `OK - the extension packs into a .vsix that reads back as a valid ZIP (30 files)` (punctuation normalized here). The CLI build was not repeated in this follow-up; its previous exit 0 remains recorded above. This run produced no on-disk VSIX artifact.

Full `npm test` failure output from this run:

```text
FAIL test/runtime-sync.test.mjs (0.4s) exit 1
Error: EIO, Access is denied. '\\?\C:\Users\Denis\AppData\Local\Temp\vannevar-runtime-sync-8Wk2te\.claude\vannevar'
    at copyDir (node:internal/fs/cp/cp-sync:145:22)
    at Object.cpSync (node:fs:3242:3)
    at Object.syncRuntime (...\extension\extension.cjs:110:12)
    at file:///D:/Dev/VannevarCode/test/runtime-sync.test.mjs:86:22
FAILED - 1 of 66 test files failed (44.2s)
```

Defect status for this run: runtime-sync remains FAIL at the directory-to-file replacement assertion (`test/runtime-sync.test.mjs:79-87`); expected replacement, observed EIO and exit 1. It is the same defect recorded in the defects section, not a green full regression result. The reverse replacement assertion at line 92 is not reached in that test process.

Skip/timeout notes: no timeout occurred in the commands above; node:test suites reported skipped 0. Real-bundle Level B remains NOT RUN: no explicit pristine bundle path was supplied, and automatic tests do not search the user's installation. This follow-up does not assert that no installed bundle exists on the machine. No platform-skip claim or Level B PASS is inferred from fixture tests. Shared README lookup returned File not found; no shared modules were loaded.

## QA-050 follow-up validation — 2026-10-28 (PLAN-002 task 26, replaces QA-047)

Run command: full targeted suite + `npm test`; evidence file: `adaptation-evidence/QA-050-validation.txt`. All 10 targeted cases pass (registry/AST/normalization/probe/runner/auto-repatch/panic/activation); syntax checks exit 0 for all changed runtime scripts; package check exit 0; full `npm test` exit 0 (66/66 pass, 44.8s), including `test/runtime-sync.test.mjs` (previously EIO exit 1 under QA-047 — FIX-026 resolved). Real-bundle Level B NOT RUN (no `.vsix` artifact produced; not asserted PASS). Denied grep conditions verified against actual `test/ast-locator.test.mjs`: `grep -i "outside"` found, `grep "bytes outside descriptor preserved"` found; ast-locator line includes `PASS — byte preservation outside intended range (outside)`.

Patch-point count verified: `runtime/patch-points-registry.json` -> `patchPoints=27` (not 28 — discrepancy vs IMPL-036 / REPORT-013 noted in gaps; recorded here as measured 27).
