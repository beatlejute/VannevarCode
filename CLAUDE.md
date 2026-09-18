# Working in this repository

## What this is

One VS Code extension. `extension.js` is the entry point and does the installing; `runtime/` is what it
copies into `~/.claude/vannevar` and is the code that actually runs inside Claude Code. There are no
dependencies and nothing to build — the `.vsix` is written by `scripts/build-vsix.mjs`.

## Branches

`main` is where the work happens. Commit straight onto it: no feature branches, no pull requests, no
merge commits. There are no version branches any more — an older release is a `.vsix` in GitHub
Releases and *Install Another Version…* in the Extensions view.

Anything else is rubbish: a `feat/…`, a branch named after whatever it was trying, a leftover from an
experiment. Delete it locally and on `origin` as soon as its commits are in `main`, checking first that
`main` contains it (`git branch --merged main`, and `git branch -d`, never `-D`).

## Versions

`version` in `package.json` is the extension's own, semver, and is what the Marketplace sees.
`verifiedAgainst` is the list of Claude Code releases whose bundles the signatures were actually checked
against — adapting to a new release means adding it there, bumping the patch version and writing a
CHANGELOG entry. A release tag is `v<version>` and has to match `package.json`, which `release.yml`
checks.

## The internal names do not change

`__ccx`, `ccx:*`, `globalThis.__ccxState`, `*.ccx-orig`. The patcher's "is this file already patched"
test is a search for that marker and every test pins it; renaming them buys nothing and breaks the
detector. Only user-visible strings, paths and command ids say Vannevar.

## Tests

`npm test` runs all of them, in order, with no test runner. They are plain `node` scripts that stub
`vscode`, `os.homedir` and `child_process` through `Module._load` — never let one touch the real
`~/.claude` or spawn the real `claude` CLI, because that would rewrite the machine's own MCP
registration. `auto-repatch.test.mjs` does read the installed Claude Code bundle, deliberately: the
apply path has to be exercised against a real release.
