// Translation between the Anthropic Messages API and the Gemini API's own generateContent.
// No network, no process state — so it can be tested independently of the server.
//
// The native API rather than Google's OpenAI compatibility layer, because that layer breaks Claude
// Code three ways. Tool schemas there are reported failing against the legacy `Schema` proto, which
// has no field for `$schema`, `additionalProperties`, `propertyNames` or `const` and answers each with
// a 400 for the whole request. Gemini 3 refuses a tool step that comes back without its thought
// signature, and that layer carries the signature in a non-standard `extra_content` field. And it
// reports a tool call with finish_reason "stop". Here the schema goes in `parametersJsonSchema`, which
// takes JSON Schema as it is; the signature is a field of the part it belongs to; and a tool call is a
// part of its own, whatever the finish reason says.

import { randomBytes } from 'node:crypto';
import { stripModelSuffix } from './translate.mjs';

// What Gemini documents for a function call it did not produce itself: history carried over from
// another provider, or from before the proxy restarted and forgot the real signatures. It passes the
// validation, at some cost to how well the model picks up its own reasoning.
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

// Google recommends leaving Gemini 3's temperature at its default of 1.0 and documents looping below
// it, so sampling settings chosen for Claude are not passed on to it.
const DEFAULT_SAMPLING = /^gemini-(?:[3-9]|\d{2,})/i;

// Ends that are the model declining. Retrying one gets the same answer, so it is reported as a refusal
// and not as a failure.
const REFUSED = new Set([
    'SAFETY',
    'RECITATION',
    'LANGUAGE',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT',
    'IMAGE_RECITATION',
]);

function textOf(blocks) {
    if (typeof blocks === 'string') return blocks;
    if (!Array.isArray(blocks)) return '';
    return blocks
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join('');
}

function toolResultText(block) {
    const content = block.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const text = textOf(content);
    if (text) return text;
    return content.some((c) => c && c.type === 'image') ? '[image omitted]' : '';
}

function mediaPart(block, fallbackType) {
    const source = block.source || {};
    if (source.type === 'base64' && source.data)
        return { inlineData: { mimeType: source.media_type || fallbackType, data: source.data } };
    if (source.type === 'text' && source.data) return { text: source.data };
    return null;
}

// A tool result carries only the id of its call, and a functionResponse is matched by name — `names`
// is filled from the calls as the history is walked. Function responses go first: Gemini pairs them
// with the calls of the step before, and text after them is what the user added to that turn.
function userParts(blocks, names) {
    const responses = [];
    const rest = [];
    for (const block of blocks) {
        if (!block) continue;
        if (block.type === 'tool_result') {
            const output = toolResultText(block);
            responses.push({
                functionResponse: {
                    name: names.get(block.tool_use_id) || 'unknown_tool',
                    response: block.is_error ? { error: output } : { output },
                },
            });
        } else if (block.type === 'text' && block.text) rest.push({ text: block.text });
        else if (block.type === 'image' || block.type === 'document') {
            const part = mediaPart(block, block.type === 'image' ? 'image/png' : 'application/pdf');
            if (part) rest.push(part);
        }
    }
    return [...responses, ...rest];
}

function modelParts(blocks, names, signatures) {
    const parts = [];
    for (const block of blocks) {
        if (block?.type === 'text' && block.text) parts.push({ text: block.text });
        else if (block?.type === 'tool_use') {
            names.set(block.id, block.name);
            const input = block.input && typeof block.input === 'object' ? block.input : {};
            const part = { functionCall: { name: block.name, args: input } };
            const signature = signatures?.recall(block.id);
            if (signature) part.thoughtSignature = signature;
            parts.push(part);
        }
    }
    // Gemini 3 validates the first function call of every step in the current turn and answers a
    // missing signature with a 400; the parallel calls after it carry none by design.
    const first = parts.find((p) => p.functionCall);
    if (first && !first.thoughtSignature) first.thoughtSignature = SKIP_SIGNATURE;
    return parts;
}

// Thinking blocks from an Anthropic turn are dropped: they are signed for Anthropic and mean nothing
// here. A message left with no parts is skipped, and neighbours of the same role are merged into one
// content, which is what a skipped message would otherwise leave behind.
function contentsOf(messages, signatures) {
    const contents = [];
    const names = new Map();
    for (const message of messages || []) {
        const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
        const model = message.role === 'assistant';
        const parts = model ? modelParts(blocks, names, signatures) : userParts(blocks, names);
        if (!parts.length) continue;
        const role = model ? 'model' : 'user';
        const last = contents.at(-1);
        if (last?.role === role) last.parts.push(...parts);
        else contents.push({ role, parts });
    }
    return contents;
}

// `$schema` is the one keyword taken out, as other clients of parametersJsonSchema do. A tool that
// takes nothing is declared without parameters: an object with no properties has been rejected as
// "should be non-empty for OBJECT type", and a declaration without parameters says the same thing.
function parametersOf(schema) {
    if (!schema || typeof schema !== 'object') return undefined;
    const { $schema, ...rest } = schema;
    const shaped =
        Object.keys(rest.properties || {}).length ||
        ['additionalProperties', 'patternProperties', 'anyOf', 'oneOf', 'allOf', '$ref'].some((k) => rest[k]);
    return shaped ? rest : undefined;
}

function toolsToGemini(tools) {
    if (!Array.isArray(tools)) return undefined;
    const declarations = tools
        .filter((t) => t && t.name && !t.type)
        .map((t) => {
            const declaration = { name: t.name, description: t.description || t.name };
            const parameters = parametersOf(t.input_schema);
            if (parameters) declaration.parametersJsonSchema = parameters;
            return declaration;
        });
    return declarations.length ? declarations : undefined;
}

function toolConfigOf(choice) {
    const mode = { auto: 'AUTO', any: 'ANY', tool: 'ANY', none: 'NONE' }[choice?.type];
    if (!mode) return undefined;
    const config = { mode };
    if (choice.type === 'tool' && choice.name) config.allowedFunctionNames = [choice.name];
    return { functionCallingConfig: config };
}

// -> { model, request }: the model travels in the URL, not in the body
function anthropicToGemini(body, { signatures, thinkingLevel } = {}) {
    const model = stripModelSuffix(body.model).replace(/^models\//, '');
    const request = { contents: contentsOf(body.messages, signatures) };

    const system = textOf(body.system);
    if (system) request.systemInstruction = { parts: [{ text: system }] };

    const tools = toolsToGemini(body.tools);
    if (tools) {
        request.tools = [{ functionDeclarations: tools }];
        const config = toolConfigOf(body.tool_choice);
        if (config) request.toolConfig = config;
    }

    const generation = {};
    if (body.max_tokens) generation.maxOutputTokens = body.max_tokens;
    if (!DEFAULT_SAMPLING.test(model)) {
        if (typeof body.temperature === 'number') generation.temperature = body.temperature;
        if (typeof body.top_p === 'number') generation.topP = body.top_p;
        if (typeof body.top_k === 'number') generation.topK = body.top_k;
    }
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length)
        generation.stopSequences = body.stop_sequences.slice(0, 5);
    if (thinkingLevel) generation.thinkingConfig = { thinkingLevel };
    if (Object.keys(generation).length) request.generationConfig = generation;

    return { model, request };
}

// Gemini hands out no call ids the CLI could rely on, and none are sent back — a response is matched to
// its call by name and order. So every call gets an id of the Messages API's own shape, which keeps it
// valid if the session later goes back to Anthropic.
function toolId() {
    return `toolu_${randomBytes(12).toString('hex')}`;
}

// `promptTokenCount` includes the cached part, and the Messages API counts it beside the input rather
// than inside it. Thinking is billed as output, so it is counted there. A chunk that omits a count
// keeps the one before it.
function usageOf(meta = {}, previous = {}) {
    const prompt =
        meta.promptTokenCount ?? (previous.input_tokens || 0) + (previous.cache_read_input_tokens || 0);
    const cached = Number(meta.cachedContentTokenCount ?? previous.cache_read_input_tokens) || 0;
    const output =
        meta.candidatesTokenCount != null || meta.thoughtsTokenCount != null
            ? (Number(meta.candidatesTokenCount) || 0) + (Number(meta.thoughtsTokenCount) || 0)
            : previous.output_tokens || 0;
    return {
        input_tokens: Math.max(0, (Number(prompt) || 0) - cached),
        output_tokens: output,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
    };
}

// How an answer ended, in the Messages API's terms. An answer that ended with nothing in it for any
// reason other than a refusal or the token limit — a malformed function call, a rejected signature,
// an empty STOP — is a failure: a well-formed empty end_turn is where an agent silently gives up, and
// only an error earns it the CLI's retry.
function outcomeOf({ finishReason, finishMessage, blockReason, produced, calledTools }) {
    const detail = finishMessage ? `: ${finishMessage}` : '';
    if (blockReason) return { stopReason: 'refusal', note: `Gemini blocked the prompt (${blockReason}).` };
    if (REFUSED.has(finishReason))
        return { stopReason: 'refusal', note: `Gemini stopped the answer (${finishReason})${detail || '.'}` };
    if (finishReason === 'MAX_TOKENS') return { stopReason: 'max_tokens' };
    if (!produced)
        return { failure: { message: `Gemini returned an empty answer (finishReason ${finishReason || 'unset'})${detail}` } };
    return { stopReason: calledTools ? 'tool_use' : 'end_turn' };
}

function failureFrom(error) {
    return {
        message: error?.message || 'upstream error',
        code: error?.code ?? null,
        type: error?.status ?? null,
    };
}

function argsOf(args) {
    return args && typeof args === 'object' ? args : {};
}

// A non-streamed answer -> one Anthropic message; `failure` is set instead when it must not be one
function geminiToAnthropic(response, fallbackModel, { onSignature } = {}) {
    if (response?.error) return { failure: failureFrom(response.error) };
    const candidate = response?.candidates?.[0] || {};
    const content = [];
    for (const part of candidate.content?.parts || []) {
        if (part.thought) continue;
        if (part.functionCall) {
            const id = toolId();
            if (part.thoughtSignature) onSignature?.(id, part.thoughtSignature);
            content.push({ type: 'tool_use', id, name: part.functionCall.name, input: argsOf(part.functionCall.args) });
        } else if (part.text) {
            const last = content.at(-1);
            if (last?.type === 'text') last.text += part.text;
            else content.push({ type: 'text', text: part.text });
        }
    }
    const outcome = outcomeOf({
        finishReason: candidate.finishReason,
        finishMessage: candidate.finishMessage,
        blockReason: response?.promptFeedback?.blockReason,
        produced: content.length > 0,
        calledTools: content.some((b) => b.type === 'tool_use'),
    });
    if (outcome.failure) return { failure: outcome.failure };
    if (!content.length && outcome.note) content.push({ type: 'text', text: outcome.note });
    return {
        message: {
            id: response.responseId || `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model: response.modelVersion || fallbackModel,
            content,
            stop_reason: outcome.stopReason,
            stop_sequence: null,
            usage: usageOf(response.usageMetadata),
        },
    };
}

// Incremental converter: streamGenerateContent chunks -> Anthropic events. Each chunk is a whole
// GenerateContentResponse holding the next parts; text arrives in pieces, a function call in one.
// message_start waits for the first thing worth sending, so a stream that fails before it can still
// be answered with a real HTTP status.
function createGeminiStreamTranslator(model, { onSignature, inputTokens } = {}) {
    let started = false;
    let first = null;
    let nextIndex = 0;
    let textIndex = null;
    let produced = false;
    let calledTools = false;
    let finishReason = null;
    let finishMessage = '';
    let blockReason = null;
    let failure = null;
    let completed = false;
    let usage = {
        input_tokens: inputTokens || 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
    };

    const events = [];
    const push = (event, data) => events.push({ event, data });
    const drain = () => events.splice(0, events.length);
    const outcome = () => outcomeOf({ finishReason, finishMessage, blockReason, produced, calledTools });

    function start() {
        if (started) return;
        started = true;
        push('message_start', {
            type: 'message_start',
            message: {
                id: first?.responseId || `msg_${Date.now()}`,
                type: 'message',
                role: 'assistant',
                model: first?.modelVersion || model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { ...usage },
            },
        });
    }

    function text(value) {
        start();
        if (textIndex === null) {
            textIndex = nextIndex++;
            push('content_block_start', {
                type: 'content_block_start',
                index: textIndex,
                content_block: { type: 'text', text: '' },
            });
        }
        push('content_block_delta', {
            type: 'content_block_delta',
            index: textIndex,
            delta: { type: 'text_delta', text: value },
        });
        produced = true;
    }

    function closeText() {
        if (textIndex === null) return;
        push('content_block_stop', { type: 'content_block_stop', index: textIndex });
        textIndex = null;
    }

    function call(part) {
        start();
        closeText();
        const id = toolId();
        if (part.thoughtSignature) onSignature?.(id, part.thoughtSignature);
        const index = nextIndex++;
        push('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id, name: part.functionCall.name || '', input: {} },
        });
        push('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(argsOf(part.functionCall.args)) },
        });
        push('content_block_stop', { type: 'content_block_stop', index });
        produced = true;
        calledTools = true;
    }

    return {
        // Same shape as the Responses translator's; the SSE here carries no event names
        event(_name, payload) {
            if (!payload) return drain();
            first ||= payload;
            if (payload.error) {
                failure = failureFrom(payload.error);
                return drain();
            }
            if (payload.usageMetadata) usage = usageOf(payload.usageMetadata, usage);
            if (payload.promptFeedback?.blockReason) {
                blockReason = payload.promptFeedback.blockReason;
                completed = true;
            }
            const candidate = payload.candidates?.[0];
            for (const part of candidate?.content?.parts || []) {
                if (part.thought) continue;
                if (part.functionCall) call(part);
                else if (part.text) text(part.text);
            }
            if (candidate?.finishReason) {
                finishReason = candidate.finishReason;
                finishMessage = candidate.finishMessage || '';
                completed = true;
            }
            return drain();
        },

        finish() {
            const { stopReason, note } = outcome();
            if (!produced && note) text(note);
            start();
            closeText();
            push('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
                usage: { ...usage },
            });
            push('message_stop', { type: 'message_stop' });
            return drain();
        },

        // `{ message, code, type }` once the upstream refused or answered with nothing, null otherwise
        get failure() {
            return failure || (completed ? outcome().failure || null : null);
        },

        get completed() {
            return completed;
        },
    };
}

// The thought signatures Gemini attached to its function calls, by the tool_use id each call was given
// here. They come back with that call on every later request; one lost to a proxy restart is replaced
// by SKIP_SIGNATURE. `blind` records like the store and recalls nothing — what a retry uses after a
// replayed signature was refused.
function createSignatureStore(limit = 1000) {
    const byId = new Map();
    const remember = (id, signature) => {
        if (!id || !signature) return;
        byId.set(id, signature);
        if (byId.size > limit) byId.delete(byId.keys().next().value);
    };
    return {
        remember,
        recall: (id) => byId.get(id) || null,
        blind: () => ({ remember, recall: () => null }),
        get size() {
            return byId.size;
        },
    };
}

export {
    anthropicToGemini,
    geminiToAnthropic,
    createGeminiStreamTranslator,
    createSignatureStore,
    toolsToGemini,
    usageOf,
    SKIP_SIGNATURE,
};
