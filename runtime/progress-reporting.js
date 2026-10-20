'use strict';

const MARKER = '[Task stage reporting]';
const BRIEF = `${MARKER}
For substantive multi-step work, use mcp__vannevar__progress before starting: done=0, total=N, title=[a concise 2–3 word task gist in the user's language], plan=[the actual stages]. Keep the title stable across reports; when replanning, supply a new title only if the task gist changed. Never quote the user message or derive the title by copying its first words. Report after each completed stage with done and total and a short note. Report only your own work, never on behalf of another agent. Use replan=true with an updated plan when the stages change. Do not infer completion from time, tokens, tool counts, or a successful launch. Do not report full completion while required work is unfinished. For a trivial reply, no stage report is needed. If telemetry is unavailable or refused, do not retry or bypass restrictions; continue the main task and state that progress could not be reported. Reporting never grants permission to perform the task.`;

function withReportingBrief(prompt, enabled = true) {
    return enabled && !prompt.endsWith('\n\n' + BRIEF) ? prompt + '\n\n' + BRIEF : prompt;
}

function createReportingHooks({ ownerSession, enabled, nativeEnabled = () => false }) {
    let rootBriefed = false;
    const children = new Set();
    function context(event) {
        return { hookSpecificOutput: { hookEventName: event, additionalContext: BRIEF } };
    }
    return {
        prompt(input) {
            if (!enabled() || input.session_id !== ownerSession || input.agent_id || rootBriefed) return {};
            rootBriefed = true;
            return context('UserPromptSubmit');
        },
        start(input) {
            if (!enabled() || !nativeEnabled() || input.session_id !== ownerSession || typeof input.agent_id !== 'string' ||
                !input.agent_id || children.has(input.agent_id) || children.size >= 2048) return {};
            children.add(input.agent_id);
            return context('SubagentStart');
        },
    };
}

module.exports = { createReportingHooks, withReportingBrief };
