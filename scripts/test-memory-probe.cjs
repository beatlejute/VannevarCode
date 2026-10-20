// Preloaded into every test child by scripts/run-tests.mjs (node --require).
// Reports the child's own peak memory on exit, so the suite output carries
// per-test-process memory measurements and not only the runner's heap:
// - maxrss: ru_maxrss from process.resourceUsage() — peak resident set of the
//   child process, the closest portable proxy for its peak commit demand;
// - heap/rss: process.memoryUsage() at exit.
// On an aborting crash (V8 "heap out of memory") exit hooks do not run, which
// is itself diagnostic: the runner then prints the child's output tail with the
// V8 fatal error instead of a MEMPROBE line.
'use strict';

process.on('exit', () => {
    try {
        const ru = process.resourceUsage();
        const mu = process.memoryUsage();
        const mb = (kb) => (kb / 1024).toFixed(1);
        console.log(
            `MEMPROBE pid=${process.pid} maxrss=${mb(ru.maxRSS)}MB ` +
            `rss=${mb(mu.rss / 1024)}MB heap=${(mu.heapUsed / 1048576).toFixed(1)}MB`,
        );
    } catch {
        // Never fail a green test because the probe could not report.
    }
});
