# Private Claude Code Capability Evidence

## Scope and evidence standard

This document records private Claude Code session capabilities used by Vannevar Code's progress work. A field is **verified** only for the Claude Code releases whose bundle shape was inspected. A source declaration or fixture proves shape, not runtime cadence. Unknown fields must degrade to unavailable data; they must not be inferred from unrelated signals.

The repository currently declares Claude Code **2.1.296** as its latest verified release, with compatibility entries through **2.1.274** (`package.json:6-7`). The compatibility evidence below is strongest for the named release and documented observations; it does not claim that every capability was independently measured on every release in that list.

## Capability evidence matrix

| Capability | Verified version and evidence | Shape / source | Minimal fixture | Alternative / fallback | Graceful degradation |
|---|---|---|---|---|---|
| `subagentTasks` | Claude Code 2.1.241 task-shape discovery, retained as a current session capability through the 2.1.296 teardown; `docs/internals.md:923-946`, `runtime/webview.js:1387-1410` | Session signal containing task entries with `taskId`, `toolUseId`, `description`, `prompt`, `taskType`, `startTime`, `status`, `usage`, `summary`, and `recentTools`. Task events are `system/task_started`, `system/task_progress`, and `system/task_notification`. | `test/agent-live-frame.test.mjs:240-241,297-305`: a signal whose value is a `Map` keyed by task id, including `toolUseId`, summary, and recent tools. | Inline subagent messages can be read from the transcript, associated by parent tool-use id; prefer transcript content when present (`docs/internals.md:943-946`). | If absent or unreadable, omit task-derived details. Do not fabricate a transcript or infer task activity from root counters. The app removes completed entries, so consumers needing terminal history must retain their own snapshot (`docs/internals.md:938-941`). |
| `agentMapAgents` | Claude Code 2.1.274 session map documented in current teardown; `docs/internals.md:953-980`, page integration in `runtime/webview.js:1996-2032` | Signal value is a `Map` of task id to entries. Relevant entry shape includes `taskId`, `toolUseId`, `parentToolUseId`, `description`, `prompt`, `subagentType`, `isBackgrounded`, `startTime`, `endTime`, `status`, `usage`, `result`, and `error` (`docs/internals.md:962-968`). | `test/agent-map.test.mjs:238-289`: session signal backed by a `Map`; test exercises native and extension-owned entries. | Use `subagentTasks` and transcript tool blocks for live task presentation; do not treat them as a replacement for the stock map's complete dialog fields. | Missing signal/value or non-map-like value (no callable `forEach` or `get`) is ignored; `syncAgentMap()` returns without altering stock state (`runtime/webview.js:1996-2003`). |
| `lastServedModel` | Verified in the current Claude Code 2.1.296 compatibility teardown; `docs/internals.md:752-754`; implementation and regression evidence in `runtime/webview.js:4881-4900,4947-4961`, `test/model-indicator.test.mjs:116-182` | Session signal slot whose `.value` receives the model from assistant messages. Resume replays historical assistant messages before a new backend answer, so the value can be stale across provider changes. | `test/model-indicator.test.mjs:116-124`: session with `lastServedModel: { value: ... }`, followed by an active-profile answer. | Active profile's model list can distinguish a known served model from a foreign/stale label (`runtime/webview.js:4947-4961`). | If missing or not a string, show no served model. After a provider switch, hold/hide the old value until a new assistant response; never pair a new provider with the previous provider's model (`runtime/webview.js:4903-4914,4930-4939`). |
| `providerGeneration` | **No upstream version verified.** The proposed field is a Vannevar protocol concept (`.workflow/plans/current/PLAN-001.md:108-120,224-227`). The inspected session fixtures do not establish an upstream generation field; this is not proof of absence under every possible name or in every release. | No upstream session property shape established. Do not conflate with session id, provider profile, or Vannevar runtime revision. | The inspected session fixtures in `test/agent-map.test.mjs:431-459` expose session id, busy, task map and agent map, not generation. Plan examples use an integer generation in normalized Vannevar snapshots, not a Claude Code fixture (`.workflow/plans/current/PLAN-001.md:166-193`). | Vannevar may maintain its own generation when observing provider switches; root identity uses direct session/provider evidence only. | Treat upstream generation evidence as unknown. Clear/hide stale served-model data on a provider switch rather than manufacturing a Claude Code generation value. |
| `activityHealth` | **No upstream version verified.** This name denotes the proposed Vannevar-derived health classification (`.workflow/plans/current/PLAN-001.md:91-96,521-523`); the inspected fixtures do not establish an upstream freshness field. | Intended to be derived from observed runtime event timestamps; it is separate from runtime state, not an already measured upstream signal. | No measured event-timestamp series in the inspected fixtures. `test/agent-live-frame.test.mjs:195-213,288-350` uses stubbed timers and task snapshots, not timing intervals. | Existing `busy` signal is a coarse active/idle indicator (`runtime/webview.js:1201-1203`); it cannot establish freshness. | Show activity as unknown/coarse when timestamp evidence is unavailable. Do not mark a quiet interval stale based only on `busy`, token counts, tool counts, or elapsed time. |
| `sharedKnowledge` | Checked in this execution on 2026-10-14: `.workflow/shared/README.md` is absent (Read returned File not found). | This is a repository-presence fact, not a Claude Code field. | Checked the exact path `.workflow/shared/README.md`. | None. | Record `sharedKnowledge: absent`; no shared behavior module was available to consult. |

## Activity cadence measurement

### Measurement status

On 2026-10-14, the user captured real `from-extension/io_message` arrivals in the running editor webview with monotonic `performance.now()` timestamps. The extended capture is preserved in [the raw trace](progress-cadence-trace-2026-10-14.json); provenance, raw-byte SHA-256, selection rules, quantile method, and limitations are recorded in [the measurement report](progress-cadence-measurement-2026-10-14.md). All four requested scenarios have an observed successful active turn. The original model-only attempt lacked a start marker and was replaced by a separately marked repeat. These are live webview observations, not stubbed fixture timers or the aggregate fixture `durationMs`. One run per scenario establishes observed cadence but does not validate production thresholds across repeated healthy runs or failures.

### Scenarios and findings

| Representative scenario | Observed active-turn evidence | Median / p95 / maximum arrival gap |
|---|---|---|
| Model call without tool | Separately marked repeat; 589 events, no tool-use blocks, successful result | 12.6 / 219.6 / 2629.1 ms |
| Frequent Read/Grep | 392 events; three Read and three Grep calls, successful result | 9.4 / 750.0 / 7419.6 ms |
| Long-running Bash | 55 events; one Bash call, progress/notification and successful result | 15.1 / 3943.9 / 26986.2 ms |
| Native Agent task | 118 events; Agent, child Read and SubagentHandback calls, task events and successful result | 12.3 / 3126.8 / 12197.2 ms |

Active-turn windows begin at the first user-text event inside the corresponding markers and end at the next successful result. Operator delay and the previous turn's tail are excluded. Task IDs and stream payloads were not retained, so the native window proves observed task events but does not provide independent task-ID correlation. Quantiles use Type 7 linear interpolation; full boundaries and counts appear in the linked measurement report.

### Selected evidence-based activity thresholds

For the initial V1 activity-only policy, select the following boundaries from this capture. Let `age` be monotonic time since the last observed event for the relevant execution, not elapsed task duration. These are engineering choices informed by measured healthy gaps, not directly measured constants or statistically validated failure detectors.

| Activity health | Selected interval | Measurement-based rationale |
|---|---|---|
| `fresh` | `0 <= age < 15000 ms` | All four p95 gaps are below 4 seconds, and the model-only, Read/Grep and native-agent maxima are below 15 seconds. Retain the plan's 15-second boundary as a conservative recent-activity label. |
| `quiet` | `15000 <= age < 60000 ms` | The successful Bash turn includes 26986.2 ms of silence. Healthy long-running work must be allowed to remain quiet without implying failure. |
| `stale` / checking | `age >= 60000 ms` | Round twice the largest observed healthy gap (53972.4 ms) upward to the next 10-second boundary: 60000 ms. The added margin is a policy choice; this capture contains no failed run and does not establish sensitivity or a false-positive rate. |

This replaces the plan's provisional 30-second stale boundary with 60 seconds for initial implementation. In the observed capture, every within-turn gap remains below the selected stale boundary. Missing timestamps yield unknown/coarse activity, not a synthetic age. Apply health labels only while runtime evidence says the execution is active; terminal state comes from terminal events. `stale` means that activity evidence is old, **not** that the process is stalled or failed. Before broad rollout, repeat the scenarios and observe failures to validate or revise this policy. `busy` is not a substitute for last-activity time, and tokens/tool counts/elapsed duration must never be converted into a completion percentage.

### Execution access and measurement boundary

An earlier attempt on 2026-10-14 to check the installed target executable was rejected by the execution rails before the process ran. In the current continuation, the same command succeeded:

```powershell
& "C:\Users\User\.vscode-oss\extensions\anthropic.claude-code-2.1.296-win32-x64\resources\native-binary\claude.exe" --version
```

The command returned `2.1.296 (Claude Code)`. The earlier executable-access limitation is resolved. Automated browser access did not attach to the target editor webview, but the user subsequently selected the correct webview execution context in Developer Tools and installed the timestamp recorder. The first selected context received no events; that empty capture was not used as evidence of runtime inactivity. The corrected context recorded actual incoming messages, and the user supplied the original and extended journals for authorized local analysis. All four scenarios now have measured active-turn intervals. The editor was not restarted and its debug configuration was not changed. A CLI version check alone did not supply these measurements. Production threshold validation remains incomplete.

An authorized measurement must observe the actual target webview's `io_message` stream, record monotonic arrival timestamps and scenario boundaries, and verify that the requested Read/Grep, Bash and native `Agent` calls actually occurred. Repeated healthy runs must distinguish event arrival gaps from healthy silence during a model call or a long-running tool. Record sample counts, interval distributions and maximum healthy silence before choosing thresholds; lack of events alone is not proof of a stalled process. The current compact delegated event projection drops timestamps and excludes system task events (`runtime/host.js:630-644,695-698`), so it cannot reconstruct this measurement afterward.

### Session and fixture discovery coverage

| Source or variant inspected | Finding and evidence boundary |
|---|---|
| Registry context versus session | `busy`, `messages`, `send` and `lastServedModel` belong to the separate session; `ctx.activeSession` is not a valid fallback (`docs/internals.md:416-436`). The registration hook accepts session as its third argument and refreshes it before the registry guard (`runtime/webview.js:5110-5123`). |
| Inline versus task-shaped agents | Inline messages use both `parentToolUseId` and `sdkParentToolUseId`; task-shaped `Agent` uses `subagentTasks`. Both paths and transcript precedence have fixtures (`test/agent-live-frame.test.mjs:237-259,286-350`). |
| Agent map and transcript API variants | The session fixture includes `busy`, `sessionId`, `subagentTasks`, `agentMapAgents` and methods; the paged transcript variant is documented from 2.1.285. A session without a map remains untouched (`test/agent-map.test.mjs:429-459`). |
| Map-like consumer validation | `taskFor()` accepts a callable `forEach`, while `syncAgentMap()` requires a signal with `value` and callable `forEach` and `get`. These are duck-typed checks, not `instanceof Map` checks (`runtime/webview.js:1400-1410,1996-2003`). |
| Served-model identity versus proposed generation | The actual hold follows provider changes and new assistant UUIDs; it moves to a replacement session. Profile model-list comparison has no verdict without a list (`runtime/webview.js:4881-4961`). None of these inspected mechanisms proves an upstream numeric generation property. |

This coverage includes session objects and historical naming/API variants, not just an exact-name search. It does not constitute exhaustive native-binary discovery or new live verification of every release. Private capabilities remain version-scoped and shape-gated.

## Version and compatibility boundary

`package.json:6-7` reports extension version `2.1.296` and `verifiedAgainst` releases `2.1.296`, `2.1.294`, `2.1.293`, `2.1.292`, `2.1.291`, `2.1.289`, `2.1.288`, `2.1.287`, `2.1.286`, `2.1.285`, `2.1.284`, `2.1.283`, `2.1.282`, `2.1.280`, `2.1.278`, `2.1.276`, and `2.1.274`. This list establishes compatibility checks for the extension's patch signatures; it is not a claim that every private session field above was separately fixture-tested on every listed release.

The repository's compatibility teardown says the `subagentTasks` task shape was observed on 2.1.241 and the `agentMapAgents` map was traced on 2.1.274 (`docs/internals.md:923-960`). The current teardown identifies 2.1.296 as its inspected release (`docs/internals.md:3-5`). Changes to private fields can occur between releases; runtime adapters must validate shape at read time.

## Operational fallback summary

- Missing or malformed `subagentTasks`: omit native task summary; preserve any independently available inline transcript evidence.
- Missing or malformed `agentMapAgents`: leave Claude Code's stock agent map untouched.
- Missing or stale `lastServedModel`: display no served model until direct evidence arrives.
- No direct provider/generation evidence: use unknown/null identity; never inherit root identity for a child by assumption.
- No timestamped activity: report coarse activity only; do not label freshness or staleness from `busy` alone.
- Broker or semantic-progress failure: runtime activity remains usable; semantic progress is optional (`.workflow/plans/current/PLAN-001.md:289-291`).

## Evidence gaps

1. Repeat the four measured cadence scenarios across healthy runs and observe failure cases before validating the selected 15/60-second policy for broad production rollout. The single-run trace, interval distributions and initial threshold selection are available; statistical validation remains open.
2. Add representative fixtures for alternate/missing private-field shapes if future runtime changes need compatibility regression coverage.
3. Re-check private-field shape when adding a newly verified Claude Code release; do not extend evidence claims solely because the patcher is compatible.

## Repository knowledge

`sharedKnowledge: absent` — `.workflow/shared/README.md` was not present when checked for this document.
