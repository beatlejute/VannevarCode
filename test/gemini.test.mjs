// The Gemini path end to end against a fake generateContent server: no keys, no outbound network.
//   node test/gemini.test.mjs
//
// The fake answers by the model in the URL, one behaviour per model name.

import http from 'node:http';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, DEFAULTS } from '../runtime/proxy/server.mjs';
import { anthropicToGemini, SKIP_SIGNATURE } from '../runtime/proxy/translate-gemini.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const received = [];

// Google frames its stream with \r\n; the last event has no blank line after it
const sse = (res, chunks, { tail = true } = {}) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    chunks.forEach((chunk, i) => {
        const last = i === chunks.length - 1;
        res.write(`data: ${JSON.stringify(chunk)}${last && !tail ? '' : '\r\n\r\n'}`);
    });
    res.end();
};

const usage = { promptTokenCount: 120, cachedContentTokenCount: 90, candidatesTokenCount: 20, thoughtsTokenCount: 14 };

const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        const url = new URL(req.url, 'http://localhost');
        const [, model, method] = url.pathname.match(/\/models\/([^:]+):(\w+)$/) || [];
        const request = JSON.parse(body);
        received.push({ model, method, alt: url.searchParams.get('alt'), headers: req.headers, body: request });

        const signed = JSON.stringify(request).includes('sig-A');
        switch (model) {
            case 'gemini-3-test':
                return sse(
                    res,
                    [
                        { responseId: 'resp-1', modelVersion: 'gemini-3-test-001', candidates: [{ content: { role: 'model', parts: [{ text: 'Let me ' }] } }] },
                        { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }, { text: 'check' }] } }] },
                        {
                            candidates: [
                                {
                                    content: {
                                        role: 'model',
                                        parts: [
                                            { functionCall: { name: 'Read', args: { file_path: 'a.js' } }, thoughtSignature: 'sig-A' },
                                            { functionCall: { name: 'Grep', args: { pattern: 'x' } } },
                                        ],
                                    },
                                    finishReason: 'STOP',
                                },
                            ],
                            usageMetadata: usage,
                        },
                    ],
                    { tail: false }
                );
            case 'gemini-3-plain':
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(
                    JSON.stringify({
                        responseId: 'resp-2',
                        candidates: [
                            {
                                content: {
                                    role: 'model',
                                    parts: [
                                        { text: 'done' },
                                        { functionCall: { name: 'Bash', args: { command: 'ls' } }, thoughtSignature: 'sig-B' },
                                    ],
                                },
                                finishReason: 'STOP',
                            },
                        ],
                        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
                    })
                );
            case 'gemini-3-picky':
                if (signed) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ error: { code: 400, message: 'Corrupted thought signature.' } }));
                }
                return sse(res, [{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]);
            case 'gemini-3-empty':
                return sse(res, [{ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }], usageMetadata: usage }]);
            case 'gemini-3-empty-plain':
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP' }] }));
            case 'gemini-3-safety':
                return sse(res, [{ candidates: [{ finishReason: 'SAFETY' }] }]);
            case 'gemini-3-overloaded':
                return sse(res, [{ error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }]);
            case 'gemini-3-cut':
                return sse(res, [{ candidates: [{ content: { parts: [{ text: 'half an ans' }] } }] }]);
            default:
                res.writeHead(404);
                return res.end();
        }
    });
});

function parseSse(text) {
    const events = [];
    for (const block of text.split('\n\n')) {
        const event = (block.match(/^event: (.+)$/m) || [])[1];
        const data = (block.match(/^data: (.+)$/m) || [])[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
    }
    return events;
}

const TOOLS = [
    {
        name: 'Read',
        description: 'reads a file',
        input_schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            additionalProperties: false,
            properties: {
                file_path: { type: 'string' },
                meta: { type: 'object', additionalProperties: { type: 'string' }, propertyNames: { type: 'string' } },
            },
            required: ['file_path'],
        },
    },
    { name: 'ExitPlanMode', description: 'no arguments', input_schema: { type: 'object', properties: {} } },
    { type: 'web_search_20250305', name: 'web_search' },
];

async function main() {
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1beta`;
    const proxy = createServer({ port: 0, upstreams: { gemini: { baseUrl, protocol: 'gemini' } } });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${proxy.address().port}/gemini`;

    const send = (payload) =>
        fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer AIza-test' },
            body: JSON.stringify(payload),
        });

    // History from another provider: its tool call never had a signature
    const history = [
        { role: 'user', content: [{ type: 'text', text: 'look at a.js' }] },
        {
            role: 'assistant',
            content: [
                { type: 'thinking', thinking: 'from Claude', signature: 'anthropic-sig' },
                { type: 'text', text: 'Reading.' },
                { type: 'tool_use', id: 'toolu_foreign', name: 'Read', input: { file_path: 'b.js' } },
            ],
        },
        {
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'toolu_foreign', content: [{ type: 'text', text: 'contents of b' }] },
                { type: 'text', text: 'and now a.js' },
            ],
        },
    ];
    const request = {
        model: 'gemini-3-test[1m]',
        max_tokens: 4096,
        temperature: 0.2,
        system: [{ type: 'text', text: 'you are an assistant', cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages: history,
        stream: true,
    };

    // --- 1. streaming: text, a thought that stays hidden, two calls, and a STOP that means tool_use
    const res = await send(request);
    assert.strictEqual(res.status, 200, 'stream: HTTP 200');
    const events = parseSse(await res.text());
    const types = events.map((e) => e.event);
    assert.strictEqual(types[0], 'message_start', 'first event is message_start');
    assert.strictEqual(types.at(-1), 'message_stop', 'last event is message_stop');
    assert.strictEqual(events[0].data.message.model, 'gemini-3-test-001', 'the model that answered is named');

    const text = events.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta.text);
    assert.strictEqual(text.join(''), 'Let me check', 'text assembled from \\r\\n-framed chunks, thought left out');

    const calls = events.filter((e) => e.data.content_block?.type === 'tool_use').map((e) => e.data.content_block);
    assert.deepStrictEqual(calls.map((c) => c.name), ['Read', 'Grep'], 'both calls surface, the last one without a trailing blank line');
    for (const c of calls) assert.match(c.id, /^toolu_[0-9a-f]{24}$/, 'call ids are minted in the Messages API shape');
    assert.notStrictEqual(calls[0].id, calls[1].id, 'and unique');
    const args = events.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => JSON.parse(e.data.delta.partial_json));
    assert.deepStrictEqual(args, [{ file_path: 'a.js' }, { pattern: 'x' }], 'arguments arrive whole');

    const delta = events.find((e) => e.event === 'message_delta').data;
    assert.strictEqual(delta.delta.stop_reason, 'tool_use', 'a STOP with calls in it is tool_use');
    assert.deepStrictEqual(
        delta.usage,
        { input_tokens: 30, output_tokens: 34, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
        'cached prompt beside the input, thinking counted as output'
    );
    const starts = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.index);
    for (const index of starts)
        assert.ok(events.some((e) => e.event === 'content_block_stop' && e.data.index === index), `block ${index} closed`);

    // --- what Gemini was asked
    let sent = received.at(-1);
    assert.strictEqual(sent.model, 'gemini-3-test', '[1m] stripped, model in the URL');
    assert.strictEqual(sent.method, 'streamGenerateContent', 'streaming method');
    assert.strictEqual(sent.alt, 'sse', 'as SSE');
    assert.strictEqual(sent.headers['x-goog-api-key'], 'AIza-test', 'the profile key goes in x-goog-api-key');
    assert.strictEqual(sent.headers.authorization, undefined, 'and nowhere else');
    assert.strictEqual(sent.body.model, undefined, 'the body carries no model');
    assert.deepStrictEqual(sent.body.systemInstruction, { parts: [{ text: 'you are an assistant' }] }, 'system prompt');
    assert.deepStrictEqual(sent.body.contents.map((c) => c.role), ['user', 'model', 'user'], 'roles');
    const replayed = sent.body.contents[1].parts;
    assert.deepStrictEqual(replayed[0], { text: 'Reading.' }, 'the Anthropic thinking block is dropped');
    assert.strictEqual(replayed[1].thoughtSignature, SKIP_SIGNATURE, 'a foreign call gets the documented placeholder');
    assert.deepStrictEqual(
        sent.body.contents[2].parts,
        [{ functionResponse: { name: 'Read', response: { output: 'contents of b' } } }, { text: 'and now a.js' }],
        'the result is named after its call, and comes before the text'
    );
    const declarations = sent.body.tools[0].functionDeclarations;
    assert.deepStrictEqual(declarations.map((d) => d.name), ['Read', 'ExitPlanMode'], 'server tools are not declared');
    const schema = declarations[0].parametersJsonSchema;
    assert.strictEqual(schema.$schema, undefined, '$schema is taken out');
    assert.strictEqual(schema.additionalProperties, false, 'the rest of the JSON Schema goes as it is');
    assert.deepStrictEqual(schema.properties.meta.propertyNames, { type: 'string' }, 'nested keywords included');
    assert.strictEqual(declarations[1].parametersJsonSchema, undefined, 'a tool that takes nothing declares no parameters');
    assert.strictEqual(sent.body.generationConfig.maxOutputTokens, 4096, 'max_tokens');
    assert.strictEqual(sent.body.generationConfig.temperature, undefined, 'Gemini 3 keeps its own temperature');

    // --- 2. the next step replays the signature on the call it came with, and only there
    const answered = [
        ...history,
        {
            role: 'assistant',
            content: [
                { type: 'text', text: 'Let me check' },
                ...calls.map((c, i) => ({ type: 'tool_use', id: c.id, name: c.name, input: args[i] })),
            ],
        },
        {
            role: 'user',
            content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'r' })),
        },
    ];
    await (await send({ ...request, messages: answered })).text();
    sent = received.at(-1);
    const step = sent.body.contents[3].parts;
    assert.strictEqual(step[1].thoughtSignature, 'sig-A', 'the real signature comes back with its call');
    assert.strictEqual(step[2].thoughtSignature, undefined, 'the parallel call after it carries none');
    assert.deepStrictEqual(
        sent.body.contents[4].parts.map((p) => p.functionResponse.name),
        ['Read', 'Grep'],
        'one response per call, in order'
    );

    // --- 3. non-streaming
    const plain = await send({ ...request, model: 'gemini-3-plain', stream: false });
    const message = await plain.json();
    assert.strictEqual(received.at(-1).method, 'generateContent', 'non-streaming method');
    assert.strictEqual(message.content[0].text, 'done', 'text');
    assert.strictEqual(message.content[1].name, 'Bash', 'tool_use');
    assert.deepStrictEqual(message.content[1].input, { command: 'ls' }, 'arguments');
    assert.strictEqual(message.stop_reason, 'tool_use', 'stop_reason');
    assert.strictEqual(message.usage.input_tokens, 7, 'usage');
    await send({
        ...request,
        model: 'gemini-3-plain',
        stream: false,
        messages: [...history, { role: 'assistant', content: [message.content[1]] }],
    });
    assert.strictEqual(received.at(-1).body.contents.at(-1).parts[0].thoughtSignature, 'sig-B', 'a non-streamed signature is kept too');

    // --- 4. a signature Gemini no longer takes: the same request again, with placeholders
    const before = received.length;
    const picky = await send({ ...request, model: 'gemini-3-picky', messages: answered });
    assert.strictEqual(picky.status, 200, 'the retry answers');
    assert.strictEqual(received.length - before, 2, 'exactly one retry');
    assert.strictEqual(received.at(-1).body.contents[3].parts[1].thoughtSignature, SKIP_SIGNATURE, 'the retry replays the placeholder');
    await (await send({ ...request, messages: answered })).text();
    assert.strictEqual(received.at(-1).body.contents[3].parts[1].thoughtSignature, 'sig-A', 'and the store still has the real one');

    // --- 5. nothing in the answer is an error the CLI retries, not an empty end_turn
    const empty = await send({ ...request, model: 'gemini-3-empty' });
    assert.strictEqual(empty.status, 502, 'empty stream -> 502');
    assert.match((await empty.json()).error.message, /MALFORMED_FUNCTION_CALL/, 'the reason is named');
    const emptyPlain = await send({ ...request, model: 'gemini-3-empty-plain', stream: false });
    assert.strictEqual(emptyPlain.status, 502, 'empty body -> 502');

    // --- 6. a refusal ends as one, with the reason in the text
    const safety = parseSse(await (await send({ ...request, model: 'gemini-3-safety' })).text());
    assert.strictEqual(safety.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'refusal', 'refusal');
    assert.match(safety.find((e) => e.data.delta?.type === 'text_delta').data.delta.text, /SAFETY/, 'says why');

    // --- 7. an overload reported inside the stream keeps the status the CLI backs off on
    const overloaded = await send({ ...request, model: 'gemini-3-overloaded' });
    assert.strictEqual(overloaded.status, 529, 'overload -> 529');
    assert.strictEqual((await overloaded.json()).error.type, 'overloaded_error', 'overloaded_error');

    // --- 8. a stream cut off before its finish reason is an error, not a finished answer
    const cut = parseSse(await (await send({ ...request, model: 'gemini-3-cut' })).text());
    assert.strictEqual(cut.at(-1).event, 'error', 'cut stream ends with an error event');
    assert.ok(!cut.some((e) => e.event === 'message_stop'), 'and is not closed as a message');

    // --- 9. translation details
    const older = anthropicToGemini({ model: 'gemini-2.5-flash', temperature: 0.2, top_p: 0.9, messages: [] }).request;
    assert.strictEqual(older.generationConfig.temperature, 0.2, 'Gemini 2.5 takes the temperature');
    assert.strictEqual(older.generationConfig.topP, 0.9, 'and top_p');
    const forced = anthropicToGemini({ model: 'g', tools: TOOLS, tool_choice: { type: 'tool', name: 'Read' }, messages: [] }).request;
    assert.deepStrictEqual(forced.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['Read'] } }, 'tool_choice');
    const thinking = anthropicToGemini({ model: 'g', messages: [] }, { thinkingLevel: 'HIGH' }).request;
    assert.deepStrictEqual(thinking.generationConfig, { thinkingConfig: { thinkingLevel: 'HIGH' } }, 'thinkingLevel from proxy.json');

    // --- 10. the bundled upstream and every template profile agree
    assert.deepStrictEqual(DEFAULTS.upstreams.gemini, {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        protocol: 'gemini',
    });
    const templates = path.join(ROOT, 'templates', 'profiles');
    for (const file of readdirSync(templates).filter((f) => f.endsWith('.json'))) {
        const env = JSON.parse(readFileSync(path.join(templates, file), 'utf8')).env;
        const url = new URL(env.ANTHROPIC_BASE_URL);
        const name = url.pathname.split('/').filter(Boolean)[0];
        assert.ok(DEFAULTS.upstreams[name], `${file}: /${name} is an upstream the proxy knows`);
        for (const family of ['OPUS', 'SONNET', 'HAIKU', 'FABLE'])
            assert.ok(env[`ANTHROPIC_DEFAULT_${family}_MODEL`], `${file}: ${family} is mapped`);
    }

    proxy.close();
    upstream.close();
    console.log('\nOK — the Gemini path: schemas, signatures, stop reasons, failures');
}

main().catch((e) => {
    console.error('\nFAIL:', e.message);
    process.exit(1);
});
