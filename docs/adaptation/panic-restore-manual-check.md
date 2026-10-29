# Panic Restore Manual Smoke Check

## Outcome

PASS: all five cases were executed interactively by a HUMAN operator on a
disposable Extension Development Host against a synthetic Claude Code bundle.
No product defect was observed. This is a UI smoke check, not a real Claude
compatibility test. The sections below keep the earlier agent-only records that
were collected while no interactive operator was available.

## Environment Evidence

- The session exposes no Windows desktop/Sandbox MCP tools for screenshots,
  accessibility snapshots, or interactive input. Browser tools are not a valid
  substitute: PLAN-002 Task 21 prohibits Playwright/Puppeteer/headless automation.
- Reading `.mcp.json` returned `File not found:
  D:\Dev\VannevarCode\.mcp.json`.
- The project glob `**/*.wsb` returned `No files found`.
- Reading `.workflow/shared/README.md` returned `File not found`; no shared
  environment instructions were available.
- The following executable-discovery command ran successfully (exit code 0):

```powershell
powershell.exe -NoProfile -Command "Get-Command WindowsSandbox.exe, code -ErrorAction Continue | Select-Object Name, Source"
```

```text
Name               Source
WindowsSandbox.exe C:\WINDOWS\system32\WindowsSandbox.exe
code.cmd           C:\Users\Denis\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd
```

Executable availability does not establish an accessible isolated desktop.
No Extension Development Host was launched: there is no exposed desktop tool
to operate or observe it, and no configured Sandbox connection to use.
No claim is made that VS Code itself failed to launch or that Windows Sandbox
is broken. A known-good UI reference could not be attempted through the same
missing transport either; this is an infrastructure precondition failure, not
an observed product startup failure.

## Case Results (agent-only attempt, superseded)

Each row is a separate manual case from the attempt that had no interactive
operator: prerequisites and source-grounded instructions, not runtime
observations. The executed run is the interactive recheck section below.

| Case | Expected assertion and manual action | Actual observation | Result |
|---|---|---|---|
| command visible | In the isolated Extension Development Host, open the Command Palette and find `Vannevar: Panic restore / Safe mode` (`vannevar.panicRestore`, `package.json:35`). | Not executed: no desktop MCP connection is exposed; the Command Palette was not opened or observed. | BLOCKED |
| warning | Invoke the command and inspect the confirmation text beginning `Vannevar: Panic restore - restore from .ccx-orig backup?`, with `Restore` and `Cancel` actions (`extension.js:439-444`). | Not executed: no isolated interactive host is accessible; no confirmation was observed. | BLOCKED |
| cancel | Invoke the command, select `Cancel`, and compare the synthetic fixture before/after: no recovery execution or file change should occur (`extension.js:445`). | Not executed: no interactive input channel; cancel was not selected and no before/after measurement exists. | BLOCKED |
| refusal | Use a disposable synthetic bundle with an unknown marker and no usable backup or pristine source; invoke the command and select `Restore`. Inspect the warning beginning `Vannevar: panic restore failed` and its `Show log` action (`extension.js:453-460`). | Not executed: no isolated interactive host; the refusal path and warning were not observed. | BLOCKED |
| success/reload | Use a disposable synthetic bundle with valid exact backups; select `Restore`. Inspect the completion message and `Reload` action, then verify that selecting it reloads the isolated window (`extension.js:464-469`). | Not executed: no isolated interactive host; neither successful recovery nor a reload prompt was observed. | BLOCKED |

Measured accounting: 5 specified cases, 0 executed product cases, 0 PASS,
0 FAIL, 5 BLOCKED. No screenshots, runtime UI snapshots, recovery hashes,
or reload observations were collected. No product defects were established.

## HUMAN Fallback Preconditions

An interactive operator must provide a disposable VS Code profile/Extension
Development Host with isolated HOME and a synthetic Claude-extension fixture,
then execute each row above. Use only disposable data and capture actual
observations before replacing any BLOCKED result. Restore/reload actions must
target that isolated host, never the user's installed Claude bundle.

No fixture, disposable profile, or HOME directory was created in this run;
there were no test processes or temporary files to clean up. No production
credentials or real Claude session were used. No Playwright, Puppeteer,
headless substitute, UI macro, or existing unit suite was used as UI evidence.

## QA-055 Recheck (2026-10-28) — interactive run

Outcome: PASS. All five cases were executed against the product by a HUMAN
operator in a disposable environment. Earlier attempts under this ID recorded
only BLOCKED prerequisite observations, because no interactive operator was
available; those records are superseded by this run and no product behaviour was
asserted from them.

Environment: a stock VS Code installation was started as an Extension
Development Host of this extension with its own user-data directory, its own
extensions directory, and `USERPROFILE`/`HOME` pointing at an empty disposable
directory, so the runtime copy, the profiles and the extension log lived outside
the operator's real home. The only bundle the host could see was a synthetic
extension at `anthropic.claude-code-9.9.9` (`package.json`, `extension.js`,
`webview/index.js`); the real Claude Code installation was neither read nor
modified. `vannevar.autoPatch` was off, so activation copied the runtime without
patching the bundle and every case below is an explicit operator action.
Playwright, Puppeteer, headless automation and production credentials were not
used.

| Case | Result | Observation in this run |
|---|---|---|
| command visible | PASS | The operator opened the Command Palette in the isolated host and found `Vannevar: Panic restore / Safe mode` (`package.json:35`). No error notification appeared at startup. |
| warning | PASS | Invoking the command showed `Vannevar: Panic restore - restore from .ccx-orig backup? This will restore modified files from backup and remove Vannevar markers.` with the `Restore` and `Cancel` actions (`extension.js:459-463`). |
| cancel | PASS | With `Cancel` selected, the extension log gained no patcher entry and both bundle files kept their byte contents: no recovery executed, nothing was written (`extension.js:464`). |
| refusal | PASS | With no `*.ccx-orig` backup present, `Restore` produced the warning `Vannevar: panic restore failed …` with a `Show log` action, while both bundle files stayed byte-identical — the patcher refused before any write (`extension.js:475-481`, `runtime/apply-patch.mjs:787-789`). |
| success/reload | PASS | With valid exact backups present, `Restore` reported completion with a `Reload` action; the operator selected it and the isolated window reloaded. On disk both files became byte-identical to their `*.ccx-orig` copies with no `__ccx` marker left (`extension.js:483-489`, `runtime/apply-patch.mjs:815-824`). |

Accounting: 5 specified cases, 5 executed, 5 PASS, 0 FAIL, 0 BLOCKED. No product
defect was established. The disposable environment and its fixtures sat outside
the repository and hold no production credentials or real Claude installation.
