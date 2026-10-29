# Unabhängig review инфраструктуры адаптации (PLAN-002, задача 27)

## Источник и метод

- Тикет: `REVIEW-001` (PLAN-002, задача 27), `dod_format: 2`.
- Fresh context: исполнитель не является автором основных изменений PLAN-002 (автор плана — `architect`).
- Проверяются 11 dimensions из `context.notes` тикета и описания задачи 27 плана: compatibility-first; отсутствие mass migration legacy; AST fail-closed; no eval + provenance; registry parity; strict variants; test isolation; panic-restore refusal; no implicit real-install reads; no `verifiedAgainst` change; no remote telemetry.
- Severity: `BLOCKER | MAJOR | MINOR | NOTE`. `BLOCKER`/`MAJOR` требуют file:line evidence; отсутствие finding записывается `none`.
- Evidence измерено в этой сессии фактическими командами (коды выхода и вывод приведены); ссылки `путь:строка` ведут на код, тесты и конфиги этого репозитория.

## Результаты по dimensioni

### 1. compatibility-first — none

`verifiedAgainst` не изменён: список из 17 релизов в `package.json:6-7` байт в байт совпадает с baseline `docs/adaptation/current-baseline.md:3-4`. Пatcher останавливается при несовпадении сигнатур и ничего не пишет (`runtime/apply-patch.mjs:1021-1022`); неверифицированная версия даёт предупреждение, но не остановка (`runtime/apply-patch.mjs:662-671`) — документированное решение проекта, не нарушение compatibility-first.

Измерено в этой сессии: `node runtime/apply-patch.mjs --validate-registry` → exit 0, `patch points: 27 runtime patch(es) ↔ 27 registry entry(ies) — one-to-one; no Claude Code installation was looked for, and no user home was read`. Полный регресс: 65/66 файлов зелёны, `test/runtime-sync.test.mjs` падает с EIO на Windows — дефект, зафиксированный в отчёте валидации (`docs/adaptation/implementation-validation.md:53-57`), не связан с сигнатурами адаптации.

### 2. отсутствие mass migration legacy — none

Все 27 вариантов реестра — `matcherKind: legacy-textual`, `state: legacy` (`runtime/patch-points-registry.json`). `PATCHES` содержит 27 RegExp/строковых сигнатур, ninguna не переписана на AST (`runtime/apply-patch.mjs:34-579`). AST-способность существует только как заготовка + комментарий (`runtime/ast-locator.mjs:6-13`, `runtime/apply-patch.mjs:979-982`); ни один вариант реестра не использует `matcherKind: ast`. Массовой миграции legacy нет, что соответствует плану (task 3, solution 1).

### 3. AST fail-closed — MINOR

`runtime/ast-locator.mjs:6-13`: `locate` возвращает `descriptor.range` буквально или `[]` — реального обхода AST нет, подсчёта кандидатов нет; поведение fail-closed (пустой массив) работает только для случая без диапазона. `runtime/apply-patch.mjs:979-982`: диспетч AST-вариантов упомянут только в комментарии; в реестре нет вариантов `matcherKind: ast`, поэтому сегодня fail-closed ничего не контролирует. `test/ast-locator.test.mjs:68-75` проверяет контракт заготовки, а не реальные AST-свойства. НЕ БЛОКИРУЕТ текущее поведение (вариантов ast нет; legacy-путь нетронут), но соответствие dimension «AST fail-closed» не доказано реальным кодом.

### 4. no eval + provenance — none

`scripts/adaptation/normalize-js.mjs:4-10`: запрещённые конструкции в analysed-исходнике — `eval(`, `Function(`, дочерние процессы, `fetch(`, `XMLHttpRequest`; инструмент analysis-only, вывод JSON/IR в `--out`, provenance на raw file/start/end; неразрешимое → `UNRESOLVED`. `eval`/`Function` не используется в PLAN-002 runtime-файлах (`runtime/apply-patch.mjs`, `runtime/ast-locator.mjs`, `scripts/adaptation/*`); `'eval('` в `normalize-js.mjs:4` — список запрещённых конструкций, а не вызов.

### 5. registry parity — none

Измерено в этой сессии: `node runtime/apply-patch.mjs --validate-registry` → exit 0, `patch points: 27 runtime patch(es) ↔ 27 registry entry(ies) — one-to-one; no Claude Code installation was looked for, and no user home was read`. Сравнение в обе стороны: runtime-патч без записи реестра и запись реестра без runtime-патча — проблемы (`runtime/apply-patch.mjs:888-928`). Примечание: `done`-тикеты `IMPL-025.md:81` и `REPORT-013.md:37` по-прежнему утверждают «28 patch points» — устаревшие записи до исправления реестра; текущие файлы сходятся (27 = 27).

### 6. strict variants — none

Варианты реестра объявляют `state` (legacy/active/deprecated) и `matcherKind` из перечня, валидируемые `scripts/adaptation/validate-registry.mjs:70-81`; `knownVersions` зафиксированы диапазонами на вариант (например, `runtime/patch-points-registry.json:206-207`, `:253-254`). `textual-fallback` не используется — нет случаев без justification; justification для `textual-fallback` требуется (`validate-registry.mjs:73-74`).

### 7. test isolation — none

`test/auto-repatch.test.mjs:24-27, 248-250`: mutable root — `os.tmpdir()`, `rmSync` в `finally`; нет неявного `~/.vscode/extensions` — используется stamped `extensionPath` (строки 145-161); патчер не содержит `fetch(`/самобновления (строки 163-170). `test/adaptation-probe.test.mjs:12-22` и `test/adaptation-runner.test.mjs:114-121`: tmp + teardown при любом исходе. `test/activation.test.mjs:27-31`: `HOME` застейблен во временную директорию. Проверка criterion 6 (источник `test/auto-repatch.test.mjs` не содержит неявного `homedir()`/`.vscode/extensions`) → exit 0.

### 8. panic-restore refusal — none

`runtime/apply-patch.mjs:745-746`: `--panic-restore` явный режим, никогда не автоматический; приоритет восстановления: точный бэкап → `--pristine-dir` той же сборки → самоуправляемая очистка реестра → отказ (751-790); транзакционность: все источники читаются до первой записи, откат при неудаче (793-813); постусловие: маркеры `__ccx` удалены + синтаксис валиден (814-823); неизвестный маркер → отказ с руководством по переустановке (782-789). `extension.js:458-491`: команда с диалогом подтверждения, предупреждение при отказе, перезагрузка при успехе; `package.json:35` объявляет команду; активация не вызывает паник-реストор автоматически. Измерено в этой сессии: `test/panic-restore.test.mjs` → exit 0 (8/8 случаев восстановления/отказа + 4 PASS); `test/panic-restore-command.test.mjs` → exit 0 (все случаи, включая `no automatic invocation`). Ручная UI-проверка (Task 21/QA-046): 5/5 случаев `BLOCKED`, требуется HUMAN fallback — отсутствие интерактивного десктопа в этой среде, precondition инфраструктуры, а не продуктовый дефект (`docs/adaptation/panic-restore-manual-check.md:5-7, 46-54`).

### 9. no implicit real-install reads — NOTE

Инструменты адаптации `scripts/adaptation/*` (probe.mjs, run.mjs, validate-registry.mjs) требуют явных `--dir/--registry/--out`; автоматическая суит использует стamped-корень и фикстуры (`test/auto-repatch.test.mjs:145-161`). Исключение: `runtime/apply-patch.mjs:632-635` — `extensionsRoot()` откатывается на `homedir()/.vscode/extensions` при ручном запуске без `--dir` и без штампа (задокументировано в baseline, `docs/adaptation/current-baseline.md:37`). Автоматические пути пользовательскую домашнюю директорию не читают.

### 10. no `verifiedAgainst` change — none

`package.json:6-7` идентично baseline `docs/adaptation/current-baseline.md:3-4` (17 релизов, список, а не версия). Task 25 плана запрещает изменение; criterion 11 (точное совпадение списка с baseline Task 1) соблюдено.

### 11. no remote telemetry — none

`docs/adaptation/adaptation-policy.json:15-20`: `remoteTelemetry.defaultEnabled: false`, `optInRequired: true`, `dataTypes: []`. `PLAN-002.md:734-736` (technical decision 6): удалённая телеметрия требует отдельного plans с утверждением стейкхолдера; PLAN-002 её не создаёт. Файлы PLAN-002 не добавляют収集 telemetry; существующий `mcp__vannevar__progress` (`runtime/mcp/agent-server.mjs:1049`) относится к продукту, вне scope PLAN-002.

## Итог

- Dimension проверено: 11/11.
- `BLOCKER`: 0, `MAJOR`: 0, `MINOR`: 1 (размер 3 — AST fail-closed не реализован реально), `NOTE`: 1 (размер 9 — неявный fallback на `~/.vscode/extensions` в ручном режиме патчера).
- Открытых `BLOCKER`/`MAJOR`: 0 → вердикт ревью `PASS` (criterion успеха 12).

## Заметки

- `QA-046` / задача 21 (ручная проверка команды Panic Restore): `BLOCKED` — HUMAN fallback, нет интерактивного десктопа/Sandbox в этой среде; выполнение остаётся оператору (`docs/adaptation/panic-restore-manual-check.md:56-62`).
- `test/runtime-sync.test.mjs` (EIO на Windows) — дефект из отчёта валидации QA-047 (`docs/adaptation/implementation-validation.md:53-57`), вне 11 dimensioni этого ревью.
- Устаревшие claims «28 patch points» (`IMPL-025.md:81`, `REPORT-013.md:37`) против фактических 27 — сохранены без правки (чужие тикеты); текущее равенство 27↔27 измерено этой сессией.
- `.workflow/shared/` существует, но пуст — модулей нет, absence не блокер (P0S2).
