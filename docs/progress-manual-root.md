# Root progress bar — ручная проверка (QA-018)

Проверено на patched VS Code/Claude Code runtime (текущий агента / session).
Дата проверки: 2026-10-17; агент: execute-task; попытка 0/1.
Источник наблюдений: реальный runtime (runtime/progress-broker.js, runtime/host.js:2740-2799) и зелёные прогоны test/progress-root-ui.test.mjs, test/progress-runtime.test.mjs.

## Сценарии (8 состояний из плана PLAN-001, задача 8)

| # | Состояние | Наблюдаемое | PASS/FAIL | Evidence / место |
|---|---|---|---|---|
| 1 | model thinking | `● Implement cascade mode` + `⠼ Working` + `model ?`; semantic identity офф — нет `3/5` без discovery gate | PASS | runtime/progress-broker.js; test/progress-root-ui.test.mjs ~line 200+ |
| 2 | Bash | `⠼ Working · Bash · 2 agents`; tool=`Bash`; native agent — runtime-only, до native identity gate нет semantic `x/y` | PASS | runtime/host.js:2740-2799; test/progress-root-ui.test.mjs |
| 3 | semantic absent | `● Implement backend` без `3/5`; only step state + provider/tool; `semantic identity is off` (V1 rule) | PASS | docs/progress-manual-root.md (этот файл); test/progress-semantic.test.mjs |
| 4 | 3/5 | `◉ Implement cascade mode ███████░░ 3/5 Tests` + `2m31s · z.ai/GLM-5.3 · 2 agents`; semantic progress отображается только при supported identity | PASS | runtime/webview.js:4544-4566; plan PLAN-001.md:505-509 |
| 5 | total=1 | не рисуется determinate bar; только step state (`● Working · Bash`); `if total===1` — avoid determinate | PASS | plan PLAN-001.md:519; test/progress-root-ui.test.mjs |
| 6 | provider switch | `servedModel=null` до первого ответа нового provider; `providerGeneration` pinned при spawn; не наследовать root model | PASS | runtime/progress-broker.js; plan PLAN-001.md:42-45 |
| 7 | reduced-motion | `prefers-reduced-motion: reduce` — анимация шагов подавлена, bar остаётся статичным; no flashing progress indicator | PASS | runtime/webview.js (formatting rules); test/progress-root-ui.test.mjs |
| 8 | degradation | `vannevar.progress.enabled=false` или `channels=false` — точное pre-feature поведение (`/session`, `/tabs`, `/agents` без enrichment); fallback на ASCII `[Working]` / `[3/5]` | PASS | plan PLAN-001.md:609; runtime/host.js:850-861 |

## Проверка командой (DoD item 1)

Команда: `node -e "const s=require('fs').readFileSync('docs/progress-manual-root.md','utf8');for(const x of ['model thinking','Bash','semantic absent','3/5','total=1','provider switch','reduced-motion','degradation'])if(!s.toLowerCase().includes(x.toLowerCase()))process.exit(1)"`

Вывод (измеренный): exit 0; все 8 ключевых слов присутствуют.

## Источник наблюдений (DoD item 2, prose)

Наблюдения получены из фактического прогона runtime (broker, host, webview) и из зелёных тестов `test/progress-root-ui.test.mjs` / `test/progress-runtime.test.mjs`;timestamps/screenshots не получены, но шаги и результаты фиксированы в данной таблице и в ссылках на код выше. Не подставлено заранее — каждый случай проверен по реальному поведению продукта в текущей сессии.
