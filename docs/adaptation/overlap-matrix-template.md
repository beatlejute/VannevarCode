# Overlap Matrix Template

**Version**: {{VERSION}}
**Date**: {{DATE}}
**Adaptation Run ID**: {{RUN_ID}}
**Claude Code Version**: {{CLAUDE_VERSION}}

---

## 1. Purpose

This matrix documents functional overlaps between Vannevar Code patches and upstream Claude Code changes. It identifies:
- Patches that target the same code region
- Potential conflicts between patches
- Semantic duplicates (different signatures, same intent)
- Owner/module-scope boundaries

---

## 2. Patch Point Registry Snapshot

| Patch Point ID | Surface | Target File | Owner | Required | Restore Policy | Active Variants |
|----------------|---------|-------------|-------|----------|----------------|-----------------|
| {{PP_ID_1}} | {{SURFACE_1}} | {{TARGET_FILE_1}} | {{OWNER_1}} | {{REQUIRED_1}} | {{RESTORE_POLICY_1}} | {{ACTIVE_VARIANTS_1}} |
| {{PP_ID_2}} | {{SURFACE_2}} | {{TARGET_FILE_2}} | {{OWNER_2}} | {{REQUIRED_2}} | {{RESTORE_POLICY_2}} | {{ACTIVE_VARIANTS_2}} |

---

## 3. Surface-Level Overlap Analysis

### 3.1 Same Target File Overlaps

| Target File | Patch Points | Overlap Type | Conflict Risk |
|-------------|--------------|--------------|---------------|
| {{TARGET_FILE_A}} | {{PP_LIST_A}} | {{OVERLAP_TYPE_A}} | {{RISK_A}} |

**Overlap Types**:
- `DISJOINT` — patches target different functions/regions
- `ADJACENT` — patches target nearby regions, potential merge conflict
- `NESTED` — one patch region contains another
- `IDENTICAL` — patches target exact same region (semantic duplicate or conflict)
- `UNKNOWN` — insufficient probe data

### 3.2 Cross-Surface Overlaps

| Surface A | Surface B | Shared Target | Overlap Type | Resolution |
|-----------|-----------|---------------|--------------|------------|
| {{SURFACE_A}} | {{SURFACE_B}} | {{SHARED_TARGET}} | {{OVERLAP_TYPE}} | {{RESOLUTION}} |

---

## 4. Variant-Level Overlap Analysis

### 4.1 Multiple Active Variants per Patch Point

| Patch Point ID | Variant A | Variant B | Both Applicable? | Resolution |
|----------------|-----------|-----------|------------------|------------|
| {{PP_ID_X}} | {{VAR_A}} | {{VAR_B}} | {{BOTH_APPLICABLE}} | {{VAR_RESOLUTION}} |

> **Rule**: Exactly one applicable variant per required patch point. Zero or multiple → fail closed.

### 4.2 Legacy vs New Variant Overlaps

| Patch Point ID | Legacy Variant | New Variant | Legacy State | New State | Transition Plan |
|----------------|----------------|-------------|--------------|-----------|-----------------|
| {{PP_ID_Y}} | {{LEGACY_VAR}} | {{NEW_VAR}} | {{LEGACY_STATE}} | {{NEW_STATE}} | {{TRANSITION}} |

---

## 5. Module Owner Boundary Analysis

### 5.1 Third-Party Owned Anchors

| Patch Point ID | Owner | Module Fingerprint | Numeric ID Only? | Boundary Verified |
|----------------|-------|-------------------|------------------|-------------------|
| {{PP_ID_Z}} | {{OWNER_Z}} | {{FINGERPRINT_Z}} | {{NUMERIC_ONLY_Z}} | {{BOUNDARY_VERIFIED_Z}} |

> **Policy**: Third-party-owned anchor cannot be identified solely by numeric webpack/module ID.

### 5.2 Owner Conflict Matrix

| Owner A | Owner B | Shared Surface | Conflict | Resolution |
|---------|---------|----------------|----------|------------|
| {{OWNER_A}} | {{OWNER_B}} | {{SHARED_SURFACE}} | {{CONFLICT}} | {{RESOLUTION}} |

---

## 6. Semantic Duplicate Detection

| Patch Point A | Patch Point B | Semantic Purpose | Same Intent? | Action |
|---------------|---------------|------------------|--------------|--------|
| {{PP_A}} | {{PP_B}} | {{PURPOSE}} | {{SAME_INTENT}} | {{ACTION}} |

**Actions**:
- `MERGE` — consolidate into single patch point with multiple variants
- `FORK` — keep separate, document distinct semantic purposes
- `DEPRECATE` — mark one as deprecated, migrate to other
- `INVESTIGATE` — insufficient data, requires manual analysis

---

## 7. Restore Policy Overlap

| Patch Point A | Patch Point B | Restore Policy A | Restore Policy B | Transactional Conflict? |
|---------------|---------------|------------------|------------------|------------------------|
| {{PP_RA}} | {{PP_RB}} | {{POLICY_A}} | {{POLICY_B}} | {{TXN_CONFLICT}} |

**Restore Policies**:
- `EXACT_BACKUP` — restore from `*.ccx-orig`
- `PRISTINE_ARTIFACT` — restore from explicit pristine copy
- `REGISTRY_GOVERNED` — controlled raw-marker cleanup
- `REFUSE` — refuse restore, advise reinstall

> Multi-file restore with different policies must be analyzed for transactional safety.

---

## 8. Version Compatibility Matrix

| Patch Point ID | Known Versions | Current Version Status | Next Version Risk |
|----------------|----------------|------------------------|-------------------|
| {{PP_VC_1}} | {{KNOWN_VERSIONS_1}} | {{CURRENT_STATUS_1}} | {{NEXT_RISK_1}} |

---

## 9. Recommendations

| Priority | Recommendation | Target Patch Points | Effort |
|----------|----------------|---------------------|--------|
| {{PRIORITY_1}} | {{RECOMMENDATION_1}} | {{TARGET_PP_1}} | {{EFFORT_1}} |

---

## 10. Sign-Off

| Role | Name | Date |
|------|------|------|
| Analyzer | {{ANALYZER_NAME}} | {{ANALYZER_DATE}} |
| Reviewer | {{REVIEWER_NAME}} | {{REVIEWER_DATE}} |

---

*This template is self-contained per adaptation policy. All required fields are defined above — no external references needed.*