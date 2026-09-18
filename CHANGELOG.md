# Changelog

Versions are the extension's own. `Verified against` is the list of Claude Code releases whose bundles
the patch signatures were actually checked against — a release outside that list usually still takes the
patch, and the notification says so when it does.

## 0.1.0

Verified against Claude Code **2.1.276**, **2.1.274**.

First release as a VS Code extension. Same feature set as Claudapter 2.1.276, installed and kept up to
date by VS Code instead of by a git clone.

- One extension instead of a repository, an installer script and a companion keeper extension. On the
  first window it copies its runtime into `~/.claude/vannevar`, patches the installed Claude Code
  bundle, installs the template profiles and registers the delegated-agent MCP server.
- The Claude Code bundle is found through `vscode.extensions.getExtension`, so Cursor, Windsurf,
  Insiders and Remote-SSH/WSL hosts work without configuring anything. Previously only
  `~/.vscode/extensions` was searched.
- Self-update and the upstream version check are gone. Nothing is fetched and nothing pulls a git
  clone in the background: a patch that no longer fits is reported, and the fix arrives as an ordinary
  extension update.
- A Claude Code update that lands together with a Vannevar Code update now refreshes the runtime from
  the newer extension folder before patching, so it takes one reload instead of two.
- State carries over from `~/.claude/claudapter/` on the first window, and nothing there is deleted.
