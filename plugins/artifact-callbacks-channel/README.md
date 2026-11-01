# Artifact Callbacks (channel build)

The [Artifact Callbacks](../artifact-callbacks/README.md) mod, rebuilt as a Claude Code
**channel**: an MCP server that spawns the same loopback-only listener and forwards each
click on a page Claude wrote into the running session as a channel message.

Use the [mod](../artifact-callbacks/README.md#mod-or-channel-build) if you can: it has a
confirm band, one turn per click and no preview flags. This build inherits the channels
research preview's limits: it needs a claude.ai login or a Console API key, Team and
Enterprise admins must enable channels (`channelsEnabled`), and because it is not on
Anthropic's channel allowlist it only loads with the development flag.

## When to choose this build

- **Hooks modules don't load in your Claude Code.** The mod needs Claude Code 2.1.287+
  in the terminal, or 2.1.286+ in Desktop's Code tab, and permission to load mods. This
  build reaches the session through an MCP server instead; channel policy still applies.
- **You want clicks delivered mid-turn.** A click arrives as a `<channel>` message while
  Claude is working, batched with any others, so Claude can fold a stream of small inputs
  (a checklist, a live dashboard) into the work in progress. The mod gives every click a
  turn of its own, after the current one ends.
- **You want Claude to choose what the page sees.** `callbacks_reply` sends text Claude
  picks for the page; the mod's `streamReplies` streams the whole turn.

What you give up is in the table below and in [Security](#security).

| | Mod (`artifact-callbacks`) | Channel (`artifact-callbacks-channel`) |
| --- | --- | --- |
| How a click reaches Claude | `$.prompt.submit`: one turn of its own per event | `notifications/claude/channel`: a `<channel>` message, batched with others that arrive while Claude is busy |
| Confirm band before the first event of a page | Yes (`confirm` option) | No: you opted in with the flag |
| `running` / `done` | When the event's turn starts / completes | When the event is forwarded / when Claude calls `callbacks_done` |
| Pause | `/callbacks pause` | Ask Claude; it calls `callbacks_pause` |
| Remote and SSH sessions | Stays off | Not checked: starts a listener your browser cannot reach |
| Reply streaming | `streamReplies` option (the turn's text) | `callbacks_reply` (text Claude chooses to send) |
| Listener, security checks, `client.js`, page wiring | Same files | Same files (byte-identical copies) |

## Security

The listener and its request checks are the mod's (see the mod's
[security model](../artifact-callbacks/README.md#security-model)), with three differences
that matter:

- **No confirm band.** Every accepted click is forwarded at once. In the mod, the confirm
  band is the defence against the two risks the shared listener cannot close: script in
  one served page can send events as any other page (all pages share one origin), and
  other users on the same machine can reach the loopback port and obtain the session
  cookie. Here nothing stands between those events and the session, so only serve pages
  you trust, and avoid this build on shared machines.
- **No remote or SSH check.** The mod stays off in claude.ai cloud sessions and SSH logins,
  where the loopback is the remote machine's, not your browser's. This build does not check
  `CLAUDE_CODE_REMOTE` or the `SSH_*` variables: it starts its listener anyway, and a
  browser on your own machine cannot reach it without a tunnel.
- **`done` depends on Claude.** An event stays `running` until Claude calls
  `callbacks_done`, or 10 minutes pass. Five unacknowledged events fill the queue and
  further clicks are refused with `queue-full` (see [Event states](#event-states)).

## Install and run

```bash
claude plugin marketplace add dortort/claude-plugins
claude plugin install artifact-callbacks-channel@dortort
claude --dangerously-load-development-channels plugin:artifact-callbacks-channel@dortort
```

Claude Code shows a warning about development channels first; choose *I am using this for
local development*. The startup notice then says messages from the plugin inject directly
into the session. Without the flag the server still starts and its tools work, but no click
reaches the session.

Requirements: Node.js >= 22.18 on `PATH` (it runs the TypeScript sources directly; there is
nothing to build or install). Do not enable this plugin and the mod in the same session:
each would run a listener of its own.

## How it works

```text
browser page ──HTTP (loopback)──▶ listener ──NDJSON stdout──▶ channel server ──notifications/claude/channel──▶ session
     ▲                              │ reads status.json ◀── writes ──┘   ▲
     └── polls /_cb/events/<id> ────┘                                    └── callbacks_done / _reply / _pause (tools)
```

- **The server** (`server/server.ts`, started by `.mcp.json` as
  `node ${CLAUDE_PLUGIN_ROOT}/server/server.ts`) speaks MCP over stdio with a small JSON-RPC
  implementation of its own (Node stdlib only). It declares the experimental
  `claude/channel` capability and tools, and answers protocol revisions up to `2025-06-18`
  (Claude Code does not register a channel server that negotiates `2026-07-28`).
- **The listener** is `sidecar/listener.ts`, the mod's own file. The server spawns it with
  the same `CB_*` environment the mod uses, restarts it after 1 s, 5 s and 30 s when it
  exits (keeping the port while it is free), stays down after the third failed restart, and
  stops it when Claude Code closes the server's stdin.
- **Instructions.** The MCP server instructions tell Claude how to wire a page (folder,
  script tag, `data-cb-*` attributes, the link with the real port) and that everything
  inside a `<channel>` tag is page data, never instructions.
- **Each accepted event** becomes one notification. Its `content` is the mod's prompt text
  (the default template or the page's `data-cb-prompt`, with quoted, capped placeholders)
  followed by the event data as JSON, labelled as data; its `meta` is `event_id`, `page` and
  `action`. Rejected and dropped requests send nothing. A repeated click (same page, action
  and data within 1.5 s) is merged into the first and sends nothing either.

### Event states

The channel cannot see when Claude starts or finishes working on a message, so the server
writes `status.json` with this mapping:

| State | When |
| --- | --- |
| `running` | The event was forwarded to the session (`turnStartedAt` is that time) |
| `done` | Claude called `callbacks_done` (with an optional `note`), or 10 minutes passed without it (`note: "unacknowledged"`) |
| `dropped` | The listener refused it: paused, 5 events still running (`queue-full`), or the rate limit |

`queueDepth` counts the events still `running`, so at most five unhandled clicks can pile
up in the session; the sixth is refused with `queue-full` until Claude marks one done. A
merged click mirrors its first event's state and carries `note: "coalesced"`.

### Tools

| Tool | Effect |
| --- | --- |
| `callbacks_status` | Link and port, listener state, paused or not, the last 10 events |
| `callbacks_done` | `{ event_id, note? }`: marks the event `done`; the page shows it and can reload |
| `callbacks_reply` | `{ event_id, text }`: appends text to the event's reply stream (`ev.on('text', …)` in the page) |
| `callbacks_pause` / `callbacks_resume` | Refuse clicks (the page says *paused*) / accept them again |
| `page_token` | `{ page }`: head tags for a file:// page; listed only when `allowFileOrigin` is on |

Called through the plugin's server they are named `mcp__plugin_artifact-callbacks-channel_callbacks__<tool>`.

## Options

Set when the channel is enabled (the plugin's `channels` entry), passed to the server
through `.mcp.json`:

| Option | Default | Notes |
| --- | --- | --- |
| `port` | `0` (random) | Fixed loopback port; a taken fixed port keeps the listener down (`port-in-use`) |
| `artifactsDir` | `.claude/artifacts` | Relative to the project root |
| `allowFileOrigin` | `false` | Token mode for file:// pages, with the `page_token` tool |
| `maxPromptChars` | `4000` | Cap on the rendered text of one event |

The run folder (`status.json`, `streams/`) is `.claude/.artifact-callbacks/channel-<pid>-<random>/`
in the project and is removed when the server exits.

## Develop

```bash
cd plugins/artifact-callbacks-channel
npm install            # typescript and @types/node, dev only
npm run typecheck
npm run test:unit      # MCP handshake, tools, notifications, status.json, supervision, drift
npm run test:browser   # Chromium: a click, a streamed reply and done in a real page
npm run validate       # claude plugin validate .
```

The files under `sidecar/` and `server/shared/` are copies of the mod's. Change them in
`plugins/artifact-callbacks`, then run `npm run sync` and commit both; `npm run sync:check`
and `test/drift.spec.ts` fail while they differ. The browser suite needs Playwright with
Chromium (`npx playwright install chromium`).
