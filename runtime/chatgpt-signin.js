'use strict';

// The ChatGPT subscription sign-in, shared by the two places that start it: the command in the
// palette (extension.js) and the "Sign in to ChatGPT" row in the command menu's Settings section,
// which is where the account that Claude Code itself is signed in with is switched — that row is what
// a user looks at when the question is "which account am I on", so the subscription belongs there too.
//
// Both callers run the flow the same way, and neither of them runs it in this process: the OAuth calls
// have to go out through the proxy variables, node reads those once at startup with --use-env-proxy,
// and a fetch from an extension host started without the flag reaches auth.openai.com as a direct
// request — which answers unsupported_country wherever ChatGPT is not served.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT_NAME = 'login-chatgpt.mjs';
const STORE_NAME = 'chatgpt-auth.json';

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

// Read rather than asked for: the menu row is redrawn on every state push, and spawning a process to
// answer "are you signed in" that often would cost more than the flow itself. The two files are the
// ones auth-chatgpt.mjs itself reads, in its order.
function status(dir) {
    const store = readJson(path.join(dir, STORE_NAME));
    const codex = store ? null : readJson(path.join(os.homedir(), '.codex', 'auth.json'));
    const tokens = store || (codex && (codex.tokens || codex));
    if (!tokens || !tokens.access_token) return { loggedIn: false };
    const expiresAt = Number(tokens.expires_at || 0);
    return {
        loggedIn: true,
        source: store ? store.source || 'vannevar' : 'codex-cli',
        accountId: (store && store.account_id) || null,
        // Not a reason to sign in again: the proxy refreshes an expired token on the next call. It is
        // said on the row because a token that cannot be refreshed fails there and nowhere else.
        expired: expiresAt ? expiresAt < Date.now() : false,
    };
}

async function openSignInPage(vscode, url, log) {
    let opened = false;
    try {
        opened = await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (e) {
        log(`openExternal failed: ${e && e.message}`);
    }
    if (opened) return;
    // The flow is alive on localhost:1455 and unreachable at this point, and the URL is the only way
    // back into it — a few hundred characters of PKCE that nobody retypes off a notification.
    vscode.window
        .showWarningMessage('Vannevar: the sign-in page did not open by itself.', 'Copy sign-in link')
        .then((choice) => choice === 'Copy sign-in link' && vscode.env.clipboard.writeText(url));
}

// Runs the flow behind a progress notification and answers with the event that ended it:
// {event:'signed-in', accountId} , {event:'error', message} or null when it was cancelled.
// `onLog` takes the child's own lines; `showLog` is offered on a failure when the caller has one.
function signIn({ vscode, dir, onLog = () => {}, showLog = null }) {
    const script = path.join(dir, SCRIPT_NAME);
    if (!fs.existsSync(script)) {
        vscode.window.showWarningMessage(`Vannevar: the runtime is not installed — no ${script}.`);
        return Promise.resolve({ event: 'error', message: `no ${script}` });
    }

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Vannevar: signing in to ChatGPT',
            cancellable: true,
        },
        (progress, cancel) =>
            new Promise((finish) => {
                const child = spawn(process.execPath, ['--use-env-proxy', script, '--json'], {
                    // process.execPath is Code.exe in an extension host; without the flag it opens a
                    // window instead of running the script.
                    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                    windowsHide: true,
                });

                let result = null;
                let cancelled = false;
                let rest = '';

                // One JSON object per line on stdout; anything else the child says is for the log.
                const handle = (line) => {
                    if (!line) return;
                    let event = null;
                    try {
                        event = JSON.parse(line);
                    } catch {}
                    if (!event || !event.event) return onLog(`chatgpt sign-in: ${line}`);
                    onLog(`chatgpt sign-in: ${event.event}${event.message ? ` — ${event.message}` : ''}`);
                    if (event.event === 'authorize') {
                        progress.report({ message: 'finish the sign-in in the browser' });
                        openSignInPage(vscode, event.url, onLog);
                    } else result = event;
                };
                const read = (chunk) => {
                    rest += chunk;
                    const lines = rest.split('\n');
                    rest = lines.pop();
                    for (const line of lines) handle(line.trim());
                };

                child.stdout.setEncoding('utf8');
                child.stdout.on('data', read);
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', (chunk) => onLog(`chatgpt sign-in (stderr): ${String(chunk).trim()}`));
                child.on('error', (e) => {
                    result = { event: 'error', message: e.message };
                });

                cancel.onCancellationRequested(() => {
                    cancelled = true;
                    child.kill();
                });

                child.on('close', (code) => {
                    handle(rest.trim());
                    if (cancelled) {
                        onLog('chatgpt sign-in: cancelled');
                        return finish(null);
                    }

                    if (result && result.event === 'signed-in') {
                        vscode.window.showInformationMessage(
                            `Vannevar: signed in to ChatGPT${result.accountId ? ` (account ${result.accountId})` : ''}. ` +
                                'Pick a profile with "CCX_PROXY": "openai" to use the subscription.',
                        );
                        return finish(result);
                    }

                    const reason = (result && result.message) || `the sign-in ended with code ${code}`;
                    const hint = result && result.proxyBypassed ? ' The request went out without the proxy.' : '';
                    const failure = result || { event: 'error', message: reason };
                    const actions = showLog ? ['Show log'] : [];
                    vscode.window
                        .showWarningMessage(`Vannevar: the ChatGPT sign-in failed — ${reason}.${hint}`, ...actions)
                        .then((choice) => choice === 'Show log' && showLog());
                    finish(failure);
                });
            }),
    );
}

module.exports = { signIn, status };
