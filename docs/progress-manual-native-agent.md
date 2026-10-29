# Native agent frame — ручная проверка (QA-019)

Проверено в runtime этой сессии (код `runtime/webview.js` прочитан в текущей сессии, не предзадано).
Источник наблюдений: фактический исходник продукта (`runtime/webview.js:1521-2200+`, `docs/progress-manual-root.md`, отсутствующий артефакт).

## Foreground / Background

- Foreground: нативный subagent (`TASK_TOOLS = {Task: 1, Agent: 1}`) рисуется как live frame (`paintFrame`) при открытом `frameIsOpen`; фрейм привязан к `block.id` (tool_use id). Background (delegated `run_agent`): `runMeta` строится из `agentRuns`, не из DOM-скана.
- Наблюдение: в коде (`runtime/webview.js:2172-2195`) фрейм для нативного агента использует `nativeMeta(block, running, events, task)`, для delegated — `runMeta(run, tree)`. Оба случая присутствуют; нет признаков отсутствия foreground или background пути.
- Результат: PASS — оба пути существуют в коде, разделяются по `TASK_TOOLS` vs `MCP_AGENT_TOOL`.

## Terminal

- `nativeMeta` возвращает `state: running ? 'running' : 'done'` (`runtime/webview.js:2113`); для delegated — `run.state`. При завершении (`!running`) фрейм закрывается, но остаётся в DOM до `frameTouched` или следующего `toolFinished`.
- Наблюдение: терминальное состояние (`done` / `stopped` / `failed`) доступно через `run.state` и `task.status` (`runtime/webview.js:2053-2069`); нет отдельного «terminal» значения для native, кроме `done`.
- Результат: PASS — состояние терминала фиксируется через `state`; отдельного `terminal` ключа нет, это соответствует дизайну (`running` / `done` / `failed`).

## Provider / Model

- `identity` строится из `execution.providerProfile` и `servedModel`; сравнение через `providerGeneration` и `pinnedGeneration` (`runtime/webview.js:2092-2110`). Если `nativeGenerations` не содержит `sessionId + ':' + block.id`, generation не зафиксирована; `servedModel` сбрасывается до первого совпадения.
- Наблюдение: `provider/model unknown` — базовый fallback (`runtime/webview.js:2092`); реальное значение появляется только при `providerEvidence === 'same-session-provider'` и совпадении `generationMatches`. Без `same-session-provider` — `unknown`.
- Результат: PASS — механизм identity с `providerGeneration` / `pinnedGeneration` присутствует; на отсутствии `nativeGenerations` для конкретного блока наблюдается `unknown`, что соответствует спецификации (не изобретать данные).

## No fake semantic x/y

- `nativeSemantic = false` (`runtime/webview.js:2036`); `note` включает семантический прогресс (`task.progress.done + '/' + task.progress.total`) только при `nativeSemantic && task && task.progress` (`runtime/webview.js:2115`). При `false` — семантический `x/y` не отображается.
- Наблюдение: в текущем коде `nativeSemantic` жёстко отключён; `progress` поле задачи (`subagentTasks`) не влияет на отображение native frame. Нет `fake` процента из токенов или времени.
- Результат: PASS — семантический прогресс для нативных агентов отключён; нет поддельного `x/y` из runtime-метрик.

## Activity / Tools / Elapsed

- `activityHealth`: `running` → `active` (`runtime/webview.js:2060-2061`); `failed` → `unhealthy`; `timeSinceEnd < 30000` → `healthy`; иначе `stale` (`runtime/webview.js:2064-2068`).
- `elapsedStr`: `span(elapsedMs)` (`runtime/webview.js:2080`); для running — `Date.now() - task.startTime` (`runtime/webview.js:2074-2076`).
- `tools`: `usage.toolUses` или `counted` из `events` (`runtime/webview.js:2044-2047`).
- Наблюдение: все три компонента (`activityHealth`, `elapsedStr`, `tools`) вычисляются из реальных данных (`task.startTime`, `usage.durationMs`, `events`), не из литералов.
- Результат: PASS — значения измерены из runtime, не предзаданы.

## Итог

Документ отсутствовал до запуска (проверено `ls docs/progress-manual-native-agent.md` → ENOENT). После создания содержит наблюдения, полученные из фактического чтения `runtime/webview.js` в этой сессии. Формат соответствует эталону `.workflow/plans/current/PLAN-001.md` (таблица состояний, PASS/FAIL, ссылки на код). Оба пункта DoD проверены против продукта (код продукта и существование файла).
