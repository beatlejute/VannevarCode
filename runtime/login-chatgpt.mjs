#!/usr/bin/env node
// ChatGPT subscription sign-in (OAuth PKCE) and token status. It lives in the runtime rather than in
// scripts/ because it is the only way into the subscription and scripts/ is not in the package — a
// Marketplace install would otherwise document a feature it cannot reach.
//
// The "Vannevar: Sign in to ChatGPT" command runs this file with --json and reads the events off
// stdout: the extension opens the page and reports the result in the editor, so nothing about the
// flow has to be read in a terminal. Run by hand, the same file prints prose instead.
//
//   node ~/.claude/vannevar/login-chatgpt.mjs           — sign in
//   node ~/.claude/vannevar/login-chatgpt.mjs --status  — show status
//   node ~/.claude/vannevar/login-chatgpt.mjs --json    — sign in, reporting to a caller, not a reader

import { login, status, refresh, readStore, STORE, CODEX_AUTH } from './proxy/auth-chatgpt.mjs';

const wantStatus = process.argv.includes('--status');
const wantRefresh = process.argv.includes('--refresh');
const asJson = process.argv.includes('--json');

// One JSON object per line, on stdout, and nothing else in --json mode: the reader is a line parser,
// so a stray console.log would be indistinguishable from an event.
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (wantStatus) {
    const state = status();
    if (asJson) {
        emit({ event: 'status', ...state, store: STORE, codexAuth: CODEX_AUTH });
        process.exit(state.loggedIn ? 0 : 1);
    }
    if (!state.loggedIn) {
        console.log('Not signed in. Run the "Vannevar: Sign in to ChatGPT" command.');
        console.log(`Checked sources: ${STORE}, ${CODEX_AUTH}`);
        process.exit(1);
    }
    console.log('Signed in');
    console.log(`  source:     ${state.source}`);
    console.log(`  account_id: ${state.accountId || '(none)'}`);
    console.log(`  expires:    ${state.expiresAt}${state.expired ? ' — expired, will be refreshed' : ''}`);
    process.exit(0);
}

if (wantRefresh) {
    const current = readStore();
    if (!current) {
        if (asJson) emit({ event: 'error', message: 'no stored tokens — sign in first' });
        else console.error('No stored tokens — sign in first.');
        process.exit(1);
    }
    await refresh(current);
    if (asJson) emit({ event: 'refreshed', store: STORE });
    else console.log('Token refreshed.');
    process.exit(0);
}

try {
    // With --json the browser is the caller's to open — VS Code resolves the user's own browser and,
    // in a remote window, forwards the callback port back to the machine that browser runs on.
    const stored = await login(asJson ? { onAuthorize: (url) => emit({ event: 'authorize', url }) } : {});
    if (asJson) emit({ event: 'signed-in', accountId: stored.account_id || null, store: STORE });
    else {
        console.log('\nSigned in.');
        console.log(`  account_id: ${stored.account_id || '(none)'}`);
        console.log(`  saved to:   ${STORE}`);
    }
} catch (e) {
    // unsupported_country means the request went out without the proxy, which is a route problem and
    // not a credential one — worth saying wherever the failure is read.
    const bypassed = /unsupported_country/.test(e.message);
    if (asJson) emit({ event: 'error', message: e.message, proxyBypassed: bypassed });
    else {
        console.error(`\nSign-in failed: ${e.message}`);
        if (bypassed)
            console.error('  The request bypassed the proxy. Check the route with "npm run diag" in the repository.');
    }
    process.exitCode = 1;
}
