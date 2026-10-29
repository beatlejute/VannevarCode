# Adaptation Runbook v3

This runbook defines the complete adaptation workflow for Vannevar Code to new Claude Code versions. It implements the engineering standard v3 (§§1–33) with Phase 0–20, Level A/B/C/D gates, signature forking, and independent review.

---

## Phase 0: Prerequisites & Setup

**Goal**: Verify environment and capture pristine baseline before any adaptation work begins.

### 0.1 Environment Verification
- Node.js >= 18
- VS Code engine ^1.85.0
- No active Claude Code sessions
- Isolated temporary directory for all mutable operations

### 0.2 Baseline Capture
```bash
# Capture repository state
git rev-parse HEAD > baseline-commit.txt
cat package.json | jq -r '.version' > baseline-version.txt
cat package.json | jq -r '.verifiedAgainst[]' > baseline-verifiedAgainst.txt
```

### 0.3 Pristine Bundle Acquisition
- Obtain pristine Claude Code bundle via explicit path (never implicit `~/.vscode/extensions` lookup)
- Compute and record SHA-256 hashes of all target files
- Store in `adaptation-evidence/pristine-hashes.json`

---

## Phase 1: Registry Validation (Level A)

**Goal**: Validate patch-points registry before any probe or adaptation.

### 1.1 Schema Validation
```bash
node scripts/adaptation/validate-registry.mjs runtime/patch-points-registry.json
# Expect: exit code 0
```

### 1.2 Runtime Consistency Check
```bash
node runtime/apply-patch.mjs --validate-registry
# Expect: exit code 0, one-to-one mapping confirmed
```

### 1.3 Registry Health Checks
- All patch points have stable semantic IDs (`PATCH-<surface>-<purpose>`)
- No duplicate IDs across patchPoints or variants
- Every `textual-fallback` variant has `justification`
- Third-party critical anchors have module-scope fingerprints
- No numeric webpack/module ID as sole owner identity

**Gate**: All Level A checks must pass → proceed to Phase 2. Any failure → **BLOCK**.

---

## Phase 2: Surface-Aware Diff & AST Analysis (Level A)

**Goal**: Analyze differences between pristine and current bundle using AST-first approach.

### 2.1 AST Probe Execution
```bash
node scripts/adaptation/probe.mjs \
  --dir <pristine-bundle-path> \
  --registry runtime/patch-points-registry.json \
  --out adaptation-evidence/probe-result.json
```

### 2.2 Probe Result Analysis
For each patch point, probe outputs:
- `variant`: `ast` | `legacy-textual` | `textual-fallback` | `literal`
- `owner/module-scope`: fingerprint match result
- `preconditions`: satisfied / not satisfied
- `matchCount`: exact hits
- `postconditionFeasibility`: can surgical edit be applied?
- `status`: `PASS` | `MISS` | `AMBIGUOUS` | `BLOCK`

### 2.3 Required Patch Points (required: true)
- **PASS** → ready for adaptation
- **MISS** → signature genuinely changed → proceed to Phase 3
- **AMBIGUOUS** → multiple variants match or owner mismatch → **BLOCK**, requires signature forking
- **BLOCK** → owner/module-scope mismatch → **REJECT/ROLLBACK**

### 2.4 Optional Patch Points (required: false)
- **PASS** / **MISS** (zero match acceptable) → continue
- **AMBIGUOUS** / **BLOCK** → treated as MISS with warning

**Gate**: No required patch point in `AMBIGUOUS` or `BLOCK` → proceed. Otherwise → **BLOCK** / **REJECT/ROLLBACK**.

---

## Phase 3: Signature Forking (Level B)

**Goal**: Create new variant for genuinely changed signatures; never modify working legacy signatures.

### 3.1 Forking Rules
1. **Never modify** existing `legacy-textual` variant definitions
2. Create new variant with `matcherKind: "ast"` or justified `textual-fallback`
3. New variant gets unique `variant.id` (e.g., `v2-ast`, `v2-textual-fallback`)
4. Original variant `state: "legacy"`, new variant `state: "active"`
5. Document `justification` for any `textual-fallback` with exact bounds, expected count, negative fixtures

### 3.2 AST Variant Creation
- Use `runtime/ast-locator.mjs` to determine raw source ranges
- Surgical edit by offsets only — **never regenerate whole bundle**
- Every normalized node/literal retains provenance to raw source range

### 3.3 Textual Fallback Justification (if AST not feasible)
- Exact bounds (file, start, end)
- Expected match count
- Negative fixtures (cases that must NOT match)
- Independent review sign-off required

**Gate**: All required patch points have applicable variant → proceed to Phase 4. Unresolvable → **ARCHITECTURE_REVIEW**.

---

## Phase 4: Semantic Normalization (Level A/B)

**Goal**: Analyze minified/obfuscated code without execution.

### 4.1 Normalization Run
```bash
node scripts/adaptation/normalize-js.mjs \
  --input <pristine-target-file> \
  --out adaptation-evidence/normalized-ir.json
```

### 4.2 Supported Patterns
- String-array mapping / constant indirection → static resolution with provenance
- Provably constant aliases → resolved with raw range
- Dynamic decoders, cycles, runtime-dependent → `UNRESOLVED` with provenance

### 4.3 Prohibited
- `eval`, `Function` constructor
- Unrestricted execution of upstream code
- Network access for deobfuscation

**Output**: JSON/IR with provenance — **not** modified source.

---

## Phase 5: Dry-Run Adaptation (Level A)

**Goal**: Apply current patcher to isolated copy without writing to real bundle.

### 5.1 Isolated Copy Creation
```bash
# Create disposable copy in system temp
cp -r <pristine-bundle> /tmp/adaptation-<timestamp>/
```

### 5.2 Dry-Run Execution
```bash
node runtime/apply-patch.mjs \
  --dir /tmp/adaptation-<timestamp>/ \
  --dry-run \
  --out adaptation-evidence/dry-run-result.json
```

### 5.3 Dry-Run Verification
- All required patch points: expected hit count achieved
- No syntax errors in modified files
- Backup files (`*.ccx-orig`) created correctly
- No writes outside isolated copy

**Gate**: Dry-run clean → proceed to Phase 6. Failures → analyze, fork signatures (Phase 3), retry. Persistent failures → **BLOCKED**.

---

## Phase 6: Syntax & Semantic Validation (Level A)

**Goal**: Verify adapted code is syntactically valid and semantically preserved.

### 6.1 Syntax Checks
```bash
# For each modified target file
node --check <adapted-file>
# Expect: exit code 0
```

### 6.2 Semantic Preservation
- Run targeted functional tests against adapted bundle (fixture-based)
- Verify `__ccx` marker preserved
- Verify no unintended behavioral changes

**Gate**: All syntax checks pass + semantic tests pass → proceed. Failures → **BLOCKED**.

---

## Phase 7: Restore Verification (Level A/B)

**Goal**: Prove safe recovery before any real write.

### 7.1 Exact Backup Restore
```bash
node runtime/apply-patch.mjs --panic-restore \
  --dir /tmp/adaptation-<timestamp>/ \
  --pristine-dir <pristine-bundle-path>
```
- Verify byte-for-byte equality with pristine

### 7.2 Registry-Governed Cleanup
- Only for entries with self-contained `restorePolicy`
- Requires: target marker present, registered policy, exact boundaries, preconditions, postcondition "markers removed + syntax valid"
- Multi-file restore is transactional (all-or-nothing)

### 7.3 Idempotency Check
- Second `--panic-restore` on already-restored bundle → no-op, success

**Gate**: All restore paths verified → proceed. Any restore failure → **BLOCKED** (do not proceed to real write).

---

## Phase 8: Real Adaptation (Level C — Human-in-the-Loop)

**Goal**: Apply adaptation to actual user bundle with explicit confirmation.

### 8.1 Pre-Flight Checklist
- [ ] All Level A/B gates passed
- [ ] Restore verified (Phase 7)
- [ ] Independent review completed (Phase 9)
- [ ] User has current backup / can reinstall

### 8.2 Execution
```bash
# Via VS Code command: "Vannevar: Panic restore / Safe mode" → confirm
# Or explicit CLI:
node runtime/apply-patch.mjs --dir <user-bundle-path>
```

### 8.3 Post-Adaptation Verification
- Run `npm test` (full regression suite)
- Verify `verifiedAgainst` updated only after successful adaptation
- Commit adapted bundle hashes

**Gate**: Green test suite + updated `verifiedAgainst` → `VERIFIED_ADAPTED`. Test failures → `BLOCKED` + panic restore.

---

## Phase 9: Independent Review (Level C)

**Goal**: Human review of adaptation evidence before commit/push/release.

### 9.1 Review Artifacts
- `adaptation-evidence/probe-result.json`
- `adaptation-evidence/dry-run-result.json`
- `adaptation-evidence/normalized-ir.json`
- `adaptation-evidence/restore-verification.json`
- Compatibility report (template: `compatibility-report-template.md`)

### 9.2 Review Criteria
- All required patch points resolved
- No `AMBIGUOUS` in final status
- Textual fallbacks justified and reviewed
- Native binary modification → `ARCHITECTURE_REVIEW` (mandatory)
- Remote telemetry default disabled confirmed

### 9.3 Review Outcome
- **APPROVE** → proceed to Phase 10
- **REQUEST_CHANGES** → return to Phase 3/4/5
- **REJECT** → `REJECTED_INCOMPATIBLE`

**Gate**: Independent review sign-off required. No automation substitute.

---

## Phase 10: VerifiedAgainst Gate

**Goal**: Update `verifiedAgainst` only after full validation.

### 10.1 Update Rule
- Add new version to `package.json:verifiedAgainst` **only** after:
  - All Level A/B/C gates passed
  - Independent review APPROVE
  - Full `npm test` green
  - Compatibility report generated

### 10.2 Prohibition
- Never add version based on prediction or partial validation
- `AMBIGUOUS` final status → automatic rejection

---

## Phase 11: Commit / Push / Release Separation

**Goal**: Enforce separation of concerns in release pipeline.

### 11.1 Commit
- Adapted source + updated `verifiedAgainst` + evidence hashes
- Conventional commit: `adapt: <version> — <status>`

### 11.2 Push
- Push to remote **only after** commit verified in CI
- CI runs: registry validation, adaptation tests, full `npm test`

### 11.3 Release
- VSIX packaging via `scripts/build-vsix.mjs`
- Release only after CI green + manual approval
- **Never** auto-release on push

---

## Phase 12–20: Edge Cases & Special Handling

### Phase 12: No Canary Channel
- Skip canary-specific probes
- Direct to stable channel analysis
- Document assumption in compatibility report

### Phase 13: Telemetry Unavailable
- Remote telemetry default `disabled` (policy)
- Local-only evidence collection
- Document limitation in report

### Phase 14: Native Binary Changed
- Trigger: `nativeBinaryModification => ARCHITECTURE_REVIEW` (policy)
- Full architecture review required
- Cannot proceed without explicit sign-off

### Phase 15: Last-Good → First-Bad Bisection
- When multiple versions skipped
- Binary search between last `VERIFIED_UNCHANGED` and first failure
- Document each step in evidence

### Phase 16: BLOCK / REJECT / ROLLBACK Procedures
- **BLOCK**: Stop, document reason, require human decision
- **REJECT**: Mark `REJECTED_INCOMPATIBLE`, do not adapt, advise reinstall
- **ROLLBACK**: Execute panic restore, verify byte-for-byte, advise reinstall if failed

### Phase 17: Safe Cleanup Verification
- After rollback: verify no Vannevar markers remain
- Syntax valid
- No orphaned `*.ccx-orig` files

### Phase 18: Evidence Archival
- Store all evidence in `adaptation-evidence/<version>/`
- Include: probe, dry-run, normalization, restore, review, compatibility report
- Hash and sign evidence bundle

### Phase 19: Compatibility Report Generation
```bash
node scripts/adaptation/validate-report.mjs \
  --input adaptation-evidence/compatibility-report.md \
  --policy docs/adaptation/adaptation-policy.json
```

### Phase 20: Final Status Assignment
Assign **exactly one** final status:
- `VERIFIED_UNCHANGED` — no changes needed
- `VERIFIED_ADAPTED` — adapted successfully
- `ARCHITECTURE_REVIEW` — native binary changed or unresolved semantic
- `BLOCKED` — required patch point unresolvable, safe path not proven
- `REJECTED_INCOMPATIBLE` — fundamental incompatibility

**Prohibited**: `AMBIGUOUS` as final status.

---

## Level Definitions Summary

| Level | Description | Automation |
|-------|-------------|------------|
| **A** | Fully automated, no human, no real bundle | CI, scripts |
| **B** | Fixture-based, explicit pristine path, no real install | Local runner |
| **C** | Human-in-the-loop, interactive, real bundle | VS Code command, manual |
| **D** | Production release, push, install | Manual approval only |

---

## Quick Reference: Status Transitions

```
START
  → Phase 0–2 (Level A) → BLOCK / REJECT_INCOMPATIBLE / proceed
  → Phase 3–7 (Level A/B) → BLOCKED / ARCHITECTURE_REVIEW / proceed
  → Phase 8 (Level C) → VERIFIED_UNCHANGED / VERIFIED_ADAPTED / BLOCKED
  → Phase 9 (Level C) → APPROVE / REQUEST_CHANGES / REJECT
  → Phase 10 → update verifiedAgainst
  → Phase 11 → commit → push (CI) → release (manual)
  → Phase 20 → FINAL STATUS (never AMBIGUOUS)
```

---

## Emergency Procedures

### Panic Restore (User-Facing)
**Command**: `Vannevar: Panic restore / Safe mode` (VS Code Command Palette)
- Warning + confirmation dialog
- Calls `runtime/apply-patch.mjs --panic-restore --dir=<resolved-bundle>`
- Success → reload prompt
- Refusal → warning with guidance
- Cancel → no action

### Safe Mode Activation
- If panic restore fails: `REJECTED_INCOMPATIBLE` guidance
- Reinstall Claude Code + Vannevar Code from marketplace
- Report issue with evidence bundle

---

## References

- Engineering Standard v3: `VannevarCode-adaptation-plan-v3.md` §§1–33
- Registry Schema: `runtime/patch-points-registry.json`
- Policy: `docs/adaptation/adaptation-policy.json`
- Templates: `compatibility-report-template.md`, `overlap-matrix-template.md`, `security-review-template.md`
- Implementation Validation: `docs/adaptation/implementation-validation.md`