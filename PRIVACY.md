# Privacy

Short version: the extension itself sends nothing anywhere. Everything it stores is a file on your own
machine, and the only network traffic is the traffic you asked for — your conversation going to the
provider you picked.

## What the extension sends

Nothing. There is no telemetry, no analytics, no crash reporting, no update check and no phone-home of
any kind. The extension makes no network request on its own behalf, ever.

## What goes over the network because you asked for it

- **Your conversations**, to the provider of the profile the tab is running on. The endpoint is the
  `ANTHROPIC_BASE_URL` in that profile — your file, your choice of provider. On a profile with an empty
  `env` nothing changes about where Claude Code was already sending things.
- **The protocol adapter** runs on `127.0.0.1` and is reachable only from this machine. It translates
  between the Anthropic protocol and the OpenAI Chat Completions or Responses API and forwards to the
  endpoint the profile names. It stores no conversation content.
- **The ChatGPT subscription mode**, if you use it, signs in against `auth.openai.com` with the OAuth
  flow the Codex CLI uses, and then talks to OpenAI's API. Tokens are written to
  `~/.claude/vannevar/chatgpt-auth.json` on this machine and are sent to nobody else.
- **Provider icons**, if you ask for them: a development script downloads each provider's favicon from
  that provider's own site onto your machine. It is not part of the published extension.

## What is stored, and where

All of it under your home directory, in plain files you can read and delete:

| Path | What |
|---|---|
| `~/.claude/profiles/*.json` | your profiles, including API keys — written by you, read by the extension |
| `~/.claude/vannevar/bindings.json` | which profile each session ran on |
| `~/.claude/vannevar/pinned.json` | session ids pinned to the top of the list |
| `~/.claude/vannevar/hidden-messages.json` | messages you took back |
| `~/.claude/vannevar/agent-health.json` | the last answer each provider gave |
| `~/.claude/vannevar/chatgpt-auth.json` | ChatGPT OAuth tokens, if you use that mode |
| `~/.claude/vannevar/proxy.json` | adapter settings |
| `~/.claude/vannevar/icons/` | downloaded provider icons |
| `~/.claude/vannevar/debug.log`, `extension.log` | local diagnostics: which profile a spawn used, what the patcher did |

`~/.claude/settings.json` is never modified. Nothing in this list is uploaded, synced or shared, and
deleting `~/.claude/vannevar/` removes everything the extension has ever stored.

## Spellcheck

Russian spellchecking runs locally against a Hunspell dictionary. Only bounded, de-duplicated single
words leave the webview, and they go to the extension host on the same machine — no draft text is sent
over the network.

## Third parties

Your provider and, in subscription mode, OpenAI receive whatever you send them and handle it under their
own privacy policies. The authors of this extension receive nothing and have no way to.
