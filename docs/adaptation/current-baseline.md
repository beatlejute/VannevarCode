---
commit: 91e383500045f347ff7423fb790ff4ca32d43942
vannevarVersion: 2.1.296
verifiedAgainst: ["2.1.296","2.1.294","2.1.293","2.1.292","2.1.291","2.1.289","2.1.288","2.1.287","2.1.286","2.1.285","2.1.284","2.1.283","2.1.282","2.1.280","2.1.278","2.1.276","2.1.274"]
---

# Implementation Baseline — Adaptation

Evidence of the checkout as it stood on 2026-10-20, recorded for PLAN-002 task 1. A baseline is
evidence, not a claim that the checkout is current. Line numbers below refer to the working tree of
that day, which is not clean — see *Divergence*.

## Repository State

- **Commit**: `91e383500045f347ff7423fb790ff4ca32d43942` (`git rev-parse HEAD`)
- **Branch**: `main` — not detached
- **Vannevar version**: `2.1.296` (`package.json:5`)
- **verifiedAgainst** (`package.json:7`): `["2.1.296","2.1.294","2.1.293","2.1.292","2.1.291","2.1.289","2.1.288","2.1.287","2.1.286","2.1.285","2.1.284","2.1.283","2.1.282","2.1.280","2.1.278","2.1.276","2.1.274"]`
- **Main extension file**: `./extension.js` (`package.json:23`)

## Divergence From Public `main`

- **Remote**: `origin` → `https://github.com/beatlejute/VannevarCode.git` (`package.json:12`)
- `git rev-parse origin/main` → `91e383500045f347ff7423fb790ff4ca32d43942` — the same commit as HEAD
- `git rev-list --left-right --count origin/main...HEAD` → `0	0` — nothing ahead, nothing behind
- **Working tree**: not clean — 11 modified tracked files, 1 deleted tracked file
  (`docs/vannevar-code-plan.md`) and untracked files, among them this directory. That work belongs to
  other tasks; `git status --short` lists it, and none of it is part of this baseline.

So there is no commit-level divergence from public `main`, but the checkout carries uncommitted work
that the recorded commit does not contain.

## Patch Targets

`runtime/apply-patch.mjs` patches files **inside the installed Claude Code extension directory**, not
inside this repository. That directory is `--dir=` when given, else the parent of the stamped
`extensionPath`, else `~/.vscode/extensions` (`runtime/apply-patch.mjs:603-619`).

- `extension.js` — Claude Code extension entry (`runtime/apply-patch.mjs:34`)
- `webview/index.js` — Claude Code webview bundle (`runtime/apply-patch.mjs:153`)

The definitions live in `const PATCHES` (`runtime/apply-patch.mjs:32`). `webview/index.js` is not a
file of this repository — it exists in the installed bundle only.

## Commands / Scripts

`package.json:84-95` — npm scripts:

| Script | Command |
| --- | --- |
| `apply` | `node runtime/apply-patch.mjs` |
| `status` | `node runtime/apply-patch.mjs --status` |
| `revert` | `node runtime/apply-patch.mjs --revert` |
| `package` | `node scripts/build-vsix.mjs` |
| `favicons` | `node scripts/fetch-favicons.mjs && node scripts/ico-to-png.mjs && node scripts/shrink-icons.mjs` |
| `icons:shrink` | `node scripts/shrink-icons.mjs` |
| `diag` | `node --use-env-proxy scripts/diag-proxy.mjs` |
| `proxy` | `node --use-env-proxy runtime/proxy/server.mjs` |
| `login:chatgpt` | `node --use-env-proxy runtime/login-chatgpt.mjs` |
| `auth:status` | `node runtime/login-chatgpt.mjs --status` |
| `test` | `node scripts/run-tests.mjs` |

`package.json:27-34` — VS Code commands: `vannevar.applyPatch`, `vannevar.revertPatch`,
`vannevar.status`, `vannevar.showLog`, `vannevar.openProfiles`, `vannevar.installMcp`,
`vannevar.loginChatgpt`. `vannevar.panicRestore` does not exist yet — it is PLAN-002 task 19.

Packing: `scripts/build-vsix.mjs` ships `runtime/` and `templates/` whole
(`scripts/build-vsix.mjs:175-186`); `docs/`, `scripts/`, `test/` and `.github/` are not shipped. New
files under `runtime/` therefore need no packer change, while `scripts/adaptation/*` is repository
tooling and stays out of the VSIX.

The patcher reads its stamp — version, `verifiedAgainst`, resolved extension path — from
`~/.claude/vannevar/patch-version.json` (`extension.js:30`, `runtime/apply-patch.mjs:588-599`). That
file is written at activation and is not tracked in this repository.

## Marker / Backup Conventions

- **Marker** `__ccx` — `const MARKER = '__ccx'`, `runtime/apply-patch.mjs:563`. The "already patched"
  test searches for it (`runtime/apply-patch.mjs:670`), and so does the guard that refuses to patch a
  file that is patched but has no backup beside it (`runtime/apply-patch.mjs:722-726`).
  `extension.js:12-15` names the marker in a comment only.
- **Backup suffix** `*.ccx-orig` — `backupPath(file)` returns `file + '.ccx-orig'`
  (`runtime/apply-patch.mjs:647-649`); the restore path copies the file back from that name.

## Files of PLAN-002 in This Checkout

Tracked and present — the ones PLAN-002 builds on:

- `runtime/apply-patch.mjs` — patch definitions, apply/status/restore
- `extension.js` — runtime copy, commands, auto-patch
- `package.json` — manifest, scripts, `verifiedAgainst`
- `scripts/build-vsix.mjs` — VSIX packaging
- `README.md` — user update/recovery section
- `docs/internals.md` — injection history

Created by this task and not yet tracked: `docs/adaptation/current-baseline.md`.

Planned by PLAN-002 and **not present yet** (checked 2026-10-20):
`runtime/patch-points-registry.json`, `runtime/ast-locator.mjs`, `runtime/patch-registry.mjs`,
`scripts/adaptation/validate-registry.mjs`, `scripts/adaptation/normalize-js.mjs`,
`scripts/adaptation/probe.mjs`, `scripts/adaptation/run.mjs`,
`scripts/adaptation/validate-report.mjs`, `test/patch-registry-validator.test.mjs`,
`test/patch-registry-runtime.test.mjs`, `test/ast-locator.test.mjs`,
`test/semantic-normalization.test.mjs`, `test/adaptation-probe.test.mjs`,
`test/adaptation-runner.test.mjs`, `test/panic-restore.test.mjs`, `test/fixtures/patch-registry/`,
`test/fixtures/ast-locator/`, `test/fixtures/semantic-normalization/`,
`test/fixtures/adaptation/`, `docs/adaptation/ast-toolchain-decision.md`,
`docs/adaptation/runbook.md`, `docs/adaptation/compatibility-report-template.md`,
`docs/adaptation/overlap-matrix-template.md`, `docs/adaptation/security-review-template.md`,
`docs/adaptation/adaptation-policy.json`, `.github/workflows/adaptation.yml`.

## Notes

- `verifiedAgainst` lists the releases actually checked; it is not a compatibility forecast, and
  PLAN-002 does not change it.
- A baseline records what is. It does not assert that the checkout matches public `main`, and it does
  not assert that the installed Claude Code bundle is compatible with the signatures in it.
