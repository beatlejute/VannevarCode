// Minimal webview/index.js for ambiguity scenario
// PATCH-WEBVIEW-MODEL-ACTION anchor
let modelSelection = { value: 'test' };
let claudeConfig = { value: 'config' };
let lastServedModel = { value: 'model' };
let ctx = { commandRegistry: { registerAction: (action) => {} } };
ctx.commandRegistry.registerAction({ id: "model", label: "Switch model...", description: "Change the AI model", trailingComponent: lastServedModel ? "span" : null });

// PATCH-WEBVIEW-ACTION-ORDER anchor
const actionOrder = ["model", "toggle-thinking", "account-usage"];

// PATCH-WEBVIEW-SEARCH-STATE anchor
const [query, setQuery] = useState("");
const [renaming, setRenaming] = useState(null);
const refs = useRef(new Map());

// PATCH-WEBVIEW-SEARCH-FILTER anchor
const lowerQ = query.toLowerCase();
const result = source.filter((item) => titleFn(item).toLowerCase().includes(lowerQ) || (item.gitBranch?.value?.toLowerCase().includes(lowerQ) ?? false));

// PATCH-WEBVIEW-OPEN-STATE anchor
const openStateAccessor = (row) => ({ openState: row.openState, remoteStatus: 'active' });

// PATCH-WEBVIEW-PIN-SORT anchor
const sorted = globalThis.__test_ccx && globalThis.__test_ccx.pinSort ? globalThis.__test_ccx.pinSort(list, pinnedIds, openState, titleMatches) : list;

// PATCH-WEBVIEW-SEARCH-QUERY anchor
const onChange = (param) => { globalThis.__test_ccx && globalThis.__test_ccx.onSearchQuery && globalThis.__test_ccx.onSearchQuery(param.target.value); };

// PATCH-WEBVIEW-ARCHIVED-FILTER anchor
const grouping = groupsOn && !query;
const result2 = groupFn(grouping ? groups : [], list, idOf, globalThis.__test_ccx && globalThis.__test_ccx.archivedFilter ? globalThis.__test_ccx.archivedFilter(isArchived, titleMatches) : isArchived);

// PATCH-WEBVIEW-CCX-AGENT-MAP anchor
const agentMapAgents = { value: [] };
globalThis.__test_ccx && globalThis.__test_ccx.mapProgress && globalThis.__test_ccx.mapProgress(null, session, h);

// PATCH-NO-AUTH-LOGIN anchor
const jsx = (tag, props) => ({ tag, props });
const cls = { noteBeneathButton: 'note', fullWidthButton: 'full' };
jsx("p", { className: cls.noteBeneathButton, children: "Instructions on how to use API keys or third-party providers." });

// PATCH-NO-AUTH-GATE anchor
const isAuthenticated = memo(() => !!globalThis.__test_ccxNoAuth || !forceLogin.value && hasSessionView.value);

// PATCH-NO-AUTH-SHOW-LOGIN anchor
function showLogin() { globalThis.__test_ccxNoAuth || (forceLogin.value = true); }

// PATCH-CCX-CALL-TIME anchor
function formatMeta(agent, now) { let duration = durationOf(agent, now); let tokens = agent.usage?.totalTokens; let __test_ccxAt = globalThis.__test_ccx && globalThis.__test_ccx.callTime ? globalThis.__test_ccx.callTime(agent.startTime) : void 0; return [__test_ccxAt]; }

// PATCH-MAP-PROGRESS anchor
function mapRow({ agent, waiting, onClick }) { return []; }

// Mock functions for testing
function useState(initial) { return [initial, (v) => v]; }
function useRef(initial) { return { current: initial }; }
function memo(fn) { return fn(); }
const forceLogin = { value: false };
const hasSessionView = { value: true };
const durationOf = (a, b) => '5m';
const titleFn = (item) => item.title || '';
const source = [];
const groupsOn = true;
const groups = [];
const list = [];
const idOf = (item) => item.id;
const isArchived = (item) => item.archived;
const titleMatches = new Set();
const pinnedIds = [];
const openState = {};
const h = (tag, props) => ({ tag, props });
const session = {};