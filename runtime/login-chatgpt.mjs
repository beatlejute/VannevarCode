#!/usr/bin/env node
// ChatGPT subscription sign-in (OAuth PKCE) and token status. It lives in the runtime rather than in
// scripts/ because it is the only way into the subscription and scripts/ is not in the package — a
// Marketplace install would otherwise document a feature it cannot reach. The "Vannevar: Sign in to
// ChatGPT" command runs this file in a terminal, where the sign-in URL and the result are readable.
//
//   node ~/.claude/vannevar/login-chatgpt.mjs           — sign in
//   node ~/.claude/vannevar/login-chatgpt.mjs --status  — show status

import { login, status, refresh, readStore, STORE, CODEX_AUTH } from './proxy/auth-chatgpt.mjs';

const wantStatus = process.argv.includes('--status');
const wantRefresh = process.argv.includes('--refresh');

if (wantStatus) {
    const state = status();
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
        console.error('No stored tokens — sign in first.');
        process.exit(1);
    }
    await refresh(current);
    console.log('Token refreshed.');
    process.exit(0);
}

try {
    const stored = await login();
    console.log('\nSigned in.');
    console.log(`  account_id: ${stored.account_id || '(none)'}`);
    console.log(`  saved to:   ${STORE}`);
} catch (e) {
    console.error(`\nSign-in failed: ${e.message}`);
    if (/unsupported_country/.test(e.message))
        console.error('  The request bypassed the proxy. Check the route with "npm run diag" in the repository.');
    process.exitCode = 1;
}
