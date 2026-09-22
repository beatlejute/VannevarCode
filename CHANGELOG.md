# Changelog

The version is the Claude Code release the signatures were verified against. `Verified against` is the
whole list — one release of this extension usually fits several Claude Code builds — and a release
outside that list still takes the patch more often than not, with the notification saying so when it
does.

## Unreleased

- A Gemini profile. `templates/profiles/gemini.json` routes a tab through the adapter to the Gemini
  API, which it speaks natively (`generateContent`) instead of through Google's OpenAI compatibility
  layer: tool schemas go as JSON Schema, Gemini 3's thought signatures come back with the calls they
  belong to, and a tool call ends the turn as `tool_use`. An existing `~/.claude/profiles` gets the
  new template on the next window; nothing already there is touched.
- The adapter reads a stream framed with `\r\n` and delivers a last event that has no blank line
  after it.

## 2.1.278

Verified against Claude Code **2.1.278**, **2.1.276**, **2.1.274**.

Claude Code 2.1.278 cost no signature: every injection point matched the shape it already matched,
through a rename of the two anchors that are written structurally for exactly that reason. 2.1.277
never landed here.

- The ChatGPT sign-in happens in the editor instead of a terminal. VS Code opens the sign-in page —
  which is what resolves the real browser, and what forwards the callback port in a remote window —
  and a progress notification holds the wait. The same flow is on the command menu's Settings
  section, beside the account Claude Code itself is signed in with.

## 2.1.276

Verified against Claude Code **2.1.276**, **2.1.274**.

First release. Everything the patch did as a hand-installed git clone, now installed and kept up to
date by VS Code.

- One extension instead of a repository, an installer script and a companion keeper extension. On the
  first window it copies its runtime into `~/.claude/vannevar`, patches the installed Claude Code
  bundle, installs the template profiles and registers the delegated-agent MCP server.
- The runtime directory is `~/.claude/vannevar`, the MCP server is `vannevar-agents`, and the
  environment variables the delegation server reads are `VANNEVAR_*`.
- The Claude Code bundle is found through `vscode.extensions.getExtension`, so Cursor, Windsurf,
  Insiders and Remote-SSH/WSL hosts work without configuring anything. Previously only
  `~/.vscode/extensions` was searched.
- Self-update and the upstream version check are gone. Nothing is fetched and nothing pulls a git
  clone in the background: a patch that no longer fits is reported, and the fix arrives as an ordinary
  extension update.
- A Claude Code update that lands together with a Vannevar Code update now refreshes the runtime from
  the newer extension folder before patching, so it takes one reload instead of two.
