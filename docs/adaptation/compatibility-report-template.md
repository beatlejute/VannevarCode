# Compatibility Report Template

**Version**: {{VERSION}}
**Date**: {{DATE}}
**Adaptation Run ID**: {{RUN_ID}}
**Claude Code Version**: {{CLAUDE_VERSION}}
**Vannevar Code Version**: {{VANNEVAR_VERSION}}

---

## 1. Executive Summary

| Field | Value |
|-------|-------|
| **Final Status** | {{FINAL_STATUS}} |
| **Previous Status** | {{PREVIOUS_STATUS}} |
| **VerifiedAgainst Updated** | {{VERIFIED_AGAINST_UPDATED}} |
| **Review Decision** | {{REVIEW_DECISION}} |

**Final Status Values**: `VERIFIED_UNCHANGED` | `VERIFIED_ADAPTED` | `ARCHITECTURE_REVIEW` | `BLOCKED` | `REJECTED_INCOMPATIBLE`

> **Note**: `AMBIGUOUS` is prohibited as a final status per adaptation policy.

---

## 2. Baseline Information

| Parameter | Value |
|-----------|-------|
| Repository Commit | {{COMMIT_SHA}} |
| Vannevar Version | {{VANNEVAR_VERSION}} |
| VerifiedAgainst (before) | {{VERIFIED_AGAINST_BEFORE}} |
| VerifiedAgainst (after) | {{VERIFIED_AGAINST_AFTER}} |
| Pristine Bundle Hash | {{PRISTINE_BUNDLE_HASH}} |
| Target Files | {{TARGET_FILES}} |

---

## 3. Patch Point Analysis Summary

### 3.1 Registry Validation
- **Schema Valid**: {{REGISTRY_SCHEMA_VALID}}
- **Runtime Consistency**: {{RUNTIME_CONSISTENCY}}
- **Total Patch Points**: {{TOTAL_PATCH_POINTS}}
- **Required**: {{REQUIRED_COUNT}}
- **Optional**: {{OPTIONAL_COUNT}}

### 3.2 Probe Results by Patch Point

| Patch Point ID | Surface | Required | Variant Used | Match Count | Preconditions | Postcondition Feasible | Status |
|----------------|---------|----------|--------------|-------------|---------------|------------------------|--------|
| {{PATCH_ID_1}} | {{SURFACE_1}} | {{REQUIRED_1}} | {{VARIANT_1}} | {{MATCH_COUNT_1}} | {{PRECONDITIONS_1}} | {{POSTCONDITION_1}} | {{STATUS_1}} |
| {{PATCH_ID_2}} | {{SURFACE_2}} | {{REQUIRED_2}} | {{VARIANT_2}} | {{MATCH_COUNT_2}} | {{PRECONDITIONS_2}} | {{POSTCONDITION_2}} | {{STATUS_2}} |

> **Status Values**: `PASS` | `MISS` | `AMBIGUOUS` | `BLOCK`
> - Required patch points in `AMBIGUOUS` or `BLOCK` → adaptation cannot proceed
> - Optional patch points in `AMBIGUOUS`/`BLOCK` → treated as `MISS` with warning

### 3.3 Signature Forking Performed

| Patch Point ID | Original Variant | New Variant | Matcher Kind | Justification |
|----------------|------------------|-------------|--------------|---------------|
| {{FORK_PATCH_ID_1}} | {{ORIGINAL_VARIANT_1}} | {{NEW_VARIANT_1}} | {{MATCHER_KIND_1}} | {{JUSTIFICATION_1}} |

---

## 4. Adaptation Execution

### 4.1 Dry-Run Results
- **Exit Code**: {{DRY_RUN_EXIT_CODE}}
- **All Required Hits Achieved**: {{ALL_HITS_ACHIEVED}}
- **Syntax Errors**: {{SYNTAX_ERRORS}}
- **Backup Files Created**: {{BACKUP_FILES_CREATED}}

### 4.2 Real Adaptation (if applicable)
- **Exit Code**: {{REAL_ADAPT_EXIT_CODE}}
- **Files Modified**: {{MODIFIED_FILES}}
- **Full npm test**: {{NPM_TEST_RESULT}}

---

## 5. Restore Verification

| Restore Path | Tested | Result | Notes |
|--------------|--------|--------|-------|
| Exact Backup Restore | {{EXACT_BACKUP_TESTED}} | {{EXACT_BACKUP_RESULT}} | {{EXACT_BACKUP_NOTES}} |
| Explicit Pristine Restore | {{PRISTINE_RESTORE_TESTED}} | {{PRISTINE_RESTORE_RESULT}} | {{PRISTINE_RESTORE_NOTES}} |
| Registry-Governed Cleanup | {{REGISTRY_CLEANUP_TESTED}} | {{REGISTRY_CLEANUP_RESULT}} | {{REGISTRY_CLEANUP_NOTES}} |
| Multi-File Transactional | {{MULTI_FILE_TESTED}} | {{MULTI_FILE_RESULT}} | {{MULTI_FILE_NOTES}} |
| Idempotent Second Run | {{IDEMPOTENT_TESTED}} | {{IDEMPOTENT_RESULT}} | {{IDEMPOTENT_NOTES}} |

---

## 6. Semantic Normalization

| Target File | Resolved Constants | Unresolved | Provenance Tracked |
|-------------|-------------------|------------|-------------------|
| {{NORM_FILE_1}} | {{RESOLVED_1}} | {{UNRESOLVED_1}} | {{PROVENANCE_1}} |

---

## 7. Independent Review

| Reviewer | Decision | Date | Notes |
|----------|----------|------|-------|
| {{REVIEWER_1}} | {{REVIEW_DECISION_1}} | {{REVIEW_DATE_1}} | {{REVIEW_NOTES_1}} |

**Review Criteria Checklist**:
- [ ] All required patch points resolved
- [ ] No `AMBIGUOUS` in final status
- [ ] Textual fallbacks justified and reviewed
- [ ] Native binary modification → `ARCHITECTURE_REVIEW`
- [ ] Remote telemetry default disabled confirmed
- [ ] Evidence bundle complete and hashed

---

## 8. Evidence Bundle

| Artifact | Path | Hash (SHA-256) |
|----------|------|----------------|
| Probe Result | {{PROBE_RESULT_PATH}} | {{PROBE_RESULT_HASH}} |
| Dry-Run Result | {{DRY_RUN_RESULT_PATH}} | {{DRY_RUN_RESULT_HASH}} |
| Normalized IR | {{NORMALIZED_IR_PATH}} | {{NORMALIZED_IR_HASH}} |
| Restore Verification | {{RESTORE_VERIFICATION_PATH}} | {{RESTORE_VERIFICATION_HASH}} |
| Compatibility Report | {{COMPATIBILITY_REPORT_PATH}} | {{COMPATIBILITY_REPORT_HASH}} |
| Review Sign-off | {{REVIEW_SIGN_OFF_PATH}} | {{REVIEW_SIGN_OFF_HASH}} |

---

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| {{RISK_1}} | {{LIKELIHOOD_1}} | {{IMPACT_1}} | {{MITIGATION_1}} |

---

## 10. Recommendations

1. {{RECOMMENDATION_1}}
2. {{RECOMMENDATION_2}}
3. {{RECOMMENDATION_3}}

---

## 11. Sign-Off

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Adapter | {{ADAPTER_NAME}} | | {{ADAPTER_DATE}} |
| Independent Reviewer | {{REVIEWER_NAME}} | | {{REVIEWER_DATE}} |
| Release Approver | {{APPROVER_NAME}} | | {{APPROVER_DATE}} |

---

*This template is self-contained per adaptation policy. Do not reference "see v3" for required fields — all required fields are defined above.*