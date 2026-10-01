# Changelog

The version is the Claude Code release the signatures were verified against. `Verified against` is the
whole list — one release of this extension usually fits several Claude Code builds — and a release
outside that list still takes the patch more often than not, with the notification saying so when it
does.

## Unreleased

A profile may declare how long its provider keeps a prompt prefix alive: `"cache": { "ttlMinutes": 60,
"source": "documented" }`. No provider returns a cache lifetime in a response, so a non-Anthropic
backend reports hits and no expiry; the declared number is what **Auto-compact before the cache
expires** counts down against there, where an Anthropic session counts down against the measured
1-hour tier. It is never presented as measured — `source` records whether the number came from
documentation or an operator's reading — and it travels to the page as a different kind of signal
(`ttl: "declared"`), with a floor of 15 minutes so a short-lived cache is ignored rather than compacted
between turns. `list_profiles` prints the declared lifetime beside each profile, and all three bundled
templates declare 60 minutes. The declared lifetime is also counted down where the app draws its own
indicator for the tiers it can measure — in the composer footer, immediately after the context-usage
chip, wearing the same classes and the same clock the stock countdown wears (lifted off the live DOM
and the stylesheet, since every name carries a per-build hash), and reading exactly as the stock one
does. The qualification lives in its tooltip instead: the profile the number came from, and the fact
that it is documentation rather than a measurement.

A run whose session ends no longer leaves a row that says "working" for the rest of the day. The MCP
server closes the manifest of every run it still has open when its client closes the pipe — the ordinary
end of a server, a window reload included — where it used to kill the children and exit with the
manifests still saying `running`. The agent map is drawn from those manifests, so a run left that way is
indistinguishable from a live one: the row sits in the dialog, and **Stop agent** on it writes a request
into a file no process will ever poll — the host has nothing to go on but the manifest, and the manifest
says running. Closing them is what makes that button honest again on a run that has already ended, and
what stops a dead run from being counted among the working ones.

The agent map says when each subagent was called. A row's meta line was a duration and a token count —
`5m 1s · 77.9k tokens` — which two runs of the same length share, and the time the run started now
leads it (`09:05 · 5m 1s · 77.9k tokens`), in the machine's own zone, 24-hour. A run from another day
carries its date as well (`18 Sep 14:32`, and `18 Sep 2025 14:32` once the year is not this one), since
the map is rebuilt when an old session is reopened and a bare clock there reads as this morning's. It
is the app's own row that carries it, so every subagent in the dialog gets it, not only the ones
delegated through the bundled MCP server.

A session's external resources are now countable without scrolling. A **resources** pill sits in the
composer footer beside the stock **agents** pill, carrying a set count — links written in messages,
pages a `WebFetch` call went to, links a `WebSearch` returned, files tool calls read or wrote, and
images and documents attached to a prompt — and the dialog behind it groups them into sections in
first-seen order, with a resource mentioned many times collapsing into one row that shows how many
times (`×3`) and when it was first said — the clock for a message from today, the date in front of it
for an older one, and the year once that is not the current one, the same rule the agent map's rows
follow. The count is of distinct resources, which is the only number worth carrying: a URL
written twice and fetched once is one resource, and the same URL reached from a message and from a
tool call is one row, in the section where it first appeared, with both origins in its tooltip. Every
URL is compared by scheme and host lowercased, so two spellings of one page do not become two rows.
What came from the user is set apart from what the model brought in: those rows carry a **you** tag and
lead their section, because a URL from a prompt and a URL from a reply look exactly alike. Whose it is
is decided by the *first* mention — the model echoing a link the user pasted is still the user's link,
while a link the model wrote and the user quoted back later is not. A tool result is not the user
speaking, though it arrives on their side of the conversation, and neither is a subagent's turn: only
the turns they actually typed, and the images and documents they attached, are marked. A compaction
summary is skipped whole — it is the conversation again in one message of the user's, so every link in
it is already counted where it came from, and counting it a second time would both double them and
claim them all for the user.

An attached image is drawn as itself: the row leads with the picture, wearing the composer chip's own
thumbnail class, and its pixel size lands beside the name once the image has decoded — the same pair
the chip shows. A document gets no thumbnail, having none in the composer either. The list is read
entirely from the transcript the tab already holds — nothing is asked of the host to draw it.

The repository is part of the session's resources too: the branches it created or moved to, the commits
it wrote and the worktrees it added, read out of git's own grammar — `checkout -b`, `switch -c`,
`branch`, `worktree add` — and out of what git prints back (`Switched to branch 'x'`, and the
`[main 4f2a1c3] subject` line a commit answers with). A commit made quietly — `git commit -q`, or one
written through a heredoc — prints no such line, so its hash is taken from what the same command line
did next: the `old..new` a push reports, and the one-line log read back beside it, which is also where
its subject comes from. A worktree is named by its path, which git puts in the first argument that is
neither an option nor an option's value — the last token of the line is a branch when a commit-ish
follows the path, and `2>` when the command redirected its output. A bare `git checkout x` is
deliberately not read from the command line, since that call may be restoring a file. Neither a branch nor a commit has anything to open, so those rows
are not drawn as clickable — their jump is the arrow.

A commit the session only looked at is a resource as well, and the two are told apart on the row: a
**made** tag for what was written or added here, a **seen** tag for what a listing merely showed —
`git log`, `git worktree list`. The seen ones sit under a fold of their own inside Commits and
Worktrees, shut by default, because the section is about work done here and a `git log` of twenty
commits would otherwise bury it; a branch has no such split, every branch in the list being somewhere
the session went. Which is which is not a guess but the question the command itself
answers: a commit made with `-q` is still the session's own, because the push or the log beside it is
on the same command line, while a hash from a bare `git log -20` is marked as read. A commit that was
read first and written later is marked by what the session did with it — reading a hash does not stop
it being yours once you push it.

Sections fold, and **Files** arrive folded: a working session has more of them than of anything else,
and the list is opened for what was said and what was committed first. What was folded stays folded
through the repaints a live session causes.

A row also goes back to where it came from: an arrow on it closes the dialog, scrolls the transcript
to the message the resource first appeared in and marks that message for a moment, so a link pasted
three turns up can be read in its context rather than only in the list. The message is found by the
app's own `data-bookmark-uuid` attribute where it is there, by the node's fiber where it is not, and by
the value the row holds as a last resort — a URL pasted into a prompt is in the bubble verbatim. A
message the page holds without drawing a bubble of its own — a tool result is one — is reached by the
turn that contains it, and the row says it landed near rather than on it. A resource from further back
than the app renders at all lands at the top of what it has, and there the switch that lifts that trim
— **History before compaction** — is named, since scrolling cannot reach what the app never drew.

Every row opens what it names: an http(s) link through the OS, an absolute path in the
editor, and an attached image or document by being written to a file first, since a pasted screenshot
exists in the transcript and nowhere else — the same attachment opened twice reuses its file. What
cannot be opened is refused with the reason shown rather than guessed at: a relative path has no
directory to be resolved against, a scheme that is not http(s) never reaches the shell, and an
attachment past a dozen megabytes is refused instead of being moved. A row naming a folder — a search
tool names one with its `path` — is revealed in the explorer rather than fed to the editor as a file.

## 2.1.286

Verified against Claude Code **2.1.286**, **2.1.285**, **2.1.284**, **2.1.283**, **2.1.282**, **2.1.280**,
**2.1.278**, **2.1.276**, **2.1.274**.

Claude Code 2.1.286 cost one signature, and not to a rename. The spawn environment is no longer the
result of the helper that adds the interrupted-turn resume marker: it is spread into an object literal
together with a new 15th `spawnClaude` parameter, so `O.env={...Wl1(P,q===!0),...N}` where 2.1.285 had
`F.env=xp1(_,q===!0)`. Injection point #3 stopped matching the leading `{`, and now takes either shape —
the one-level object literal or the older identifier/call.

- The environment it hands `envFor` is the whole merged object, not just the helper's half. That is what
  keeps the per-tab profile in charge: `envFor` deletes the managed keys from the object it is given and
  assigns its own over the top, so the new `...N` spread — last-wins if the CLI were left to it — cannot
  put a provider back. The config probe's `{CLAUDE_CODE_CONFIG_PROBE:"1"}` is not a managed key and
  survives the merge untouched.
- Every other signature matched the shape it already matched: #2's icon pair stayed `light:G,dark:G` for
  a fourth release, and the webview's eleven points were untouched. The settings schema is 2.1.285's
  exactly but for its generation timestamp, and `package.json` differs only in its version string.

## 2.1.285

Verified against Claude Code **2.1.285**, **2.1.284**, **2.1.283**, **2.1.282**, **2.1.280**, **2.1.278**,
**2.1.276**, **2.1.274**.

Claude Code 2.1.285 cost no signature: of the two anchors written structurally for exactly this, only
the session environment's renamed, and every injection point matched the shape it already matched. What
it did change is the one thing the agent map below takes from Claude Code without a signature: the
dialog behind a row now reads a transcript in pages, and *Open transcript* on a delegated run answers in
whichever shape the running release asks for.

- A machine whose managed settings list `allowedProviders` — new in Claude Code 2.1.285, and read from
  managed settings only — refuses a tab on any provider the list leaves out, at startup and again at
  the next request. Every profile that sets `ANTHROPIC_BASE_URL`, which is every template here, counts
  as `customEndpoint`, and that entry admits only the address the same managed source pins in its own
  `env`. That is the policy doing its job; nothing here goes around it.
- Message timestamps are gone from this extension. Claude Code 2.1.284 draws its own — a time on every
  message and a date line where the day changes — behind **Claude Code: Show Message Timestamps**
  (`claudeCode.showMessageTimestamps`, off by default), and two sets of the same labels on one message
  were the only thing the pair could produce. Turn the stock setting on to keep seeing times. On a
  Claude Code older than 2.1.284 there is no setting to turn on, and messages carry no time at all.
- Delegated runs appear in Claude Code's agent map, beside its own subagents. Each `run_agent` call is a
  row under whichever agent made it, named by its profile and a short label, with its time and context;
  a run started by a subagent whose turns never reach the tab sits at the top, and a run another run
  started hangs under that run. The pill beside the model picker counts them. Behind a row, *Open
  transcript* shows the run's whole conversation, and *Stop agent* ends it — the run's MCP server stops
  it and tells the calling agent the user did. `run_agent` takes an optional `description` for the label;
  without one the first line of the prompt stands in. The card's model segment follows the call's own
  `model`, or the tab's model when the call named none, and its tool-call list stays empty: Claude Code
  draws both from the tab.

## 2.1.284

Verified against Claude Code **2.1.284**, **2.1.283**, **2.1.282**, **2.1.280**, **2.1.278**, **2.1.276**,
**2.1.274**.

Claude Code 2.1.284 is the first release since 2.1.274 to cost signatures, and it cost two, neither of
them to a rename. The walk that rebuilds a reopened transcript took a second parameter, which kept
*History before compaction* from finding it, and the Model section gained a stock *Ultracode* row,
which changed the list that orders that section. Both are now matched by their shape, and every release
already on the list still takes the patch.

- A patch refused over the second file no longer leaves the first one written. The patcher wrote
  `extension.js` before it had looked at `webview/index.js`, so a signature that moved only in the
  webview left Claude Code carrying half its hooks, with no result line to say so. Every file is now
  patched in memory first, and nothing is written unless all of them take the patch. It did not bite
  on 2.1.284, where the signature that moved first is in `extension.js`.
- Claude Code 2.1.284 has message timestamps of its own, behind `claudeCode.showMessageTimestamps` and
  off by default. Turned on, every message carries two times, the stock one and this extension's, and a
  change of day two date lines.

## 2.1.283

Verified against Claude Code **2.1.283**, **2.1.282**, **2.1.280**, **2.1.278**, **2.1.276**, **2.1.274**.

Claude Code 2.1.283 cost no signature: of the two anchors written structurally for exactly this, only
the session environment's renamed this time, and every injection point matched the shape it already
matched. Nothing else in the extension changed.

## 2.1.282

Verified against Claude Code **2.1.282**, **2.1.280**, **2.1.278**, **2.1.276**, **2.1.274**.

Claude Code 2.1.282 cost no signature: the two anchors written structurally for exactly this renamed
for the fourth release running, and every injection point matched the shape it already matched.
Nothing else in the extension changed. Claude Code 2.1.281 never landed here — this extension's own
2.1.281 is the Open VSX re-publish below and has nothing to do with it.

## 2.1.281

Verified against Claude Code **2.1.280**, **2.1.278**, **2.1.276**, **2.1.274**.

Nothing in the extension changed. Open VSX reserves a version identity permanently once it has been
published — deleting the upload does not give the number back — and 2.1.280 was uploaded there before
the publisher agreement was signed, which leaves it deactivated and unrepublishable. This release
carries the same code under the next patch number so the Open VSX listing can exist at all; the
Marketplace and the `.vsix` in the GitHub release are unaffected, and `verifiedAgainst` stays as it
was, because the build this was verified against did not move.

## 2.1.280

Verified against Claude Code **2.1.280**, **2.1.278**, **2.1.276**, **2.1.274**.

Claude Code 2.1.280 cost no signature either: every injection point matched the shape it already
matched, through a third rename running of the two anchors that are written structurally for exactly
that reason. 2.1.279 never landed here, so the patch number this release had taken under Claude Code
2.1.278 goes unused and the work below ships under the new build instead.

- A Gemini profile. `templates/profiles/gemini.json` routes a tab through the adapter to the Gemini
  API, which it speaks natively (`generateContent`) instead of through Google's OpenAI compatibility
  layer: tool schemas go as JSON Schema, Gemini 3's thought signatures come back with the calls they
  belong to, and a tool call ends the turn as `tool_use`. An existing `~/.claude/profiles` gets the
  new template on the next window; nothing already there is touched.
- The adapter reads a stream framed with `\r\n` and delivers a last event that has no blank line
  after it.
- Auto mode stops being interrupted on a third-party profile. From Claude Code 2.1.278 auto mode asks
  the server to run its safety classifier inside the session's own requests — a `safeguards` field
  out, `safeguard_results` back — and charges nothing for it. No endpoint this extension routes to
  answers that way: the adapter translates to the Responses or Gemini protocol entirely, and DeepSeek
  or GLM never saw the field. The CLI used to discover that by holding the first checked action
  behind a notice saying the session is not eligible. A profile that routes away from
  `api.anthropic.com` now says so up front with `CLAUDE_CODE_AUTO_MODE_SERVER=0`, which keeps auto
  mode on the CLI's own classifier requests — the same checks, billed as token usage as they always
  were. The subscription profile, a profile that only swaps the Anthropic account, and Bedrock and
  Vertex all keep the free server-side checks, and a value you set yourself still wins.

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
