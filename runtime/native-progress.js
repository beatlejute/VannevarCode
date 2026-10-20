'use strict';

const { randomUUID } = require('crypto');

// Query objects are opaque producer identities. A reader never acquires ownership
// from the currently visible tab or the most recently spawned process.
const producers = new WeakMap();
function bindNativeProducer(query, bridge) {
    if (!query || producers.has(query)) return false;
    producers.set(query, bridge);
    return true;
}
function observeNativeFrame(query, frame) {
    producers.get(query)?.observe(frame);
}

function createNativeProgressBridge({ broker, ownerSession, resumed = false, createClient, enabled = () => true }) {
    const instance = broker.info().instanceId;
    const runs = new Map();
    const seenTasks = new Set();
    const invocations = new Map();
    const unsupportedTasks = new Set();
    const calls = new Map();
    let closed = false;
    const active = () => !closed && enabled() && broker.info().instanceId === instance;
    const valid = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024;
    const reject = (reason) => ({ accepted: false, reason });
    function closeRun(run) {
        run.closed = true;
        run.client?.close();
        if (run.scopeId) broker.closeScope(run.scopeId);
    }
    function observe(frame) {
        if (!active() || frame?.type !== 'system') return;
        if (frame.subtype === 'task_started' && valid(frame.task_id)) {
            if (seenTasks.has(frame.task_id)) {
                unsupportedTasks.add(frame.task_id);
                const previous = runs.get(frame.task_id);
                if (previous) closeRun(previous);
                broker.setNativeStatus(ownerSession, 'unsupported_resume');
                runs.delete(frame.task_id);
                return; // A resumed attempt has no universally attributable hook run id.
            }
            seenTasks.add(frame.task_id);
            if (!valid(frame.run_id) || !valid(frame.tool_use_id) || seenTasks.size > 2048) return;
            const invocation = invocations.get(frame.tool_use_id);
            if (resumed && (!invocation || invocation.used || invocation.signal?.aborted)) {
                unsupportedTasks.add(frame.task_id);
                return;
            }
            if (invocation) {
                if (invocation.used || invocation.signal?.aborted) return;
                invocation.used = true;
            }
            const existing = runs.get(frame.task_id);
            if (existing && !existing.closed && existing.runId === null) {
                // The task frame belongs to the same live attempt the hook already bound.
                existing.runId = frame.run_id;
                existing.toolUseId = frame.tool_use_id;
                return;
            }
            runs.set(frame.task_id, { taskId: frame.task_id, runId: frame.run_id,
                toolUseId: frame.tool_use_id, closed: false, queue: Promise.resolve() });
        } else if (['task_notification', 'task_updated'].includes(frame.subtype) &&
            ['completed', 'failed', 'stopped', 'killed'].includes(frame.status ?? frame.patch?.status)) {
            const run = runs.get(frame.task_id);
            if (run && frame.run_id === run.runId) closeRun(run);
        }
    }
    function pre(input, toolUseId, { signal } = {}) {
        if (!active() || input?.session_id !== ownerSession) return {};
        const id = toolUseId || input.tool_use_id;
        if (!valid(id)) return {};
        if (['Agent', 'Task'].includes(input.tool_name)) {
            if (!input.tool_input?.resume && !invocations.has(id) && invocations.size < 2048) {
                invocations.set(id, { signal, used: false });
            }
            return {};
        }
        if (input.tool_name !== 'mcp__vannevar__progress' || calls.has(id) || calls.size >= 2048) return {};
        // An explicit root hook is positive attribution; an unknown child is never root.
        const child = valid(input.agent_id);
        let run = child ? runs.get(input.agent_id) : null;
        if (child && !run && !unsupportedTasks.has(input.agent_id) && !seenTasks.has(input.agent_id)
            && runs.size < 2048) {
            // A live hook inside a subagent is engine-issued evidence that this child exists now, so
            // launches that never emit task frames (background runners) still get their own scope.
            run = { taskId: input.agent_id, runId: null, toolUseId: null, closed: false, queue: Promise.resolve() };
            runs.set(input.agent_id, run);
        }
        const reason = child && unsupportedTasks.has(input.agent_id) ? 'unsupported_resume' : child && (!run || run.closed) ? 'unresolved_attempt' : null;
        calls.set(id, { run, root: !child, reason, signal, state: 'pending',
            payload: structuredClone({ done: input.tool_input?.done, total: input.tool_input?.total,
                title: input.tool_input?.title, plan: input.tool_input?.plan, note: input.tool_input?.note,
                replan: input.tool_input?.replan }) });
        return {};
    }
    function classify(id) {
        if (!active()) return reject('telemetry_unavailable');
        const call = calls.get(id);
        if (!call) return reject('unrecorded_call');
        if (call.reason) return reject(call.reason);
        if (call.signal?.aborted || call.run?.closed || call.state !== 'pending') return reject('closed_attempt');
        if (call.root) {
            call.state = 'root_reported';
            return { root: true };
        }
        // The first report creates the scope, so it must already carry a valid plan; refusing here
        // tells the model now instead of dropping the report after a pending acknowledgement.
        const report = call.payload;
        if (!call.run.scopeId && (!Number.isInteger(report.total) || report.total <= 0
            || !Number.isInteger(report.done) || report.done < 0 || report.done > report.total
            || !Array.isArray(report.plan) || report.plan.length !== report.total)) {
            call.state = 'failed';
            return reject('invalid_report');
        }
        call.state = 'classified';
        return { accepted: true, pending: true };
    }
    async function post(input, toolUseId) {
        if (!active() || input?.session_id !== ownerSession || input.tool_name !== 'mcp__vannevar__progress') return {};
        const call = calls.get(toolUseId || input.tool_use_id);
        if (!call || call.state !== 'classified') return {};
        call.state = 'settled';
        const run = call.run;
        const live = () => active() && !run.closed && !call.signal?.aborted;
        if (!live() || input.tool_response?.isError === true) return {};
        const work = async () => {
            if (!live()) return;
            const report = call.payload;
            if (!run.scopeId) {
                if (!Array.isArray(report.plan) || report.plan.length !== report.total) return;
                const scopeId = 'native-' + randomUUID();
                const scope = broker.createDelegatedScope({ scopeId, ownerSession });
                run.scopeId = scopeId;
                if (valid(run.toolUseId) && valid(run.runId))
                    broker.bindNativeScope(ownerSession, run.toolUseId, run.runId, scopeId);
                run.client = createClient({ ...broker.info(), capability: scope.capability });
            }
            if (live()) {
                const result = await run.client.report(report);
                // A frameless child sends no task completion, so its final report ends the scope.
                if (result?.accepted && report.done === report.total && run.runId === null) closeRun(run);
            }
        };
        run.queue = run.queue.then(work, work).catch(() => {});
        await run.queue;
        return {};
    }
    function failure(input, toolUseId) {
        if (input?.session_id === ownerSession) {
            const call = calls.get(toolUseId || input.tool_use_id);
            if (call) call.state = 'failed';
        }
        return {};
    }
    return { observe, pre, post, failure, classify,
        dispose() { closed = true; for (const run of runs.values()) closeRun(run); } };
}

module.exports = { bindNativeProducer, observeNativeFrame, createNativeProgressBridge };
