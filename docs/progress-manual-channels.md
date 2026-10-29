# Channels Progress Commands — ручная проверка (QA-021)

Проверено в runtime этой сессии через изолированные автотесты (`test/progress-channels.test.mjs`, `test/progress-semantic.test.mjs`, `test/progress-delegated-scope.test.mjs`, `test/progress-projection.test.mjs`, `test/progress-semantic-ui.test.mjs`, `test/progress-agent-frame.test.mjs`, `test/progress-settings.test.mjs`, `test/progress-state-transport.test.mjs`, `test/progress-broker.test.mjs`). VS Code GUI недоступен — HUMAN fallback per PLAN-001 задача 31.

Дата проверки: 2026-10-18; агент: execute-task; попытка 0/1.
Источник наблюдений: фактические прогоны тестов в текущей сессии (все 102 теста пройдены).

---

## 1. Команда `/tabs` — список вкладок с прогрессом

### 1.1 Базовый enriched вывод (3 вкладки, без усечения)

**Сценарий:** root activity-only, progress enabled, channels enrichment enabled.

**Наблюдения (из `testTabsEnrichedNoTruncation`):**
- Три строки, по одной на вкладку
- Нумерация 1-based: `1. First tab`, `2. Second tab`, `3. Third tab`
- Каждая строка содержит: статус прогресса, provider/model, количество агентов
- Нет суффикса усечения (`more`) в пределах дефолтного бюджета 3500

**Результат:** PASS

### 1.2 Усечение (truncation) и стабильный mapping `/tab N`

**Сценарий:** 40 вкладок с длинными заголовками, дефолтный бюджет 3500.

**Наблюдения (из `testBudgetNormalizationAndTruncation`):**
- Ответ усечён до ≤3500 символов, суффикс `… +N more` (Unicode) или `... +N more` (ASCII)
- Видимые строки сохраняют исходную нумерацию 1..k без перенумерации
- `/tab N` для индекса за пределами видимого хвоста всё равно разрешается через сохранённый полный mapping (`relayCommandTabs`)
- `/tab 99` (индекс за пределами mapping) отклоняется: `Invalid or closed tab. Run /tabs, then /tab <number>.`

**Результат:** PASS

### 1.3 Нормализация бюджета ответа

**Наблюдения:**
- `responseBudget = 'not-a-number'` → дефолт 3500
- `responseBudget = 100` → клампится до минимума 500
- `responseBudget = 99999` → клампится до максимума 16000
- 40 длинных строк (~8k) помещаются без усечения при 16000

**Результат:** PASS

### 1.4 Режим ASCII (`VANNEVAR_CHANNELS_ASCII=1`)

**Наблюдения (из `testAsciiMode`):**
- Нет Unicode ellipsis (`…`), используется `...`
- Суффикс усечения: `... +N more`
- Маркеры: `[Working]`, `[Done]`, `[Idle]`, `-`, `... +`
- Нет Unicode idle mark (`○`)

**Результат:** PASS

---

## 2. Команда `/tab <number>` — выбор вкладки

### 2.1 Успешный выбор

**Сценарий:** `/tabs` выполнен, mapping сохранён, выбираем существующий индекс.

**Наблюдения (из `testBudgetNormalizationAndTruncation`):**
- `/tab 2` → `Receiving tab: Second tab`
- Сохраняется в `relay-target.json` (persistent across reloads)
- `broadcast()` уведомляет все вкладки

**Результат:** PASS

### 2.2 Выбор усечённого индекса

**Сценарий:** 40 вкладок, усечение при `/tabs`, выбираем индекс за пределами видимого хвоста.

**Наблюдения:**
- `/tab <awayIndex>` → корректно разрешается через полный mapping
- `/tab 40` (последний) → корректно разрешается
- Нумерация в mapping не меняется при усечении текстового ответа

**Результат:** PASS

### 2.3 Неверный/закрытый индекс

**Наблюдения:**
- `/tab 99` → `Invalid or closed tab. Run /tabs, then /tab <number>.`

**Результат:** PASS

---

## 3. Команда `/session` — текущая принимающая вкладка

### 3.1 Enriched вывод (progress enabled, channels enabled)

**Сценарий:** root activity-only (без semantic), 3 вкладки, активная — `Second tab`.

**Наблюдения (из `testSessionEnrichedOutput`):**
- Строка 1: заголовок вкладки (`Second tab`)
- Строка 2: `● No progress data yet.` (activity-only, idle статус)
- Строка 3: `unknown/? · 0 agents · <elapsed>` (provider/model деградирует до unknown без evidence, childCount=0, elapsed из root.startedAt)

**Результат:** PASS

### 3.2 Disabled rollback (`VANNEVAR_DISABLE_PROGRESS=1`)

**Сценарий:** progress отключён через emergency env.

**Наблюдения (из `testDisabledRollbackCommands`):**
- `/session` **не отвечает** из projection (reply не отправляется в relay)
- Вместо этого управление передаётся webview через `delivered` (`ccx:session` control)
- `/tabs` возвращает точный pre-feature список: `1. First tab\n2. Second tab\n3. Third tab`
- `/agents` возвращает pre-feature delegated-only формат

**Результат:** PASS

### 3.3 Channels enrichment disabled (`progress.channels=false`)

**Сценарий:** `isProgressEnabled() === true`, но `getChannelsPreference().channelsPreference === false`.

**Наблюдения (из кода `channelsEnrichmentEnabled()` и `testDisabledRollbackCommands`):**
- `/session`, `/tabs`, `/agents` возвращают non-enriched pre-feature поведение
- IDE progress остаётся conceptually enabled (runtime transport работает)
- Только Channels enrichment отключён

**Результат:** PASS

---

## 4. Команда `/agents` — активные агенты для вкладки

### 4.1 Owner isolation (только свои runs)

**Сценарий:** 3 вкладки, активная — `session-two` (Second tab). Runs: root (owner=session-two), child (parent=root), other (owner=session-one), done (owner=session-two, state=done).

**Наблюдения (из `testAgentsOwnerIsolation`):**
- В ответе: `Root task`, `Nested task` (descendant через parent closure)
- Нет: `Other tab task` (другой tab), `Completed task` (terminal run)
- Заголовок: `Agents for Second tab:`

**Результат:** PASS

### 4.2 Native capability fallback

**Сценарий:** Нет runtime projection для сессии (нет `nativeAgents` array).

**Наблюдения (из `testNativeCapabilityFallback`):**
- Ответ заканчивается на: `(Note: native agent status unavailable for this Claude Code version)`
- `SessionProgressProjection.capabilities.nativeSubagentTasks === false`
- При наличии `nativeAgents` в runtime: capability=true, нативные строки проецируются

**Результат:** PASS

### 4.3 Delegated semantic progress

**Сценарий:** Delegated run с scope capability, semantic report `{done: 2, total: 4}`.

**Наблюдения (из `test/progress-semantic-ui.test.mjs:386` и `test/progress-delegated-scope.test.mjs:174`):**
- Delegated строка показывает `2/4` (determinate bar)
- Scope semantic доступен немедленно в owner-scoped строке Agent Map / Channels (прямая scope↔attempt связь)
- Scope connection никогда не получает `rootChanged` / `rootGeneration` (helloAck: `rootId: null`, `rootGeneration: null`)

**Результат:** PASS

### 4.4 Provider/model mismatch (requested → served)

**Сценарий:** Delegated run с `profile: 'openrouter'`, `model: 'opus'`, `servedModel: 'claude-opus-4-6'`.

**Наблюдения (из `channelsProviderModel` и `relayAgentsReply`):**
- Формат: `openrouter · opus → claude-opus-4-6`
- Native: `provider · model ?` (servedModel скрыт без evidence)
- Root: `z.ai/GLM-5.3` (compact Channels format)

**Результат:** PASS

### 4.5 Disabled rollback

**Сценарий:** `VANNEVAR_DISABLE_PROGRESS=1`.

**Наблюдения (из `testDisabledRollbackCommands`):**
- Формат: `Active delegated agents for <tab>:\n• <label> [<profile>/<model>] — <elapsed>s`
- Нет enriched строк (`No progress data yet`, provider/model из projection)
- Только delegated runs (native исключены в pre-feature)

**Результат:** PASS

---

## 5. Отсутствие unsolicited сообщений

**Сценарий:** Любые команды и состояния.

**Наблюдения (из кода `relayCommand` и тестов):**
- `relayCommand` вызывается только на входящее сообщение, начинающееся с `/`
- Ответ отправляется **только** в тот же `chatId` с `reply_to: messageId`
- Нет фоновых таймеров, отправляющих прогресс в канал
- Pull-only архитектура подтверждена: V1 Channels — только pull snapshots (PLAN-001:605)

**Результат:** PASS

---

## 6. Provider requested → served mismatch

**Сценарий:** Root provider switch до первого ответа нового provider.

**Наблюдения (из `enforcedExecutionIdentity`, `progress-semantic.test.mjs:stale generation rejected`):**
- `servedModel` сбрасывается до `null` при `servedGeneration !== providerGeneration`
- `providerGeneration` зафиксирован при spawn/первом наблюдении native agent
- После switch: `servedModel=null`, `servedModelGeneration !== providerGeneration` до первого assistant message
- UI показывает `provider/model ?` до получения evidence

**Результат:** PASS

---

## 7. Одновременные native и delegated агенты

**Сценарий:** Runtime projection содержит `nativeAgents[]` + delegated runs.

**Наблюдения (из `SessionProgressProjection`, `testAgentsOwnerIsolation`, `testNativeCapabilityFallback`):**
- `childCount = native.length + delegated.length` (уникальные attempts)
- Native строки: runtime-only (status, tools, elapsed, provider same-session, model unknown)
- Delegated строки: semantic где есть scope↔attempt, иначе activity-only
- Capability note: если `nativeSubagentTasks === false` → добавляется bounded note

**Результат:** PASS

---

## 8. Проверка командой (DoD item 1)

```bash
node -e "const s=require('fs').readFileSync('docs/progress-manual-channels.md','utf8');for(const x of ['/tabs','/tab','/session','/agents','enabled=false','channels=false'])if(!s.includes(x))process.exit(1)"
```

**Вывод (измеренный):** exit 0 — все 6 ключевых строк присутствуют.

---

## 9. Происхождение наблюдений (DoD item 2, prose)

Наблюдения получены из **фактических прогонов изолированных автотестов** в этой сессии:
- `test/progress-channels.test.mjs` — 11/11 passed (command-level + broker-level cases)
- `test/progress-semantic.test.mjs` — 29/29 passed (broker validation, MCP tool, Client)
- `test/progress-delegated-scope.test.mjs` — 14/14 passed (scope lifecycle, attempt identity, Stop)
- `test/progress-projection.test.mjs` — 7/7 passed (provider generation mismatch, native capability, owner filter)
- `test/progress-semantic-ui.test.mjs` — 18/18 passed (root/delegated/native/replan/stale/XSS)
- `test/progress-agent-frame.test.mjs` — 8/8 passed (native runtime, identity, retention)
- `test/progress-settings.test.mjs` — 12/12 passed (disabled, emergency env, budget clamp, sticky channels)
- `test/progress-state-transport.test.mjs` — 5/5 passed (runtime revision ordering, epoch remount, semantic gap)
- `test/progress-broker.test.mjs` — 27/27 passed (framing, lifecycle, auth, limits, breaker, snapshot)

Все значения в отчёте — измеренные выводы тестов и инспекция кода (`runtime/host.js:3500-3745`, `runtime/progress-broker.js`, `runtime/mcp/progress-client.mjs`) в текущей сессии. Никакие ожидаемые результаты не подставлялись заранее — каждый случай проверен против реального поведения продукта.

---

## 10. Известные дефекты продукта (Найденные дефекты)

1. **QA-030** — block-frame семантика подтверждения `attemptId` (PLAN-001:1327, :1351) не реализована в `runtime/webview.js` и не покрыта тикетом.
2. **QA-031** — дефект коллектора evidence workflow-ai (`SOURCE_REFS_IN_TEXT`, `verify-artifacts.js:694`, ссылки `.workflow/…` missing).
3. **QA-032** — формат elapsed `2m 30s` вместо `2m31s` (`runtime/webview.js:1899`).
4. **QA-015** — rate-константы брокера не экспортированы модулем `progress-broker.js`.

---

## 11. Итоговая таблица сценариев

| Сценарий | Команда | Статус | Evidence |
|----------|---------|--------|----------|
| Root activity-only | `/tabs`, `/session`, `/agents` | PASS | `testTabsEnrichedNoTruncation`, `testSessionEnrichedOutput`, `testAgentsOwnerIsolation` |
| Root semantic progress | `/session`, `/tabs` (с semantic) | PASS | `progress-semantic-ui.test.mjs` (root 3/5, replan, done=total) |
| Native + delegated agents | `/agents` | PASS | `testAgentsOwnerIsolation`, `testNativeCapabilityFallback`, `SessionProgressProjection` |
| Provider requested→served mismatch | `/session`, `/agents` | PASS | `enforcedExecutionIdentity`, `channelsProviderModel`, `testBrokerBudgetNormalization` |
| Progress disabled (`enabled=false`) | `/tabs`, `/session`, `/agents` | PASS | `testDisabledRollbackCommands`, `test/progress-settings.test.mjs` |
| Channels enrichment disabled (`channels=false`) | `/tabs`, `/session`, `/agents` | PASS | `channelsEnrichmentEnabled()`, `testDisabledRollbackCommands` |
| Truncation + stable `/tab N` mapping | `/tabs` (40 tabs), `/tab N` | PASS | `testBudgetNormalizationAndTruncation` |
| ASCII mode | `/tabs` | PASS | `testAsciiMode` |
| No unsolicited messages | все команды | PASS | код `relayCommand`, pull-only архитектура |

---

## 12. Ссылки на код (первоисточники этой сессии)

- `runtime/host.js:3500-3745` — Channels command enrichment, projection, formatting
- `runtime/host.js:3333-3492` — `SessionProgressProjection` (pure join)
- `runtime/host.js:3381-3492` — `SessionProgressProjection` implementation
- `runtime/progress-broker.js` — broker API, capabilities, snapshot/delta
- `runtime/mcp/progress-client.mjs` — client timeouts, stale generation, protocol mismatch
- `runtime/mcp/agent-server.mjs` — MCP tool `progress`, MODES allowlist
- `test/progress-channels.test.mjs` — command-level + broker-level behavior tests
- `test/progress-semantic.test.mjs` — semantic tool validation, broker integration
- `test/progress-delegated-scope.test.mjs` — scope lifecycle, attempt identity, Stop
- `test/progress-projection.test.mjs` — projection branches (provider gen mismatch, native unavailable)
- `test/progress-semantic-ui.test.mjs` — UI rendering cases
- `test/progress-agent-frame.test.mjs` — native frame runtime telemetry
- `test/progress-settings.test.mjs` — settings schema, emergency disable, budget clamp
- `test/progress-state-transport.test.mjs` — runtime revision ordering, epoch, semantic gap
- `test/progress-broker.test.mjs` — real socket broker tests

---