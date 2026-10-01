(function () {
    if (window.__ccx) return;

    // A page-level opt-out of the Claude.ai / Console login gate. The patched sign-in screen writes this
    // key and reloads the page; the guarded isAuthenticated memo reads the flag this restores, and this
    // script runs before the app module does, so a reload comes up on the session view instead of the
    // login screen. Kept here rather than in the app bundle because the host script is the one thing
    // that always runs first.
    try {
        if (window.localStorage.getItem('ccx:skipAnthropicLogin') === '1') globalThis.__ccxNoAuth = true;
    } catch (e) {
        /* storage unavailable: the gate simply stays as stock */
    }

    var api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    var rawPost = api ? api.postMessage.bind(api) : function () {};

    if (api) {
        var proxy = {
            postMessage: function (m) {
                trackOutgoing(m);
                return rawPost(m);
            },
            getState: api.getState.bind(api),
            setState: api.setState.bind(api),
        };
        window.acquireVsCodeApi = function () { return proxy; };
    }

    var state = { profiles: [], active: null, defaultProfile: null, sessionId: null, bindings: {} };
    var icons = {};
    var fallback = null;
    var registry = null;
    var ctx = null;
    // The session object (messages, busy, lastServedModel, send) — a different class from the context
    // object, and not reachable from it, so injection point #4 hands it over separately. Re-set on
    // every registration, which the app re-runs whenever the model selection changes, so a tab that
    // swaps its session object is followed rather than remembered.
    var sessionObj = null;
    var jsx = null;
    var chip = null;
    var overlay = null;
    // Which of the two overlays is up: only the status list is worth repainting on a state push.
    var overlayKind = null;
    var launchByChannel = {};
    var sessionByChannel = {};
    var activeChannelId = null;
    var pendingRestart = null;
    // The last 1h cache signal the host reported for the active session ({ ttl, anchorAt }), and the
    // timer that fires the pre-expiry compaction. Both are page-local: a reload drops the signal, and
    // the next message_delta restores it; the enabled flag survives in localStorage.
    var cacheInfo = null;
    var autocompactTimer = null;
    var cacheSession = null;
    var searchSetter = null;
    var searchSeq = 0;
    var searchDebounceTimer = null;
    var spellcheckSeq = 0;
    var spellcheckTimer = null;
    // Delegated runs reported by the host, newest last, and the per-frame open/closed state. Both
    // live here rather than in the DOM: React owns the nodes a frame hangs off and re-creates them
    // freely, so anything remembered inside one is lost on the next commit.
    var agentRuns = [];
    var frameOpen = {};
    var frameTouched = {};
    var claimedRuns = {};
    // The last progress the app reported for a task-style subagent, by tool_use id. Kept because the
    // app DELETES its entry the moment the task ends (handleTaskNotification), and a frame that blanks
    // itself exactly when the run finishes is the one moment it is worth reading.
    var taskSnapshots = {};
    var spellcheckComposer = null;
    var spellcheckText = '';
    var spellcheckUnknown = new Set();
    var spellcheckSuggestions = {};
    // The pinned session ids, mirrored from the host. Two consumers: the row marks, drawn from the
    // DOM side, and the session list's own ordering, which only ever sees what pushPinned() hands
    // to its state setter — the component re-reads nothing on its own.
    var pinnedIds = new Set();
    var pinSetter = null;
    var pinPushed = null;
    // Uuids of the summary each compaction wrote, as the host's get_session_response marks them. The
    // page's own message objects drop that flag, so this is the only way to tell a summary apart from
    // an ordinary prompt once a transcript has been rebuilt from disk.
    var compactSummaryUuids = new Set();
    var compactionEdges = typeof WeakMap === 'function' ? new WeakMap() : null;

    function send(message) {
        rawPost(message);
    }

    function trackOutgoing(m) {
        if (!m || typeof m.type !== 'string') return;
        if (m.type === 'launch_claude') {
            activeChannelId = m.channelId;
            launchByChannel[m.channelId] = {
                channelId: m.channelId,
                cwd: m.cwd,
                resume: m.resume,
                permissionMode: m.permissionMode,
                thinkingLevel: m.thinkingLevel,
            };
            if (m.resume) noteSession(m.channelId, m.resume);
        } else if (m.type === 'io_message' && m.channelId) {
            activeChannelId = m.channelId;
        }
    }

    function noteSession(channelId, sessionId) {
        if (!sessionId) return;
        sessionByChannel[channelId] = sessionId;
        if (channelId === activeChannelId && sessionId !== state.sessionId) {
            state.sessionId = sessionId;
            send({ type: 'ccx:session', sessionId: sessionId });
        }
    }

    function syncAction() {
        if (!registry) return;
        var trailing = jsx && state.active
            ? jsx('span', { className: 'ccx-prov-tag', children: state.active })
            : undefined;
        try {
            registry.registerAction(
                {
                    id: 'ccx-provider',
                    label: 'Switch provider…',
                    description: 'Change API provider profile for this session',
                    trailingComponent: trailing,
                },
                'Model',
                openPicker
            );
            // An entry of its own rather than a section grafted into Account & Usage: that panel is
            // React-owned, its class names carry a per-build hash, and it reports one subscription —
            // while this reports every profile. The tally rides on the menu row, so the state of the
            // other providers is legible without opening anything.
            registry.registerAction(
                {
                    id: 'ccx-health',
                    label: 'Provider status…',
                    description: 'Last verdict from each API provider profile',
                    trailingComponent: healthTally(),
                },
                'Model',
                openHealth
            );
            // Sits under "Thinking" (toggle-thinking) by the Model section's sort order. keepMenuOpen
            // keeps the menu up so the checkbox can be flipped without re-opening it each time.
            registry.registerAction(
                {
                    id: 'ccx-autocompact',
                    label: 'Auto-compact before cache expiry',
                    description: 'Run /compact five minutes before the 1-hour prompt cache expires',
                    trailingComponent: autocompactTick(),
                    keepMenuOpen: true,
                },
                'Model',
                toggleAutocompact
            );
            // Settings, not Model: the row above it is "Switch account", which is the same question
            // asked of Anthropic — which account is this running on. The ChatGPT subscription is the
            // one provider whose credentials are not a key pasted into a profile, so it is the one
            // that needs a row of its own.
            registry.registerAction(
                {
                    id: 'ccx-chatgpt',
                    label: 'Sign in to ChatGPT…',
                    description: 'OAuth sign-in for the ChatGPT Plus/Pro subscription',
                    trailingComponent: chatgptTag(),
                },
                'Settings',
                startChatgptLogin
            );
            registry.registerAction(
                {
                    id: 'ccx-full-history',
                    label: 'History before compaction',
                    description: 'Show what /compact folded away when a session opens — view only, not sent to the model',
                    trailingComponent: historyTick(),
                    keepMenuOpen: true,
                },
                'Model',
                toggleHistoryBeforeCompaction
            );
        } catch (e) {
            console.warn('ccx: registerAction failed', e);
        }
    }

    // What the sign-in row says on its right: the state of the tokens on disk, as the host reads them.
    // An expired token is not a reason to sign in again — the proxy refreshes it on the next call — but
    // it is the state, and the row is the only place it is ever visible.
    function chatgptTag() {
        if (!jsx || !state.chatgpt) return undefined;
        var text = state.chatgpt.signingIn
            ? 'signing in…'
            : state.chatgpt.loggedIn
              ? state.chatgpt.expired
                  ? 'expired'
                  : 'signed in'
              : undefined;
        return text ? jsx('span', { className: 'ccx-prov-tag', children: text }) : undefined;
    }

    // The host owns the flow: it spawns the script with the proxy flag, opens the page through VS Code
    // and reports the result. The page only asks for it, and redraws when ccx:state comes back.
    function startChatgptLogin() {
        if (state.chatgpt && state.chatgpt.signingIn) return;
        send({ type: 'ccx:chatgptLogin' });
    }

    function tallyText(rows) {
        var down = 0;
        var known = 0;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].state === 'unknown') continue;
            known++;
            if (rows[i].state !== 'ok') down++;
        }
        if (!known) return 'not probed yet';
        return down ? known - down + ' ok · ' + down + ' down' : known + ' ok';
    }

    function healthTally() {
        if (!jsx) return undefined;
        var rows = providerRows(state.now || Date.now());
        var down = 0;
        var known = 0;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].state === 'unknown') continue;
            known++;
            if (rows[i].state !== 'ok') down++;
        }
        if (!known) return undefined;
        return jsx('span', {
            // One chip style, whatever the count says. A red pill next to the profile chip read as a
            // different kind of control; which providers are down is the rows' job to show.
            className: 'ccx-prov-tag',
            children: down ? down + ' down' : 'all ok',
        });
    }

    function openHealth() {
        closePicker();
        var rows = providerRows(state.now || Date.now());
        overlay = document.createElement('div');
        overlay.className = 'ccx-overlay';
        overlay.onclick = function (e) {
            if (e.target === overlay) closePicker();
        };
        overlayKind = 'health';

        var box = document.createElement('div');
        box.className = 'ccx-box ccx-health-box';

        var title = document.createElement('div');
        title.className = 'ccx-title';
        title.textContent = 'Provider status';
        var tally = document.createElement('span');
        tally.className = 'ccx-prov-tally';
        tally.textContent = tallyText(rows);
        title.appendChild(tally);
        box.appendChild(title);

        var hint = document.createElement('div');
        hint.className = 'ccx-hint';
        // Said out loud because it is the one thing a status list is normally assumed to do: this one
        // reports what the last real call found, and never spends a request of its own to refresh it.
        hint.textContent = 'What the last call to each profile found — checked before a delegated run, never from here';
        box.appendChild(hint);

        var list = document.createElement('div');
        list.className = 'ccx-prov-list';
        paintProviders(list, rows, state.active);
        box.appendChild(list);

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        var onKey = function (e) {
            if (e.key === 'Escape') {
                closePicker();
                window.removeEventListener('keydown', onKey, true);
            }
        };
        window.addEventListener('keydown', onKey, true);
    }

    function syncChip() {
        if (registry) {
            if (chip) chip.remove();
            chip = null;
            return;
        }
        if (!chip) {
            chip = document.createElement('button');
            chip.className = 'ccx-chip';
            chip.title = 'Claude provider';
            chip.onclick = openPicker;
            document.body.appendChild(chip);
        }
        chip.textContent = '⇄ ' + (state.active || 'subscription');
    }

    function closePicker() {
        if (overlay) overlay.remove();
        overlay = null;
        overlayKind = null;
    }

    function openPicker() {
        closePicker();
        overlay = document.createElement('div');
        overlay.className = 'ccx-overlay';
        overlay.onclick = function (e) {
            if (e.target === overlay) closePicker();
        };

        var box = document.createElement('div');
        box.className = 'ccx-box';

        var title = document.createElement('div');
        title.className = 'ccx-title';
        title.textContent = 'API provider';
        box.appendChild(title);

        var hint = document.createElement('div');
        hint.className = 'ccx-hint';
        hint.textContent = state.sessionId ? 'Bound to this session' : 'No active session yet — applies on next launch';
        box.appendChild(hint);

        state.profiles.forEach(function (p) {
            var row = document.createElement('div');
            row.className = 'ccx-row';
            row.onclick = function () {
                send({
                    type: 'ccx:apply',
                    sessionId: sessionByChannel[activeChannelId] || state.sessionId,
                    channelId: activeChannelId,
                    name: p.name,
                });
                closePicker();
            };
            var mark = document.createElement('span');
            mark.className = 'ccx-mark';
            mark.textContent = p.name === state.active ? '●' : '○';
            var name = document.createElement('span');
            name.textContent = p.name;
            var model = document.createElement('span');
            model.className = 'ccx-model';
            model.textContent = p.model || '—';
            // The default is a third state beside the active mark: the star sets which profile a new
            // tab falls back to, without touching the one this tab is on. Clicking it again clears it,
            // which puts the fallback back on settings.json / the subscription.
            var star = document.createElement('span');
            star.className = 'ccx-star';
            star.textContent = p.name === state.defaultProfile ? '★' : '☆';
            star.title = p.name === state.defaultProfile
                ? 'Default provider — click to clear'
                : 'Set as default for new sessions';
            star.onclick = function (e) {
                e.stopPropagation();
                send({ type: 'ccx:setDefault', name: p.name === state.defaultProfile ? null : p.name });
                toast(p.name === state.defaultProfile
                    ? 'Default cleared — new sessions fall back to settings.json.'
                    : 'Default provider set to "' + p.name + '".');
                closePicker();
            };
            row.append(mark, name, model, star);
            box.appendChild(row);
        });

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        var onKey = function (e) {
            if (e.key === 'Escape') {
                closePicker();
                window.removeEventListener('keydown', onKey, true);
            }
        };
        window.addEventListener('keydown', onKey, true);
    }

    window.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || typeof d.type !== 'string') return;

        if (d.type === 'from-extension') {
            var msg = d.message;
            if (!msg) return;
            if (msg.type === 'io_message' && msg.message) {
                var inner = msg.message;
                if (inner.type === 'system' && inner.subtype === 'init' && inner.session_id)
                    noteSession(msg.channelId, inner.session_id);
                if (inner.type === 'system' && inner.subtype === 'compact_boundary')
                    onCompactBoundary(msg.channelId);
            } else if (msg.type === 'response' && msg.response && msg.response.type === 'get_session_response') {
                noteCompactSummaries(msg.response.messages);
            } else if (msg.type === 'close_channel' && pendingRestart && msg.channelId === pendingRestart.channelId) {
                var job = pendingRestart;
                pendingRestart = null;
                clearTimeout(job.timer);
                setTimeout(function () { doLaunch(job); }, 150);
            }
            return;
        }

        if (d.type === 'ccx:state') {
            state = {
                profiles: d.profiles || [],
                active: d.active || null,
                defaultProfile: d.defaultProfile || null,
                models: d.models || null,
                bindings: d.bindings || {},
                // The host stamps every state push, so the ages in the panel are all measured from
                // one instant instead of from whenever each row happened to be drawn.
                now: d.now || Date.now(),
                sessionId: d.sessionId || state.sessionId,
                // The state the page keeps is rebuilt field by field, not merged — anything the host
                // sends and this list does not name is dropped on the next push.
                historyBeforeCompaction: d.historyBeforeCompaction === true,
                chatgpt: d.chatgpt || null,
            };
            rememberHistoryBeforeCompaction(state.historyBeforeCompaction);
            adoptAttachmentPrompts(d.attachmentPrompts);
            adoptPinned(d.pinnedSessions);
            // Retracted uuids arrive from the host; a session change resets the set, otherwise the
            // host's list merges in (the host only ever adds, so local in-flight additions survive).
            if (state.sessionId !== hiddenSession) {
                hiddenSession = state.sessionId;
                hiddenUuids = new Set();
                pendingRetractBefore = null;
                pendingRetractText = null;
                pendingRetractIdx = -1;
                pendingRetractResponse = false;
            }
            if (Array.isArray(d.hiddenMessages))
                for (var hi = 0; hi < d.hiddenMessages.length; hi++) hiddenUuids.add(d.hiddenMessages[hi]);
            // The cache signal belongs to one session; a new one starts with no signal and no timer.
            if (state.sessionId !== cacheSession) {
                cacheSession = state.sessionId;
                cacheInfo = null;
                cancelAutocompact();
            }
            syncAction();
            syncChip();
            if (overlayKind === 'health') openHealth();
            if (overlayKind === 'resources') openResources();
            decorateModelPicker();
            decorateSessionList();
            decorateAgentFrames();
            decorateSidebar();
            decorateResourcePill();
            applyHidden();
        } else if (d.type === 'ccx:icons') {
            icons = d.icons || {};
            fallback = d.fallback || null;
            decorateSessionList();
            decorateSidebar();
            // An icon arriving after the fact is the one thing the open status list cannot redraw on
            // its own — it was painted before the host got round to sending the brand marks.
            if (overlayKind === 'health') openHealth();
        } else if (d.type === 'ccx:applied') {
            if (d.sessionId && !state.sessionId) state.sessionId = d.sessionId;
            restartChannel(d.name);
        } else if (d.type === 'ccx:searchResults') {
            // A later keystroke may already have moved past this — only the newest request's answer counts.
            if (d.seq !== searchSeq || !searchSetter) return;
            searchSetter(d.matches && d.matches.length ? new Set(d.matches) : null);
        } else if (d.type === 'ccx:spellcheckResult') {
            applySpellcheckResult(d);
        } else if (d.type === 'ccx:cache') {
            // Two kinds of signal arrive here. The 1h tier is measured — the host reads it off the
            // usage split — and every other tier from the Anthropic API is treated as "no signal", so
            // a stale timer never fires on a session that has since dropped to the 5m one. The second
            // kind is a declared lifetime for a backend with no split to read: `ttlMinutes` comes from
            // the profile, is an operator's estimate from documentation, and is never dressed as a
            // measurement — the page labels it where it is used and nowhere pretends to know more.
            if (d.ttl === '1h' && typeof d.anchorAt === 'number') cacheInfo = { ttl: '1h', anchorAt: d.anchorAt };
            else if (d.ttl === 'declared' && typeof d.anchorAt === 'number' && Number(d.ttlMinutes) > 0)
                cacheInfo = { ttl: 'declared', ttlMinutes: Number(d.ttlMinutes), profile: d.profile || '', anchorAt: d.anchorAt };
            else cacheInfo = null;
            decorateCachePill();
            if (autocompactPref()) scheduleAutocompact();
            else cancelAutocompact();
        } else if (d.type === 'ccx:agentRuns') {
            // Inert data for a read-only frame and for the agent map's rows. It is never written into
            // the composer, nothing of what a run said goes back to the host (the map's two buttons send
            // a run's session id and nothing else), and the only thing of the app's it reaches is the
            // agent map's own Map, which is view state (see syncAgentMap) — the tab's context is the
            // tool call and its result, and that is all it stays.
            agentRuns = Array.isArray(d.runs) ? d.runs : [];
            claimedRuns = {};
            decorateAgentFrames();
        } else if (d.type === 'ccx:openResourceResult') {
            // Success is silent — the editor or the browser has already answered for it. A refusal is
            // the only thing the page can say something about, and the host words it.
            if (d.seq !== resourceSeq) return;
            if (!d.ok) toast(d.error || 'Could not open that resource.');
        } else if (d.type === 'ccx:agentReply') {
            onAgentReply(d);
        }
    });

    var ALIAS_BY_LABEL = [
        { test: /^Default\b/, key: 'opus' },
        { test: /^Opus\b/, key: 'opus' },
        { test: /^Fable\b/, key: 'fable' },
        { test: /^Sonnet\b/, key: 'sonnet' },
        { test: /^Haiku\b/, key: 'haiku' },
    ];

    function decorateModelPicker() {
        if (!state.models) {
            document.querySelectorAll('.ccx-model-tag').forEach(function (n) {
                n.remove();
            });
            return;
        }
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var pending = [];
        var node;
        while ((node = walker.nextNode())) {
            var text = node.nodeValue && node.nodeValue.trim();
            if (!text || text.length > 24) continue;
            for (var i = 0; i < ALIAS_BY_LABEL.length; i++) {
                if (!ALIAS_BY_LABEL[i].test.test(text)) continue;
                var model = state.models[ALIAS_BY_LABEL[i].key];
                if (model) pending.push({ node: node, model: model });
                break;
            }
        }
        pending.forEach(function (item) {
            var host = item.node.parentElement;
            if (!host || host.dataset.ccxModel === item.model) return;
            var old = host.querySelector(':scope > .ccx-model-tag');
            if (old) old.remove();
            var tag = document.createElement('span');
            tag.className = 'ccx-model-tag';
            tag.textContent = item.model;
            host.appendChild(tag);
            host.dataset.ccxModel = item.model;
        });
    }

    // The values the composer actually shows are the session's live signals, not settings.json — that
    // file only holds the defaults, so it names whatever chat last changed /model or /effort, which is
    // exactly the "not this chat" complaint. A fresh session reports undefined until the user picks, and
    // the picker renders that as "Auto".
    function sessionField(name) {
        var s = sessionObj;
        try {
            var v = s && s[name];
            return v && typeof v === 'object' && 'value' in v ? v.value : undefined;
        } catch (e) {
            return undefined;
        }
    }

    // The session id is nowhere in the DOM: the history row is a bare <button> whose entire prop object
    // is {ref, className, onClick, onMouseMove, children}, and the id exists only as the React key at the
    // call site. React writes __reactFiber$<random> onto every host node it creates, but that pointer is
    // set at mount and never refreshed — with double buffering it is the stale alternate about every other
    // commit, so memoizedProps cannot be trusted. createWorkInProgress does copy `key` onto the alternate,
    // which makes fiber.key the one stale-proof read — and it is exactly the session id.
    var CCX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    var fiberKey = null;

    function fiberKeyOf(node) {
        if (fiberKey && fiberKey in node) return fiberKey;
        var names = Object.keys(node);
        for (var i = 0; i < names.length; i++) {
            if (names[i].indexOf('__reactFiber$') === 0) {
                fiberKey = names[i];
                return fiberKey;
            }
        }
        return null;
    }

    // The session's own fields are signals — read through .value
    function signalValue(v) {
        try {
            return v && typeof v === 'object' && 'value' in v ? v.value : undefined;
        } catch (e) {
            return undefined;
        }
    }

    // Two independent reads of the same value. A non-UUID key means the parent fell back to the array
    // index (the session had no id when it rendered), and a disagreement means the fiber is stale or
    // re-keyed — both give up, because a wrong provider icon is worse than none.
    function sessionIdOfRow(row) {
        var key = fiberKeyOf(row);
        var fiber = key ? row[key] : null;
        if (!fiber) return null;
        var fromKey = null;
        var fromProps = null;
        for (var d = 0; fiber && d < 4; d++, fiber = fiber.return) {
            if (!fromKey && typeof fiber.key === 'string' && CCX_UUID.test(fiber.key)) fromKey = fiber.key;
            if (!fromProps) {
                var session = fiber.memoizedProps && fiber.memoizedProps.session;
                var id = session && signalValue(session.sessionId);
                if (typeof id === 'string' && CCX_UUID.test(id)) fromProps = id;
            }
            if (fromKey && fromProps) break;
        }
        if (!fromKey) return null;
        if (fromProps && fromProps !== fromKey) return null;
        return fromKey;
    }

    function applyRowIcon(row) {
        var id = null;
        try {
            id = sessionIdOfRow(row);
        } catch (e) {
            id = null;
        }
        var name = (id && state.bindings && state.bindings[id]) || null;
        var uri = (name && icons[name]) || null;
        // A resolved session with no binding of its own ran on whatever settings.json said, so it takes
        // the host's fallback mark. An UNRESOLVED row takes nothing: guessing there could put a provider
        // on the wrong session, and a wrong icon is worse than none.
        var assumed = false;
        if (id && !uri && fallback && fallback.uri) {
            name = fallback.name;
            uri = fallback.uri;
            assumed = true;
        }
        var stamp = uri ? id + '|' + name + (assumed ? '|~' : '') : '';
        if (row.dataset.ccxRow === stamp) return;
        row.dataset.ccxRow = stamp;
        if (!uri) {
            row.removeAttribute('data-ccx-provider');
            row.style.removeProperty('--ccx-icon');
            row.removeAttribute('title');
            return;
        }
        // data-* and inline style survive React's commits; className does not — it is rewritten on every
        // isActive/isFocused change, so the icon must not hang off a class of ours
        row.setAttribute('data-ccx-provider', name);
        row.style.setProperty('--ccx-icon', 'url("' + uri + '")');
        row.title = 'Provider: ' + name + (assumed ? ' (default — not recorded for this session)' : '');
    }

    function decorateSessionList() {
        try {
            // The _<hash> suffix is a CSS-module content hash — match by prefix, never literally
            var rows = document.querySelectorAll('button[class*="sessionItem_"]');
            for (var i = 0; i < rows.length; i++) {
                applyRowIcon(rows[i]);
                applyRowPin(rows[i]);
            }
        } catch (e) {
            /* an unrecognised list is a list without icons, not a broken webview */
        }
    }

    // --- Pinned sessions ----------------------------------------------------------------------
    //
    // The history list is ordered by the app, by recency, and re-derived on every render — so a pin
    // cannot be a DOM move: the next commit would undo it. It is a sort instead, applied where the
    // list is computed (injection point #7), which puts the row above the rest for the app's own
    // keyboard navigation too, not just visually.
    //
    // Ordering has to reach the component as state or nothing re-renders when a pin is toggled, so
    // the patch declares a state pair for it and hands the setter over here, the same way content
    // search does. The page stays the owner of the value; the state pair is what makes it visible.
    function adoptPinned(list) {
        if (!Array.isArray(list)) return;
        var next = new Set();
        for (var i = 0; i < list.length; i++) if (typeof list[i] === 'string' && list[i]) next.add(list[i]);
        pinnedIds = next;
        pushPinned();
    }

    function samePins(a, b) {
        if (!a || !b || a.size !== b.size) return false;
        var values = a.values();
        for (var v = values.next(); !v.done; v = values.next()) if (!b.has(v.value)) return false;
        return true;
    }

    // A fresh Set every time, because that identity is the whole re-render signal — but only when
    // the membership actually changed, or every state push would re-render the list for nothing.
    function pushPinned() {
        if (!pinSetter || samePins(pinPushed, pinnedIds)) return;
        pinPushed = new Set(pinnedIds);
        pinSetter(pinPushed);
    }

    // Called from the component's own render, on every render — hence the identity guard: writing
    // state from inside a render is what it exists to avoid, and the setter is stable across them.
    function onPinState(setter) {
        if (setter === pinSetter) return;
        pinSetter = setter;
        pinPushed = null;
        setTimeout(pushPinned, 0);
    }

    // A stable partition, not a comparator: rows fall into blocks — pinned, running, the rest, and
    // under a query the last two again for rows that matched by transcript — and keep the list's own
    // recency order inside each one, so neither a pin, nor a turn starting, nor a search ever
    // reorders anything else.
    //
    // The middle blocks are the row's own status dot: the third argument is the
    // component's accessor for it (openState — "waiting" / "running" / "idle" / "unread", and nothing
    // at all for a session that is neither open in a tab nor holding unread output), the same function
    // that decides whether the dot is drawn green, grey, or not drawn. Sorting by the dot rather than
    // by the raw signals is what puts an open-but-idle session above a closed one: idle and closed
    // differ only by the openSessionIds prop, which the accessor closes over.
    //
    // "unread" arrived in 2.1.257 and is returned for an open session as well as a closed one — an
    // open idle session with unread output reports "unread", not "idle". Treating it as anything but
    // block 2 would therefore sink open sessions to the bottom, which is the opposite of the point.
    //
    // Without the accessor — an older patcher, or a bundle whose openSessionIds memo has moved — the
    // raw busy/pendingInput signals still separate the running rows from the rest, so the sort
    // degrades to two blocks instead of failing.
    //
    // The second argument is what the component last received. Before the first push it is null and
    // the page's own copy stands in — it is authoritative either way, and the two only differ for
    // the one render between a toggle and the state write landing.
    //
    // The fourth is the search half: under a query a row is on screen for one of two reasons — its
    // own name (or branch) matched, or the transcript did — and the one the user typed a name for
    // should not sit under a row that merely said the word once. The ids whose name matched are
    // collected by the filter itself (injection point #7), so this only has to read the set. Without
    // a query it is null and every row counts as a name match, which is the ordering as it was.
    function pinSort(list, fromState, openState, titleMatches) {
        try {
            var pins = fromState && typeof fromState.has === 'function' ? fromState : pinnedIds;
            var titles = titleMatches && typeof titleMatches.has === 'function' ? titleMatches : null;
            if (!list || !list.length) return list;
            var blocks = [[], [], [], [], [], [], []];
            var highest = 0;
            var moved = false;
            for (var i = 0; i < list.length; i++) {
                var session = list[i];
                var rank = sessionRank(session, pins, openState, titles);
                if (rank < highest) moved = true;
                else highest = rank;
                blocks[rank].push(session);
            }
            // A list already in block order is handed back untouched: a fresh array would be a new
            // identity for nothing, and this one is what the component memoises against.
            if (!moved) return list;
            var out = [];
            for (var b = 0; b < blocks.length; b++) out = out.concat(blocks[b]);
            return out;
        } catch (e) {
            /* an unrecognised list is an unsorted list, not a broken history panel */
            return list;
        }
    }

    // 0 pinned, then one block per liveness rank — 1 running a turn or waiting for input, 2 open in a
    // tab but idle or holding unread output, 3 neither — and, under a query, the same three again at
    // 4/5/6 for the rows that matched by transcript rather than by name. A pin still outranks both:
    // it is the one ordering the user set by hand, and a search that hides it does so by filtering the
    // row out, not by sinking it.
    function sessionRank(session, pins, openState, titles) {
        var id = session && session.sessionId && session.sessionId.value;
        if (id && pins && pins.size && pins.has(id)) return 0;
        var live = livenessRank(session, openState);
        return titles && !(id && titles.has(id)) ? live + 3 : live;
    }

    // Archived sessions are the app's own section, built after the sort and rendered last whatever the
    // sort did — so a search that found an archived session BY NAME could never show it where the user
    // is looking: the row sat under the "Archived sessions" fold below every transcript hit. Under a
    // query the archived rows whose name matched are therefore reported as not archived, for the one
    // call that partitions the list (injection point #11) and nowhere else. They land in the main block
    // among the other name hits, in the order the sort already put them.
    //
    // Only the name hits are lifted. A query that merely occurs in an archived transcript is why the
    // section exists — archiving is how a session is put out of the way, and emptying the fold of
    // everything a query touches would undo that.
    //
    // Every other read of the predicate is the app's own: the row still offers Unarchive rather than
    // Archive, and the group/drag rules are unchanged, because those call the real one.
    function archivedFilter(isArchived, titleMatches) {
        if (typeof isArchived !== 'function') return isArchived;
        if (!titleMatches || typeof titleMatches.has !== 'function' || !titleMatches.size) return isArchived;
        return function (session) {
            if (!isArchived(session)) return false;
            var id = session && session.sessionId && session.sessionId.value;
            return !(id && titleMatches.has(id));
        };
    }

    function livenessRank(session, openState) {
        var dot = null;
        if (typeof openState === 'function') {
            try {
                dot = openState(session);
            } catch (e) {
                /* the accessor is the app's own; a throw from it is not this sort's business */
            }
        }
        if (dot === 'running' || dot === 'waiting') return 1;
        if (dot === 'idle' || dot === 'unread') return 2;
        // No dot at all, or a state this version has never heard of: fall back to the two signals the
        // dot is drawn from, which are on the row whether or not the accessor reached us.
        var busy = session && session.busy && session.busy.value === true;
        var pending = session && session.pendingInput && session.pendingInput.value === true;
        return busy || pending ? 1 : 3;
    }

    function togglePin(sessionId) {
        if (!sessionId) return;
        var pinned = !pinnedIds.has(sessionId);
        // Optimistic: the host echoes the authoritative list back on the next ccx:state, but the row
        // has to move now, not a round trip later.
        if (pinned) pinnedIds.add(sessionId);
        else pinnedIds.delete(sessionId);
        pushPinned();
        decorateSessionList();
        send({ type: 'ccx:pinSession', sessionId: sessionId, pinned: pinned });
    }

    var PIN_PATHS = [
        'M12 17v5',
        'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
    ];

    // Built node by node rather than through innerHTML: the webview runs under a content policy that
    // can treat a markup string as a script sink, and this needs no markup to begin with.
    function pinGlyph() {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '12');
        svg.setAttribute('height', '12');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        for (var i = 0; i < PIN_PATHS.length; i++) {
            var path = document.createElementNS(ns, 'path');
            path.setAttribute('d', PIN_PATHS[i]);
            svg.appendChild(path);
        }
        return svg;
    }

    // Unlike the provider mark this cannot be a pseudo-element — it has to be clickable — so it is a
    // real child, appended last so it lands past the time column. React owns the row's other
    // children and reconciles them by position; an extra trailing node is outside that list, and the
    // observer pass puts it back at the end if a commit ever does move it.
    function applyRowPin(row) {
        var id = null;
        try {
            id = sessionIdOfRow(row);
        } catch (e) {
            id = null;
        }
        var pin = row.querySelector(':scope > .ccx-pin');
        // An unresolved row has no id to pin, and pinning the wrong session is worse than not
        // offering it — the same rule the provider icon follows.
        if (!id) {
            if (pin) pin.remove();
            return;
        }
        if (!pin) {
            pin = document.createElement('span');
            pin.className = 'ccx-pin';
            pin.setAttribute('role', 'button');
            pin.appendChild(pinGlyph());
            // The row is itself a <button> that opens the session, and the list runs its own
            // selection handling off mousedown — neither may see this one.
            pin.onmousedown = function (e) {
                e.preventDefault();
                e.stopPropagation();
            };
            pin.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                togglePin(pin.dataset.ccxSession || '');
            };
            row.appendChild(pin);
        } else if (row.lastElementChild !== pin) {
            row.appendChild(pin);
        }
        // Read back at click time rather than closed over: a row's DOM node is reused when the list
        // re-keys, and a captured id would then pin whatever used to sit in that slot.
        pin.dataset.ccxSession = id;
        var pinned = pinnedIds.has(id);
        pin.dataset.ccxPinned = pinned ? '1' : '0';
        pin.title = pinned ? 'Unpin from the top of the list' : 'Pin to the top of the list';
    }

    // --- The transcript message behind a bubble ---------------------------------------------
    //
    // Each transcript turn is rendered from a `message` prop — {type, uuid, content, timestamp, …} —
    // carried straight from the .jsonl line that produced it, which is not otherwise exposed anywhere
    // in the DOM or in ccx:state. The same fiber read as sessionIdOfRow gets it: no signal unwrapping
    // needed here, `message` is a plain object, not a signal.
    //
    // A `message` prop alone is not enough to trust an object found this way — walking up through
    // memoized props of intermediate wrappers can surface something else entirely that happens to carry
    // a field of that name (a live status/notification object, for one). A transcript message has this
    // whole shape together; nothing else plausibly does.
    function isTranscriptMessage(message) {
        return (
            message &&
            typeof message === 'object' &&
            (message.type === 'user' || message.type === 'assistant') &&
            typeof message.uuid === 'string' &&
            Array.isArray(message.content) &&
            message.timestamp !== undefined &&
            message.timestamp !== null
        );
    }

    function messagePropOf(node) {
        var key = fiberKeyOf(node);
        var fiber = key ? node[key] : null;
        // Deeper than sessionIdOfRow's four hops — that one only has to clear the registry component;
        // this has to clear whatever wraps the specific content-block renderer inside a turn, which
        // varies with how many layers a given block type (text, tool use, thinking) happens to add.
        for (var d = 0; fiber && d < 10; d++, fiber = fiber.return) {
            var message = fiber.memoizedProps && fiber.memoizedProps.message;
            if (isTranscriptMessage(message)) return message;
        }
        return null;
    }

    // --- Live subagent frames ------------------------------------------------------------------
    //
    // A delegated run is invisible while it happens. A native subagent renders as a fold with a tool
    // count, and a run_agent call as a spinner; in both cases the one thing that would say whether it
    // is working or stuck — what the agent is actually doing — is the thing not shown.
    //
    // The two sources are different but the frame is the same. A native subagent's whole conversation
    // is already in this page: its turns arrive on the same stream as everything else, tagged with the
    // tool_use id of the Task call that started them (`parentToolUseId` on a streamed or replayed
    // assistant turn, `sdkParentToolUseId` on one rebuilt from the SDK envelope), and the app files
    // them into `session.messages` and then declines to draw them. Nothing has to be fetched for that
    // one; it is a rendering job. A run_agent call is a separate process, so its lines come from the
    // host, which follows the agent's own transcript.
    //
    // Neither path feeds anything back: a frame is an inert sibling node inside the tool-call block,
    // built from data the page already has or was handed, and the parent turn never learns it exists.
    var TASK_TOOLS = { Task: 1, Agent: 1 };
    var MCP_AGENT_TOOL = 'mcp__vannevar-agents__run_agent';

    // The tool_use block is not in the DOM either — the div only carries a hashed class name. It is a
    // prop of the component that renders it (`content`, a wrapper whose own `.content` is the raw
    // block), which is the same walk messagePropOf already does for a turn, one level further in.
    function toolUseOf(node) {
        var key = fiberKeyOf(node);
        var fiber = key ? node[key] : null;
        for (var d = 0; fiber && d < 8; d++, fiber = fiber.return) {
            var props = fiber.memoizedProps;
            if (!props) continue;
            var candidates = [props.content, props.block, props.toolUse];
            for (var i = 0; i < candidates.length; i++) {
                var c = candidates[i];
                if (!c || typeof c !== 'object') continue;
                var raw = c.type === 'tool_use' ? c : c.content;
                if (raw && raw.type === 'tool_use' && typeof raw.id === 'string' && typeof raw.name === 'string')
                    return { block: raw, wrapper: c };
            }
        }
        return null;
    }

    // A wrapper exposes its tool result as a signal; its presence is what "this run has ended" means
    // for a native subagent, which reports no state of its own.
    function toolFinished(wrapper) {
        try {
            var result = wrapper && wrapper.toolResult;
            return Boolean(result && 'value' in result ? result.value : result);
        } catch (e) {
            return false;
        }
    }

    function blockOf(entry) {
        try {
            var raw = entry && entry.content;
            return raw && typeof raw === 'object' && typeof raw.type === 'string' ? raw : null;
        } catch (e) {
            return null;
        }
    }

    // A native subagent reaches the page in one of two shapes, and which one depends on how the
    // harness ran it.
    //
    // Inline, it is a conversation: its turns arrive on this tab's stream tagged with the tool_use id,
    // and messagesFor() below reads them whole. Run as a *task* (`task_type: "local_agent"` — what the
    // Agent tool does here, in the foreground as well as in the background), its turns never reach the
    // page at all; they go to the task's own output file. What the page gets instead is a progress
    // feed — `system/task_started|task_progress|task_notification` — which the app files into a
    // `subagentTasks` map and then reads only to count them for telemetry.
    //
    // So the task shape gives a summary, not a transcript: the last few tool names, a one-line summary
    // and running totals. That is what a frame can show for it, and it is still the difference between
    // "working" and "stuck".
    function taskFor(toolUseId) {
        var tasks = sessionField('subagentTasks');
        try {
            if (tasks && typeof tasks.forEach === 'function')
                tasks.forEach(function (t) {
                    if (t && t.toolUseId === toolUseId) taskSnapshots[toolUseId] = t;
                });
        } catch (e) {
            /* an unreadable map is one source missing, not a broken frame */
        }
        return taskSnapshots[toolUseId] || null;
    }

    function taskEvents(task) {
        var events = [];
        if (typeof task.prompt === 'string' && task.prompt.trim()) events.push({ k: 'prompt', t: task.prompt.slice(0, 1200) });
        var tools = task.recentTools;
        if (Array.isArray(tools)) for (var i = 0; i < tools.length; i++) if (tools[i]) events.push({ k: 'tool', n: String(tools[i]) });
        if (typeof task.summary === 'string' && task.summary.trim()) events.push({ k: 'text', t: task.summary.slice(0, 1200) });
        return events;
    }

    // The same shape the host sends for a delegated run, built here from the page's own messages, so
    // one renderer covers every source.
    function messagesFor(toolUseId) {
        var messages = sessionField('messages');
        if (!Array.isArray(messages)) return null;
        var events = [];
        for (var i = 0; i < messages.length; i++) {
            var m = messages[i];
            if (!m) continue;
            var parent = m.parentToolUseId || m.sdkParentToolUseId;
            if (parent !== toolUseId) continue;
            var content = m.content;
            if (!Array.isArray(content)) continue;
            for (var j = 0; j < content.length; j++) {
                var raw = blockOf(content[j]);
                if (!raw) continue;
                if (raw.type === 'text' && typeof raw.text === 'string' && raw.text.trim())
                    events.push({ k: m.type === 'user' ? 'prompt' : 'text', t: raw.text.slice(0, 1200) });
                else if (raw.type === 'thinking') events.push({ k: 'thinking' });
                else if (raw.type === 'tool_use') events.push({ k: 'tool', n: String(raw.name || 'tool'), t: toolArgument(raw.input) });
                else if (raw.type === 'tool_result') events.push({ k: 'result', ok: !raw.is_error });
            }
        }
        return events.slice(-160);
    }

    // Messages first: where they exist they are the whole conversation, which no progress feed can
    // match. The task snapshot is what is left when the turns went somewhere this page cannot see.
    function nativeEvents(toolUseId, task) {
        var fromMessages = messagesFor(toolUseId);
        if (fromMessages === null) return task ? taskEvents(task) : null;
        if (fromMessages.length) return fromMessages;
        return task ? taskEvents(task) : fromMessages;
    }

    function toolArgument(input) {
        if (!input || typeof input !== 'object') return '';
        var keys = ['file_path', 'command', 'pattern', 'path', 'query', 'url', 'prompt', 'description'];
        for (var i = 0; i < keys.length; i++) {
            var v = input[keys[i]];
            if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim().slice(0, 200);
        }
        return '';
    }

    // An MCP server never sees the tool_use id of the call that reached it, so the manifest cannot
    // name the block it belongs to. The prompt can: it is the same string on both sides, and it is
    // already on screen. Where two live runs carry the same prompt the newest unclaimed one wins,
    // which is the only answer that keeps two identical calls from sharing one frame.
    function runForPrompt(prompt) {
        if (typeof prompt !== 'string' || !prompt.trim()) return null;
        var best = null;
        for (var i = 0; i < agentRuns.length; i++) {
            var run = agentRuns[i];
            // A run with a parent was started by another agent, not by this tab: it belongs inside
            // its parent's frame and must never be adopted by a block of its own.
            if (run.parent || claimedRuns[run.session]) continue;
            if (!samePrompt(run.prompt, prompt)) continue;
            if (!best || (run.startedAt || 0) >= (best.startedAt || 0)) best = run;
        }
        if (best) claimedRuns[best.session] = true;
        return best;
    }

    // The manifest carries the prompt capped, so the shorter of the two is compared against the other.
    function samePrompt(a, b) {
        a = a || '';
        b = b || '';
        var n = Math.min(a.length, b.length);
        return n > 0 && a.slice(0, n) === b.slice(0, n);
    }

    function span(ms) {
        if (!ms || ms < 0) return '';
        var s = Math.round(ms / 1000);
        if (s < 60) return s + 's';
        var m = Math.floor(s / 60);
        return m + 'm ' + (s % 60) + 's';
    }

    // A run the tab started can itself delegate, and then it spends the whole time dispatching while
    // its child does the work — the frame would truthfully show almost nothing. So a child's lines are
    // folded into its parent's frame, under a header of their own, and the parent's own note counts
    // the whole tree rather than just its own two tool calls.
    function withChildren(run, depth) {
        var events = (run.events || []).slice();
        if (depth >= 2) return events;
        for (var i = 0; i < agentRuns.length; i++) {
            var child = agentRuns[i];
            if (!child.parent || child.parent !== run.session) continue;
            claimedRuns[child.session] = true;
            events.push({ k: 'child', run: child });
            events = events.concat(withChildren(child, depth + 1));
        }
        return events;
    }

    function eventLine(e) {
        if (e.k === 'child') {
            var meta = runMeta(e.run);
            return { cls: 'ccx-agent-child', text: meta.title + ' — ' + meta.note };
        }
        if (e.k === 'tool') return { cls: 'ccx-agent-tool', text: e.t ? e.n + ' ' + e.t : e.n };
        if (e.k === 'thinking') return { cls: 'ccx-agent-thinking', text: 'thinking' };
        if (e.k === 'result') return null;
        if (e.k === 'prompt') return { cls: 'ccx-agent-prompt', text: e.t };
        return { cls: 'ccx-agent-text', text: e.t };
    }

    function ensureChild(parent, className, tag) {
        for (var i = 0; i < parent.children.length; i++)
            if (parent.children[i].className === className) return parent.children[i];
        var el = document.createElement(tag || 'div');
        el.className = className;
        parent.appendChild(el);
        return el;
    }

    // The frame is appended to the tool-call div rather than inserted anywhere particular: React
    // reconciles that subtree by references it holds, and an unknown node at the end stays clear of
    // its insertBefore calls. If a commit does drop it, the
    // observer puts it back on the next pass.
    function paintFrame(host, id, open, meta, events) {
        var frame = ensureChild(host, 'ccx-agent-frame');
        frame.dataset.ccxOpen = open ? '1' : '0';
        frame.dataset.ccxState = meta.state;

        var head = ensureChild(frame, 'ccx-agent-head');
        if (!head.dataset.ccxWired) {
            head.dataset.ccxWired = '1';
            head.addEventListener('click', function (e) {
                e.stopPropagation();
                e.preventDefault();
                // Read the current state off the node rather than the closure: this listener is wired
                // once and every later paint has its own `meta`.
                frameOpen[id] = frame.dataset.ccxOpen !== '1';
                frameTouched[id] = true;
                decorateAgentFrames();
            });
        }
        var caret = ensureChild(head, 'ccx-agent-caret', 'span');
        caret.textContent = open ? '▾' : '▸';
        var title = ensureChild(head, 'ccx-agent-title', 'span');
        if (title.textContent !== meta.title) title.textContent = meta.title;
        var note = ensureChild(head, 'ccx-agent-note', 'span');
        if (note.textContent !== meta.note) note.textContent = meta.note;

        var body = ensureChild(frame, 'ccx-agent-body');
        if (!open || !events) {
            body.textContent = '';
            return;
        }
        // Rebuilt only when the tail actually changed: this runs on every observer pass, and rewriting
        // the body each time would fight the user's own scrolling inside it.
        var stamp = meta.note + '|' + String(events.length) + '|' + (events.length ? JSON.stringify(events[events.length - 1]) : '');
        if (body.dataset.ccxStamp === stamp) return;
        body.dataset.ccxStamp = stamp;
        // Temporary diagnostic on the channel the model indicator already uses. A frame that renders
        // correctly in a harness and wrongly in the real page is a difference only the real page can
        // report, and guessing at it from a screenshot has already cost two rounds.
        reportFrame(id, open, meta, events);
        var atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
        body.textContent = '';
        if (!events.length) {
            var idle = document.createElement('div');
            idle.className = 'ccx-agent-idle';
            idle.textContent = meta.running ? 'starting…' : 'nothing was recorded for this run';
            body.appendChild(idle);
        }
        for (var i = 0; i < events.length; i++) {
            var line = eventLine(events[i]);
            if (!line) continue;
            var row = document.createElement('div');
            row.className = line.cls;
            row.textContent = line.text;
            body.appendChild(row);
        }
        // Only follow the tail for a reader who was already at it. Someone who scrolled back to read
        // an earlier line in a live frame should not be yanked forward by the next one.
        if (atBottom) body.scrollTop = body.scrollHeight;
    }

    // Compact by construction: kind tallies and the first few rendered rows, never the text itself —
    // an agent's transcript is not something to copy into a log file.
    function reportFrame(id, open, meta, events) {
        try {
            var kinds = {};
            for (var i = 0; i < events.length; i++) kinds[events[i].k] = (kinds[events[i].k] || 0) + 1;
            var rows = [];
            for (var j = 0; j < events.length && rows.length < 8; j++) {
                var line = eventLine(events[j]);
                if (line) rows.push(line.cls.replace('ccx-agent-', '') + ':' + (line.text || '').slice(0, 24));
            }
            send({
                type: 'ccx:debug',
                reason: 'agentFrame',
                dump: { id: id, open: open, state: meta.state, note: meta.note, total: events.length, kinds: kinds, rows: rows },
            });
        } catch (e) {}
    }

    function dropFrame(host) {
        for (var i = 0; i < host.children.length; i++)
            if (host.children[i].className === 'ccx-agent-frame') {
                host.children[i].remove();
                return;
            }
    }

    // Open while it runs, closed once it has answered — the answer itself is the tool result right
    // below. A frame the reader has touched keeps whatever they chose.
    function frameIsOpen(id, running) {
        return frameTouched[id] ? Boolean(frameOpen[id]) : running;
    }

    function nativeMeta(block, running, events, task) {
        var input = block.input || {};
        var name = typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'subagent';
        var description = typeof input.description === 'string' && input.description ? input.description : task && task.description;
        // The task's own totals beat anything counted here: they cover the whole run, including the
        // tool calls whose names never made it into the last-three list.
        var usage = task && task.usage;
        var counted = 0;
        if (events) for (var i = 0; i < events.length; i++) if (events[i].k === 'tool') counted++;
        var tools = usage && usage.toolUses ? usage.toolUses : counted;
        // Grouped the same way the delegated run's own report groups its totals ('en-US', not the
        // runtime locale), so two frames side by side read as one thing.
        var tokens = usage && usage.totalTokens ? Number(usage.totalTokens).toLocaleString('en-US') + ' tok' : '';
        return {
            running: running,
            state: running ? 'running' : 'done',
            title: name + (description ? ' · ' + description : ''),
            note: [running ? 'running' : 'done', tools ? tools + ' tool calls' : '', tokens].filter(Boolean).join(' · '),
        };
    }

    function runMeta(run, tree) {
        var running = run.state === 'running';
        var elapsed = span((running ? Date.now() : run.finishedAt || Date.now()) - (run.startedAt || 0));
        var tools = 0;
        if (tree) for (var i = 0; i < tree.length; i++) if (tree[i].k === 'tool') tools++;
        return {
            running: running,
            state: run.state,
            title: (run.profile || 'agent') + (run.model ? ' · ' + run.model : ''),
            note: [running ? 'running' : run.state, elapsed, tools ? tools + ' tool calls' : '', run.tokens || '', (run.error || '').slice(0, 80)]
                .filter(Boolean)
                .join(' · '),
        };
    }

    // The host posts only when a run's tail actually changes, which is right for the body and wrong
    // for the clock: an agent that thinks for a minute without writing anything would leave the frame
    // reading the same elapsed time, which is indistinguishable from a frame that has died. So a
    // running frame repaints itself once a second regardless of what the host has to say.
    function watchRunningFrames() {
        // Guarded rather than assumed: the page is booted headless by the test harnesses, and a
        // missing timer here would take the whole bootstrap — every other decoration with it — down.
        if (typeof setInterval !== 'function') return;
        setInterval(function () {
            for (var i = 0; i < agentRuns.length; i++)
                if (agentRuns[i].state === 'running') {
                    decorateAgentFrames();
                    return;
                }
        }, 1000);
    }

    function decorateAgentFrames() {
        // Every moment a frame can change is a moment the agent map can, so the two ride the same passes.
        syncAgentMap();
        try {
            claimedRuns = {};
            var nodes = document.querySelectorAll('[class*="toolUse_"]');
            for (var i = 0; i < nodes.length; i++) {
                var host = nodes[i];
                var found = toolUseOf(host);
                var block = found && found.block;
                if (!block) {
                    dropFrame(host);
                    continue;
                }
                if (TASK_TOOLS[block.name]) {
                    var running = !toolFinished(found.wrapper);
                    var open = frameIsOpen(block.id, running);
                    // The body is the whole cost of this pass: filling it means walking every message
                    // in the transcript looking for the ones tagged with this call, and this runs on
                    // every commit. A closed frame is not worth that, and a transcript full of old
                    // Task calls is exactly where it would add up.
                    // Read on every pass, open or closed: the app throws the entry away when the task
                    // ends, so a frame that only looked while it was open would miss the final state.
                    var task = taskFor(block.id);
                    var events = open ? nativeEvents(block.id, task) : null;
                    // Nothing readable at all means the session object is not reachable this commit —
                    // leaving the previous frame alone beats blanking it on a transient miss.
                    if (open && !events) continue;
                    paintFrame(host, block.id, open, nativeMeta(block, running, events, task), events);
                } else if (block.name === MCP_AGENT_TOOL) {
                    var run = runForPrompt(block.input && block.input.prompt);
                    if (!run) {
                        dropFrame(host);
                        continue;
                    }
                    var tree = withChildren(run, 0);
                    paintFrame(host, block.id, frameIsOpen(block.id, run.state === 'running'), runMeta(run, tree), tree);
                } else {
                    dropFrame(host);
                }
            }
        } catch (e) {
            /* a missing frame is a plainer tool call, not a broken transcript */
        }
    }

    // --- Delegated runs in the agent map --------------------------------------------------------
    //
    // Claude Code has an agent map (every release on the verified list has it, 2.1.274 on): a pill
    // beside the model picker that counts the tab's live subagents, and a dialog with one row per agent
    // — status, time, context — and a card behind each row with the prompt, the result, "Open
    // transcript" and "Stop agent". All of it is drawn from one signal on the session, `agentMapAgents`,
    // a Map of task id → entry that the app fills from its own task events. A run_agent call is not a
    // task, so a delegated run never appeared there.
    //
    // It does now, by the same route: an entry of ours goes into that Map, and the pill, the tree and
    // the card are the app's own. The entries are view state and nothing else — the Map is read by the
    // pill, the dialog and one telemetry count, never by anything that talks to the CLI, and the tab's
    // context stays the tool call and its result.
    //
    // Where a run comes from decides where it hangs:
    //   - a run_agent call in this tab's messages is one entry, keyed by its tool_use id, under whoever
    //     made the call — the main agent, or an inline subagent. Its run is matched by prompt, the way
    //     the inline frame matches it. A call whose run is gone (swept, or from an old session) still
    //     gets an entry, built from the call and its result, as the app does for its own subagents;
    //   - a run whose `owner` is this tab's session but which no call here explains was started by a
    //     subagent whose turns never reach the page. It goes at the top level;
    //   - a run whose `parent` is one of the above hangs under it.
    //
    // The app rewrites the Map on its own events: it rebuilds it from the transcript when a session
    // loads, and marks every working entry stopped when the tab's process ends. So ours are put back on
    // any pass that finds them missing or altered, and left alone when they are intact — the same
    // object, no write — which is what keeps one write from setting off the next.
    //
    // Two of the card's buttons would send the CLI an id it has never heard of, so the session's own
    // methods are wrapped for our ids: "Open transcript" asks the host for the run's own transcript,
    // "Stop agent" asks the host to have the run's MCP server end it.
    var MAP_PREFIX = 'ccx:';
    var MAP_RUN_PREFIX = 'ccx:run:';
    // A run starts after the call that asked for it. The slack is for the clocks: the call's time is
    // the CLI's, the run's is the MCP server's, and those agree only as well as one machine does.
    var MAP_CLOCK_SLACK_MS = 60000;
    var mapMemo = {};
    var mapReplies = {};
    var mapSeq = 0;

    function isMapEntry(taskId) {
        return typeof taskId === 'string' && taskId.indexOf(MAP_PREFIX) === 0;
    }

    function mapEntry(taskId) {
        var memo = isMapEntry(taskId) ? mapMemo[taskId] : null;
        return memo ? memo.entry : null;
    }

    function runAgentCalls(messages) {
        var calls = [];
        if (!Array.isArray(messages)) return calls;
        for (var i = 0; i < messages.length; i++) {
            var m = messages[i];
            if (!m || m.type !== 'assistant' || !Array.isArray(m.content)) continue;
            for (var j = 0; j < m.content.length; j++) {
                var raw = blockOf(m.content[j]);
                if (!raw || raw.type !== 'tool_use' || raw.name !== MCP_AGENT_TOOL || typeof raw.id !== 'string') continue;
                // The same precedence the app uses to place a call under the subagent that made it.
                var parent = m.sdkParentToolUseId !== undefined ? m.sdkParentToolUseId : m.parentToolUseId;
                calls.push({
                    block: raw,
                    wrapper: m.content[j],
                    parent: parent || null,
                    // createdAt is the CLI's own time for the turn; `timestamp` is when this page built
                    // the object, which on a reopened session is long after the run it asked for.
                    at: m.createdAt || 0,
                    shown: m.createdAt || m.timestamp || 0,
                });
            }
        }
        return calls;
    }

    function callResult(wrapper) {
        var value;
        try {
            value = wrapper && wrapper.toolResult && 'value' in wrapper.toolResult ? wrapper.toolResult.value : undefined;
        } catch (e) {
            return null;
        }
        if (!value) return null;
        var content = value.content !== undefined ? value.content : value;
        var text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content))
            text = content
                .map(function (c) {
                    return c && typeof c.text === 'string' ? c.text : '';
                })
                .filter(Boolean)
                .join('\n');
        return { text: text, isError: value.is_error === true };
    }

    // The row says which provider a run went out on; the app's own rows have no need to.
    function mapLabel(profile, description, prompt) {
        var text = typeof description === 'string' ? description.trim() : '';
        if (!text && typeof prompt === 'string') {
            var lines = prompt.split('\n');
            for (var i = 0; i < lines.length && !text; i++) text = lines[i].trim();
            if (text.length > 80) text = text.slice(0, 79) + '…';
        }
        return (profile ? profile + ' · ' : '') + (text || 'agent');
    }

    function mapStatus(state) {
        if (state === 'running') return 'working';
        if (state === 'done') return 'finished';
        if (state === 'stopped') return 'stopped';
        return 'failed';
    }

    function lastText(events) {
        if (!Array.isArray(events)) return undefined;
        for (var i = events.length - 1; i >= 0; i--) if (events[i] && events[i].k === 'text' && events[i].t) return events[i].t;
        return undefined;
    }

    // The agent map's row meta is the run's duration and its tokens — `5m 1s · 77.9k tokens` — and two
    // runs of the same length are told apart by when they happened, not by how long they took. The row
    // the app draws asks for the call's own clock time through this (see the meta-line hook in
    // runtime/apply-patch.mjs), and an entry with no start time gets nothing.
    //
    // Hours and minutes, zero-padded, in the machine's own zone. A locale-aware format would put an
    // am/pm or a leading zero wherever the locale says, which is not what a column of times wants.
    //
    // The map is rebuilt when an old session is reopened, so a row can be from a day other than today,
    // and a bare clock time there reads as this morning's — the day is printed in front of it, and the
    // year only when it is not the current one, which is as much as a row can hold. Month names are
    // spelled out rather than taken from the locale, for the same reason the clock is: a column of
    // times sorts and lines up by being the same width every time.
    var MAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function callTime(startTime) {
        var ms = Number(startTime);
        if (!Number.isFinite(ms) || ms <= 0) return undefined;
        var at = new Date(ms);
        var clock = ('0' + at.getHours()).slice(-2) + ':' + ('0' + at.getMinutes()).slice(-2);
        var now = new Date();
        if (at.getDate() === now.getDate() && at.getMonth() === now.getMonth() && at.getFullYear() === now.getFullYear())
            return clock;
        var day = at.getDate() + ' ' + MAP_MONTHS[at.getMonth()] + (at.getFullYear() === now.getFullYear() ? '' : ' ' + at.getFullYear());
        return day + ' ' + clock;
    }

    function runEntry(run, taskId, toolUseId, parentToolUseId) {
        var status = mapStatus(run.state);
        var endTime = status === 'working' ? undefined : run.finishedAt || undefined;
        return {
            taskId: taskId,
            toolUseId: toolUseId,
            parentToolUseId: parentToolUseId,
            description: mapLabel(run.profile, run.description, run.prompt),
            prompt: run.prompt || undefined,
            // The card prints this beside the status. The model the transcript says answered, not the
            // alias the run asked for — the profile decides what `sonnet` means.
            subagentType: run.servedModel || run.model || undefined,
            isBackgrounded: run.background === true,
            startTime: run.startedAt || undefined,
            endTime: endTime,
            status: status,
            usage: {
                totalTokens: run.contextTokens || undefined,
                toolUses: run.toolUses || undefined,
                durationMs: endTime && run.startedAt ? endTime - run.startedAt : undefined,
            },
            result: status === 'finished' ? lastText(run.events) : undefined,
            error:
                status === 'failed'
                    ? run.error || (run.state === 'timeout' ? 'The run was killed when its time ran out.' : undefined)
                    : undefined,
            ccxSession: run.session,
            ccxLive: status === 'working',
        };
    }

    // No manifest left behind the call: what the call and its result say is all there is. The run's
    // answer comes first in the result, then a `---` and the server's report, which names the session
    // the transcript is under.
    function callEntry(call, busy) {
        var input = call.block.input || {};
        var result = callResult(call.wrapper);
        var status = result ? (result.isError ? 'failed' : 'finished') : busy ? 'working' : 'stopped';
        var text = result ? result.text : '';
        var cut = text.lastIndexOf('\n\n---\n');
        var session = cut > -1 ? /\bsession: ([0-9a-f-]{36})\b/i.exec(text.slice(cut)) : null;
        return {
            taskId: MAP_PREFIX + call.block.id,
            toolUseId: call.block.id,
            parentToolUseId: call.parent,
            description: mapLabel(input.profile, input.description, input.prompt),
            prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
            subagentType: typeof input.model === 'string' ? input.model : undefined,
            isBackgrounded: input.background === true,
            startTime: call.shown || undefined,
            status: status,
            result: status === 'finished' ? (cut > -1 ? text.slice(0, cut) : text) || undefined : undefined,
            error: status === 'failed' ? text.slice(0, 2000) || undefined : undefined,
            ccxSession: session ? session[1] : undefined,
            ccxLive: false,
        };
    }

    // The earliest unclaimed run that started after the call — so two calls with one prompt pair off
    // in order rather than both taking the newest.
    function runForCall(call, claimed) {
        var prompt = call.block.input && call.block.input.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) return null;
        var best = null;
        for (var i = 0; i < agentRuns.length; i++) {
            var run = agentRuns[i];
            if (run.parent || claimed[run.session] || !samePrompt(run.prompt, prompt)) continue;
            if (call.at && run.startedAt && run.startedAt < call.at - MAP_CLOCK_SLACK_MS) continue;
            if (!best || (run.startedAt || 0) < (best.startedAt || 0)) best = run;
        }
        return best;
    }

    function mapEntriesFor() {
        var entries = [];
        var calls = runAgentCalls(sessionField('messages'));
        var busy = Boolean(sessionField('busy'));
        var tab = sessionField('sessionId');
        var claimed = {};
        var placed = {};
        for (var i = 0; i < calls.length; i++) {
            var call = calls[i];
            var run = runForCall(call, claimed);
            if (!run) {
                entries.push(callEntry(call, busy));
                continue;
            }
            claimed[run.session] = true;
            placed[run.session] = call.block.id;
            entries.push(runEntry(run, MAP_PREFIX + call.block.id, call.block.id, call.parent));
        }
        for (var j = 0; j < agentRuns.length; j++) {
            var owned = agentRuns[j];
            if (owned.parent || claimed[owned.session] || !tab || owned.owner !== tab) continue;
            claimed[owned.session] = true;
            placed[owned.session] = MAP_RUN_PREFIX + owned.session;
            entries.push(runEntry(owned, placed[owned.session], placed[owned.session], null));
        }
        // The server refuses a third level, so two passes would do; looping until nothing moves costs
        // nothing and does not lean on that limit.
        for (var moved = true; moved; ) {
            moved = false;
            for (var k = 0; k < agentRuns.length; k++) {
                var nested = agentRuns[k];
                if (!nested.parent || claimed[nested.session] || !placed[nested.parent]) continue;
                claimed[nested.session] = true;
                placed[nested.session] = MAP_RUN_PREFIX + nested.session;
                entries.push(runEntry(nested, placed[nested.session], placed[nested.session], placed[nested.parent]));
                moved = true;
            }
        }
        return entries;
    }

    function syncAgentMap() {
        try {
            var session = sessionObj;
            var signal = session && session.agentMapAgents;
            if (!signal || typeof signal !== 'object' || !('value' in signal)) return;
            var current = signal.value;
            if (!current || typeof current.forEach !== 'function' || typeof current.get !== 'function') return;
            adoptAgentMethods(session);

            // An entry whose content has not changed is the very object written last time, so the
            // identity check below is what "nothing to do" means.
            var wanted = mapEntriesFor();
            var memo = {};
            for (var i = 0; i < wanted.length; i++) {
                var stamp = JSON.stringify(wanted[i]);
                var prev = mapMemo[wanted[i].taskId];
                if (prev && prev.stamp === stamp) wanted[i] = prev.entry;
                memo[wanted[i].taskId] = { stamp: stamp, entry: wanted[i] };
            }
            mapMemo = memo;

            var dirty = false;
            for (var j = 0; j < wanted.length && !dirty; j++) if (current.get(wanted[j].taskId) !== wanted[j]) dirty = true;
            if (!dirty)
                current.forEach(function (entry, key) {
                    if (isMapEntry(key) && !memo[key]) dirty = true;
                });
            if (!dirty) return;

            var next = new Map();
            current.forEach(function (entry, key) {
                if (!isMapEntry(key)) next.set(key, entry);
            });
            for (var k = 0; k < wanted.length; k++) next.set(wanted[k].taskId, wanted[k]);
            signal.value = next;
        } catch (e) {
            /* a map without our rows is the stock map, not a broken one */
        }
    }

    function adoptAgentMethods(session) {
        if (session.__ccxAgentMap) return;
        var transcript = session.getSubagentTranscript;
        var stop = session.stopSubagent;
        if (typeof transcript !== 'function' || typeof stop !== 'function') return;
        // 2.1.285 made the dialog read a transcript in pages: the stock method takes a cursor and
        // resolves to { frames, from } instead of the bare message array, and the dialog destructures
        // that — handed an array, it finds no frames and stays on "Loading…". Which shape this release
        // wants is read off the stock method, which spells it out literally. Ours ignores the cursor
        // and leaves `from` out: the dialog then sets whatever arrives against what it already shows
        // and keeps only what is new, so the whole transcript each time is still a correct answer.
        var framed = /\bframes\s*:/.test(Function.prototype.toString.call(transcript));
        session.__ccxAgentMap = true;
        session.getSubagentTranscript = function (taskId) {
            var entry = mapEntry(taskId);
            if (!entry) return transcript.apply(this, arguments);
            // A rejection is what the dialog already words as "could not be read", and it still shows
            // the prompt beneath that.
            if (!entry.ccxSession) return Promise.reject(new Error('this run left no transcript'));
            return askHost({ type: 'ccx:agentTranscript', session: entry.ccxSession }).then(function (reply) {
                var messages = Array.isArray(reply.messages) ? reply.messages : [];
                return framed ? { frames: messages } : messages;
            });
        };
        session.stopSubagent = function (taskId) {
            var entry = mapEntry(taskId);
            if (!entry) return stop.apply(this, arguments);
            if (!entry.ccxLive) return Promise.reject(new Error('the run is not running'));
            return askHost({ type: 'ccx:stopAgent', session: entry.ccxSession }).then(function () {});
        };
    }

    function askHost(message) {
        return new Promise(function (resolve, reject) {
            var seq = ++mapSeq;
            message.seq = seq;
            mapReplies[seq] = {
                resolve: resolve,
                reject: reject,
                timer: setTimeout(function () {
                    delete mapReplies[seq];
                    reject(new Error('the extension host did not answer'));
                }, 30000),
            };
            send(message);
        });
    }

    function onAgentReply(d) {
        var pending = mapReplies[d.seq];
        if (!pending) return;
        delete mapReplies[d.seq];
        clearTimeout(pending.timer);
        if (d.ok) pending.resolve(d);
        else pending.reject(new Error(d.error || 'the request failed'));
    }

    // --- Provider health in the account panel --------------------------------------------------
    //
    // The stock Account & Usage panel answers one question: how much of *this* subscription is left.
    // On an install that switches provider per tab that is a fraction of the picture — the other
    // endpoints carry their own quotas, and the first sign one of them is spent is usually a
    // delegated run that dies a minute after it was handed the work.
    //
    // The verdicts already exist: the MCP server probes a profile before it delegates to it and
    // writes the result to agent-health.json, which the host forwards on every ccx:state. Nothing is
    // probed from here — a panel that opened a connection per provider each time it rendered would
    // spend real quota to draw a row.
    //
    // Read-only on purpose. The rows report; switching provider stays with the picker, which is the
    // one place that also restarts the channel.
    var STALE_MS = 12 * 60 * 60 * 1000;

    function providerAge(ms) {
        if (!isFinite(ms) || ms < 0) return '';
        var s = Math.round(ms / 1000);
        if (s < 90) return s + 's';
        var m = Math.round(s / 60);
        if (m < 90) return m + 'm';
        var h = Math.round(m / 60);
        if (h < 36) return h + 'h';
        return Math.round(h / 24) + 'd';
    }

    // Four states, and the difference between the middle two is the whole reason they are kept apart:
    // a provider that refused is an account to top up, one that never answered is an adapter to
    // restart, and one nothing has ever asked is neither.
    function providerState(health) {
        if (!health) return 'unknown';
        if (health.ok) return 'ok';
        return health.unreachable ? 'silent' : 'failed';
    }

    function providerNote(health, now) {
        if (!health || health.ok) return '';
        var parts = [];
        // Both can be present at once: a 5xx is recorded as silence — it says nothing about this
        // profile — but the status it arrived with is still the part worth reading.
        if (health.unreachable) parts.push('no answer');
        if (health.status) parts.push('HTTP ' + health.status);
        if (health.message) parts.push(health.message);
        if (health.resetsAt) {
            var left = health.resetsAt - now;
            parts.push(left > 0 ? 'resets in ' + providerAge(left) : 'reset window passed — worth retrying');
        }
        return parts.join(' · ');
    }

    function providerRows(now) {
        var list = state.profiles || [];
        var rows = [];
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            var h = p.health || null;
            rows.push({
                name: p.name,
                // What the probe actually reached beats what the profile asks for: a profile whose
                // model was remapped upstream is exactly the row worth being honest about.
                model: (h && h.model) || p.model || '',
                endpoint: p.endpoint || '',
                state: providerState(h),
                stale: Boolean(h && now - h.at > STALE_MS),
                age: h ? providerAge(now - h.at) : '',
                note: providerNote(h, now),
                icon: icons[p.name] || null,
            });
        }
        return rows;
    }

    function paintProviders(host, rows, active) {
        host.textContent = '';
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var row = document.createElement('div');
            row.className = 'ccx-prov-row';
            row.setAttribute('data-ccx-prov', r.state);
            if (r.stale) row.setAttribute('data-ccx-prov-stale', '1');
            if (r.name === active) row.setAttribute('data-ccx-prov-active', '1');
            row.title = [r.name, r.endpoint, r.model, r.age ? 'checked ' + r.age + ' ago' : 'never probed']
                .filter(Boolean)
                .join(' · ') + '\nClick to open ~/.claude/profiles/' + r.name + '.json';
            // Every answer this list gives ends in the same place — the profile file: a placeholder
            // left in a credential, a model that needs remapping, an endpoint that moved. The host
            // opens it; the page only names which one, and the overlay gets out of the way.
            row.onclick = (function (name) {
                return function () {
                    send({ type: 'ccx:openProfile', name: name });
                    closePicker();
                };
            })(r.name);

            var head = document.createElement('div');
            head.className = 'ccx-prov-head';
            // A wrapper span with the logo inside it, never the <img> itself: the status dot is that
            // element's ::after, and a replaced element (an <img>) renders no pseudo-elements at all —
            // which is exactly how the dots disappeared the moment the logo stopped being a background.
            var mark = document.createElement('span');
            mark.className = r.icon ? 'ccx-prov-icon' : 'ccx-prov-icon ccx-prov-icon-blank';
            // The refusal hangs off the mark the dot is drawn on: the state and the reason for it are
            // the same thing, and a provider's own error text is a paragraph the row has no room for.
            mark.title = r.note || (r.age ? (r.state === 'ok' ? 'answered ' : 'checked ') + r.age + ' ago' : 'never probed');
            if (r.icon) {
                var logo = document.createElement('img');
                logo.className = 'ccx-prov-logo';
                logo.src = r.icon;
                mark.appendChild(logo);
            }
            var name = document.createElement('span');
            name.className = 'ccx-prov-name';
            name.textContent = r.name;
            var age = document.createElement('span');
            age.className = 'ccx-prov-age';
            age.textContent = r.age || 'never';
            head.appendChild(mark);
            head.appendChild(name);
            head.appendChild(age);
            row.appendChild(head);
            host.appendChild(row);
        }
    }

    // --- The same verdicts as a sidebar section -------------------------------------------------
    //
    // The sessions sidebar is a second webview drawn by the same bundle, and it stacks collapsible
    // sections: "Account & usage" (header, a View details link, and a body) then "Session manager".
    // A provider list belongs in that stack — it is where this window's other standing state already
    // lives — so the section is built out of the sidebar's own header markup and dropped in front of
    // the session manager.
    //
    // Nothing here is copied by name. Every class carries a per-build hash (`sectionHeader_djirOA`),
    // so the classes are lifted off the live header and the chevron is cloned from it; what the page
    // adds is only the collapse state and the rows.
    var COLLAPSE_KEY = 'ccx.providers.collapsed';

    function sidebarPart(node, part) {
        return node ? node.querySelector('[class*="' + part + '_"]') : null;
    }

    // The stack, identified by the two labels only it has. Returns the node the section goes in front
    // of, plus the class names to build it out of.
    function sidebarStack() {
        var headers = document.querySelectorAll('[class*="sectionHeader_"]');
        var stock = null;
        var before = null;
        for (var i = 0; i < headers.length; i++) {
            var label = sidebarPart(headers[i], 'sectionLabel');
            var text = label ? (label.textContent || '').trim().toLowerCase() : '';
            if (text !== 'account & usage' && text !== 'session manager') continue;
            if (!stock) stock = headers[i];
            if (text === 'session manager' && !before) before = headers[i];
        }
        if (!stock || !stock.parentElement) return null;
        return { parent: stock.parentElement, before: before || null, header: stock };
    }

    function collapsedPref() {
        try {
            return window.localStorage.getItem(COLLAPSE_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function rememberCollapsed(collapsed) {
        try {
            window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
        } catch (e) {
            /* a sidebar that cannot remember its fold is still a working sidebar */
        }
    }

    // --- Auto-compact before the cache expires --------------------------------------------------
    //
    // The host reports the last cache signal (ccx:cache) and this schedules a /compact a little before
    // it lapses — the compaction itself then rides the still-warm prefix instead of paying to re-cache
    // the whole transcript on the next turn. Two signals count: the 1h tier, which is measured, and a
    // lifetime the profile declares (`cache.ttlMinutes`) for a backend that reports hits and no
    // expiry. The 5m tier is ignored — too short for a wait to mean anything — and so is a declared
    // lifetime below the floor, for the same reason: compacting a five-minute cache would run between
    // turns and buy nothing. A declared number is documentation, not a measurement, which is why the
    // two are carried as different kinds and only ever compared against their own threshold.
    var AUTOCOMPACT_KEY = 'ccx.autocompact.enabled';
    var COMPACT_MARGIN_MS = 5 * 60 * 1000;
    var DECLARED_MIN_MINUTES = 15;

    function autocompactPref() {
        try {
            return window.localStorage.getItem(AUTOCOMPACT_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function rememberAutocompact(on) {
        try {
            window.localStorage.setItem(AUTOCOMPACT_KEY, on ? '1' : '0');
        } catch (e) {
            /* a flag that cannot be remembered still toggles for this page */
        }
    }

    // The stock Thinking row draws its state with the app's own switch, and a glyph of ours beside it
    // would read as an add-on wedged into the section. The registry keeps each section's actions in
    // `sections`, and a React element carries its component on `.type` — so the very element Thinking
    // registered supplies the switch, re-rendered with our own `isOn`.
    //
    // Nothing is drawn in its place when it cannot be found. A lookalike would hide the one thing worth
    // seeing — that the bundle moved — and the row still toggles without it. The first pass can also
    // genuinely miss it, since Thinking registers from an effect of its own; the next state push
    // re-registers this row with the real switch.
    function stockToggle(on) {
        try {
            var section = registry && registry.sections && registry.sections.get('Model');
            if (section)
                for (var i = 0; i < section.length; i++) {
                    var row = section[i];
                    if (!row || row.id !== 'toggle-thinking') continue;
                    var el = row.trailingComponent;
                    if (el && el.type) return jsx(el.type, { isOn: on });
                }
        } catch (e) {
            /* a switch we could not borrow is a bare row, not a broken one */
        }
        return undefined;
    }

    function autocompactTick() {
        if (!jsx) return undefined;
        return stockToggle(autocompactPref());
    }

    function toggleAutocompact() {
        var next = !autocompactPref();
        rememberAutocompact(next);
        syncAction(); // re-register so the trailing checkbox follows the new state
        if (next) scheduleAutocompact();
        else cancelAutocompact();
    }

    function cancelAutocompact() {
        if (autocompactTimer) {
            clearTimeout(autocompactTimer);
            autocompactTimer = null;
        }
    }

    // When the cache this session is riding is due to lapse, or null when nothing about it can be
    // acted on — no signal, a measured tier too short to wait, or a declared one below the floor.
    function cacheDeadline() {
        if (!cacheInfo || typeof cacheInfo.anchorAt !== 'number') return null;
        if (cacheInfo.ttl === '1h') return cacheInfo.anchorAt + 60 * 60 * 1000 - COMPACT_MARGIN_MS;
        if (cacheInfo.ttl === 'declared' && cacheInfo.ttlMinutes >= DECLARED_MIN_MINUTES)
            return cacheInfo.anchorAt + cacheInfo.ttlMinutes * 60000 - COMPACT_MARGIN_MS;
        return null;
    }

    function scheduleAutocompact() {
        cancelAutocompact();
        if (!autocompactPref()) return;
        var at = cacheDeadline();
        if (at == null) return;
        autocompactTimer = setTimeout(runAutocompact, Math.max(0, at - Date.now()));
    }

    function runAutocompact() {
        autocompactTimer = null;
        if (!autocompactPref() || cacheDeadline() == null) return;
        // A turn still running means the compaction would queue behind it; retry shortly instead.
        if (!canCompact()) {
            autocompactTimer = setTimeout(runAutocompact, 30000);
            return;
        }
        toast('Compacting before the cache expires…');
        try {
            var s = activeSession();
            if (!s) return;
            var r = s.send('/compact');
            if (r && typeof r.catch === 'function') r.catch(function () {});
        } catch (err) {
            /* a compaction that cannot start is not a broken page */
        }
    }

    // --- The declared lifetime, drawn where the app's own indicator would be --------------------
    //
    // The app draws a countdown for the tiers it can measure and nothing at all for a backend whose
    // answer carries no cache_creation split. This fills that silence in the app's own idiom rather
    // than as a badge of ours: the same footer row, the same classes, and the same place the stock
    // countdown takes when it exists — immediately after the context-usage chip.
    //
    // Not one of those names is written down here. They carry a per-build hash
    // (`inputFooterV2_gGYT1w`), so each class is read off the live DOM, or — for the countdown's own
    // `indicator_…`, which a provider like this one never renders — out of the stylesheet the page
    // has already loaded. A build where neither can be found draws nothing rather than a pill adrift
    // in the composer, and the composer is React's: the pill is re-inserted by the same debounced
    // pass that decorates everything else.
    //
    // Only the declared kind is drawn: a measured 1h tier already has the app's own countdown, and
    // two of them for one cache would disagree with each other.
    var cacheInterval = null;

    // `footerButton_gGYT1w` for a build whose hash is `gGYT1w` — the prefix is the contract, the
    // suffix is the build's own business.
    function stockClass(prefix, scope) {
        var live = (scope || document).querySelector('[class*="' + prefix + '"]');
        if (live) {
            var own = String(live.className || '').split(/\s+/);
            for (var i = 0; i < own.length; i++) if (own[i].indexOf(prefix + '_') === 0) return own[i];
        }
        try {
            var sheets = document.styleSheets || [];
            for (var s = 0; s < sheets.length; s++) {
                var rules = sheets[s].cssRules || [];
                for (var r = 0; r < rules.length; r++) {
                    var m = new RegExp('\\.(' + prefix + '_[A-Za-z0-9_-]+)').exec(rules[r].selectorText || '');
                    if (m) return m[1];
                }
            }
        } catch (e) {
            /* a stylesheet that cannot be read is a class we do without */
        }
        return '';
    }

    function cacheLeftMinutes() {
        if (!cacheInfo || cacheInfo.ttl !== 'declared') return null;
        var left = cacheInfo.anchorAt + cacheInfo.ttlMinutes * 60000 - Date.now();
        return left > 0 ? Math.max(1, Math.round(left / 60000)) : 0;
    }

    // Where the app's own countdown lives, in the order of how exactly that is known: before one, if
    // this session has one; otherwise where the app's own order puts it — the left end of the row,
    // ahead of the model pill; failing that, after the menu button. The choice is re-made on every
    // pass rather than taken once, because the composer renders its chips only when their state calls
    // for them, and a pill placed at the first opportunity would spend the session at whichever end
    // the row happened to have just then.
    function placeCachePill(pill) {
        var footer = document.querySelector('[class*="inputFooterV2_"]');
        if (!footer) return;
        // Our own pill wears the stock countdown's class — that is what puts it in the row's look —
        // so the search for one has to skip the pill itself. Anchoring to itself is how the first
        // version of this stayed exactly where it was first appended, at the end of the row.
        var stock = null;
        var found = footer.querySelectorAll ? footer.querySelectorAll('[class*="indicator_"]') : [];
        for (var i = 0; i < found.length; i++)
            if (found[i] !== pill) {
                stock = found[i];
                break;
            }
        if (stock && stock.parentElement) {
            if (pill.nextSibling !== stock) stock.parentElement.insertBefore(pill, stock);
            return noteCacheSlot('before-stock', footer);
        }
        // The app's own order in the composer puts the countdown before the agents pill and the model
        // pill — the left end of the row, past the menu button. The model pill is the one of the two
        // that is always there, which makes it the anchor; the menu button is the fallback for a build
        // whose model pill lives in a row of its own.
        var model = footer.querySelector('[class*="modelPill_"]');
        if (model && model.parentElement) {
            if (pill.nextSibling !== model) model.parentElement.insertBefore(pill, model);
            return noteCacheSlot('before-model', footer);
        }
        var menu = footer.querySelector('[class*="menuButton_"]');
        if (menu && menu.parentElement && menu.nextSibling !== pill) {
            menu.parentElement.insertBefore(pill, menu.nextSibling);
            return noteCacheSlot('after-menu', footer);
        }
        if (pill.parentElement !== footer) footer.appendChild(pill);
        noteCacheSlot('footer-end', footer);
    }

    // Which slot was taken, and what the row actually held at the time. The class names are per-build
    // and the composer's own markup is the only thing that says where a countdown belongs, so the
    // answer to "it is in the wrong place" is the row the page is looking at, not the pattern it was
    // looking for. Said once per stage, so a redrawing composer does not fill the log.
    var cacheSlotNote = null;

    function noteCacheSlot(stage, footer) {
        if (cacheSlotNote === stage) return;
        cacheSlotNote = stage;
        try {
            var kids = [];
            for (var i = 0; i < footer.children.length && i < 10; i++) {
                var child = footer.children[i];
                kids.push(child.tagName + '.' + String(child.className || '').split(' ')[0]);
            }
            send({ type: 'ccx:cachePill', stage: stage, kids: kids.join(' ') });
        } catch (e) {
            /* a note that cannot be sent is not a missing countdown */
        }
    }

    // The app's own clock, glyph for glyph: the same 20×20 path its countdown draws, `currentColor`
    // so the row's own text colour reaches it. The data is copied rather than reached for, because
    // the component lives inside the app's module and a rebuild can move it anywhere — a path is
    // data, and data is the one thing a repack cannot rename.
    var CACHE_CLOCK =
        'M10 2.5C14.1421 2.5 17.5 5.85786 17.5 10C17.5 14.1421 14.1421 17.5 10 17.5C5.85786 17.5 2.5 14.1421 2.5 10C2.5 5.85786 5.85786 2.5 10 2.5ZM10 3.5C6.41015 3.5 3.5 6.41015 3.5 10C3.5 13.5899 6.41015 16.5 10 16.5C13.5899 16.5 16.5 13.5899 16.5 10C16.5 6.41015 13.5899 3.5 10 3.5ZM10 5C10.2761 5 10.5 5.22386 10.5 5.5V9.66895L13.6973 11.04L13.7852 11.0898C13.9763 11.2224 14.0552 11.4751 13.96 11.6973C13.8647 11.9193 13.6272 12.0372 13.3994 11.9902L13.3027 11.96L9.80273 10.46C9.61896 10.3811 9.5 10.2 9.5 10V5.5C9.5 5.22386 9.72386 5 10 5Z';

    function cacheClock() {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('viewBox', '0 0 20 20');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', CACHE_CLOCK);
        path.setAttribute('fill', 'currentColor');
        svg.appendChild(path);
        return svg;
    }

    function decorateCachePill() {
        var left = cacheLeftMinutes();
        try {
            // One countdown, whoever drew the other. React redraws this row freely, and a pass that
            // found the pill already detached — the composer replaces its children wholesale — would
            // draw a second one and leave both on screen. Everything carrying the handle is dropped
            // except the node this pass keeps, which makes the state converge however it drifted.
            var all = document.querySelectorAll ? document.querySelectorAll('.ccx-cache-pill') : [];
            var pill = all.length ? all[0] : null;
            for (var k = 1; k < all.length; k++) all[k].remove();
            if (left == null) {
                if (pill) pill.remove();
                if (cacheInterval) {
                    clearInterval(cacheInterval);
                    cacheInterval = null;
                }
                return;
            }
            if (!pill) {
                var footer = document.querySelector('[class*="inputFooterV2_"]');
                if (!footer) return;
                pill = document.createElement('span');
                // The stock countdown's own classes, lifted the same way the app lifts them: a footer
                // button's, and the indicator's for the number itself. `ccx-cache-pill` is only a
                // handle for the next pass to find it by — it carries no styling of ours, so the pill
                // reads as part of the row instead of as an addition to it.
                pill.className = [
                    'ccx-cache-pill',
                    stockClass('footerButton', footer),
                    stockClass('footerButtonPrimary', footer),
                    stockClass('indicator'),
                ]
                    .filter(Boolean)
                    .join(' ');
                // The rest of the stock markup: a status role, the clock, and the number in a span of
                // its own — the app puts `data-footer-fixed-width` there so a countdown that loses a
                // digit does not shift the row, and the same holds for one that never had a tier.
                pill.setAttribute('role', 'status');
                pill.setAttribute('aria-live', 'off');
                pill.setAttribute('data-cache-window', 'declared');
                try {
                    pill.appendChild(cacheClock());
                } catch (e) {
                    /* an icon that cannot be built is a countdown without a clock, not a missing one */
                }
                var number = document.createElement('span');
                number.setAttribute('data-footer-fixed-width', '');
                pill.__ccxNumber = pill.appendChild(number);
                footer.appendChild(pill);
            }
            placeCachePill(pill);
            // The number reads exactly like the app's own, and the qualification lives where it costs
            // nothing to read: the tooltip. A visible "≈" would be one more thing in the row that the
            // stock countdown does not have, which is the whole complaint a uniform row answers.
            (pill.__ccxNumber || pill).textContent = left + 'm';
            pill.title =
                'Prompt cache: about ' + cacheInfo.ttlMinutes + ' min declared for "' + (cacheInfo.profile || 'this profile') + '"' +
                (left ? ', roughly ' + left + ' min left' : ' — the declared window has passed') +
                '. Declared in the profile from the provider\'s documentation, not measured: a hit proves the prefix was alive, not how long it lasts.';
        } catch (e) {
            /* a footer that cannot take the pill is a missing countdown, not a broken composer */
        }
        if (!cacheInterval) cacheInterval = setInterval(decorateCachePill, 30000);
    }

    // --- The session's external resources -------------------------------------------------------
    //
    // A tab accumulates references it never gathers in one place: links written in messages, pages
    // handed to a fetch tool, files read or written by tool calls, images and documents pasted into
    // prompts. The agent map is the one dialog Claude Code has that summarises a session's working
    // state; this is its resource-side counterpart — a pill beside the agents pill, carrying a count,
    // and a dialog behind it with one section per kind.
    //
    // The whole list is read off `session.messages`, which the page already holds; nothing is asked of
    // the host to draw it. The host is reached only when a row is clicked, because opening a file in
    // the editor or a URL in the browser is something only the extension host can do.
    //
    // The count is of *distinct* resources, which is what makes it worth carrying: a URL the model
    // wrote three times and fetched once is one resource. So one Map holds every kind — first seen
    // wins its section and its position, and the same URL reaching the list from a message and from a
    // tool call merges into the row that was already there.
    var RESOURCE_SECTIONS = [
        { kind: 'link', label: 'Links in messages' },
        { kind: 'tool', label: 'URLs from tools' },
        { kind: 'file', label: 'Files' },
        { kind: 'branch', label: 'Branches' },
        { kind: 'commit', label: 'Commits' },
        { kind: 'worktree', label: 'Worktrees' },
        { kind: 'media', label: 'Images & documents' },
    ];
    // What a row's own click does, where it has one. A branch or a commit has nothing to open — there
    // is no file behind either — and says so by having no handler rather than by failing at the host.
    var RESOURCE_OPEN = { link: 'url', tool: 'url', file: 'file', media: 'media', worktree: 'file' };
    // A WebSearch-heavy turn can produce dozens of links and the list is meant to be read, so a
    // section stops where a wall of rows would begin. The count stays the full one.
    var RESOURCE_CAP = 100;
    var RESOURCE_URL = /https?:\/\/[^\s<>"'`]+/g;
    var resourceSeq = 0;
    // Sections arrive folded or open, and Files arrive folded: a working session has more of them than
    // of anything else, and the list is opened for what was said and what was committed first. What the
    // user folds is remembered for the life of the page — the dialog is repainted on every state push,
    // and a repaint that unfolded what had just been folded would be unusable on a live session.
    var RESOURCE_FOLDED = { file: true };
    var resourceFold = {};
    function sectionOpen(kind) {
        return resourceFold[kind] === undefined ? !RESOURCE_FOLDED[kind] : resourceFold[kind];
    }
    // { stamp, rows }, so the ~60 ms observer pass during a stream does not re-walk the transcript.
    var resourceMemo = { stamp: null, rows: [] };

    // A link that ended a sentence carries the author's punctuation, not the URL's.
    function trimUrl(url) {
        return String(url).replace(/[.,;:!?)\]}>]+$/, '');
    }

    // Scheme and host are case-insensitive and name the resource; the path is left exactly as written,
    // a path being case-sensitive on the systems that matter here.
    function urlKey(url) {
        var s = trimUrl(url);
        var m = /^(https?:\/\/)([^\/?#]*)([\s\S]*)$/i.exec(s);
        return m ? m[1].toLowerCase() + m[2].toLowerCase() + m[3] : s;
    }

    // The Windows and the POSIX spelling of one file are one file, and `./a.js` is the `a.js` a Write
    // call named.
    function fileKey(p) {
        return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
    }

    function baseName(p) {
        var s = String(p).replace(/[\/\\]+$/, '');
        var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return i < 0 ? s : s.slice(i + 1);
    }

    function dirPrefix(p) {
        var s = String(p).replace(/[\/\\]+$/, '');
        var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return i < 0 ? '' : s.slice(0, i + 1);
    }

    // Which input field names a file is the CLI's business, not this file's, and it differs by tool:
    // NotebookEdit has `notebook_path` where Write has `file_path`, and a search tool names a
    // directory with `path`. All three are a place the session touched. A shell command is not: the
    // paths inside one are guesswork, and guessing them back out would read as noise in a list whose
    // point is being scannable.
    function filePathOf(input) {
        if (!input || typeof input !== 'object') return '';
        var keys = ['file_path', 'notebook_path', 'path'];
        for (var i = 0; i < keys.length; i++) {
            var v = input[keys[i]];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
        return '';
    }

    function humanSize(chars) {
        var bytes = Math.round((chars * 3) / 4);
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' kB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // A pasted image is base64 and a media type; a document is the same plus whatever title the app
    // gave it, which is not always there. So a block with no name is identified by its type, its
    // decoded length and the head of its payload — enough to count one attachment once, and the
    // payload itself is never used for the key, only that prefix.
    function mediaEntry(kind, block) {
        var src = block && block.source;
        var type = (src && src.media_type) || (block && block.name) || kind;
        var data = typeof (src && src.data) === 'string' ? src.data : '';
        var link = typeof (src && src.url) === 'string' ? src.url : '';
        var size = (data || link).length;
        var title = typeof (block && block.title) === 'string' ? block.title : '';
        return {
            key: kind + ':' + type + ':' + size + ':' + (data || link).slice(0, 32),
            label: title || link || kind + ' · ' + type + ' · ' + humanSize(size),
            // What opening it needs: a URL when the block carries one, otherwise the payload itself.
            // Nothing is decoded here — the host writes the bytes to a file and hands it to the OS.
            payload: { mediaType: type, data: data, url: link },
        };
    }

    // When a message was written: `createdAt` is the CLI's own stamp for the turn, `timestamp` whatever
    // the shape it arrived in carries — an ISO string on one rebuilt from disk, a number on one that
    // streamed in. Neither is guaranteed, and a row with no time shows none.
    function messageTime(m) {
        var raw = m.createdAt || m.timestamp;
        if (typeof raw === 'string') {
            var parsed = Date.parse(raw);
            return isNaN(parsed) ? 0 : parsed;
        }
        var ms = Number(raw);
        return isFinite(ms) && ms > 0 ? ms : 0;
    }

    // The transcript is the whole signal, so the stamp has to move for anything that can add a
    // resource: a new message, a message rewritten, or a reply still growing its text.
    function resourceStamp(messages) {
        var last = messages.length ? messages[messages.length - 1] : null;
        var tail = '';
        if (last && Array.isArray(last.content))
            for (var i = 0; i < last.content.length; i++) {
                var raw = blockOf(last.content[i]);
                if (raw && raw.type === 'text' && typeof raw.text === 'string') tail += raw.text.length + ',';
            }
        return (
            messages.length + '|' + ((last && last.uuid) || '') + '|' + tail + '|' + (sessionField('sessionId') || '')
        );
    }

    // What a shell command says about the repository. Only git's own grammar is read, never a path out
    // of a command line: `git switch -c x` names a branch and nothing else, and `[main 4f2a1c3] subject`
    // is what git prints when it commits. A bare `git checkout x` is deliberately *not* read from the
    // command — that call may be restoring a file — so a branch moved to is taken from what git echoes
    // back instead. A `git log` full of hashes contributes nothing for the same reason: the list is of
    // what this session did, not of what it looked at.
    var GIT_BRANCH_CREATE = /git\s+(?:checkout\s+-b|switch\s+-c|branch)\s+([^\s;&|'"]+)/g;
    var GIT_WORKTREE_ADD = /git\s+worktree\s+add\s+([^\n;&|<>]+)/g;
    var GIT_SWITCHED = /Switched to (?:a new )?branch '([^']+)'/g;
    var GIT_COMMITTED = /\[([^\s\]]+)(?:\s+\([^)]*\))?\s+([0-9a-f]{7,40})\]\s*(.*)$/gm;
    var GIT_WORKTREE_LIST = /^\s*(\S+)\s+([0-9a-f]{7,40})\s+\[([^\]]+)\]/gm;
    // `git commit -q` prints nothing at all, and a commit written through a heredoc prints the same
    // blank — both are ordinary ways to commit. What such a command line usually does next is read the
    // commit back (`git log --oneline -1`) or push it, and both name the hash. So those two are read,
    // but only when the same command actually wrote something: without that condition a `git log` of
    // twenty lines would fill the section with every commit the session merely looked at.
    var GIT_PUSH_LINE = /([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\s+(\S+)\s*->\s*(\S+)/;
    var GIT_NEW_REF = /\*\s+\[new branch\]\s+(\S+)\s*->\s*(\S+)/g;
    var GIT_ONELINE = /^\s*([0-9a-f]{7,40})\s+(\S.*)$/gm;
    var GIT_WROTE = /git\s+(?:commit|push)\b/;

    // `git worktree add [-f] [--detach] [-b <name>] <path> [<commit-ish>]` — the path is the first
    // argument that is neither an option nor an option's value. Taking the last one instead is what put
    // `2>` in this list from a command whose output was redirected, and a branch name from a command
    // that named the commit-ish after the path.
    function worktreePath(argsText) {
        var tokens = String(argsText).trim().split(/\s+/);
        for (var i = 0; i < tokens.length; i++) {
            var t = tokens[i];
            if (!t) continue;
            if (/^\d*[<>]/.test(t)) break; // a redirection is where the arguments ended
            if (t.charAt(0) === '-') {
                if (t === '-b' || t === '-B' || t === '--reason') i++;
                continue;
            }
            return t.replace(/^["']|["']$/g, '');
        }
        return '';
    }

    function resourceScan() {
        var messages = sessionField('messages');
        if (!Array.isArray(messages)) messages = [];
        var stamp = resourceStamp(messages);
        if (resourceMemo.stamp === stamp) return resourceMemo.rows;

        var rows = new Map();
        // Where a sighting came from, as one object: whose it was, which message held it, and when that
        // message was written. Only the first sighting's details are kept, so this is what each note()
        // carries rather than three arguments that have to stay in step.
        function note(kind, key, label, value, full, source, ctx) {
            if (!key) return;
            var at = ctx || {};
            var row = rows.get(key);
            if (!row) {
                row = {
                    kind: kind,
                    key: key,
                    label: label,
                    value: value,
                    full: full || value,
                    count: 0,
                    from: [],
                    // Whose it is, by *first* mention: the model echoing a link the user pasted is still
                    // the user's link, while a link the model wrote and the user later quoted is not — and
                    // only the first sighting can tell those two apart. Which side of the conversation a
                    // resource came from is the one thing about it a reader cannot recover from the value
                    // itself, so it is carried on the row rather than left to the tooltip.
                    you: !!at.you,
                    open: RESOURCE_OPEN[kind] || null,
                    // Where it first appeared, for the row's jump and for the row's time. The first
                    // sighting and not the last: "where did this come from" is the question, and the rest
                    // are the same thing said again.
                    uuid: at.uuid || null,
                    at: at.at || 0,
                };
                rows.set(key, row);
            }
            row.count++;
            // A commit usually reaches the list twice and the first time with less: a push names the
            // hash, the `git log` beside it names what the commit says. The row is read by its subject,
            // so a label that is only the short hash gives way to one that is not.
            if (label && label !== row.label && row.label === String(row.value).slice(0, 7)) row.label = label;
            if (source && row.from.indexOf(source) < 0) row.from.push(source);
        }
        function noteUrls(text, kind, source, ctx) {
            if (typeof text !== 'string' || text.indexOf('http') < 0) return;
            RESOURCE_URL.lastIndex = 0;
            var m;
            while ((m = RESOURCE_URL.exec(text))) {
                var url = trimUrl(m[0]);
                if (url) note(kind, urlKey(url), url, url, url, source, ctx);
            }
        }

        function noteBranch(name, how, ctx) {
            note('branch', 'branch:' + name, name, name, name, how, ctx);
        }

        // Commits and worktrees come in two flavours and the difference is worth the tag: one the
        // session made, and one it only read out of git. `made` is set on the first sighting and only
        // ever raised, so a commit pushed as a bare hash and read back with its subject stays the
        // session's own.
        function noteOwn(kind, key, label, value, full, source, made, ctx) {
            note(kind, key, label, value, full, source, ctx);
            var row = rows.get(key);
            if (!row) return;
            if (typeof row.made !== 'boolean') row.made = !!made;
            else if (made) row.made = true;
        }

        function noteGit(command, output, ctx) {
            var m;
            GIT_BRANCH_CREATE.lastIndex = 0;
            while ((m = GIT_BRANCH_CREATE.exec(command)))
                if (m[1].charAt(0) !== '-') noteBranch(m[1], 'created', ctx);
            GIT_WORKTREE_ADD.lastIndex = 0;
            while ((m = GIT_WORKTREE_ADD.exec(command))) {
                var target = worktreePath(m[1]);
                if (target)
                    noteOwn('worktree', 'worktree:' + fileKey(target), baseName(target), target, target, 'added as a worktree', true, ctx);
            }
            if (typeof output !== 'string' || !output || !/\bgit\b/.test(command)) return;
            var wrote = GIT_WROTE.test(command);
            GIT_SWITCHED.lastIndex = 0;
            while ((m = GIT_SWITCHED.exec(output))) noteBranch(m[1], 'switched to', ctx);
            GIT_COMMITTED.lastIndex = 0;
            while ((m = GIT_COMMITTED.exec(output))) {
                var subject = String(m[3] || '').trim().slice(0, 80);
                noteOwn(
                    'commit',
                    'commit:' + m[2],
                    subject || m[2].slice(0, 7),
                    m[2],
                    m[2] + ' on ' + m[1] + (subject ? ' — ' + subject : ''),
                    'committed on ' + m[1],
                    true,
                    ctx,
                );
            }
            if (command.indexOf('worktree') > -1) {
                GIT_WORKTREE_LIST.lastIndex = 0;
                while ((m = GIT_WORKTREE_LIST.exec(output)))
                    noteOwn('worktree', 'worktree:' + fileKey(m[1]), baseName(m[1]), m[1], m[1], 'listed as a worktree on ' + m[3], false, ctx);
            }
            // What a push says: the range it moved, and the ref it moved it on.
            var push = GIT_PUSH_LINE.exec(output);
            if (push) {
                noteOwn('commit', 'commit:' + push[2], push[2].slice(0, 7), push[2], push[2] + ' on ' + push[3], 'pushed', true, ctx);
                noteBranch(push[3].replace(/^refs\/heads\//, ''), 'pushed', ctx);
            }
            GIT_NEW_REF.lastIndex = 0;
            while ((m = GIT_NEW_REF.exec(output))) noteBranch(m[2].replace(/^refs\/heads\//, ''), 'pushed as a new branch', ctx);
            // The one-line log, read whether or not the same command wrote something: a commit the
            // session looked up is a resource too, it is just not the session's own — which is what the
            // `made` flag is for. `git log -20` therefore fills the section, honestly labelled.
            GIT_ONELINE.lastIndex = 0;
            while ((m = GIT_ONELINE.exec(output))) {
                var line = String(m[2] || '').trim().slice(0, 80);
                noteOwn('commit', 'commit:' + m[1], line || m[1].slice(0, 7), m[1], m[1] + (line ? ' — ' + line : ''), 'read out of git', wrote, ctx);
            }
        }

        // A message of type `user` is not always the user's — a tool result arrives on the same side of
        // the conversation, and the app's own injected turns are marked synthetic. Only what they
        // actually typed counts as theirs.
        function userVoice(m) {
            if (m.type !== 'user' || m.isSynthetic) return false;
            // A turn tagged with the tool call that spawned it belongs to a subagent, not to the person.
            // A subagent's prompt and its own tool results arrive on the user's side of the conversation
            // exactly as the user's do, and a link inside one of them is the model's, not theirs.
            if (m.parentToolUseId || m.sdkParentToolUseId) return false;
            if (!Array.isArray(m.content)) return true;
            for (var k = 0; k < m.content.length; k++) {
                var b = blockOf(m.content[k]);
                if (b && b.type === 'tool_result') return false;
            }
            return true;
        }

        for (var i = 0; i < messages.length; i++) {
            var m = messages[i];
            if (!m) continue;
            // A compaction summary is the whole conversation again in one user-role message, so every
            // link in it is already counted from where it came from — counting it again would double
            // them all and mark every one as the user's, the summary being written on their side of the
            // conversation. Skipped whole, not just unmarked: it is a copy, not a mention.
            if (m.isCompactSummary === true || (m.uuid && compactSummaryUuids.has(m.uuid))) continue;
            var you = userVoice(m);
            var mine = you ? 'in your message' : 'in a reply';
            var uuid = typeof m.uuid === 'string' ? m.uuid : null;
            // When the message was written, off the clock the CLI stamped the turn with rather than the
            // one the page built the object at — a session reopened from disk is full of the latter.
            var at = messageTime(m);
            var ctxYou = { you: you, uuid: uuid, at: at };
            var ctxTool = { you: false, uuid: uuid, at: at };
            if (typeof m.content === 'string') {
                noteUrls(m.content, 'link', mine, ctxYou);
                continue;
            }
            if (!Array.isArray(m.content)) continue;
            for (var j = 0; j < m.content.length; j++) {
                var raw = blockOf(m.content[j]);
                if (!raw) continue;
                if (raw.type === 'text') {
                    noteUrls(raw.text, 'link', mine, ctxYou);
                    continue;
                }
                if (raw.type === 'image' || raw.type === 'document') {
                    var media = mediaEntry(raw.type, raw);
                    // An attachment is always the user's: the app has no other way to put one in a
                    // transcript, and a pasted screenshot is the clearest "this came from me" there is.
                    note('media', media.key, media.label, media.label, media.label, 'attached by you', ctxYou);
                    var mediaRow = rows.get(media.key);
                    if (mediaRow && !mediaRow.payload) mediaRow.payload = media.payload;
                    continue;
                }
                if (raw.type !== 'tool_use') continue;
                var input = raw.input || {};
                if (raw.name === 'WebFetch' && typeof input.url === 'string' && input.url.trim())
                    note('tool', urlKey(input.url), trimUrl(input.url), input.url, input.url, 'fetched by WebFetch', ctxTool);
                else if (raw.name === 'WebSearch') {
                    // A search result is on the call's own wrapper — the app attaches it there — so its
                    // links are read the way the agent map reads a delegated run's, not off a field.
                    var hit = callResult(m.content[j]);
                    if (hit && !hit.isError) noteUrls(hit.text, 'tool', 'from WebSearch results', ctxTool);
                }
                if (raw.name === 'Bash') {
                    // A shell command is not a file and is not parsed for one — the paths inside one are
                    // guesswork. What *is* read from it is the repository's own bookkeeping, because git
                    // spells those in a grammar rather than in a shell: a branch is created by
                    // `checkout -b`/`switch -c`/`branch`, a worktree by `worktree add`, and a commit is
                    // whatever git answers with.
                    var out = callResult(m.content[j]);
                    noteGit(
                        typeof input.command === 'string' ? input.command : '',
                        out && !out.isError ? out.text : '',
                        ctxTool,
                    );
                    continue;
                }
                var p = filePathOf(input);
                if (p) note('file', fileKey(p), baseName(p), p, p, 'touched by ' + String(raw.name || 'a tool'), ctxTool);
            }
        }

        var out = [];
        rows.forEach(function (row) {
            out.push(row);
        });
        resourceMemo = { stamp: stamp, rows: out };
        return out;
    }

    function resourceLabel(n) {
        return n + (n === 1 ? ' resource' : ' resources');
    }

    function decorateResourcePill() {
        try {
            var rows = resourceScan();
            var pill = document.querySelector('.ccx-resource-pill');
            // No resources means no pill: a control that opens an empty list is one more thing in the
            // row for no answer. The stock agents pill draws its own zero, but its zero is a state of
            // the tab; this one is a property of the transcript.
            if (!rows.length) {
                if (pill) pill.remove();
                return;
            }
            var footer = document.querySelector('[class*="inputFooterV2_"]');
            if (!pill) {
                if (!footer) return;
                pill = document.createElement('button');
                pill.type = 'button';
                // The agents pill is `modelPill_<hash> agentsPill_<hash>`, and the look is the first of
                // those: `modelPill` is what carries the rounded pill, the min-height and the padding.
                // `footerButton` is deliberately not borrowed — it sets `border-radius:2px` and a
                // transparent background, and whichever of the two the stylesheet defines last wins, so
                // asking for both a pill and a footer button is asking for a square. The label goes in
                // a span because `modelPill span` is the rule that stops it wrapping.
                pill.className = ['ccx-resource-pill', stockClass('modelPill', footer)].filter(Boolean).join(' ');
                var label = document.createElement('span');
                label.className = 'ccx-res-pill-label';
                pill.appendChild(label);
                pill.onclick = openResources;
            }
            placeResourcePill(pill);
            // The label span is written, never the button: assigning textContent would delete the span
            // and with it the `modelPill span` rule that keeps the text on one line.
            var text = resourceLabel(rows.length);
            var labelEl = pill.querySelector('.ccx-res-pill-label');
            if (labelEl) {
                if (labelEl.textContent !== text) labelEl.textContent = text;
            } else if (pill.textContent !== text) pill.textContent = text;
            pill.title = text + ' · click for the list';
            pill.setAttribute('aria-label', pill.title);
        } catch (e) {
            /* a footer that cannot take the pill is a missing list, not a broken composer */
        }
    }

    // Where the count belongs, in the order of how exactly that is known — the same walk the countdown
    // takes (placeCachePill), because the composer renders its chips only when their state calls for
    // them and a pill placed at the first opportunity spends the session at whichever end the row
    // happened to have just then.
    //
    // First choice is immediately right of the agents pill: the two are the row's per-session summaries
    // and read as a pair. That pill is also the one thing here with a stable handle — `data-agents-dot`
    // — where everything else about it is a hashed class name. Failing that, right of the model pill,
    // the row's other control that says something about the session and the one that is always there;
    // then after the menu button. Never the end of the footer, which is where an unanchored insert
    // lands and what put the first version of this past the send button.
    function placeResourcePill(pill) {
        var footer = document.querySelector('[class*="inputFooterV2_"]');
        if (!footer) return;
        var anchor = document.querySelector('button[data-agents-dot]');
        if (anchor && anchor.parentElement) {
            if (anchor.nextSibling !== pill) anchor.parentElement.insertBefore(pill, anchor.nextSibling);
            return;
        }
        // Our own pill wears the model pill's class — that is what gives it the pill look — so the
        // search for the stock one has to skip the pill itself, the same trap the countdown documents.
        var model = null;
        var found = footer.querySelectorAll ? footer.querySelectorAll('[class*="modelPill_"]') : [];
        for (var i = 0; i < found.length; i++)
            if (found[i] !== pill) {
                model = found[i];
                break;
            }
        if (model && model.parentElement) {
            if (model.nextSibling !== pill) model.parentElement.insertBefore(pill, model.nextSibling);
            return;
        }
        var menu = footer.querySelector('[class*="menuButton_"]');
        if (menu && menu.parentElement && menu.nextSibling !== pill) {
            menu.parentElement.insertBefore(pill, menu.nextSibling);
            return;
        }
        if (pill.parentElement !== footer) footer.appendChild(pill);
    }

    // The nodes the transcript draws a turn in, the ones both this and applyHidden are about.
    function drawnMessages(assistantFirst) {
        var nodes = [];
        try {
            var assistant = document.querySelectorAll('[data-testid="assistant-message"]');
            var user = document.querySelectorAll('[class*="userMessageContainer_"]');
            var i;
            if (assistantFirst) {
                if (assistant) for (i = 0; i < assistant.length; i++) nodes.push(assistant[i]);
                if (user) for (i = 0; i < user.length; i++) nodes.push(user[i]);
            } else {
                if (user) for (i = 0; i < user.length; i++) nodes.push(user[i]);
                if (assistant) for (i = 0; i < assistant.length; i++) nodes.push(assistant[i]);
            }
        } catch (e) {
            /* a transcript that cannot be walked has no message to land on */
        }
        return nodes;
    }

    // An id in a selector: the attribute the app itself links to a message by. `CSS.escape` is there
    // in the webview, and the fallback escapes the two characters that would end the string early.
    function attrLiteral(value) {
        var s = String(value);
        return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
    }

    // The node for a message, in the order of how exactly it can be named.
    //
    // An assistant message names itself: `data-bookmark-uuid` is the attribute the app puts on it and
    // the one the app's own code links to a message by. A user message has no such attribute, so it
    // comes off the fiber — the walk applyHidden makes, and the same message object the hidden set is
    // keyed by. If neither answers, the row's own value is used as a last resort: a URL pasted into a
    // prompt is in the bubble verbatim, and so is the path a tool call names.
    //
    // The floor under all of it is the toast: the transcript draws only the turns near the viewport, so
    // a resource from far up a long session has no node at all, and the jump says so rather than
    // scrolling to whatever was nearest and calling it the one.
    function messageNode(row) {
        var uuid = row && row.uuid;
        if (uuid) {
            try {
                var named = document.querySelector('[data-bookmark-uuid="' + attrLiteral(uuid) + '"]');
                if (named) return named;
            } catch (e) {
                /* a selector the engine refuses is one handle less, not a broken jump */
            }
            // The fiber walk, with a shallower test than messagePropOf's: the jump only has to
            // recognise the message, and isTranscriptMessage() is strict on purpose (it decides what
            // applyHidden is allowed to mark) — requiring a `timestamp` there would take the jump away
            // on any build that stops carrying one. The depth is the other half of that: a turn nests
            // one level per block renderer, so a message holding a tool call sits further from its node
            // than a plain one, and ten hops was measured on the plainest kind.
            var nodes = drawnMessages(!row.you);
            for (var i = 0; i < nodes.length; i++) {
                var key = fiberKeyOf(nodes[i]);
                var fiber = key ? nodes[i][key] : null;
                for (var d = 0; fiber && d < 30; d++, fiber = fiber.return) {
                    var props = fiber.memoizedProps;
                    var found = props && props.message;
                    if (found && typeof found === 'object' && found.uuid === uuid) return nodes[i];
                }
            }
        }
        // Then the value itself, as text — and for an attachment, which has no text to be found by, the
        // picture: the row carries the payload, and the bubble it came from holds the same bytes.
        var probe = row && typeof row.value === 'string' ? row.value.trim() : '';
        var all = drawnMessages(!row.you);
        var k;
        if (row && row.kind === 'media' && row.payload) {
            var prefix = 'data:' + row.payload.mediaType + ';base64,' + String(row.payload.data || '').slice(0, 64);
            for (k = 0; k < all.length; k++) {
                var images = all[k].getElementsByTagName ? all[k].getElementsByTagName('img') : [];
                for (var n = 0; n < images.length; n++)
                    if (String(images[n].src || '').indexOf(prefix) === 0) return all[k];
            }
        }
        if (probe.length < 4) return null;
        for (k = 0; k < all.length; k++) {
            var text = all[k].textContent;
            if (text && text.indexOf(probe) > -1) return all[k];
        }
        return null;
    }

    // Where a message sits in the session's own list, which is the order it is drawn in.
    function messageIndex(messages, uuid) {
        if (!uuid) return -1;
        for (var i = 0; i < messages.length; i++) if (messages[i] && messages[i].uuid === uuid) return i;
        return -1;
    }

    // The drawn nodes that can be tied back to a message, with that message's index. A turn draws as one
    // node and holds many messages — a tool result is a message of its own and no bubble — so this is
    // what says which part of the session the page is showing at all.
    function drawnIndexed(messages) {
        var out = [];
        var nodes = drawnMessages(true);
        for (var i = 0; i < nodes.length; i++) {
            var uuid = null;
            try {
                uuid = nodes[i].getAttribute('data-bookmark-uuid');
            } catch (e) {
                uuid = null;
            }
            var key = fiberKeyOf(nodes[i]);
            var fiber = key ? nodes[i][key] : null;
            for (var d = 0; fiber && d < 30 && !uuid; d++, fiber = fiber.return) {
                var props = fiber.memoizedProps;
                var m = props && props.message;
                if (m && typeof m === 'object' && typeof m.uuid === 'string') uuid = m.uuid;
            }
            var idx = messageIndex(messages, uuid);
            if (idx >= 0) out.push({ node: nodes[i], index: idx });
        }
        return out;
    }

    // The nearest drawn turn at or above the message: a resource from inside a turn is reached by the
    // turn, and one from before everything the page draws is reached by the top of it. The distance is
    // returned as well, because the caller has to tell those two apart — one is a jump that landed
    // close, the other is a jump that landed at the edge of what the app has.
    function nearestDrawnNode(row) {
        var messages = sessionField('messages');
        if (!Array.isArray(messages)) return null;
        var target = messageIndex(messages, row.uuid);
        if (target < 0) return null;
        var drawn = drawnIndexed(messages);
        if (!drawn.length) return null;
        var best = null;
        for (var i = 0; i < drawn.length; i++)
            if (drawn[i].index <= target && (!best || drawn[i].index > best.index)) best = drawn[i];
        var chosen = best || drawn[0];
        return { node: chosen.node, index: chosen.index, target: target };
    }

    // Why a jump found nothing, on the channel the agent frame uses: which handles were tried, how many
    // message nodes the page has at all, how many of them carry the app's own uuid attribute, and where
    // the message sits in the session. A page that renders differently from what this file expects is a
    // difference only the real page can report, and guessing at it from a screenshot has cost rounds.
    function reportJumpMiss(row) {
        try {
            var drawn = drawnMessages(true);
            var named = 0;
            try {
                named = document.querySelectorAll('[data-bookmark-uuid]').length;
            } catch (e) {
                named = -1;
            }
            var messages = sessionField('messages');
            var list = Array.isArray(messages) ? messages : [];
            var indexed = drawnIndexed(list);
            send({
                type: 'ccx:debug',
                reason: 'jumpMiss',
                dump: {
                    kind: row.kind,
                    you: !!row.you,
                    uuid: String(row.uuid || ''),
                    value: String(row.value || '').slice(0, 60),
                    drawn: drawn.length,
                    named: named,
                    index: messageIndex(list, row.uuid),
                    messages: list.length,
                    from: indexed.length ? indexed[0].index : -1,
                    to: indexed.length ? indexed[indexed.length - 1].index : -1,
                },
            });
        } catch (e) {
            /* a report that cannot be sent is not a second failure */
        }
    }

    // A highlight that fades on its own, so what the jump found is identifiable without leaving a mark
    // on a node React owns and redraws. An attribute rather than a class for the reason
    // `data-ccx-hidden` is one: the app rewrites className, and the stylesheet rule is written for it.
    function flashMessage(node) {
        try {
            node.setAttribute('data-ccx-flash', '');
            setTimeout(function () {
                node.removeAttribute('data-ccx-flash');
            }, 1600);
        } catch (e) {
            /* a node that cannot be marked was still scrolled to */
        }
    }

    function landOn(node) {
        try {
            if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (e) {
            /* an engine that refuses the options object still lands on the message */
        }
        flashMessage(node);
    }

    function jumpToResource(row) {
        closePicker();
        var node = messageNode(row);
        if (node) {
            landOn(node);
            return;
        }
        // Not drawn by name. Everything below says which of the two that was, because they want
        // different things from the user: a message the page holds but gives no node of its own — a
        // tool result is a message and no bubble — is reached by the turn that holds it, while a
        // message from further back than the app renders at all is reached by nothing, and the switch
        // that would put it on screen is worth naming. A jump that lands near is useful; a jump that
        // pretends to be exact is not.
        var near = nearestDrawnNode(row);
        if (near) {
            landOn(near.node);
            toast(
                near.target - near.index > 50
                    ? 'That message is further back than the transcript the app draws — this is the oldest turn it has. "History before compaction", and a session reopened after it, reach the rest.'
                    : 'The message itself is not drawn — this is the nearest turn the app has.',
            );
            return;
        }
        reportJumpMiss(row);
        toast('That message is not in the part of the transcript the app has drawn — scroll back to it, then jump again.');
    }

    function resourceRow(row) {
        var el = document.createElement('div');
        // A branch or a commit has nothing to open — there is no file behind either — so its row is not
        // drawn as something that opens. The jump arrow is on every row; that is the affordance both
        // kinds do have.
        el.className = 'ccx-row ccx-res-row' + (row.open ? ' ccx-res-open' : '');
        if (row.open)
            el.onclick = function () {
                // The host decides what may be opened and says why when it may not: a path that is not
                // absolute has no directory to resolve against here, and the wrong file is worse than a
                // refusal. An attachment is the one kind with nothing to open *yet* — the payload
                // travels with the request and the host writes it to a file before handing it to the OS,
                // so what the user sees is the picture, not a base64 blob.
                send({
                    type: 'ccx:openResource',
                    kind: row.open,
                    value: row.value,
                    mediaType: row.payload ? row.payload.mediaType : undefined,
                    data: row.payload ? row.payload.data : undefined,
                    url: row.payload ? row.payload.url : undefined,
                    seq: ++resourceSeq,
                });
                closePicker();
            };

        // An attached image gets the composer chip's own treatment: the picture itself, at the chip's
        // own class, so the row is recognised the way the attachment it came from was. Only images —
        // a document block has no thumbnail in the composer either, and a broken `<img>` is worse than
        // a name.
        var dims = null;
        if (row.kind === 'media' && row.payload && /^image\//i.test(row.payload.mediaType) && row.payload.data) {
            var thumb = document.createElement('img');
            thumb.className = 'ccx-res-thumb ' + stockClass('thumbIcon', document);
            thumb.src = 'data:' + row.payload.mediaType + ';base64,' + row.payload.data;
            thumb.alt = '';
            // The chip prints the pixel size beside the name, and the size is only known once the
            // image has decoded, so the span starts empty and the load fills it.
            dims = document.createElement('span');
            dims.className = 'ccx-res-dims';
            thumb.onload = function () {
                if (thumb.naturalWidth && thumb.naturalHeight)
                    dims.textContent = thumb.naturalWidth + '×' + thumb.naturalHeight;
            };
            el.appendChild(thumb);
        }

        var label = document.createElement('span');
        label.className = 'ccx-res-label';
        if (row.kind === 'file') {
            var dir = dirPrefix(row.value);
            if (dir) {
                var dim = document.createElement('span');
                dim.className = 'ccx-res-dir';
                dim.textContent = dir;
                var name = document.createElement('span');
                name.className = 'ccx-res-name';
                name.textContent = baseName(row.value);
                label.appendChild(dim);
                label.appendChild(name);
            } else label.textContent = row.label;
        } else if (row.kind === 'commit') {
            // The hash dimmed and the subject beside it, the way a directory sits in front of a file: a
            // column of commits is read by its subjects, and the hashes only have to line up.
            var hash = document.createElement('span');
            hash.className = 'ccx-res-dir';
            hash.textContent = row.value.slice(0, 7) + ' ';
            var subject = document.createElement('span');
            subject.className = 'ccx-res-name';
            subject.textContent = row.label;
            label.appendChild(hash);
            label.appendChild(subject);
        } else label.textContent = row.label;
        el.appendChild(label);
        // A commit or a worktree says whose it is: made here, or only read out of git in a listing.
        if (typeof row.made === 'boolean') {
            var own = document.createElement('span');
            own.className = 'ccx-res-own ccx-res-own-' + (row.made ? 'made' : 'seen');
            own.textContent = row.made ? 'made' : 'seen';
            own.title = row.made
                ? 'This session made it'
                : 'The session only read this one out of git — it is not work done here';
            el.appendChild(own);
        }
        // When it was first said. The same clock the agent map's rows lead with, and the same rule: the
        // time alone for today, the date in front of it for anything older, the year once that is not the
        // current one — a list of resources spans days in a session that was left open.
        var when = row.at ? callTime(row.at) : undefined;
        if (when) {
            var time = document.createElement('span');
            time.className = 'ccx-res-time';
            time.textContent = when;
            try {
                time.title = 'First mentioned at ' + new Date(row.at).toLocaleString();
            } catch (e) {
                /* a clock that cannot be formatted is a time without a tooltip */
            }
            el.appendChild(time);
        }
        if (row.you) {
            var youTag = document.createElement('span');
            youTag.className = 'ccx-res-you';
            youTag.textContent = 'you';
            youTag.title = 'This came from one of your own messages, not from the model';
            el.appendChild(youTag);
        }
        if (dims) el.appendChild(dims);

        // The row's second affordance: the value opens the resource, the arrow goes to where it came
        // from. Only one of them can be the row's own click, so this one stops the event.
        var jump = document.createElement('span');
        jump.className = 'ccx-res-jump';
        jump.textContent = '↵';
        jump.title = row.uuid ? 'Jump to the message this came from' : 'No message to jump to';
        jump.onclick = function (e) {
            if (e && e.stopPropagation) e.stopPropagation();
            jumpToResource(row);
        };
        el.appendChild(jump);

        if (row.count > 1) {
            var badge = document.createElement('span');
            badge.className = 'ccx-res-count';
            badge.textContent = '×' + row.count;
            el.appendChild(badge);
        }
        el.title = row.full + (row.from.length ? '\n' + row.from.join(' · ') : '');
        return el;
    }

    // One fold's worth of rows, capped, with the count of what the cap left out. Used for a section's
    // own rows and for the list of what was only read.
    function appendResourceRows(container, rows) {
        var shown = rows.slice(0, RESOURCE_CAP);
        for (var i = 0; i < shown.length; i++) container.appendChild(resourceRow(shown[i]));
        if (rows.length > shown.length) {
            var more = document.createElement('div');
            more.className = 'ccx-res-more';
            more.textContent = '+' + (rows.length - shown.length) + ' more';
            container.appendChild(more);
        }
        return container;
    }

    // The fold a commit or a worktree that was only read goes under. Same markup and same stylesheet as
    // the section's own head, one level in, so the two fold the same way and look like what they are.
    function readOnlyFold(kind, rows) {
        var fold = document.createElement('div');
        fold.className = 'ccx-res-sub';
        var key = kind + ':seen';
        fold.setAttribute('data-ccx-open', resourceFold[key] ? '1' : '0');

        var head = document.createElement('div');
        head.className = 'ccx-res-head ccx-res-subhead';
        var caret = document.createElement('span');
        caret.className = 'ccx-res-caret';
        caret.textContent = '▸';
        var label = document.createElement('span');
        label.className = 'ccx-res-head-label';
        label.textContent = 'only read';
        var count = document.createElement('span');
        count.className = 'ccx-res-head-count';
        count.textContent = String(rows.length);
        head.appendChild(caret);
        head.appendChild(label);
        head.appendChild(count);
        head.title = 'Read out of git in this session — looked at, not made here';
        head.onclick = function () {
            var open = fold.getAttribute('data-ccx-open') === '1';
            fold.setAttribute('data-ccx-open', open ? '0' : '1');
            resourceFold[key] = !open;
        };
        fold.appendChild(head);

        var body = document.createElement('div');
        body.className = 'ccx-res-body';
        appendResourceRows(body, rows);
        fold.appendChild(body);
        return fold;
    }

    function openResources() {
        closePicker();
        var rows = resourceScan();
        overlay = document.createElement('div');
        overlay.className = 'ccx-overlay';
        overlay.onclick = function (e) {
            if (e.target === overlay) closePicker();
        };
        overlayKind = 'resources';

        var box = document.createElement('div');
        box.className = 'ccx-box ccx-resources-box';

        var title = document.createElement('div');
        title.className = 'ccx-title';
        title.textContent = 'Session resources';
        var tally = document.createElement('span');
        tally.className = 'ccx-res-tally';
        tally.textContent = rows.length ? resourceLabel(rows.length) : 'none yet';
        title.appendChild(tally);
        box.appendChild(title);

        var hint = document.createElement('div');
        hint.className = 'ccx-hint';
        hint.textContent =
            'Read from this session\'s transcript — links in messages, pages the tools fetched, files they touched, the branches, commits and worktrees it made, attachments. "you" marks what you mentioned first, and those lead each section; a section head folds it';
        box.appendChild(hint);

        // forEach rather than a counting loop, because each section's head closes over its own wrapper:
        // one `var` between them and every head would fold the last section drawn.
        RESOURCE_SECTIONS.forEach(function (section) {
            // The user's own first, inside the section: the question this dialog is opened with is
            // usually "what did I put in this session", and a tag alone would still leave the answer
            // to be picked out of a list ordered by nothing the reader knows. The rest keeps the
            // first-seen order it was scanned in.
            var mine = [];
            var theirs = [];
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].kind !== section.kind) continue;
                (rows[i].you ? mine : theirs).push(rows[i]);
            }
            if (!mine.length && !theirs.length) return;
            mine = mine.concat(theirs);

            var wrap = document.createElement('div');
            wrap.className = 'ccx-res-section';
            wrap.setAttribute('data-ccx-open', sectionOpen(section.kind) ? '1' : '0');

            var head = document.createElement('div');
            head.className = 'ccx-res-head';
            var caret = document.createElement('span');
            caret.className = 'ccx-res-caret';
            caret.textContent = '▸';
            var name = document.createElement('span');
            name.className = 'ccx-res-head-label';
            name.textContent = section.label;
            var count = document.createElement('span');
            count.className = 'ccx-res-head-count';
            count.textContent = String(mine.length);
            head.appendChild(caret);
            head.appendChild(name);
            head.appendChild(count);
            head.onclick = function () {
                var folded = wrap.getAttribute('data-ccx-open') === '1';
                wrap.setAttribute('data-ccx-open', folded ? '0' : '1');
                resourceFold[section.kind] = !folded;
            };
            wrap.appendChild(head);

            // The rows are built whether the section is folded or not: the fold is a stylesheet rule on
            // the wrapper, so nothing has to be rebuilt to unfold one — and the dialog is repainted on
            // every state pass, which would otherwise throw away what was unfolded.
            var body = document.createElement('div');
            body.className = 'ccx-res-body';
            // A commit or a worktree the session only read out of git goes under its own fold, shut by
            // default: what the section is about is work done here, and a `git log` of twenty commits
            // would otherwise bury it. Everything else has no such split.
            var kept = [];
            var readOnly = [];
            for (var k = 0; k < mine.length; k++) (mine[k].made === false ? readOnly : kept).push(mine[k]);
            appendResourceRows(body, kept);
            if (readOnly.length) body.appendChild(readOnlyFold(section.kind, readOnly));
            wrap.appendChild(body);
            box.appendChild(wrap);
        });
        if (!rows.length) {
            var empty = document.createElement('div');
            empty.className = 'ccx-res-empty';
            empty.textContent = 'No external resources in this session yet.';
            box.appendChild(empty);
        }

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        var onKey = function (e) {
            if (e.key === 'Escape') {
                closePicker();
                window.removeEventListener('keydown', onKey, true);
            }
        };
        window.addEventListener('keydown', onKey, true);
    }

    // --- History before compaction --------------------------------------------------------------
    //
    // The switch lives on the host (full-history.json), because the host is what rebuilds a transcript
    // when a session opens and no page is asked first. The page mirrors it for its own two jobs: lifting
    // the 600-message cap, and keeping fork/rewind away from the part of a transcript the model no
    // longer has. Both run while the transcript is being rebuilt, which can be before the first state
    // push reaches a fresh page, so the last value seen is kept in localStorage to start from.
    var HISTORY_KEY = 'ccx.historyBeforeCompaction';

    function rememberHistoryBeforeCompaction(on) {
        try {
            window.localStorage.setItem(HISTORY_KEY, on ? '1' : '0');
        } catch (e) {
            /* the host's state push still carries it */
        }
    }

    function historyBeforeCompactionPref() {
        if (typeof state.historyBeforeCompaction === 'boolean') return state.historyBeforeCompaction;
        try {
            return window.localStorage.getItem(HISTORY_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function historyTick() {
        if (!jsx) return undefined;
        return stockToggle(historyBeforeCompactionPref());
    }

    // Nothing reloads here. Rebuilding the open transcript means relaunching its CLI, which is not
    // something a view switch should do to a session mid-turn — the next session opened picks it up.
    function toggleHistoryBeforeCompaction() {
        var next = !historyBeforeCompactionPref();
        state.historyBeforeCompaction = next;
        rememberHistoryBeforeCompaction(next);
        send({ type: 'ccx:historyBeforeCompaction', enabled: next });
        syncAction();
        toast(next
            ? 'History before compaction is on — reopen a session to see it'
            : 'History before compaction is off — sessions opened from now on start at the last compaction');
    }

    function keepEveryMessage() {
        return historyBeforeCompactionPref();
    }

    function noteCompactSummaries(messages) {
        if (!Array.isArray(messages)) return;
        for (var i = 0; i < messages.length; i++) {
            var m = messages[i];
            if (m && m.isCompactSummary === true && typeof m.uuid === 'string') compactSummaryUuids.add(m.uuid);
        }
    }

    // True for a message that sits above the last compaction in `list`: a summary rebuilt from disk, or
    // the divider a compaction leaves in a live tab. Messages the compaction kept come after the summary
    // and stay actionable — the model still has those.
    //
    // Asked once per rendered prompt, over a list that can now run to thousands of messages, so the
    // position of every message and of the edge are indexed once per list. A list the app appends to in
    // place changes length, and that is what invalidates the entry.
    function beforeCompaction(list, message) {
        if (!historyBeforeCompactionPref() || !Array.isArray(list) || !message) return false;
        var edge = compactionEdges && compactionEdges.get(list);
        if (!edge || edge.length !== list.length) {
            edge = { length: list.length, last: -1, index: new Map() };
            for (var i = 0; i < list.length; i++) {
                var m = list[i];
                edge.index.set(m, i);
                if (m && (m.type === 'compact' || (m.uuid && compactSummaryUuids.has(m.uuid)))) edge.last = i;
            }
            if (compactionEdges) compactionEdges.set(list, edge);
        }
        var at = edge.index.get(message);
        return at !== undefined && at < edge.last;
    }

    function buildSidebarSection(stack) {
        var section = document.createElement('div');
        section.className = 'ccx-side-section';

        var head = document.createElement('div');
        head.className = stack.header.className;
        var toggle = document.createElement('button');
        var stockToggle = sidebarPart(stack.header, 'sectionToggle');
        toggle.className = stockToggle ? stockToggle.className : 'ccx-side-toggle';
        toggle.onclick = function () {
            var next = section.getAttribute('data-ccx-open') !== '0';
            section.setAttribute('data-ccx-open', next ? '0' : '1');
            rememberCollapsed(next);
        };

        // The chevron is the app's own SVG, cloned: rebuilding it would mean guessing at a path that
        // changes with their icon set. A clone carries no React handler, which is exactly what is
        // wanted — the button above owns the click.
        var stockChevron = sidebarPart(stack.header, 'sectionChevron');
        var chevron = document.createElement('span');
        chevron.className = 'ccx-side-chev';
        if (stockChevron && stockChevron.cloneNode) chevron.appendChild(stockChevron.cloneNode(true));
        else chevron.textContent = '›';
        toggle.appendChild(chevron);

        var label = document.createElement('span');
        var stockLabel = sidebarPart(stack.header, 'sectionLabel');
        label.className = stockLabel ? stockLabel.className : 'ccx-side-label';
        label.textContent = 'Providers';
        toggle.appendChild(label);
        head.appendChild(toggle);

        // Sits where "View details" sits on the account section, and does the same job: the full list,
        // in the overlay, with the notes a narrow sidebar has no room for. It wears the chip the menu
        // entry wears rather than the sidebar's own link class — the count is the same fact in both
        // places, and it should not read as two different controls.
        var link = document.createElement('button');
        link.className = 'ccx-prov-tag ccx-side-link';
        link.onclick = openHealth;
        head.appendChild(link);
        section.appendChild(head);

        var list = document.createElement('div');
        list.className = 'ccx-prov-list ccx-side-body';
        section.appendChild(list);
        section.setAttribute('data-ccx-open', collapsedPref() ? '0' : '1');
        return section;
    }

    function decorateSidebar() {
        try {
            var stack = sidebarStack();
            if (!stack) return;
            var rows = providerRows(state.now || Date.now());
            if (!rows.length) return;

            var section = null;
            var kids = stack.parent.children;
            for (var i = 0; i < kids.length; i++)
                if (String(kids[i].className).indexOf('ccx-side-section') > -1) section = kids[i];
            if (!section) {
                section = buildSidebarSection(stack);
                try {
                    stack.parent.insertBefore(section, stack.before);
                } catch (e) {
                    // React owns this container; a section at the end still reads correctly.
                    stack.parent.appendChild(section);
                }
            }

            var down = 0;
            var known = 0;
            for (var j = 0; j < rows.length; j++) {
                if (rows[j].state === 'unknown') continue;
                known++;
                if (rows[j].state !== 'ok') down++;
            }
            var stamp = tallyText(rows) + '|' + rows.map(function (r) {
                return r.name + ';' + r.state + ';' + r.age + ';' + r.note + ';' + (r.icon ? '1' : '0');
            }).join('|');
            if (section.getAttribute('data-ccx-stamp') === stamp) return;
            section.setAttribute('data-ccx-stamp', stamp);

            var link = section.children[0].children[1];
            if (link) {
                link.textContent = known ? (down ? down + ' down' : 'all ok') : 'no checks yet';
                link.setAttribute('data-ccx-down', down ? '1' : '0');
                link.title = 'Provider status — open the full list';
            }
            paintProviders(section.children[1], rows, state.active);
        } catch (e) {
            /* a sidebar without the section is not a broken sidebar */
        }
    }

    function watchPicker() {
        var timer = null;
        new MutationObserver(function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                decorateModelPicker();
                    decorateSessionList();
                decorateAgentFrames();
                decorateSidebar();
                applyHidden();
                watchComposerSpellcheck();
                syncAttachmentPrompt();
                syncResumePrompt();
                decorateCachePill();
                decorateResourcePill();
            }, 60);
        }).observe(document.body, { childList: true, subtree: true });
        watchRunningFrames();
    }

    function toast(message) {
        var bar = document.createElement('div');
        bar.className = 'ccx-toast';
        bar.textContent = message;
        document.body.appendChild(bar);
        setTimeout(function () { bar.remove(); }, 6000);
    }

    // --- Quote selection ---------------------------------------------------------------------
    //
    // VS Code draws the webview's Cut/Copy/Paste menu itself, and an extension can only add to it by
    // contributing `menus."webview/context"` in the extension manifest. Patching an installed
    // extension's package.json is not viable: the scanned manifest is cached against the mtime of
    // extensions.json, so the edit either does nothing or trips the "Extensions have been modified
    // on disk" error. What the page *can* do is pre-empt the menu entirely — VS Code's webview
    // preload leads its own handler with `if (e.defaultPrevented) return;`, so calling
    // preventDefault() means its menu is never even requested. That is the whole mechanism.
    //
    // It is used as narrowly as possible: only on a right-click inside a non-empty transcript
    // selection. Everywhere else the stock menu is left alone, so Cut/Copy/Paste in the composer
    // and everything outside the transcript keep working untouched.

    var menu = null;
    var selectionSnapshot = null;

    // The composer's own glyphs are transparent (`color:#0000`) — what the user reads is a sibling
    // mirror element React renders from state. Writing to the DOM without going through their input
    // path therefore produces text that is not stale but *invisible*, so every insert below is an
    // execCommand that fires their `oninput`.
    function composerEl() {
        return document.querySelector('[role="textbox"][aria-label="Message input"]');
    }

    // VS Code starts this webview with Chromium spellchecking disabled, and Claude Code's own checker
    // only decorates its terminal UI. The host therefore checks a bounded list of Russian words with
    // local Hunspell. Custom Highlight ranges decorate the React-owned source nodes without wrapping or
    // editing them, which keeps the app's input state, selection and undo history intact.
    function clearSpellcheckHighlights() {
        if (window.CSS && CSS.highlights) CSS.highlights.delete('ccx-spelling');
    }

    function spellcheckTokens(el) {
        var text = el.textContent || '';
        var tokens = [];
        var match;
        var words = /[А-Яа-яЁё]{2,}/g;
        while ((match = words.exec(text))) {
            var word = match[0].toLowerCase();
            tokens.push({ word: word, start: match.index, end: match.index + match[0].length });
        }
        return { text: text, tokens: tokens };
    }

    function spellcheckTextNodes(el) {
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        var nodes = [];
        var start = 0;
        var node;
        while ((node = walker.nextNode())) {
            var end = start + node.nodeValue.length;
            nodes.push({ node: node, start: start, end: end });
            start = end;
        }
        return nodes;
    }

    function spellcheckPoint(nodes, offset) {
        for (var i = 0; i < nodes.length; i++) {
            if (offset <= nodes[i].end) return { node: nodes[i].node, offset: offset - nodes[i].start };
        }
        return null;
    }

    function spellcheckOffsetAtPoint(el, x, y) {
        var range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
        if (!range && document.caretPositionFromPoint) {
            var position = document.caretPositionFromPoint(x, y);
            if (position) {
                range = document.createRange();
                range.setStart(position.offsetNode, position.offset);
                range.collapse(true);
            }
        }
        if (!range || !el.contains(range.startContainer)) return null;
        var before = document.createRange();
        before.selectNodeContents(el);
        before.setEnd(range.startContainer, range.startOffset);
        return before.toString().length;
    }

    function spellcheckTokenAtPoint(el, x, y) {
        var offset = spellcheckOffsetAtPoint(el, x, y);
        if (offset === null) return null;
        var tokens = spellcheckTokens(el).tokens;
        for (var i = 0; i < tokens.length; i++) {
            if (offset >= tokens[i].start && offset <= tokens[i].end && spellcheckUnknown.has(tokens[i].word)) {
                return tokens[i];
            }
        }
        return null;
    }

    function replaceSpellcheckToken(el, token, replacement) {
        var point = spellcheckPoint(spellcheckTextNodes(el), token.start);
        var end = spellcheckPoint(spellcheckTextNodes(el), token.end);
        if (!point || !end) return false;
        var range = document.createRange();
        range.setStart(point.node, point.offset);
        range.setEnd(end.node, end.offset);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        el.focus();
        return document.execCommand('insertText', false, replacement);
    }

    function onComposerSpellcheckContextMenu(e) {
        var el = composerEl();
        if (!el || !el.contains(e.target) || el !== spellcheckComposer || (el.textContent || '') !== spellcheckText) return;
        var token = spellcheckTokenAtPoint(el, e.clientX, e.clientY);
        var suggestions = token && Array.isArray(spellcheckSuggestions[token.word]) ? spellcheckSuggestions[token.word] : [];
        if (!suggestions.length) return;
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, suggestions.slice(0, 5).map(function (suggestion) {
            return menuItem(suggestion, function () {
                if (!replaceSpellcheckToken(el, token, suggestion)) toast('Не удалось заменить слово.');
            });
        }));
    }

    function applySpellcheckResult(result) {
        if (result.seq !== spellcheckSeq || !Array.isArray(result.unknown)) return;
        var el = spellcheckComposer;
        if (!el || el !== composerEl() || (el.textContent || '') !== spellcheckText) return;

        spellcheckUnknown = new Set(result.unknown.map(function (word) { return word.toLowerCase(); }));
        spellcheckSuggestions = result.suggestions && typeof result.suggestions === 'object' ? result.suggestions : {};
        if (!window.CSS || !CSS.highlights || typeof Highlight !== 'function') return;
        var unknown = spellcheckUnknown;
        var tokens = spellcheckTokens(el).tokens;
        var nodes = spellcheckTextNodes(el);
        var ranges = [];
        for (var i = 0; i < tokens.length; i++) {
            if (!unknown.has(tokens[i].word)) continue;
            var start = spellcheckPoint(nodes, tokens[i].start);
            var end = spellcheckPoint(nodes, tokens[i].end);
            if (!start || !end) continue;
            var range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            ranges.push(range);
        }
        if (ranges.length) CSS.highlights.set('ccx-spelling', new Highlight(...ranges));
        else clearSpellcheckHighlights();
    }

    function runSpellcheck() {
        var el = composerReady();
        clearSpellcheckHighlights();
        if (!el) return;
        var parsed = spellcheckTokens(el);
        if (!parsed.tokens.length) return;
        var words = [];
        var seen = new Set();
        for (var i = 0; i < parsed.tokens.length && words.length < 200; i++) {
            if (seen.has(parsed.tokens[i].word)) continue;
            seen.add(parsed.tokens[i].word);
            words.push(parsed.tokens[i].word);
        }
        spellcheckComposer = el;
        spellcheckText = parsed.text;
        send({ type: 'ccx:spellcheck', seq: ++spellcheckSeq, words: words });
    }

    function queueSpellcheck() {
        clearTimeout(spellcheckTimer);
        spellcheckUnknown = new Set();
        spellcheckSuggestions = {};
        clearSpellcheckHighlights();
        spellcheckTimer = setTimeout(runSpellcheck, 450);
    }

    function watchComposerSpellcheck() {
        var el = composerEl();
        if (!el || el.dataset.ccxSpellcheck) return;
        el.dataset.ccxSpellcheck = '1';
        el.addEventListener('input', queueSpellcheck);
        el.addEventListener('contextmenu', onComposerSpellcheckContextMenu, true);
        el.addEventListener('compositionstart', function () {
            clearTimeout(spellcheckTimer);
            clearSpellcheckHighlights();
        });
        el.addEventListener('compositionend', queueSpellcheck);
        queueSpellcheck();
    }

    // While a permission request is pending the app sets `display:none` on the composer's container.
    // execCommand refuses to edit a hidden contenteditable and returns false, so the item must not be
    // offered at all in that state — inserting "successfully" into an invisible box is worse.
    function composerReady() {
        var el = composerEl();
        return el && el.offsetParent !== null ? el : null;
    }

    function fencedLanguage(node) {
        var pre = node && node.nodeType === 1 ? node : node && node.parentElement;
        pre = pre && pre.closest ? pre.closest('pre') : null;
        if (!pre) return null;
        var code = pre.querySelector('code');
        var m = code && /(?:^|\s)language-([\w+-]+)/.exec(code.className || '');
        return { lang: m ? m[1] : '' };
    }

    // Selected transcript text is rendered output, not the original markdown — links and emphasis are
    // already flattened by the time it reaches us, and there is no reliable way back to the source.
    // Quoting what the user actually sees is the honest reading of "quote selection". Code is the one
    // case worth special-handling: a selection sitting inside a <pre> becomes a fence, because
    // blockquoting code destroys it.
    function quoteText(sel) {
        var text = sel.toString().replace(/\r\n?/g, '\n').replace(/\s+$/, '');
        if (!text) return '';

        var fence = fencedLanguage(sel.anchorNode);
        if (fence && fencedLanguage(sel.focusNode)) {
            return '```' + fence.lang + '\n' + text + '\n```';
        }
        return text
            .split('\n')
            .map(function (line) {
                var trimmed = line.replace(/\s+$/, '');
                return trimmed ? '> ' + trimmed : '>';
            })
            .join('\n');
    }

    // One execCommand per line, with insertLineBreak between them. A single insertText carrying the
    // newlines is what the app itself uses for @-mentions, but it splits a multi-line payload into
    // <div> blocks and mangles the text; line-at-a-time lands it verbatim.
    function insertIntoComposer(el, text, trailingBreak) {
        el.focus();
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
            if (i && !document.execCommand('insertLineBreak')) return false;
            if (lines[i] && !document.execCommand('insertText', false, lines[i])) return false;
        }
        // A trailing break would leave the caret before it rather than after, so the blank line the
        // user needs is inserted as the separator for whatever they type next.
        return trailingBreak === false ? true : document.execCommand('insertLineBreak');
    }

    // --- Attachment with no text ---------------------------------------------------------------
    //
    // An image alone cannot be sent. Submit starts with `let je = te.current?.textContent?.trim()||"";
    // if(!je) return;`, and the send button is `disabled: !busy && !canSendMessage` where
    // canSendMessage is `!!v.trim()` — so with an empty composer the button is genuinely disabled and
    // does not even emit a click. Intercepting the send is therefore impossible; the only way through
    // is to make the text non-empty, which is what enables their button by their own rule.
    //
    // The draft is written the moment the attachment appears rather than at submit time, so the user
    // sees exactly what will be sent and can edit or replace it before pressing Enter.

    // The wording follows the language from /config. host.js resolves ~/.claude/settings.json into
    // these four finished sentences and ships them in ccx:state, so this side only has to decide which
    // of them fits what is attached — and a /config change repaints them without a reload.
    //
    // These English defaults are what stays in place if a host that predates the field is loaded, and
    // are also what an unrecognised language resolves to. To reword any language, edit LANGUAGES in
    // host.js; this table is only the fallback.
    var ATTACHMENT_PROMPTS = {
        image: 'Analyse the image in the context of this conversation',
        images: 'Analyse the images in the context of this conversation',
        attachment: 'Analyse the attachment in the context of this conversation',
        attachments: 'Analyse the attachments in the context of this conversation',
    };

    // All or nothing: a half-filled table would mean one attachment count silently drops to English
    // while the rest are translated, which reads as a bug in the wording rather than in the message.
    function adoptAttachmentPrompts(next) {
        if (!next) return;
        var keys = ['image', 'images', 'attachment', 'attachments'];
        for (var i = 0; i < keys.length; i++) if (typeof next[keys[i]] !== 'string' || !next[keys[i]]) return;
        ATTACHMENT_PROMPTS = next;
        // The resume and retract prompts ride on the same payload.
        if (typeof next.resume === 'string' && next.resume) RESUME_PROMPT = next.resume;
        if (typeof next.retract === 'string' && next.retract) RETRACT_TEMPLATE = next.retract;
    }

    var promptedForAttachments = false;

    function attachmentChips() {
        var box = document.querySelector('[class*="attachedFilesContainer_"]');
        // Every chip carries its own remove button; counting those is steadier than counting children,
        // which would also pick up whatever wrapper the app decides to add around them.
        return box ? Array.prototype.slice.call(box.querySelectorAll('button[title="Remove attachment"]')) : [];
    }

    // A chip renders the thumbnail as an <img> only when the file is an image; a document gets an icon
    // component instead. That is the difference the wording needs.
    function attachmentNoun(chips) {
        var box = document.querySelector('[class*="attachedFilesContainer_"]');
        var images = box ? box.querySelectorAll('img[class*="thumbIcon_"]').length : 0;
        if (images === chips.length) return chips.length > 1 ? 'images' : 'image';
        return chips.length > 1 ? 'attachments' : 'attachment';
    }

    function syncAttachmentPrompt() {
        try {
            var chips = attachmentChips();
            if (!chips.length) {
                // Reset only when the last attachment is gone, so clearing the draft by hand does not
                // immediately get it written back — that would be the feature fighting the user.
                promptedForAttachments = false;
                return;
            }
            if (promptedForAttachments) return;

            var el = composerReady();
            if (!el || el.textContent.trim()) return;

            promptedForAttachments = true;
            insertIntoComposer(el, ATTACHMENT_PROMPTS[attachmentNoun(chips)], false);
        } catch (err) {
            console.warn('ccx: attachment prompt failed', err);
        }
    }

    // --- Resume after terminal state --------------------------------------------------------------
    //
    // When the model hits an error, a hard usage limit, or the user interrupts, the conversation stops
    // and the only way forward is to type "continue" by hand. This injects that prompt automatically
    // when the composer is empty and one of those halt states is visible.
    //
    // Four states, distinguished by their markup:
    //   - Error banner:      [class*="banner_"][data-color="error"]
    //   - Interrupt message: [class*="interruptedMessage_"]
    //   - Usage limit hit:   a [data-color="warning"] banner whose text begins "You've hit your"
    //   - Request failure:   the newest assistant turn whose text begins "API Error:"
    //
    // The prompt is injected once per terminal state. It resets when the state clears (the user sends
    // a message and the banner disappears), so the next terminal gets a fresh prompt.

    var RESUME_PROMPT = 'Continue from where you stopped';
    var promptedForResume = false;
    var lastResumeState = null;

    // An interrupt marker is transcript history: it stays in the DOM long after the conversation has
    // moved on, so its presence alone does not mean anything is halted NOW. It is a live halt only
    // while nothing renders after it — the moment an answer or a newer message follows, that
    // interrupt is a past event being displayed, not a state to resume.
    function interruptIsCurrent() {
        var halts = document.querySelectorAll('[class*="interruptedMessage_"]');
        if (!halts.length) return false;
        var halt = halts[halts.length - 1];
        if (halt.offsetParent === null) return false;
        var messages = document.querySelectorAll(
            '[data-testid="assistant-message"], [class*="userMessageContainer_"]',
        );
        if (!messages.length) return true;
        // querySelectorAll returns document order, so the last entry is the newest message. The halt
        // marker renders inside its own user-message container, so "inside the newest message" and
        // "nothing follows it" both mean the same thing: the halt is the end of the transcript.
        var last = messages[messages.length - 1];
        return last.contains(halt) || !(halt.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING);
    }

    // Check for the halt states worth resuming: a real error (a 429 rate limit is an error, so it
    // lands here too), a trailing user interrupt, a hard usage limit, and a request-level failure.
    // The usage limit shares the warning-banner colour with the soft "approaching a limit" notice, so
    // it is told apart by wording (see hitLimitNotice), not by colour — "Approaching …" and "You've
    // used N% of …" mean the run is still healthy and must not fill the composer.
    function detectTerminalState() {
        var errorBanner = document.querySelector('[class*="banner_"][data-color="error"]');
        if (errorBanner && errorBanner.offsetParent !== null) return 'error';
        if (interruptIsCurrent()) return 'interrupt';
        if (hitLimitNotice()) return 'limit';
        if (failedTurnIsCurrent()) return 'failed';
        return null;
    }

    // "You've hit your <limit> · resets …" is a hard block — the request was rejected and nothing can
    // be sent until the reset time. It renders as a warning banner, the same colour as the soft
    // "approaching a limit" notice, so wording is the only honest discriminator. The string is
    // hardcoded English in the bundle (not localised), which keeps the text match stable across
    // /config languages.
    function hitLimitNotice() {
        var banners = document.querySelectorAll('[class*="banner_"][data-color="warning"]');
        for (var i = 0; i < banners.length; i++) {
            var banner = banners[i];
            if (banner.offsetParent === null) continue;
            if (/You've hit your\b/i.test(banner.textContent || '')) return true;
        }
        return false;
    }

    // A request-level failure ("API Error: Request rejected (429) …") lands in the transcript as an
    // ordinary assistant turn whose text is the error, not as a banner — the error-banner selector
    // above never sees it. The prefix is the CLI's own hardcoded English, so the match is stable.
    // Only the newest turn counts: once a later message follows, the failure is a past event, not a
    // state to resume.
    function failedTurnIsCurrent() {
        var s = activeSession();
        var msgs = s && s.messages && s.messages.value;
        if (!Array.isArray(msgs) || !msgs.length) return false;
        var last = msgs[msgs.length - 1];
        if (!last || last.type !== 'assistant') return false;
        return /^API Error:/.test(messageText(last));
    }

    // The send button swaps its icon between send and stop: stopIcon_ only renders while the model is
    // generating. That is the difference between "the user just sent the prompt and the answer is on
    // its way" and "the run actually halted and is waiting" — the interrupt message stays in the
    // transcript either way, so it cannot tell them apart on its own.
    function modelBusy() {
        var stop = document.querySelector('[class*="stopIcon_"]');
        return Boolean(stop && stop.offsetParent !== null);
    }

    function syncResumePrompt() {
        try {
            var state = detectTerminalState();
            // While the model is generating there is nothing to resume — the run is in progress, not
            // halted. This also clears the flag from the last halt, so the next halt gets a prompt.
            if (!state || modelBusy()) {
                promptedForResume = false;
                lastResumeState = null;
                return;
            }

            // Idle and halted. Don't re-inject for the same halt, but do inject if the state changed
            // (e.g., the error cleared, then the user interrupted).
            if (promptedForResume && lastResumeState === state) return;

            var el = composerReady();
            if (!el || el.textContent.trim()) return;

            insertIntoComposer(el, RESUME_PROMPT, false);
            promptedForResume = true;
            lastResumeState = state;
        } catch (err) {
            console.warn('ccx: resume prompt failed', err);
        }
    }

    function closeMenu() {
        if (menu) menu.remove();
        menu = null;
        window.removeEventListener('keydown', onMenuKey, true);
        window.removeEventListener('scroll', closeMenu, true);
        window.removeEventListener('blur', closeMenu, true);
        document.removeEventListener('mousedown', onMenuOutside, true);
    }

    function onMenuKey(e) {
        if (e.key === 'Escape') closeMenu();
    }

    function onMenuOutside(e) {
        if (menu && !menu.contains(e.target)) closeMenu();
    }

    function menuItem(label, run) {
        var row = document.createElement('div');
        row.className = 'ccx-menu-item';
        row.textContent = label;
        row.onclick = function () {
            closeMenu();
            run();
        };
        return row;
    }

    function menuSeparator() {
        var row = document.createElement('div');
        row.className = 'ccx-menu-sep';
        return row;
    }

    function openMenu(x, y, items) {
        closeMenu();
        menu = document.createElement('div');
        menu.className = 'ccx-menu';
        // Without this the mousedown collapses the selection before the click handler reads it, and
        // the highlight disappears from under the menu while it is open.
        menu.onmousedown = function (e) { e.preventDefault(); };
        items.forEach(function (item) { menu.appendChild(item); });

        // Measure before showing, or the box paints once at the origin on its way to the cursor.
        menu.style.visibility = 'hidden';
        document.body.appendChild(menu);
        var w = menu.offsetWidth;
        var h = menu.offsetHeight;
        menu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
        menu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
        menu.style.visibility = '';

        window.addEventListener('keydown', onMenuKey, true);
        window.addEventListener('scroll', closeMenu, true);
        window.addEventListener('blur', closeMenu, true);
        document.addEventListener('mousedown', onMenuOutside, true);
    }

    // --- Retract the last message -------------------------------------------------------------
    //
    // The stock "Rewind to…" picker restores a file checkpoint, forks the conversation and puts the
    // text back in the composer — a fork, which is exactly what this replaces. Retracting keeps the
    // session: the erroneous message and the assistant's answer to it are hidden from the transcript,
    // and the agent is told — under the hood, in a user turn that is hidden the moment it renders —
    // that the message was a mistake and should be ignored. The turn stays in the .jsonl, so the agent
    // keeps the context; only the view drops it. The hidden uuids are persisted per session on the
    // host, so a resume re-hides them and content search skips them.
    var RETRACT_TEMPLATE = 'The message «%s» was a mistake — ignore it and your response to it.';
    var RETRACT_QUOTE_LEN = 200;
    var hiddenUuids = new Set();
    var hiddenSession = null;
    // The retract accounts for two more turns than the one being retracted: the hidden "ignore it"
    // instruction, and the assistant's answer to it (which would otherwise dangle as an orphan reply
    // to nothing). The instruction's uuid is only knowable once send() has appended the turn, so these
    // fields track the search until both turns are found and hidden.
    var pendingRetractBefore = null;      // messages.value index where the instruction turn should land
    var pendingRetractText = null;        // the instruction text, a backstop if the index shifts
    var pendingRetractIdx = -1;           // the instruction turn's index, once found
    var pendingRetractResponse = false;   // true while the instruction's answer is still to hide

    function messageText(m) {
        if (!m || !Array.isArray(m.content)) return '';
        var parts = [];
        for (var i = 0; i < m.content.length; i++) {
            var b = m.content[i];
            // A message's content is an array of the app's block wrappers (class Bp), not the raw
            // blocks — the raw block sits one level down at block.content ({type:"text", text}). The
            // string branch guards the app's older string-content shape (its LX constructor).
            var block = b && b.content;
            if (typeof block === 'string') { parts.push(block); continue; }
            if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        }
        return parts.join('\n');
    }

    // The last message the user actually sent — the one "taking back the last message" refers to.
    // isSynthetic marks the app's own injected turns, which are not the user's to retract.
    function lastUserMessage() {
        var s = activeSession();
        if (!s) return null;
        var msgs = s.messages && s.messages.value;
        if (!Array.isArray(msgs)) return null;
        for (var i = msgs.length - 1; i >= 0; i--) {
            var m = msgs[i];
            // A retracted turn is already accounted for — the previous message is the one the user
            // gets to take back next.
            if (m && m.type === 'user' && !m.isSynthetic && !isInterruptTurn(m) && !(m.uuid && hiddenUuids.has(m.uuid)))
                return { index: i, uuid: m.uuid, text: messageText(m) };
        }
        return null;
    }

    // An interruption is not a user message: when the user stops a turn (or the retract interrupts it),
    // the CLI records it as an ordinary type:"user" turn whose text is one of these markers — with no
    // isSynthetic flag at all, so the isSynthetic check above does not catch it. "Taking back the last
    // message" must reach past the interruption to the message the user actually sent.
    function isInterruptTurn(m) {
        if (!m || m.type !== 'user') return false;
        var t = messageText(m);
        return t === '[Request interrupted by user]' || t === '[Request interrupted by user for tool use]';
    }

    // A busy session is retractable too — retractLastMessage interrupts the running turn first — so
    // the only thing that makes the gesture inert is a session with nothing to take back.
    function canRetract() {
        var s = activeSession();
        if (!s) return false;
        return lastUserMessage() !== null;
    }

    function persistHidden(uuids) {
        if (!uuids || !uuids.length) return;
        send({ type: 'ccx:hideMessages', sessionId: state.sessionId, uuids: uuids });
    }

    function hideNow(uuids) {
        var fresh = [];
        for (var i = 0; i < uuids.length; i++) {
            if (typeof uuids[i] === 'string' && !hiddenUuids.has(uuids[i])) {
                hiddenUuids.add(uuids[i]);
                fresh.push(uuids[i]);
            }
        }
        if (fresh.length) persistHidden(fresh);
        applyHidden();
    }

    // Pull the erroneous message back into the composer for editing — this is the "edit the last
    // message" half of the gesture. Writing textContent directly replaces whatever draft was already
    // there (retract means "rewrite that message", not "append to what I was typing"), and matches the
    // app's own setInputText (`st`): it assigns ne.current.textContent = ae and syncs the draft signal.
    // execCommand must NOT be used here: insertText on a contenteditable="plaintext-only" box only
    // lands when a live, collapsed selection is in place, and the select-all + delete that would clear
    // the old draft leaves that selection invalid — insertText then reports success while the DOM stays
    // empty, so the field reads blank. A direct textContent write always lands; the synthetic input
    // below makes the app's onInput (`os`) read it back and sync the draft signal, so the app's
    // "clear the composer when the draft is empty" effect (`if(ne.current&&v==="")…`) does not wipe it.
    function replaceComposerText(text) {
        var el = composerReady();
        if (!el) return false;
        el.focus();
        el.textContent = text;
        var range = document.createRange();
        var sel = window.getSelection();
        if (sel) {
            range.selectNodeContents(el);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        }
        if (typeof el.dispatchEvent === 'function') {
            var evt;
            try {
                evt = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text });
            } catch (err) {
                evt = null;
            }
            if (!evt) {
                try { evt = new Event('input', { bubbles: true }); } catch (err2) { evt = null; }
            }
            if (evt) el.dispatchEvent(evt);
        }
        return true;
    }

    // The retract proper, run once the session is idle. Busy turns take a different route (they are
    // interrupted first), so this entry point assumes nothing about the agent's state.
    function doRetract(s) {
        var last = lastUserMessage();
        if (!last) return toast('Nothing to retract.');

        // Everything from the erroneous message to the end of the list is the failed exchange: the
        // message itself and whatever the agent answered to it.
        var msgs = s.messages.value;
        var toHide = [];
        for (var i = last.index; i < msgs.length; i++) {
            var m = msgs[i];
            if (m && typeof m.uuid === 'string') toHide.push(m.uuid);
        }
        var quote = (last.text || '').replace(/\s+/g, ' ').trim();
        if (quote.length > RETRACT_QUOTE_LEN) quote = quote.slice(0, RETRACT_QUOTE_LEN) + '…';
        var instruction = RETRACT_TEMPLATE.replace('%s', quote || '…');

        hideNow(toHide);
        // Put the message back in the composer so it can be corrected and re-sent; the instruction
        // below is what tells the agent to ignore the old copy it still holds in context.
        if (last.text && !replaceComposerText(last.text))
            toast('Retracted — paste the message text into the composer to resend.');

        // The instruction's own uuid is only knowable once send() has appended the turn. applyHidden
        // resolves it the moment the turn lands — here, when the send settles, and again from the DOM
        // observer — and then hides the instruction's answer the moment it appears. The pending state
        // is cleared by applyHidden, not by the send resolving, so the turn can never outlive its own
        // hiding.
        pendingRetractBefore = msgs.length;
        pendingRetractText = instruction;

        var sent;
        try {
            sent = s.send(instruction);
        } catch (err) {
            pendingRetractBefore = null;
            pendingRetractText = null;
            toast('Could not retract the message.');
            return;
        }
        if (sent && typeof sent.then === 'function') {
            sent.then(
                function () { applyHidden(); },
                function () {
                    pendingRetractBefore = null;
                    pendingRetractText = null;
                    toast('Could not retract the message.');
                },
            );
            // If the turn never materialises (a send that settles in an unusual way), let the pending
            // state expire rather than hide an unrelated later message.
            window.setTimeout(function () {
                if (pendingRetractBefore !== null) {
                    pendingRetractBefore = null;
                    pendingRetractText = null;
                }
            }, 30000);
        }
    }

    function retractLastMessage() {
        var s = activeSession();
        if (!s) return toast('No active session.');
        if (!(s.busy && s.busy.value)) { doRetract(s); return; }

        // A turn is streaming. Retracting mid-stream is unsafe, but not because anything would break
        // here — the failure is downstream: the instruction would be appended while the old response
        // is still finalising, so the "first assistant message after the instruction" scan would find
        // that old response instead of the instruction's own answer, and the instruction's answer
        // could not be hidden. So the running turn is interrupted first (the same session.interrupt
        // the stop button and Escape use), then the retract waits for the partial response to settle
        // into messages.value before proceeding. busy clears when the CLI's result arrives, so polling
        // it is the ground truth; the timer bounds the wait in case the CLI never answers.
        if (typeof s.interrupt !== 'function') { toast('Wait for the current response before retracting.'); return; }
        try { s.interrupt(); } catch (err) { toast('Wait for the current response before retracting.'); return; }
        toast('Stopping the current response…');
        var waited = 0;
        (function poll() {
            if (s.busy && s.busy.value === false) { doRetract(s); return; }
            waited += 150;
            if (waited >= 10000) {
                toast('Could not stop the current response in time — retract again once it finishes.');
                return;
            }
            window.setTimeout(poll, 150);
        })();
    }

    // Three jobs, called from the DOM observer and from ccx:state. First it accounts for the retract's
    // own turns — the hidden "ignore it" instruction, then the assistant's answer to it — by finding
    // their uuids in messages.value the moment they appear; then it hides every message whose uuid is
    // in the set. Hiding rides on a data attribute rather than inline style — an assistant bubble
    // keeps re-rendering while a turn streams, and React leaves an attribute it does not own alone.
    function applyHidden() {
        var s = activeSession();
        var msgs = s && s.messages && s.messages.value;
        if (pendingRetractBefore !== null && Array.isArray(msgs)) {
            for (var fi = pendingRetractBefore; fi < msgs.length; fi++) {
                var m = msgs[fi];
                if (!m || m.type !== 'user' || typeof m.uuid !== 'string') continue;
                // The turn lands exactly where the retract left off; the text check is a backstop for
                // any array reshuffling between the capture and the append.
                if (fi !== pendingRetractBefore && messageText(m) !== pendingRetractText) continue;
                pendingRetractIdx = fi;
                pendingRetractBefore = null;
                pendingRetractText = null;
                pendingRetractResponse = true;
                if (!hiddenUuids.has(m.uuid)) {
                    hiddenUuids.add(m.uuid);
                    persistHidden([m.uuid]);
                }
                break;
            }
        }
        if (pendingRetractResponse && Array.isArray(msgs)) {
            for (var ai = pendingRetractIdx + 1; ai < msgs.length; ai++) {
                var a = msgs[ai];
                if (!a || typeof a.uuid !== 'string') continue;
                if (a.type === 'assistant') {
                    pendingRetractResponse = false;
                    if (!hiddenUuids.has(a.uuid)) {
                        hiddenUuids.add(a.uuid);
                        persistHidden([a.uuid]);
                    }
                    break;
                }
            }
        }
        try {
            var nodes = document.querySelectorAll('[data-testid="assistant-message"], [class*="userMessageContainer_"]');
            var seen = [];
            for (var i = 0; i < nodes.length; i++) {
                var node = nodes[i];
                var msg = messagePropOf(node);
                if (!msg) continue;
                // Some bubbles render a second matching container inside themselves, and both fibers
                // lead to the same message. Document order puts an ancestor before its descendant, so
                // keeping only the outermost node of each message hides the whole bubble once.
                var nested = false;
                for (var j = 0; j < seen.length; j++)
                    if (seen[j].contains(node)) { nested = true; break; }
                if (nested) continue;
                seen.push(node);
                if (msg.uuid && hiddenUuids.has(msg.uuid)) node.setAttribute('data-ccx-hidden', '');
                else node.removeAttribute('data-ccx-hidden');
            }
        } catch (e) {
            /* a message that cannot be hidden is one that stays visible */
        }
    }

    // Ctrl+Shift+Z. In a contenteditable that is redo, so the composer gives redo up for this — undo
    // is untouched, and what redo would restore there is a line of prose. It is a trade, not a free
    // key, which is also why the event is only swallowed when there is actually a message to retract.
    function onRetractKey(e) {
        if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
        if ((e.key || '').toLowerCase() !== 'z') return;
        if (!canRetract()) return;
        e.preventDefault();
        e.stopPropagation();
        retractLastMessage();
    }

    function rangeHasPoint(range, x, y) {
        var rects = range.getClientRects();
        for (var i = 0; i < rects.length; i++) {
            var r = rects[i];
            if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return true;
        }
        return false;
    }

    // A right-click outside a selection collapses it before the contextmenu event, so the live
    // selection alone cannot answer "did they click inside their selection". The snapshot is taken on
    // the mousedown that precedes it — and is only trusted when the click actually landed on it,
    // otherwise a click elsewhere would quote text the user had left behind.
    function usableSelection(e) {
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) return sel;
        if (selectionSnapshot && rangeHasPoint(selectionSnapshot, e.clientX, e.clientY)) {
            var restored = window.getSelection();
            restored.removeAllRanges();
            restored.addRange(selectionSnapshot);
            return restored;
        }
        return null;
    }

    function onContextMenu(e) {
        try {
            // Positive gate on the transcript container. Matching the CSS-module prefix is the same
            // approach the session-list icons use; it fails closed — a renamed module means the item
            // stops appearing, never that the app's own menus break.
            if (!e.target.closest || !e.target.closest('[class*="messagesContainer_"]')) return;
            // The app has its own menu on markdown links; leave that one to it.
            if (e.target.closest('a[href]')) return;

            var sel = usableSelection(e);
            var text = sel ? quoteText(sel) : '';
            var items = [];

            if (text) {
                var quote = menuItem('Quote selection', function () {
                    var el = composerReady();
                    if (!el) return toast('The composer is not available right now.');
                    if (!insertIntoComposer(el, text)) toast('Could not insert the quote.');
                });
                if (!composerReady()) quote.classList.add('ccx-menu-disabled');
                items.push(quote);
                // preventDefault took the stock Copy away with the rest of the menu, so it comes back
                // here. The webview iframe is granted clipboard-write, so this is the whole story.
                items.push(
                    menuItem('Copy', function () {
                        navigator.clipboard.writeText(sel.toString()).catch(function () {
                            toast('Could not copy the selection.');
                        });
                    }),
                );
            }

            // Reached with no selection too, which is the point: over a transcript the stock menu is
            // three inert entries, so replacing it costs nothing there. The composer is outside
            // messagesContainer_ and keeps its own menu, which is the one where Paste matters.
            if (activeSession()) {
                if (items.length) items.push(menuSeparator());
                items.push(menuItem('Retract last message', retractLastMessage));
            }
            if (!items.length) return;

            e.preventDefault();
            e.stopPropagation();
            openMenu(e.clientX, e.clientY, items);
        } catch (err) {
            console.warn('ccx: context menu failed', err);
        }
    }

    function watchSelection() {
        document.addEventListener(
            'mousedown',
            function (e) {
                if (e.button !== 2) {
                    selectionSnapshot = null;
                    return;
                }
                var sel = window.getSelection();
                selectionSnapshot =
                    sel && !sel.isCollapsed && sel.toString().trim() ? sel.getRangeAt(0).cloneRange() : null;
            },
            true,
        );
        // Capture phase: React binds its delegated listeners on #root, so this runs first, and
        // stopPropagation() here also keeps VS Code's own window-level handler from seeing the event.
        document.addEventListener('contextmenu', onContextMenu, true);
        // Same reason for the capture phase, and it has to be the window: the composer stops some keys
        // at its own handler, and the composer is exactly where you are when you want this.
        window.addEventListener('keydown', onRetractKey, true);
    }

    function restartChannel(name) {
        var launch = launchByChannel[activeChannelId];
        var conn = ctx && ctx.comms && ctx.comms.connection && ctx.comms.connection.value;
        if (!activeChannelId || !conn || typeof conn.launchClaude !== 'function') {
            toast('Provider "' + name + '" will apply on the next session launch.');
            return;
        }
        if (pendingRestart) return;

        // What is resumed has to be a session the CLI has actually written: the id it announced on
        // this channel (system/init) or the one this channel was launched to resume. state.sessionId
        // is deliberately not a fallback — on a tab that has not sent anything yet the page already
        // holds a provisional id, and resuming that gives "No conversation found with session ID".
        // A tab with nothing said in it has nothing to lose: it restarts fresh, and the first
        // system/init binds the real session to the profile.
        var resume = sessionByChannel[activeChannelId] || (launch && launch.resume) || undefined;

        // A tab with history is offered a compaction first. The prompt cache never survives a provider
        // change anyway — the next backend has never seen this prefix — so the first turn pays for the
        // whole transcript either way; sending the compact summary instead of the raw history is the
        // one lever that makes that first turn cheaper, and it also keeps a longer conversation inside
        // a smaller window on the other side. It is a question, not a default: compaction discards
        // detail the user may be about to rely on.
        if (resume && canCompact()) return offerCompaction(name, resume);
        performRestart(name, resume);
    }

    // --- Compact before switching -------------------------------------------------------------
    //
    // The compaction is the stock one: the page's own send() with "/compact", the same thing the
    // command menu does. The CLI answers with a system/compact_boundary on the io_message stream we
    // already listen to; that is the moment the summary is written and the restart can go ahead. If
    // it never arrives — the model is stuck, or the turn errors — the switch is not held hostage:
    // after COMPACT_WAIT_MS it restarts uncompacted and says so.
    var COMPACT_WAIT_MS = 90000;
    var pendingCompact = null;

    function activeSession() {
        // The context object (class `t_e`) has no route to the session at all — the session is class
        // `MX`, and reading an `activeSession` field off the context was the bug: always undefined, so
        // canCompact() said no and the offer never appeared. It arrives through injection point #4.
        var s = sessionObj;
        return s && typeof s.send === 'function' ? s : null;
    }

    // "Switch model… → <model>" in the command menu is the stock indicator of lastServedModel, which the
    // page fills from the model on the last assistant turn — and it fills it while REPLAYING history
    // for a resume (loadFromMessages → processMessage per item), before the CLI has said a word. So
    // after a provider switch it names the model the old provider answered with, until the new one
    // answers. The stock reset lives in system/init and fires only when the session id changes, which
    // a --resume never does. Cleared here instead, on every restart of a switch, so the menu shows the
    // selection rather than a ghost from the transcript.
    function forgetServedModel() {
        try {
            var s = activeSession();
            if (s && s.lastServedModel && 'value' in s.lastServedModel) s.lastServedModel.value = undefined;
        } catch (err) {
            /* an indicator we could not reset is a stale label, not a broken switch */
        }
    }

    function canCompact() {
        var s = activeSession();
        if (!s) return false;
        // Nothing to compact on a transcript with no assistant turn yet, and no point asking while a
        // turn is already running — the compaction would queue behind it.
        var msgs = s.messages && s.messages.value;
        var hasAssistant = Array.isArray(msgs) && msgs.some(function (m) { return m && m.type === 'assistant'; });
        var busy = s.busy && s.busy.value;
        return hasAssistant && !busy;
    }

    function offerCompaction(name, resume) {
        var bar = document.createElement('div');
        bar.className = 'ccx-toast';
        var text = document.createElement('span');
        text.textContent = 'Switching to "' + name + '". Compact the conversation first?';
        var yes = document.createElement('button');
        yes.className = 'ccx-toast-btn';
        yes.textContent = 'Compact & switch';
        var no = document.createElement('button');
        no.className = 'ccx-toast-btn ccx-toast-btn-quiet';
        no.textContent = 'Switch as is';
        bar.append(text, yes, no);
        document.body.appendChild(bar);
        var done = false;
        var settle = function (compact) {
            if (done) return;
            done = true;
            bar.remove();
            if (compact) compactThenRestart(name, resume);
            else performRestart(name, resume);
        };
        yes.onclick = function () { settle(true); };
        no.onclick = function () { settle(false); };
        // Left unanswered, the switch still happens — the profile was already applied on the host, and
        // a toast that quietly outlives the decision would leave the tab claiming one provider while
        // running another.
        setTimeout(function () { settle(false); }, 20000);
    }

    function compactThenRestart(name, resume) {
        var s = activeSession();
        if (!s) return performRestart(name, resume);
        toast('Compacting before switching to "' + name + '"…');
        var job = { name: name, resume: resume, channelId: activeChannelId };
        job.timer = setTimeout(function () {
            if (pendingCompact !== job) return;
            pendingCompact = null;
            toast('Compaction did not finish — switching to "' + name + '" as is.');
            performRestart(name, resume);
        }, COMPACT_WAIT_MS);
        pendingCompact = job;
        try {
            var r = s.send('/compact');
            if (r && typeof r.catch === 'function') r.catch(function () { onCompactFailed(job); });
        } catch (err) {
            onCompactFailed(job);
        }
    }

    function onCompactFailed(job) {
        if (pendingCompact !== job) return;
        pendingCompact = null;
        clearTimeout(job.timer);
        toast('Could not compact — switching to "' + job.name + '" as is.');
        performRestart(job.name, job.resume);
    }

    // Called from the io_message listener the moment the CLI reports the boundary
    function onCompactBoundary(channelId) {
        var job = pendingCompact;
        if (!job || job.channelId !== channelId) return;
        pendingCompact = null;
        clearTimeout(job.timer);
        // The boundary is reported before the turn is fully wound down; a short beat lets the summary
        // land in the transcript before the channel is closed on top of it.
        setTimeout(function () { performRestart(job.name, job.resume); }, 400);
    }

    function performRestart(name, resume) {
        var launch = launchByChannel[activeChannelId];
        var conn = ctx && ctx.comms && ctx.comms.connection && ctx.comms.connection.value;
        if (!activeChannelId || !conn || typeof conn.launchClaude !== 'function') {
            toast('Provider "' + name + '" will apply on the next session launch.');
            return;
        }
        if (pendingRestart) return;
        forgetServedModel();
        toast('Switching to "' + name + '" — ' + (resume ? 'restarting session…' : 'starting fresh…'));
        var job = {
            channelId: activeChannelId,
            conn: conn,
            resume: resume,
            cwd: launch && launch.cwd,
            permissionMode: launch && launch.permissionMode,
            thinkingLevel: launch && launch.thinkingLevel,
        };
        job.timer = setTimeout(function () {
            if (pendingRestart === job) {
                pendingRestart = null;
                doLaunch(job);
            }
        }, 6000);
        pendingRestart = job;
        send({ type: 'close_channel', channelId: job.channelId });
    }

    function doLaunch(job) {
        try {
            job.conn.launchClaude(job.channelId, job.resume, job.cwd, job.permissionMode, job.thinkingLevel);
        } catch (err) {
            console.error('ccx: relaunch failed', err);
            toast('Could not restart the session — start a new conversation.');
        }
    }

    // --- Search sessions by content ------------------------------------------------------------
    //
    // The stock search box matches only a row's title and git branch, both already sitting in the
    // page. Matching the conversation itself needs the transcript, which the page does not hold for
    // rows outside the active tab — so title/branch matching stays instant and client-side, and a
    // query additionally goes to the host, which greps each visible session's file on disk and
    // reports back which ones actually contain it. The session list patch (injection point #4) hands
    // over the candidate ids and a setter for the result; this only debounces the request and the
    // response, so a fast typist does not fire one lookup per keystroke.
    //
    // Every call clears the previous result immediately, before scheduling anything: without that, a
    // stale Set from the last query would keep matching sessions under the new one for as long as the
    // debounce takes to resolve.
    function onSearchState(setter) {
        searchSetter = setter;
    }

    function onSearchQuery(query, sessionIds) {
        clearTimeout(searchDebounceTimer);
        var mySeq = ++searchSeq;
        if (searchSetter) searchSetter(null);
        var q = (query || '').trim();
        if (!q) return;
        searchDebounceTimer = setTimeout(function () {
            send({ type: 'ccx:searchContent', query: q, sessionIds: sessionIds || [], seq: mySeq });
        }, 250);
    }

    window.__ccx = {
        onRegistry: function (host, jsxFactory, session) {
            // The session is refreshed even when the rest is already wired: this hook fires on every
            // re-registration, and only the first one gets past the guard below.
            if (session) sessionObj = session;
            if (registry || !host || !host.commandRegistry) return;
            ctx = host;
            registry = host.commandRegistry;
            jsx = jsxFactory;
            syncAction();
            syncChip();
        },
        onSearchState: onSearchState,
        onSearchQuery: onSearchQuery,
        onPinState: onPinState,
        pinSort: pinSort,
        archivedFilter: archivedFilter,
        retract: retractLastMessage,
        keepEveryMessage: keepEveryMessage,
        beforeCompaction: beforeCompaction,
        callTime: callTime,
    };

    // styles
    var s = document.createElement('style');
    s.textContent = [
        '.ccx-chip{position:fixed;right:10px;bottom:8px;z-index:9999;font:11px var(--vscode-font-family);padding:2px 8px;border-radius:10px;cursor:pointer;color:var(--vscode-foreground);background:var(--vscode-badge-background);border:1px solid var(--vscode-widget-border, transparent)}',
        '.ccx-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35)}',
        '.ccx-box{min-width:280px;max-width:80vw;max-height:70vh;overflow:auto;padding:6px;border-radius:6px;font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border, var(--vscode-focusBorder));box-shadow:0 4px 16px rgba(0,0,0,.4)}',
        '.ccx-title{padding:6px 10px;opacity:.7;font-size:11px;text-transform:uppercase}',
        '.ccx-hint{padding:0 10px 6px;opacity:.55;font-size:11px}',
        '.ccx-row{display:flex;gap:8px;align-items:baseline;padding:6px 10px;border-radius:4px;cursor:pointer}',
        '.ccx-row:hover{background:var(--vscode-list-hoverBackground)}',
        '.ccx-mark{opacity:.7;width:1em}',
        '.ccx-model{margin-left:auto;opacity:.6;font-size:11px}',
        '.ccx-star{margin-left:8px;opacity:.55;cursor:pointer}',
        '.ccx-star:hover{opacity:1}',
        '.ccx-prov-tag{opacity:.7;font-size:11px;padding:1px 6px;border-radius:8px;color:var(--vscode-badge-foreground, var(--vscode-foreground));background:var(--vscode-badge-background);border:none}',
        '.ccx-side-link{margin-left:auto;align-self:center;cursor:pointer;font-family:var(--vscode-font-family)}',
        '.ccx-side-link:hover{opacity:1}',
        '.ccx-model-tag{margin-left:6px;opacity:.55;font-size:10px;font-family:var(--vscode-editor-font-family, monospace)}',
        // The provider rows sit inside a React-owned panel, so every colour here is a VS Code theme
        // variable with a literal fallback: the section has to read as part of the panel in whatever
        // theme is loaded, and no stock class is borrowed except the two copied off the panel itself.
        '.ccx-prov-tally{float:right;font-size:10px;font-weight:400;letter-spacing:0;text-transform:none;opacity:.55}',
        '.ccx-health-box{min-width:340px;padding-bottom:8px}',
        // The pill itself borrows the stock model-pill classes, so only its pointer is ours; the
        // dialog below it follows the picker's own box.
        '.ccx-resource-pill{cursor:pointer}',
        '.ccx-resources-box{min-width:420px;max-width:min(760px,80vw)}',
        '.ccx-res-tally{float:right;font-size:10px;font-weight:400;letter-spacing:0;text-transform:none;opacity:.55}',
        '.ccx-res-head{display:flex;align-items:center;gap:5px;padding:8px 10px 2px;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;opacity:.5;cursor:pointer;user-select:none}',
        '.ccx-res-head:hover{opacity:.85}',
        '.ccx-res-caret{flex:0 0 auto;width:8px;transition:transform .12s ease}',
        // Both the section and the fold inside it are a wrapper with a head and a body, so the two rules
        // are written against that shape rather than against one of the two class names.
        '[data-ccx-open="1"] > .ccx-res-head .ccx-res-caret{transform:rotate(90deg)}',
        '[data-ccx-open="0"] > .ccx-res-body{display:none}',
        '.ccx-res-subhead{opacity:.4;font-size:10px;letter-spacing:0}',
        '.ccx-res-sub > .ccx-res-body{padding-left:8px}',
        '.ccx-res-head-count{margin-left:6px;opacity:.8}',
        // One row per resource, so the value is what the eye follows: monospace, ellipsised from the
        // right for a path and from the left is not possible in CSS — a long URL therefore gives up
        // its tail, which is why the full value is in the tooltip.
        '.ccx-res-row{align-items:center}',
        '.ccx-res-open{cursor:pointer}',
        '.ccx-res-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family, monospace);font-size:11.5px}',
        '.ccx-res-dir{opacity:.45}',
        // The chip's own thumbnail is 12px, which is the right size in a one-line chip and too small to
        // recognise a picture by in a dialog row. Two classes here, so this beats the stock rule
        // whatever order the two stylesheets end up in; the radius and the cover fit stay the chip's.
        '.ccx-res-row .ccx-res-thumb{width:28px;height:28px}',
        '.ccx-res-dims{flex:0 0 auto;opacity:.45;font-size:10.5px;font-variant-numeric:tabular-nums}',
        '.ccx-res-time{flex:0 0 auto;opacity:.45;font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap}',
        '.ccx-res-you{flex:0 0 auto;padding:0 4px;border-radius:6px;font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;opacity:.8;color:var(--vscode-badge-foreground, var(--vscode-foreground));background:var(--vscode-badge-background)}',
        // Made versus seen. The two are told apart by brightness rather than by hue, because which
        // commits a session wrote is a fact about it, not a warning.
        '.ccx-res-own{flex:0 0 auto;padding:0 4px;border-radius:6px;font-size:9.5px;letter-spacing:.04em;text-transform:uppercase}',
        '.ccx-res-own-made{opacity:.85;color:var(--vscode-charts-green, #3fb950);border:1px solid currentColor}',
        '.ccx-res-own-seen{opacity:.4;border:1px dashed currentColor}',
        '.ccx-res-jump{flex:0 0 auto;padding:0 4px;border-radius:3px;font-size:11px;opacity:.45;cursor:pointer}',
        '.ccx-res-jump:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2))}',
        // What the jump found, for as long as it takes to look: the app's own find-match colour, fading
        // out on its own so nothing has to be undone and no node keeps a mark of ours.
        '[data-ccx-flash]{animation:ccx-res-flash 1.6s ease-out}',
        '@keyframes ccx-res-flash{0%{background-color:var(--vscode-editor-findMatchHighlightBackground, rgba(255,204,0,.33))}100%{background-color:transparent}}',
        '.ccx-res-count{flex:0 0 auto;opacity:.45;font-size:10.5px;font-variant-numeric:tabular-nums}',
        '.ccx-res-more{padding:2px 10px 6px;opacity:.45;font-size:10.5px}',
        '.ccx-res-empty{padding:10px;opacity:.55;font-size:12px}',
        // The sidebar section borrows the stock header markup, so only the fold and the body are new.
        '.ccx-side-section[data-ccx-open="0"] .ccx-side-body{display:none}',
        '.ccx-side-chev{display:flex;align-items:center;transition:transform .12s ease}',
        '.ccx-side-section[data-ccx-open="1"] .ccx-side-chev{transform:rotate(90deg)}',
        '.ccx-side-body{padding:0 6px 6px}',
        // The rows sit on the sidebar surface here, so the badge ring has to be that colour instead.
        '.ccx-side-section .ccx-prov-icon::after{box-shadow:0 0 0 2px var(--vscode-sideBar-background, var(--vscode-editorWidget-background, transparent))}',
        '.ccx-prov-list{display:flex;flex-direction:column;gap:1px;margin-top:2px;padding:0 4px}',
        '.ccx-prov-row{padding:4px 6px;border:1px solid transparent;border-radius:5px;cursor:pointer}',
        '.ccx-prov-row:hover{background:var(--vscode-list-hoverBackground, rgba(128,128,128,.12))}',
        // The bound profile is marked the way the picker marks it — the panel is read next to a tab
        // that is running one of these, and which one it is should not need a second look.
        '.ccx-prov-row[data-ccx-prov-active="1"]{background:var(--vscode-list-hoverBackground, rgba(128,128,128,.1));border-color:var(--vscode-widget-border, rgba(128,128,128,.28))}',
        '.ccx-prov-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.5}',
        // var()'s fallback is what draws the placeholder: a profile with no icon file of its own never
        // sets --ccx-icon, and the flat tint takes the same 14px slot so no row is a pixel narrower.
        '.ccx-prov-icon{position:relative;flex:0 0 auto;width:15px;height:15px;border-radius:4px;cursor:help}',
        // Only a profile with no icon file of its own gets the flat tint; a logo would sit on it.
        '.ccx-prov-icon-blank{background:rgba(128,128,128,.2)}',
        '.ccx-prov-logo{display:block;width:100%;height:100%;border-radius:4px;object-fit:contain}',
        // The status rides on the icon rather than taking a column of its own, the way a presence dot
        // sits on an avatar. The ring is the panel background, so it reads as a badge, not a bullet.
        '.ccx-prov-icon::after{content:"";position:absolute;right:-3px;bottom:-3px;width:7px;height:7px;border-radius:50%;background:var(--ccx-dot, var(--vscode-descriptionForeground, rgba(128,128,128,.7)));box-shadow:0 0 0 2px var(--vscode-editorWidget-background, var(--vscode-editor-background, transparent))}',
        '.ccx-prov-row[data-ccx-prov="ok"]{--ccx-dot:var(--vscode-charts-green, #3fb950)}',
        '.ccx-prov-row[data-ccx-prov="failed"]{--ccx-dot:var(--vscode-charts-red, #f85149)}',
        '.ccx-prov-row[data-ccx-prov="silent"]{--ccx-dot:var(--vscode-charts-yellow, #d29922)}',
        // Half a day old is not a verdict about now, and a green dot that bright would say it is.
        '.ccx-prov-row[data-ccx-prov-stale="1"] .ccx-prov-icon::after{opacity:.4}',
        '.ccx-prov-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.ccx-prov-row[data-ccx-prov-active="1"] .ccx-prov-name{font-weight:600}',
        '.ccx-prov-age{flex:0 0 auto;min-width:26px;text-align:right;opacity:.45;font-size:10.5px;font-variant-numeric:tabular-nums}',
        // A provider quotes its own refusal and some of them are a paragraph long: two lines, clamped,
        // indented under the icon so the row above stays the thing being read.
        // A frame is a block inside the tool-call node, not a floating panel: it has to read as part of
        // that call, and it has to survive the app's own reconciliation of the subtree it sits in.
        '.ccx-agent-frame{margin:4px 0 2px;border:1px solid var(--vscode-widget-border, rgba(128,128,128,.35));border-radius:6px;overflow:hidden;font:11px var(--vscode-font-family)}',
        '.ccx-agent-head{display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;background:var(--vscode-editorWidget-background, rgba(128,128,128,.08));user-select:none}',
        '.ccx-agent-head:hover{background:var(--vscode-list-hoverBackground, rgba(128,128,128,.16))}',
        '.ccx-agent-caret{flex:0 0 auto;width:10px;opacity:.6}',
        '.ccx-agent-title{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.95}',
        '.ccx-agent-note{margin-left:auto;flex:0 0 auto;opacity:.55;font-size:10px;white-space:nowrap}',
        // Capped and scrollable rather than free to grow: a long run would otherwise push the rest of
        // the turn off the screen every time it printed a line.
        '.ccx-agent-frame[data-ccx-open="0"] .ccx-agent-body{display:none}',
        '.ccx-agent-body{max-height:220px;overflow:auto;padding:4px 8px 6px;display:flex;flex-direction:column;gap:2px;font-family:var(--vscode-editor-font-family, monospace);font-size:10.5px;line-height:1.45}',
        '.ccx-agent-frame[data-ccx-state="running"] .ccx-agent-caret{opacity:1}',
        '.ccx-agent-tool{opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.ccx-agent-tool::before{content:"> ";opacity:.6}',
        '.ccx-agent-thinking{opacity:.4;font-style:italic}',
        '.ccx-agent-thinking::before{content:"* ";font-style:normal}',
        // The delegated prompt and the agent's own text read differently on purpose: one is what it was
        // asked, the other is what it is saying back.
        '.ccx-agent-prompt{opacity:.5;white-space:pre-wrap;padding-left:8px;border-left:2px solid var(--vscode-widget-border, rgba(128,128,128,.35))}',
        '.ccx-agent-text{opacity:.9;white-space:pre-wrap}',
        // A nested run gets a rule of its own rather than an indent: the lines under it are the work,
        // and burying them a level deep is what made them hard to find in the first place.
        '.ccx-agent-child{margin:4px 0 2px;padding:2px 0 2px 6px;border-left:2px solid var(--vscode-textLink-foreground, currentColor);opacity:.8;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.ccx-agent-child::before{content:"↳ ";font-style:normal;opacity:.7}',
        '.ccx-agent-idle{opacity:.45;font-style:italic}',
        // The row is display:flex;align-items:center;gap:8px, so ::before simply becomes its leading flex
        // item and the flex:1 title still ellipsizes. No child node, so nothing for React to reconcile.
        'button[data-ccx-provider]::before{content:"";flex:0 0 auto;width:13px;height:13px;margin-right:-3px;border-radius:3px;background-image:var(--ccx-icon);background-size:contain;background-position:center;background-repeat:no-repeat;opacity:.9}',
        // A fixed slot on every row, hidden rather than absent, so nothing shifts when a row is
        // hovered. Only a pinned row keeps it lit once the pointer leaves.
        '.ccx-pin{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:16px;height:16px;margin-left:2px;margin-right:-2px;border-radius:4px;cursor:pointer;visibility:hidden;color:var(--app-secondary-foreground, var(--vscode-descriptionForeground, var(--vscode-foreground)))}',
        'button[class*="sessionItem_"]:hover .ccx-pin,button[class*="sessionItem_"][class*="focused_"] .ccx-pin,.ccx-pin[data-ccx-pinned="1"]{visibility:visible}',
        '.ccx-pin[data-ccx-pinned="1"]{color:var(--app-link-foreground, var(--vscode-textLink-foreground, var(--vscode-foreground)))}',
        '.ccx-pin[data-ccx-pinned="1"] svg{fill:currentColor;fill-opacity:.22}',
        '.ccx-pin:hover{background:var(--app-ghost-button-hover-background, var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)));color:var(--app-primary-foreground, var(--vscode-foreground))}',
        '.ccx-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:10001;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:6px;font:12px var(--vscode-font-family);color:var(--vscode-notifications-foreground, var(--vscode-foreground));background:var(--vscode-notifications-background, var(--vscode-editorWidget-background));border:1px solid var(--vscode-notificationCenter-border, var(--vscode-widget-border));box-shadow:0 4px 16px rgba(0,0,0,.4)}',
        '.ccx-toast-btn{font:12px var(--vscode-font-family);padding:3px 10px;border-radius:4px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:none}',
        '.ccx-toast-btn-quiet{color:var(--vscode-button-secondaryForeground, var(--vscode-foreground));background:var(--vscode-button-secondaryBackground, transparent);border:1px solid var(--vscode-button-border, var(--vscode-widget-border))}',
        '.ccx-toast-skip{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}',
        // Above the app's own .previewOverlay (z-index 1e4) and Vannevar's toast, since it is opened
        // from a right-click that can land anywhere. Menu colours first, widget colours as the fallback.
        '.ccx-menu{position:fixed;z-index:10002;min-width:160px;padding:4px;border-radius:5px;font:13px var(--vscode-font-family);color:var(--vscode-menu-foreground, var(--vscode-foreground));background:var(--vscode-menu-background, var(--vscode-editorWidget-background));border:1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--vscode-focusBorder)));box-shadow:0 2px 12px rgba(0,0,0,.4)}',
        '.ccx-menu-item{padding:4px 22px 4px 10px;border-radius:3px;cursor:pointer;white-space:nowrap}',
        '.ccx-menu-item:hover{color:var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));background:var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground))}',
        '.ccx-menu-disabled{opacity:.45;pointer-events:none}',
        '.ccx-menu-sep{height:1px;margin:4px 6px;background:var(--vscode-menu-separatorBackground, var(--vscode-widget-border, rgba(128,128,128,.35)))}',
        // The composer glyphs are transparent because the app paints a sibling mirror. A Custom Highlight
        // still paints this text decoration in the input layer, without changing React-owned markup.
        '::highlight(ccx-spelling){background-color:rgba(255,85,85,.16);text-decoration-line:underline;text-decoration-style:wavy;text-decoration-color:#ff5555;text-decoration-thickness:1px}',
        // A retracted message (and the hidden "ignore it" turn) is dropped by a data attribute rather
        // than an inline style, so a React re-render of the bubble cannot bring it back.
        '[data-ccx-hidden]{display:none !important}',
    ].join('');
    document.head.appendChild(s);

    send({ type: 'ccx:get' });
    // Listeners go on `document`, which exists before <body> does, so this does not wait for the DOM.
    // It also has to be registered before VS Code's preload hooks the frame, which is why the injected
    // script is a classic inline <script> rather than a module.
    watchSelection();
    if (document.body) {
        syncChip();
        decorateSessionList();
        watchComposerSpellcheck();
        watchPicker();
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            syncChip();
            decorateSessionList();
            watchComposerSpellcheck();
            watchPicker();
        });
    }
})();