# Editor webview activity cadence measurement — 2026-10-14

## Provenance

The user captured incoming `from-extension/io_message` messages in the running editor webview using a window message listener. Each entry records `performance.now()` arrival time, UTC wall time, channel ID, message type/subtype, completion flag, and content block types/tool names. Message text, tool arguments/results, streamed event payloads, task IDs, and parent tool-use IDs were not retained.

Raw files remain local:

- Original: `C:/Users/Denis/.claude/channels/telegram/inbox/1791981172862-AgAD77EAAtUneUo.txt`; SHA-256 `bc6268855437c6f9ab38f328ac2834b2f6f09bfac5e1a04ed5c4b5876d891c87`.
- Extended: `C:/Users/Denis/.claude/channels/telegram/inbox/1791981708607-AgADE7IAAtUneUo.txt`; SHA-256 `9caacbfd36e994792dc3398985eec0b73d24425ad752fa72a03ca0bb9c9b387f`.

Both hashes were computed over original file bytes with Python `hashlib.sha256`. The extended file contains 4,183 records; the complete original array is its unchanged prefix. Arrival timestamps are nondecreasing. Processing was local with Python isolated mode; no trace was sent to another provider.

The original model-only attempt lacks its start marker. Its marker-to-marker duration is excluded. A separately marked repeat supplies the model-only measurement.

## Active-turn selection

For each named scenario, select event records between its start/end markers. Begin at the first `user` message containing a `text` block and end at the next `result/success` event. This excludes operator delay between setting the marker and submitting the prompt, and delay between receiving completion and setting the end marker. It also excludes the previous turn's tail captured inside the Read/Grep and Bash marker windows.

This is an explicitly stated observable selection rule, not reconstructed backend timing. The recorder omitted identifiers, so child-task events cannot be independently paired by task ID. The native-agent selected window includes the child task's events; its first root user-text message precedes the child user-text message.

Compute adjacent arrival differences inside each selected window. Quantiles use sorted gaps with linear interpolation at rank `(n - 1) * p` (Type 7). All values below are milliseconds.

## Measurements

| Scenario | Selected start UTC | Selected end UTC | Events | Duration | Median gap | p90 gap | p95 gap | Maximum gap |
|---|---|---|---:|---:|---:|---:|---:|---:|
| Model-only repeat | 12:39:58.702 | 12:40:28.858 | 589 | 30156.1 | 12.6 | 172.6 | 219.6 | 2629.1 |
| Three Read and three Grep calls | 12:25:55.831 | 12:27:16.003 | 392 | 80172.1 | 9.4 | 196.6 | 750.0 | 7419.6 |
| Long-running Bash | 12:28:51.925 | 12:29:40.187 | 55 | 48262.3 | 15.1 | 1579.1 | 3943.9 | 26986.2 |
| Native Agent task | 12:30:58.004 | 12:31:48.284 | 118 | 50280.0 | 12.3 | 969.1 | 3126.8 | 12197.2 |

The model-only marker window contains no recorded tool-use blocks. The Read/Grep marker window contains exactly three `Read` and three `Grep` calls. The Bash marker window contains one `Bash` call and an earlier channel-send call belonging to a preceding turn; that preceding turn is excluded by the active-turn selection rule. The requested Bash command was `sleep 30`, executed successfully in the main conversation. The native-agent marker window contains one `Agent`, one `Read`, and one `SubagentHandback` call, together with task-started/task-progress/task-updated/task-notification events. The main conversation independently records the Agent invocation and completed result; task IDs are unavailable in the capture.

The largest selected Bash gap is from `system/task_started` to `tool_progress`; it lasts 26986.2 ms and is followed by task notification, tool result, and a successful turn result. The native-agent maximum gap is from `system/status` to `stream_event`; the Read/Grep maximum has the same event-type endpoints. The model-only maximum lies between two `stream_event` records.

## Interpretation and remaining limits

These measurements establish real editor-webview arrival cadence for one observed run of each requested scenario. They are not fixture timer values, CLI-only arrival measurements, or delegated-provider activity substituted for native events.

Successful long-running work can produce almost 27 seconds without a recorded event. Therefore a short inactivity interval alone does not prove a stalled process. The original plan's fresh/quiet/stale candidates remain provisional: these data do not validate production thresholds or reliability across providers, repeated runs, or failures. A stale activity label must not be promoted to a failed/stalled runtime state solely from elapsed silence.

No production thresholds are claimed to be validated by this single capture. Repeated healthy runs and explicit failure observations are still needed for robust threshold selection. Stream payloads and task correlation identifiers would be needed for finer-grained attribution. The extended raw capture is preserved as `progress-cadence-trace-2026-10-14.json` beside this report. The pipeline can incorporate these artifacts during its document/review stage. DOCS-001 has not been marked complete by this analysis.
