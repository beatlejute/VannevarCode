# Vannevar Code — план нового репозитория

Дата: 2026-09-18. Исходник: Vannevar 2.1.276 (этот репозиторий).

## 0. Принятые решения

| Вопрос | Решение | Почему |
|---|---|---|
| Форма | Одно расширение VS Code: keeper + установщик + рантайм. npm-пакета нет | Аудитория только VS Code; keeper и так обязан быть расширением; Node на машине не гарантирован (CLI без bundled-node с 2.1.227), а extension host даёт свой через `ELECTRON_RUN_AS_NODE` |
| Имя | displayName **Vannevar Code**, `name: vannevarcode`, publisher без «vannevar» и «claude» (предложение: `beatlejute`) | Свободно на npm и Open VSX; словесный знак VANNEVAR (Serial 88786465, Vannevar Labs) в соседнем классе, риск средний; «Claude» в имени — прямой риск (прецедент Clawdbot → Moltbot, 27.01.2026) |
| Каналы | 1) .vsix в GitHub Releases, 2) Marketplace, 3) Open VSX тем же файлом | Marketplace — единственный автообновляемый канал для стокового VS Code; Open VSX — для Cursor/Windsurf/VSCodium; GitHub Releases переживёт takedown |
| Версия | Своя, semver `x.y.z`, старт `0.1.0`; поле `verifiedAgainst: ["2.1.276", "2.1.274"]` в package.json | Marketplace принимает только `major.minor.patch`; схема «версия = версия Claude Code» ломается на втором релизе под один Claude Code |
| Рантайм | По-прежнему копия в `~/.claude/vannevar/`, патч `require`-ит host.js оттуда | Стабильный путь: папка расширения меняется с каждой версией, а хуки в чужом бандле — нет |
| Внутренние имена | Маркер `/*__ccx*/`, сообщения `ccx:*`, `globalThis.__ccxState`, `*.ccx-orig` остаются | Сигнатуры, тесты и детектор пропатченности (`filePatched` ищет MARKER) на них завязаны; переименование — риск без пользы. Меняются только пользовательские строки, пути и имена команд |
| Самообновление | Удаляется целиком (git ff-only, self-update.json, 6 отказов, upstream-check) | Его заменяет updater VS Code |

## 1. Структура репозитория

```
vannevar-code/
  package.json              манифест расширения (см. §2)
  extension.js              точка входа: бывшие keeper/extension.js + scripts/install.mjs
  runtime/                  копируется в ~/.claude/vannevar при смене версии
    host.js
    webview.js
    apply-patch.mjs
    proxy/                  server.mjs, translate.mjs, translate-responses.mjs, auth-chatgpt.mjs
    mcp/                    agent-server.mjs
  templates/profiles/       codex.json, openai.json
  scripts/                  только dev: build-vsix.mjs (из vsix.mjs + png.mjs), fetch-favicons, ico-to-png,
                            shrink-icons, diag-proxy, login-chatgpt
  test/                     26 файлов как есть + activation.test.mjs, migration.test.mjs
  docs/internals.md         как есть
  README.md  DISCLAIMER.md  PRIVACY.md  CHANGELOG.md  LICENSE
  .github/workflows/        ci.yml, release.yml
  .vscodeignore             test/, docs/, images/, scripts/, .github/
  images/                   скриншоты для README и Marketplace
```

Что не переезжает: `keeper/` (растворяется в extension.js), `scripts/install.mjs`, `install-keeper.mjs`, `install-mcp.mjs` (логика уходит в extension.js), `scripts/vsix.mjs` как отдельный установщик (остаётся только сборщиком для CI).

## 2. package.json расширения

```json
{
    "name": "vannevarcode",
    "displayName": "Vannevar Code",
    "description": "Per-tab API provider switching for the Claude Code extension: Anthropic, DeepSeek, OpenAI, OpenRouter, Ollama, a ChatGPT subscription — switched from the command menu, per tab.",
    "publisher": "beatlejute",
    "version": "0.1.0",
    "verifiedAgainst": ["2.1.276", "2.1.274"],
    "license": "MIT",
    "icon": "images/icon.png",
    "repository": { "type": "git", "url": "https://github.com/beatlejute/vannevar-code" },
    "engines": { "vscode": "^1.85.0" },
    "extensionKind": ["workspace", "ui"],
    "activationEvents": ["onStartupFinished"],
    "main": "./extension.js",
    "categories": ["Other"],
    "keywords": ["claude-code", "provider", "openai", "deepseek", "proxy"],
    "contributes": {
        "commands": [
            { "command": "vannevar.applyPatch",   "title": "Vannevar: Apply patch to Claude Code" },
            { "command": "vannevar.revertPatch",  "title": "Vannevar: Revert patch (restore Claude Code)" },
            { "command": "vannevar.status",       "title": "Vannevar: Patch status" },
            { "command": "vannevar.showLog",      "title": "Vannevar: Show log" },
            { "command": "vannevar.openProfiles", "title": "Vannevar: Open profiles folder" },
            { "command": "vannevar.installMcp",   "title": "Vannevar: Register the delegated-agent MCP server" }
        ],
        "configuration": {
            "title": "Vannevar Code",
            "properties": {
                "vannevar.autoPatch":       { "type": "boolean", "default": true,  "description": "Re-apply the patch by itself after a Claude Code update." }
            }
        }
    }
}
```

`extensionKind: ["workspace", "ui"]`: в Remote-SSH/WSL бандл Claude Code лежит на удалённой машине, и патчер должен жить там же. Сейчас `apply-patch.mjs:406` и `host.js:30` знают только `~/.vscode/extensions`.

## 3. extension.js — активация

1. **Найти бандл Claude Code.** `vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath`: точный путь на правильном хосте и в любом форке VS Code. Cursor, Windsurf и Insiders держат расширения в своих папках (`~/.cursor/extensions`, `~/.windsurf/extensions`, `~/.vscode-insiders/extensions`), Remote-SSH/WSL — в `~/.vscode-server/extensions` на удалённой машине; сегодняшний скан `~/.vscode/extensions` (apply-patch.mjs:406, host.js:30) их не видит, а API — видит без настроек. Корень для скана `.obsolete` и соседних версий — родитель этого пути. Настройки списка корней нет.
2. **Синхронизировать рантайм.** Сравнить `version` из своего package.json со `~/.claude/vannevar/patch-version.json`. Расходятся → скопировать `runtime/` целиком, записать stamp `{ version, verifiedAgainst, extensionPath }`. Совпадают → ничего.
3. **Патчить.** Версия сменилась → полный apply (поверх `*.ccx-orig`: хуки могли добавиться). Иначе `--if-needed`. Тот же lock на бандл, что и сейчас (несколько окон при восстановлении сессии).
4. **Сказать.** Три исхода как у keeper: тишина / «re-applied» + Reload Window / «does not fit 2.1.277» + кнопки **Check for Updates** (`workbench.extensions.action.checkForUpdates`) и **Show log**. `HEAL_HINTS` и «pull and re-run» исчезают.
5. **Миграция** с Vannevar — §6, до шага 3.
6. **MCP.** При первой активации (нет записи `vannevar-agents` в `claude mcp list`) регистрируется сразу: `claude mcp add --scope user vannevar-agents -- <execPath> ~/.claude/vannevar/mcp/agent-server.mjs`, бинарь `claude` ищется рядом с бандлом из п. 1 (`resources/native-binary/`), как в install-mcp.mjs. Одно уведомление по факту, без вопроса. Команда `vannevar.installMcp` — для повтора руками.
7. Node — `process.execPath` + `ELECTRON_RUN_AS_NODE=1`, как в keeper сейчас.

Тест `activation.test.mjs`: fake `vscode` через `require` hook, временный `$HOME`, проверка порядка «sync → apply → notification» для всех трёх исходов и обоих режимов (смена версии / `--if-needed`).

## 4. Что уходит из apply-patch.mjs и host.js

| Файл | Строки сейчас | Что |
|---|---|---|
| apply-patch.mjs | 18, 24 | путь в `HOST_LOAD`: `".claude","vannevar"` → `".claude","vannevar"` |
| apply-patch.mjs | ~453–500 | upstream-check: `upstreamUrl`, `upstreamLine`, `--no-upstream-check`, `CCX_UPSTREAM_URL`, строка `ccx-upstream:` |
| apply-patch.mjs | ~503–580 | self-update: `git()`, `heal*`, `--no-self-update`, `CCX_NO_SELF_UPDATE`, `ccx-heal-blocked`, `ccx-result: healed` |
| apply-patch.mjs | чтение версии | `verifiedAgainst[]` из stamp вместо `package.json` репозитория; «unverified» = installed ∉ verifiedAgainst |
| host.js | 11 | `DIR` → `.claude/vannevar` |
| host.js | 784–812 | `SELF_UPDATE_FILE`, `selfUpdateEnabled/Repo`, `setSelfUpdate`, строка меню «Update Vannevar by itself» и её обработчик в webview.js |
| host.js | watcher | см. §5 |
| webview.js, agent-server.mjs, install-mcp | 19 вхождений `vannevar` | путь, `VANNEVAR_RUNTIME_DIR` → `VANNEVAR_RUNTIME_DIR`, `SERVER_NAME` → `vannevar-agents` |
| test/ | self-update-toggle.test.mjs | удалить; update-watcher, auto-repatch, state-contract — править под новые пути и отсутствие heal |

Остаются: `--if-needed`, `--status`, `--revert`, lock, `ccx-result:` / `ccx-unverified:` строки, идемпотентность поверх `.ccx-orig`.

## 5. Watcher в host.js: обновление Claude Code при открытом окне

Сейчас watcher запускает замороженную копию `~/.claude/vannevar/apply-patch.mjs`. В день адаптации новые папки Claude Code и Vannevar появляются вместе; старая копия падает на уехавших сигнатурах, после reload новая версия чинит — два reload и одно ложное уведомление.

Новое поведение перед патчем: найти самую новую папку `beatlejute.vannevarcode-*` в том же корне, где лежит работающий бандл (родитель `__dirname` хука, а не `~/.vscode/extensions` — так watcher работает и в Cursor, и на удалённом хосте); если её версия новее stamp — скопировать из неё `runtime/` в `~/.claude/vannevar/` и уже потом патчить. Правило «ничего не качать при записи в чужой бандл» не нарушено: файлы пришли через updater VS Code. Тест — расширить `update-watcher.test.mjs`: два новых каталога сразу → один apply, один reload.

## 6. Миграция с Vannevar

На активации, если существует `~/.claude/vannevar/`:

1. Перенести состояние, только если целевого файла нет (паттерн `LEGACY_RUNTIME` из install.mjs): `bindings.json`, `pinned.json`, `hidden-messages.json`, `agent-health.json`, `full-history.json`, `chatgpt-auth.json`, `proxy.json`, папка `icons/`. Профили в `~/.claude/profiles/` общие, не трогаются.
2. Патч применить как обычно: он ложится поверх `*.ccx-orig`, старые хуки перезаписываются новыми с новым путём. Отдельный `--revert` старым патчером не нужен.
3. Старый keeper `local.vannevar-keeper` не будет драться: его `--if-needed` ищет `MARKER` (`filePatched`, apply-patch.mjs:609), а маркер тот же. Но он остаётся мусором: предложить деинсталляцию через `workbench.extensions.uninstallExtension`.
4. MCP: `claude mcp remove vannevar-agents --scope user`, затем регистрация `vannevar-agents` (§3 п. 6).
5. `~/.claude/vannevar/` не удалять — пользовательские данные; README говорит, что можно снести руками.
6. Репозиторий Vannevar пока не трогаем: из него забирается всё ценное (src, tests, docs/internals.md, скрипты, images), ветки и история остаются как есть. Пометка «superseded» — отдельным решением после 0.2.0.

Тест `migration.test.mjs`: временный `$HOME` с обеими папками, проверка «не перезаписывает существующее», «переносит всё перечисленное», «не удаляет источник».

## 7. Версии и релизы

- `0.1.0` — первый .vsix в GitHub Releases, установка руками, обкатка недели две.
- `0.2.0` — Marketplace + Open VSX.
- Дальше: адаптация к Claude Code — patch (`0.2.1`), фича — minor. Каждый релиз — git tag `v0.2.1`, запись в CHANGELOG с `verifiedAgainst`.
- Таблица «Vannevar ↔ Claude Code» в README генерируется из CHANGELOG, веток на версию Claude Code больше нет; откат для пользователя — «Install Another Version…» в VS Code.
- Pre-release канал Marketplace (отдельная ветка версий, на которую пользователь подписывается кнопкой «Switch to Pre-Release Version») — не заводим: уведомление «re-applied on 2.1.277, verified only against 2.1.276» уже покрывает случай «прошло по сигнатурам, глазами не смотрели».

## 8. CI/CD

`ci.yml` (push, PR): матрица ubuntu + windows (пути!), Node 20 и 22; запуск цепочки из `npm test`; `node scripts/build-vsix.mjs` как smoke-проверка упаковки.

`release.yml` (tag `v*`): build .vsix → GitHub Release с файлом → `vsce publish --packagePath` (секрет `VSCE_PAT`) → `ovsx publish` (секрет `OVSX_PAT`). Оба шага после `0.2.0`; до этого workflow только кладёт .vsix в Release.

`vsce` и `ovsx` — только в CI через `npx`, в проекте зависимостей по-прежнему нет.

## 9. Документы

- **README.md** — короче нынешнего: что делает, 5 скриншотов, установка (Marketplace / .vsix), профили, провайдеры и ChatGPT-подписка, как переживает обновления (§3–5 одним абзацем), миграция с Vannevar, ограничения, раздел **Why «Vannevar»** (ниже). Многостраничная история сигнатур уезжает в `docs/internals.md`.
- **DISCLAIMER.md** — как сейчас, с новым именем.
- **PRIVACY.md** — обязателен для Marketplace (типичная причина suspend — внешний трафик без policy). Само расширение в сеть не ходит (upstream-check удалён). Сеть: прокси → эндпоинты из `~/.claude/profiles/*.json`; OAuth ChatGPT → `auth.openai.com`; `fetch-favicons` — dev-скрипт, в расширение не входит. Ключи только в `~/.claude/profiles/` и `~/.claude/vannevar/chatgpt-auth.json`.
- **CHANGELOG.md** — по релизам, с `verifiedAgainst`.
- Листинг Marketplace: описание из package.json, категория Other, иконка своя (§10), «Claude Code» только описательно в тексте.

### Why «Vannevar» — черновик раздела README

> Claude, the model this extension switches away from and back to, is named after Claude Shannon. In 1936 Vannevar Bush, then at MIT, hired the young Shannon to run his differential analyzer — a room-sized mechanical computer — and pointed him at one question: what is the relationship between the machine's relay switches and mathematical logic? The answer became Shannon's 1937 master's thesis, *A Symbolic Analysis of Relay and Switching Circuits*, the paper that turned switching into algebra and made the digital computer possible.
>
> This extension is about switching too — every tab decides which provider its relay closes on. And it does for the Claude Code UI what Bush did for Shannon: it does not change what is inside, it lets it out. Bush later wrote *As We May Think*; the extension is named for the mentor rather than the machine because it was the pointer, not the analyzer, that set the work free.

Проверить перед публикацией: год найма (1936), название и год диссертации (1937, опубликована 1938), формулировку про дифференциальный анализатор — по Wikipedia/MIT.

## 10. Гигиена товарных знаков

- Ни «claude», ни «anthropic» в `name`, `displayName`, `publisher`, `icon`, имени репозитория.
- Иконка расширения — своя (реле/переключатель), никаких логотипов Anthropic. `claude-logo.svg` для стокового профиля по-прежнему скачивается `fetch-favicons` на машину пользователя, в .vsix не входит.
- Скриншоты UI Claude Code в README допустимы, в иконке и баннере — нет.
- В описании: «for the Claude Code extension», «works with Claude Code». Не «Claude Code Vannevar», не «Vannevar for Claude».
- Проверить имя в поиске marketplace.visualstudio.com руками до создания publisher (из shell API недоступен): удалённое имя резервируется навсегда.

## 11. Этапы

| # | Этап | Результат | Проверка |
|---|---|---|---|
| 0 | Аккаунты и репозиторий | GitHub `beatlejute/vannevar-code`, publisher `beatlejute` в Marketplace (Azure DevOps PAT), namespace `beatlejute` в Open VSX, имя проверено в поиске Marketplace | — |
| 1 | Скелет расширения | package.json §2, extension.js §3 без миграции, `runtime/` из `src/` как есть с путём `.claude/vannevar` | `code --install-extension`, чистая машина или временный `$HOME`: патч ложится, Switch provider… на месте |
| 2 | Перенос тестов | 26 тестов зелёные под новыми путями; `self-update-toggle` удалён | `npm test` на Windows и Linux |
| 3 | Удаление self-update и upstream | §4 | `apply-patch.mjs --help` не знает удалённых флагов; тесты |
| 4 | Watcher из новейшей папки | §5 | `update-watcher.test.mjs` с двумя новыми каталогами |
| 5 | Миграция с Vannevar | §6 + `migration.test.mjs` | на этой машине: keeper снят, состояние на месте, MCP перерегистрирован |
| 6 | CI и релиз 0.1.0 | `ci.yml`, `release.yml` без publish, .vsix в GitHub Release | установка .vsix из Release на второй машине |
| 7 | Документы | README, PRIVACY, CHANGELOG, DISCLAIMER, иконка | — |
| 8 | Релиз 0.2.0 | Marketplace + Open VSX через workflow | автообновление 0.2.0 → 0.2.1 на тестовой машине проходит по §3 |
| 9 | Vannevar | не трогаем; пометка «superseded» — после 0.2.0 отдельным решением | — |

## 12. Решения по открытым вопросам (2026-09-18)

1. Publisher — `beatlejute`.
2. MCP регистрируется сразу при первой активации, уведомление по факту (§3 п. 6).
3. Форки VS Code (Cursor, Windsurf, Insiders) и Remote — через `getExtension().extensionPath`, без настройки корней (§3 п. 1, §5).
4. Pre-release канал не заводим (§7).
5. Репозиторий Vannevar не трогаем, забираем из него всё ценное (§6 п. 6).
