// Runs the full regression suite: every test file below must exit 0.
// Files are independent (each isolates HOME/runtime into its own temp dir and
// binds only ephemeral ports), so they run with a small worker pool instead of
// one long sequential chain. The suite must fit the pipeline's 120 s check
// budget, which the sequential chain regularly exceeded (~120 s).
//
// Stability guards (FIX-011: intermittent "Committing semi space failed" OOM):
// - every test child gets a bounded old space, so a runaway test fails fast
//   with an error attributed to its own file instead of pushing the whole
//   machine into system commit exhaustion and killing an arbitrary sibling;
// - every file has a wall-clock timeout; a hung file is killed together with
//   its whole process tree, so the suite still reports a result inside the
//   pipeline budget and no grandchildren outlive the run;
// - the runner logs its own heap after every file and free RAM at start/end,
//   so a memory regression is visible in the suite output itself.
//
// Root cause of the historical OOM (FIX-012): the V8 wording "Committing semi
// space failed. Allocation failed - JavaScript heap out of memory" is an OS
// VirtualAlloc refusal, not this suite growing its heaps. Evidence: the
// crashing child in the FIX-001 trace (.workflow/tickets/blocked/FIX-001.md,
// PID 6156) died at 9654 ms with a ~5.8 MB heap — far below any cap; the
// runner heap stays flat at 5-6 MB across all 36 files; and on 2026-10-18 the
// host had ~12 GB physical RAM free while its commit limit (RAM + pagefile,
// ~34.7 GB) was ~70% consumed, with 21+ node processes from unrelated agent
// sessions running concurrently. When commit charge spikes, an arbitrary
// process asking the OS for pages is refused, and the test child that happens
// to allocate at that instant dies with the misleading "heap out of memory"
// text. The suite cannot fix host commit pressure, so it:
// - measures each test child instead of guessing: every child preloads
//   scripts/test-memory-probe.cjs and reports its peak RSS/heap on exit, and
//   free RAM is logged after every file (crash-moment context, not only at
//   suite start/end). Measured across two full green runs on 2026-10-18:
//   child peak RSS 78.5-126.3 MB per file (max: auto-repatch), exit heap
//   5.7-44.9 MB, runner heap 5.0-6.3 MB — worst-case concurrent demand of
//   4 workers + runner is ~0.5 GB, orders of magnitude below the ~9.6-10 GB
//   of free commit observed on the host, so the suite cannot be the driver
//   of commit exhaustion;
// - retries a file once when it dies with a heap allocation failure: that
//   crash reflects transient host commit shortage, not a broken test. The
//   retry is logged as RETRY-OOM and still requires exit 0 to pass.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const memoryProbePath = fileURLToPath(new URL('./test-memory-probe.cjs', import.meta.url));

const testFiles = [
    'test/proxy.test.mjs',
    'test/responses.test.mjs',
    'test/auth-chatgpt.test.mjs',
    'test/gemini.test.mjs',
    'test/model-overrides.test.mjs',
    'test/profile-icons.test.mjs',
    'test/env-isolation.test.mjs',
    'test/proxy-revival.test.mjs',
    'test/attachment-prompt.test.mjs',
    'test/fresh-tab-switch.test.mjs',
    'test/resume-guard.test.mjs',
    'test/foreign-message-id.test.mjs',
    'test/compact-on-switch.test.mjs',
    'test/model-indicator.test.mjs',
    'test/content-search.test.mjs',
    'test/retract-last-message.test.mjs',
    'test/spellcheck.test.mjs',
    'test/model-routing.test.mjs',
    'test/agent-server.test.mjs',
    'test/agent-live-frame.test.mjs',
    'test/agent-map.test.mjs',
    'test/tab-icon-progress.test.mjs',
    'test/pinned-sessions.test.mjs',
    'test/provider-health.test.mjs',
    'test/session-resources.test.mjs',
    'test/autocompact.test.mjs',
    'test/full-history.test.mjs',
    'test/channel-launch.test.mjs',
    'test/channel-relay.test.mjs',
    'test/channel-proxy.test.mjs',
    'test/channel-approvals.test.mjs',
    'test/channel-send.test.mjs',
    'test/channel-pill.test.mjs',
    'test/auto-repatch.test.mjs',
    'test/update-watcher.test.mjs',
    'test/state-contract.test.mjs',
    'test/activation.test.mjs',
    'test/runtime-sync.test.mjs',
    'test/progress-runtime.test.mjs',
    'test/progress-tool-index.test.mjs',
    'test/progress-root-ui.test.mjs',
    'test/progress-agent-frame.test.mjs',
    'test/progress-broker.test.mjs',
    'test/progress-client.test.mjs',
    'test/progress-semantic.test.mjs',
    'test/progress-session-capability.test.mjs',
    'test/progress-launch.test.mjs',
    'test/progress-reporting.test.mjs',
    'test/native-progress.test.mjs',
    'test/native-progress-integration.test.mjs',
    'test/progress-delegated-scope.test.mjs',
    'test/progress-state-transport.test.mjs',
    'test/progress-semantic-ui.test.mjs',
    'test/progress-projection.test.mjs',
    'test/progress-channels.test.mjs',
    'test/progress-settings.test.mjs',
    'test/progress-security.test.mjs',
    'test/progress-performance.test.mjs',
];

const workers = Math.max(2, Math.min(4, os.cpus().length - 2));
// Green ceiling observed for the slowest file (auto-repatch) is ~58 s; the
// pipeline kills the whole run at 120 s, so a per-file cap below that keeps
// the suite diagnosable instead of silently killed.
const perFileTimeoutMs = 75_000;
// Hard old-space bound per test child: green files stay far below this; only
// a runaway test can reach it, and it then fails as its own file's OOM.
const maxOldSpaceMb = 1024;
// Keep only the tail of a child's output: enough for diagnosis, bounded for
// the runner heap even if a broken test spews output in a tight loop.
const outputLimitBytes = 64 * 1024;

const started = Date.now();
let nextIndex = 0;
let failed = 0;
const live = new Set();

function mb(bytes) {
    return (bytes / 1048576).toFixed(1);
}

function killTree(child) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
        // /T kills the whole tree; a bare kill() leaves grandchildren behind.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
        child.kill('SIGKILL');
    }
}

function killAllLive() {
    for (const child of live) killTree(child);
}

process.on('SIGINT', () => { killAllLive(); process.exit(130); });
process.on('SIGTERM', () => { killAllLive(); process.exit(143); });
process.on('exit', killAllLive);

console.log(`MEM start free=${mb(os.freemem())}MB workers=${workers} maxOldSpace=${maxOldSpaceMb}MB perFileTimeout=${perFileTimeoutMs / 1000}s`);

// The probe prints one MEMPROBE line on a clean exit; a crashed child has
// none, and its output tail then carries the V8 fatal error instead.
function childMemory(output) {
    const start = output.lastIndexOf('MEMPROBE pid=');
    if (start === -1) return 'no-probe(crash)';
    const line = output.slice(start, output.indexOf('\n', start)).trim();
    const maxrss = line.match(/maxrss=([0-9.]+)MB/);
    const heap = line.match(/heap=([0-9.]+)MB/);
    if (!maxrss || !heap) return 'no-probe(crash)';
    return `rss=${maxrss[1]}MB heap=${heap[1]}MB`;
}

function isHeapOomCrash(output) {
    return /heap out of memory|Committing semi space failed/i.test(output);
}

function runOnce(file) {
    return new Promise((resolve) => {
        const fileStarted = Date.now();
        const child = spawn(process.execPath, [
            `--max-old-space-size=${maxOldSpaceMb}`,
            '--require', memoryProbePath,
            file,
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        live.add(child);
        let output = '';
        let truncated = false;
        const append = (chunk) => {
            output += chunk;
            if (output.length > outputLimitBytes) {
                output = output.slice(output.length - outputLimitBytes);
                truncated = true;
            }
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const timer = setTimeout(() => {
            console.error(`TIMEOUT ${file} after ${perFileTimeoutMs / 1000}s — killing process tree`);
            killTree(child);
        }, perFileTimeoutMs);
        child.on('error', (error) => {
            clearTimeout(timer);
            live.delete(child);
            resolve({
                ok: false,
                seconds: ((Date.now() - fileStarted) / 1000).toFixed(1),
                why: `could not start: ${error.message}`,
                output: '',
                truncated: false,
            });
        });
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            live.delete(child);
            const seconds = ((Date.now() - fileStarted) / 1000).toFixed(1);
            if (code === 0 && signal === null) {
                resolve({ ok: true, seconds, output, truncated });
            } else {
                resolve({
                    ok: false,
                    seconds,
                    why: signal !== null ? `signal ${signal}` : `exit ${code}`,
                    output,
                    truncated,
                });
            }
        });
    });
}

async function runNext() {
    if (nextIndex >= testFiles.length) return;
    const file = testFiles[nextIndex++];
    let result = await runOnce(file);
    if (!result.ok && isHeapOomCrash(result.output)) {
        console.error(`RETRY-OOM ${file} — child died with a heap allocation failure after ${result.seconds}s; retrying once (transient host commit pressure)`);
        result = await runOnce(file);
    }
    const free = mb(os.freemem());
    const heap = mb(process.memoryUsage().heapUsed);
    if (result.ok) {
        console.log(`PASS ${file} (${result.seconds}s) child ${childMemory(result.output)} runner-heap ${heap}MB free ${free}MB`);
    } else {
        failed += 1;
        console.error(`FAIL ${file} (${result.seconds}s) ${result.why} child ${childMemory(result.output)} free ${free}MB${result.truncated ? ' [output truncated]' : ''}`);
        console.error(result.output.trimEnd());
    }
    return runNext();
}

await Promise.all(Array.from({ length: workers }, () => runNext()));

const total = ((Date.now() - started) / 1000).toFixed(1);
console.log(`MEM end free=${mb(os.freemem())}MB runner-heap=${mb(process.memoryUsage().heapUsed)}MB`);
if (failed) {
    console.error(`FAILED — ${failed} of ${testFiles.length} test files failed (${total}s)`);
    process.exit(1);
}
console.log(`OK — all ${testFiles.length} test files passed (${total}s)`);
