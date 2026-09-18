# Working in this repository

## What this is

One VS Code extension. `extension.js` is the entry point and does the installing; `runtime/` is what it
copies into `~/.claude/vannevar` and is the code that actually runs inside Claude Code. There are no
dependencies and nothing to build — the `.vsix` is written by `scripts/build-vsix.mjs`.

## Branches

Two kinds of branch exist here, and nothing else is kept:

- **`main`** — where the work happens. Commit straight onto it. No feature branches, no pull requests,
  no merge commits; `main` always tracks the newest Claude Code release the signatures were verified
  against.
- **`v<version>`** — one per released version, pointing at the last commit that still works with that
  Claude Code release, so an older install stays reproducible. Written once, when `main` moves on to
  the next release, and never developed on.

Anything else is rubbish: a `feat/…`, a branch named after whatever it was trying, a leftover from an
experiment. Delete it locally and on `origin` as soon as its commits are in `main`.

Never create a branch to hold ordinary work, and never leave one behind after merging. Do not offer a
pull request — the change goes on `main` and gets pushed.

Before deleting any branch, check that `main` already contains it (`git branch --merged main`, and
`git branch -d`, never `-D`). A release branch is kept even when it is *not* merged — that is the whole
point of it.

## Versions

`version` in `package.json` **is the Claude Code version the signatures were verified against**, as it
was in Claudapter: Claude Code 2.1.276 → Vannevar Code 2.1.276. The number is the compatibility
statement, and it is what the Marketplace shows.

`verifiedAgainst` carries the whole list, newest first — one release of this extension often fits
several Claude Code builds (2.1.276 and 2.1.274 share every signature). `version` is the first entry of
that list; the patcher flags anything outside it as unverified.

Adapting to a new Claude Code release: add it to the front of `verifiedAgainst`, set `version` to it,
write a CHANGELOG entry, tag `v<version>`. `release.yml` refuses a tag that does not match
`package.json`.

**The one place this scheme runs out.** A second release under the same Claude Code build — a bug fix
between their releases — has no number left: the Marketplace takes `major.minor.patch` and nothing
else, and it refuses a version it has already seen. There is no spare component, so that release takes
the next patch number (`2.1.277` under Claude Code 2.1.276) and `verifiedAgainst` stays as it was. From
that point `verifiedAgainst`, not `version`, is the truth about compatibility — which is why every part
of the code that decides anything reads the list and not the number.

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
