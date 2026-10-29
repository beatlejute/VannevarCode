# Security Review Template

**Version**: {{VERSION}}
**Date**: {{DATE}}
**Adaptation Run ID**: {{RUN_ID}}
**Claude Code Version**: {{CLAUDE_VERSION}}

---

## 1. Purpose

This security review evaluates the adaptation for:
- Supply chain integrity
- Code injection risks
- Telemetry and data exfiltration
- Privilege escalation vectors
- Integrity of recovery mechanisms

---

## 2. Scope

| Component | In Scope | Out of Scope |
|-----------|----------|--------------|
| Patch Definitions | ✅ | |
| Registry Validation | ✅ | |
| AST Locator / Normalization | ✅ | |
| Adaptation Runner | ✅ | |
| Panic Restore | ✅ | |
| VS Code Command Registration | ✅ | |
| User Configuration | | ✅ |
| Upstream Claude Code Binary | | ✅ |
| Network Infrastructure | | ✅ |

---

## 3. Supply Chain Integrity

### 3.1 Pristine Bundle Verification
- [ ] Pristine bundle obtained via explicit path (no implicit `~/.vscode/extensions` lookup)
- [ ] SHA-256 hashes recorded for all target files before adaptation
- [ ] Hashes verified after adaptation matches expected modifications only
- [ ] No full proprietary bundles stored in Git

### 3.2 Dependency Integrity
- [ ] No new runtime dependencies added without architecture review
- [ ] Parser/traversal toolchain (AST) vetted for supply chain risk
- [ ] All dependencies pinned to exact versions in `package.json`
- [ ] No `eval`, `Function`, or unrestricted execution of upstream code

### 3.3 Build Artifact Integrity
- [ ] VSIX packaging includes only intended runtime files
- [ ] Registry JSON shipped with extension (no separate YAML dependency)
- [ ] No credentials, tokens, or prompts in build artifacts

---

## 4. Code Injection & Execution Risks

### 4.1 Patch Application
- [ ] Patches applied to raw pristine source, never regenerated source
- [ ] Surgical edits by offset only — no whole-file regeneration
- [ ] Expected hit count validated before write
- [ ] Fail-closed: mismatch between runtime and registry → abort before write

### 4.2 Semantic Normalization
- [ ] Restricted static evaluator with allowlist only
- [ ] No dynamic code execution (`eval`, `Function`, child processes)
- [ ] Network access prohibited for deobfuscation
- [ ] Unresolved values marked `UNRESOLVED` with provenance

### 4.3 Probe & Runner
- [ ] Probe accepts explicit `--dir`, `--registry`, `--out` — no implicit user-home fallback
- [ ] Runner writes only to explicit `--out` directory
- [ ] No writes to user config, installed extension, or `package.json`
- [ ] No production OAuth/API credentials used

---

## 5. Telemetry & Data Exfiltration

### 5.1 Remote Telemetry
- [ ] Default: **disabled** (per adaptation policy)
- [ ] Opt-in only with explicit user consent
- [ ] No user content, prompts, code, or session data transmitted
- [ ] Telemetry endpoint configurable, not hardcoded

### 5.2 Local Data Handling
- [ ] Adaptation evidence stored in explicit `--out` directory only
- [ ] No reads from `~/.claude`, `~/.vscode/extensions` in automatic tests
- [ ] Temporary files in system temp only, cleaned up on teardown
- [ ] No persistent local storage of upstream bundle content

---

## 6. Privilege Escalation & Integrity

### 6.1 Panic Restore Security
- [ ] Recovery priority enforced: exact backup → pristine artifact → registry-governed → refuse
- [ ] Controlled cleanup requires: target marker, registered policy, exact boundaries, preconditions, postcondition verification
- [ ] Multi-file restore is transactional (all-or-nothing)
- [ ] Unknown marker/boundary → refuse + reinstall guidance (no silent partial restore)
- [ ] Panic restore never runs automatically — explicit user confirmation required

### 6.2 VS Code Command
- [ ] Command `vannevar.panicRestore` requires explicit user confirmation
- [ ] Warning dialog explains risks before execution
- [ ] Success path prompts reload (not auto-reload)
- [ ] Refusal path shows guidance, does not execute partial restore
- [ ] Command not invoked on activation or auto-patch

### 6.3 File System Permissions
- [ ] No writes outside explicit target directories
- [ ] Backup files (`*.ccx-orig`) created with same permissions as source
- [ ] No elevation of privileges required

---

## 7. Recovery Mechanism Integrity

### 7.1 Backup Integrity
- [ ] `*.ccx-orig` files created before any modification
- [ ] Backup integrity verified (byte-for-byte match on restore)
- [ ] Stale backup detection (hash mismatch → refuse)

### 7.2 Restore Verification
- [ ] Exact backup restore tested and verified
- [ ] Explicit pristine restore tested and verified
- [ ] Registry-governed cleanup tested with valid and invalid markers
- [ ] Multi-file rollback tested (transactional semantics)
- [ ] Idempotent second restore verified (no-op success)

### 7.3 Failure Modes
| Failure Mode | Detection | Response |
|--------------|-----------|----------|
| Marker without backup | Pre-check | Refuse + guidance |
| Foreign `__ccx` marker | Owner verification | Refuse + guidance |
| Half-restored pair | Transaction check | Rollback + refuse |
| Pristine mismatch | Hash comparison | Refuse + guidance |
| Syntax corruption | `node --check` | Refuse + guidance |
| Target missing | Existence check | Refuse + guidance |

---

## 8. Native Binary Modification

### 8.1 Policy Enforcement
- [ ] `nativeBinaryModification => ARCHITECTURE_REVIEW` enforced in policy
- [ ] Any adaptation involving native binary changes triggers mandatory architecture review
- [ ] Architecture review sign-off required before proceed
- [ ] No automatic patching of native binaries

---

## 9. Test Security Hygiene

### 9.1 Automatic Test Isolation
- [ ] Mutable root only in system temporary directory
- [ ] Teardown on all outcomes (including assertion failure)
- [ ] Read-only fixtures only from `test/fixtures/`
- [ ] No writes to working repository
- [ ] No reads/writes to real `~/.claude`
- [ ] No implicit reads of real `~/.vscode/extensions`
- [ ] No launch of real user Claude CLI
- [ ] No production OAuth/API credentials

### 9.2 Fixture Sanitization
- [ ] Fixtures are synthetic/minimized, not full proprietary bundles
- [ ] No embedded credentials or tokens in fixtures
- [ ] Fixtures versioned with test code

---

## 10. Compliance Checklist

| Requirement | Status | Evidence |
|-------------|--------|----------|
| No `AMBIGUOUS` final status | {{REQ_1}} | {{EVIDENCE_1}} |
| Textual fallback review required | {{REQ_2}} | {{EVIDENCE_2}} |
| Remote telemetry default disabled | {{REQ_3}} | {{EVIDENCE_3}} |
| Native binary → ARCHITECTURE_REVIEW | {{REQ_4}} | {{EVIDENCE_4}} |
| Independent review completed | {{REQ_5}} | {{EVIDENCE_5}} |
| Evidence bundle hashed and archived | {{REQ_6}} | {{EVIDENCE_6}} |

---

## 11. Findings

| Severity | Finding | Component | Recommendation |
|----------|---------|-----------|----------------|
| {{SEV_1}} | {{FINDING_1}} | {{COMPONENT_1}} | {{REC_1}} |

**Severity Levels**: `CRITICAL` | `HIGH` | `MEDIUM` | `LOW` | `INFO`

---

## 12. Sign-Off

| Role | Name | Decision | Date |
|------|------|----------|------|
| Security Reviewer | {{SECURITY_REVIEWER}} | {{SECURITY_DECISION}} | {{SECURITY_DATE}} |
| Architecture Reviewer (if native binary) | {{ARCH_REVIEWER}} | {{ARCH_DECISION}} | {{ARCH_DATE}} |

**Decisions**: `APPROVE` | `APPROVE_WITH_CONDITIONS` | `REJECT`

---

*This template is self-contained per adaptation policy. All required fields are defined above — no external references needed.*