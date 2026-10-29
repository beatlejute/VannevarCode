# AST Toolchain Decision

## Decision
Выбран подход на основе **@babel/parser + @babel/traverse** как основной AST toolchain для Node >=18 adaptation workflow. Решение обеспечивает raw source ranges, отсутствие eval, возможность owner/module fingerprints и понятный способ distribution в VSIX/runtime.

## Alternatives
### Alternative A — @babel/parser + @babel/traverse
**Source ranges:** поддержка `loc` и `start/end` с raw source mapping.  
**Syntax coverage:** полная поддержка ECMAScript 2023+, JSX, TypeScript-моды, unstable proposals при включении плагинов.  
**Distribution strategy:** пакет `@babel/parser` и `@babel/traverse` доступны как CommonJS/ESM, размер ~2.5 MB unpacked, можно bundle в VSIX через `scripts/build-vsix.mjs`. Нет runtime eval.

### Alternative B — acorn + acorn-walk
**Source ranges:** `start`, `end`, `loc` с опцией `ranges` и `locations`.  
**Syntax coverage:** чистый ECMAScript, без встроенной TypeScript/JSX поддержки; требует дополнительных плагинов для расширения.  
**Distribution strategy:** минимальный footprint ~300 KB, быстрый парсинг, CommonJS, легко ship в runtime. Ограничение по синтаксису для edge cases.

## Node >=18 Requirements
- Работает на Node >=18 без дополнительных нативных модулей.
- Парсер должен сохранять raw source ranges для каждого узла, чтобы патчи применялись к pristine source.
- Запрещено использование eval, Function constructor или динамического выполнения upstream кода.

## Raw source
Оба подхода возвращают raw source ranges. Babel сохраняет точные позиции с учётом комментариев и whitespace; acorn — точные смещения. Требуется provenance от normalized node к `start/end` в исходном файле.

## Distribution
- VSIX/runtime shipping: Babel toolchain требует bundling зависимостей, увеличивает размер VSIX. Acorn легче.
- Для adaptation workflow выбран Babel из-за синтаксического покрытия и стабильности диапазонов.
- Distribution strategy подразумевает включение parser/traverse в `runtime/` и явное перечисление в `scripts/build-vsix.mjs`.

## Eval
Оба подхода не используют eval. Запрещены любые deobfuscation техники через `eval` или `Function`. Semantic normalization выполняется analysis-only.

## ARCHITECTURE_REVIEW
Решение требует ARCHITECTURE_REVIEW при следующих edge cases:
- unsupported syntax в minified bundle;
- unstable ranges при трансформированном коде;
- dependency слишком тяжёлая для runtime;
- runtime package не включает dependency.

Рекомендации по mitigations записаны в заметках плана.
