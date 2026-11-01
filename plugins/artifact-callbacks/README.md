# Artifact Callbacks

A Claude Code mod that turns clicks on HTML pages Claude writes into follow-up prompts in
the **running** session. Claude writes `triage.html` with *Fix* and *Skip* buttons, you
open it in your browser, click *Fix* on one test, and a new turn starts in the same
session: "From triage.html: the user chose fix for `test_auth_refresh`". Claude does the
work and rewrites the page; the page shows *queued → running → done*.

Everything stays on your machine: the listener binds `127.0.0.1` only, on a random port,
and only pages served by this session can trigger prompts.

## Install

```bash
claude plugin marketplace add dortort/claude-plugins
claude plugin install artifact-callbacks@dortort
```

Or, at the prompt of a terminal session:

```text
/plugin install artifact-callbacks --marketplace dortort/claude-plugins
```

Requirements: Claude Code with mods (hooks modules), and either Node.js >= 18 or
Python >= 3.8 on `PATH` for the listener. Nothing else to configure: the next
interactive session starts the listener and tells Claude how to wire a page.

## How it works

```text
browser page ──HTTP (loopback)──▶ sidecar listener ──NDJSON stdout──▶ hooks module ──$.prompt.submit──▶ session
     ▲                                  │  reads status.json  ◀── writes ──┘
     └──────── polls /_cb/events/<id> ──┘
```

1. **Session start.** The hooks module (`hooks/register.tsx`) spawns the sidecar
   (`sidecar/listener.mjs`, or `sidecar/listener.py` when Node is missing) on
   `127.0.0.1` and adds a short system-prompt section naming the port.
2. **Claude writes a page** under `.claude/artifacts/`, loads `/_cb/client.js`, and marks
   controls with `data-cb-action` (the bundled `interactive-artifacts` skill is its
   authoring guide). It gives you `http://127.0.0.1:<port>/a/<file>`.
3. **You click.** The client POSTs the event to the listener, which checks Host, Origin,
   the session cookie, the template and the rate limits, answers `202`, and reports the
   event on stdout.
4. **The mod queues it** behind the confirm policy and submits it with `$.prompt.submit`
   as a message *from the artifact-callbacks plugin* (never as you). One event runs at a
   time; events that arrive mid-turn wait for the session to be idle.
5. **The page follows along** by polling the event's state (`queued`, `running`, `done`)
   and can reload when Claude has rewritten it.

The full design is in [docs/SPEC.md](docs/SPEC.md); the wire details between components
are pinned in [docs/CONTRACT.md](docs/CONTRACT.md).

## Options

Set them in the plugin's options in the config menu (`userConfig` in
[.claude-plugin/plugin.json](.claude-plugin/plugin.json)).

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `port` | number | `0` | Fixed loopback port for the listener; `0` picks a random free port each session. Still loopback only. |
| `confirm` | `first-per-page` / `always` / `never` | `first-per-page` | `first-per-page`: the first event from each page waits for *Run* in a band above the prompt, and *Run* trusts that page for the session. `always`: every event waits. `never`: events run straight away. Unanswered events expire after 5 minutes. |
| `artifactsDir` | path | `.claude/artifacts` | Folder served under `/a/`, relative to the session's working directory. |
| `allowFileOrigin` | boolean | `false` | Token mode for pages opened straight from disk (`file://`): a per-page token in a `<meta name="cb-token">` tag replaces the cookie; Claude gets the tags from the mod's `page_token` tool, registered only in this mode. Off by default because the token sits in the file and the transcript. |
| `runtime` | `auto` / `node` / `python3` | `auto` | Listener runtime. `auto` tries `node --version`, then `python3 --version` (`py -3` on Windows). |
| `maxPromptChars` | number | `4000` | Cap on the rendered prompt of one event, in characters. |
| `autoStart` | boolean | `true` | Start the listener with the session. When off, run `/callbacks start`. |
| `streamReplies` | boolean | `false` | Write Claude's reply text for each event where the page can stream it from `/_cb/events/<id>/stream` (`ev.on('text', …)` in the page). |

## `/callbacks`

| Command | Effect |
| --- | --- |
| `/callbacks` | Status: URL, port, pages served, queue, last 10 events with their states |
| `/callbacks open <page>` | Open `http://127.0.0.1:<port>/a/<page>` in the default browser (`open`, `xdg-open` or `start`) |
| `/callbacks pause` | Stop submitting events; new events are dropped and the page says so. Claude's system-prompt section is removed while paused |
| `/callbacks resume` | Submit events again |
| `/callbacks start` | Start the listener |
| `/callbacks stop` | Stop the listener |
| `/callbacks rotate` | New secret and port; open tabs must be reopened from the new link |
| `/callbacks trust <page>` | Run events from `<page>` without asking, for this session |
| `/callbacks untrust <page>` | Ask again before events from `<page>` |

The status line shows `callbacks :<port> · <n> queued` while the listener runs, and a
toast announces each accepted event (`triage.html → fix`).

## Writing pages by hand

Claude does this for you, but a wired page is just HTML:

```html
<!doctype html>
<meta charset="utf-8"><title>Failing tests</title>
<script src="/_cb/client.js" defer></script>
<button data-cb-action="fix"
        data-cb-data='{"test":"test_auth_refresh"}'
        data-cb-prompt="Fix the failing test {{data.test}}, then update triage.html.">Fix this</button>
```

Save it under `.claude/artifacts/` and open it from the listener's link. The full
attribute reference, the `ArtifactCallbacks` JavaScript API, `data-cb-state` styling and
patterns are in [skills/interactive-artifacts/SKILL.md](skills/interactive-artifacts/SKILL.md).

## Security model

The listener is a way to type into an agent that can run commands, so it treats every
request as hostile until proven otherwise. Any website you have open can send requests
to `127.0.0.1`; the design assumes that.

- **Loopback only.** Binds `127.0.0.1`, never `0.0.0.0` or `::`. Random port per session.
- **Same-origin plus a session cookie.** The listener serves the pages itself and sets an
  `HttpOnly; SameSite=Strict` cookie (`cb_session_<port>`, an HMAC of a per-session
  secret). Events must carry it, so another site cannot post events.
- **Host and Origin checks** on every request defeat DNS rebinding and cross-site posts;
  `Sec-Fetch-Site` must be `same-origin`; only `application/json` bodies; no CORS headers
  ever (except the opt-in file:// token mode); failures get a bare `403`.
- **No path tricks.** `/a/` serves regular files whose real path is inside the artifacts
  folder: no `..`, no dotfiles, no symlinks out, no directory listings.
- **Templates come from disk.** A `data-cb-prompt` sent with an event must match one in
  the page file as it is now, so script injected into a page cannot invent prompts.
- **Data stays data.** Event data is rendered quoted, escaped and capped (500 characters
  per placeholder, `maxPromptChars` overall) and labelled as page data; the raw JSON
  rides as hidden context. Events are framed as the plugin's messages, never as yours.
- **A human in the loop.** The first event from each page waits for your *Run* by default.
- **Flood limits.** 16 KB bodies, 10 s request timeout, at most 5 pending events,
  10 events per minute per page and 30 per session; double clicks are coalesced.
- **Short-lived.** The listener dies with the session and holds the secret only in memory;
  trust never carries over to another session. The mod never runs tools or commands
  itself on an event's behalf.

Pages you ask Claude to build from untrusted content (issue bodies, web pages) are the
main residual risk: the confirm band, on-disk template matching and the skill's rules
(no untrusted text in templates, escape everything shown) are the defences. Use
`confirm: always` on shared machines.

## Limitations

- **Interactive local sessions only.** Headless runs (`claude -p`, SDK hosts) report
  `isInteractive: false` and the mod does nothing.
- **Remote and container sessions** (claude.ai cloud sessions, `CLAUDE_CODE_REMOTE=true`,
  SSH) stay off: the listener's loopback is the remote machine's, not your browser's.
  There is no tunnel by design.
- **Published claude.ai artifacts** run on another origin and cannot reach your loopback;
  they are not supported.
- **One-way.** Claude's reply is not streamed into the page unless `streamReplies` is on;
  pages poll for state and reload when Claude rewrites them.
- **Windows.** `/callbacks open` uses `cmd /c start ""`; the `auto` runtime looks for
  `node`, then `python3`, then `py -3`. Whether every browser on Windows (Edge in
  particular) applies `SameSite=Strict` to `127.0.0.1` exactly as on other platforms is
  still an open question; if clicks are rejected as forbidden, reopen the page from
  `http://localhost:<port>/a/<file>`.
- **file:// pages** need `allowFileOrigin` and a per-page token; prefer the served link.

## Development

Tests need Node.js >= 22.18, which runs the TypeScript sources directly. `npm install`
brings the dev-only `typescript` and `@types/node` for `npm run typecheck`; the suites
themselves need nothing from npm, except the browser suite, which needs the
`playwright` package and its Chromium (`npm install --no-save playwright` and
`npx playwright install chromium` once, unless both are already installed). The
`validate` and `test:hooks` scripts need the `claude` CLI on `PATH`.

```bash
cd plugins/artifact-callbacks
npm test                         # unit, conformance, browser and docs suites
npm run typecheck                # tsc --noEmit over sidecar/*.ts, client.js (// @ts-check) and the tests
npm run test:unit
npm run test:conformance         # HTTP conformance suite against sidecar/listener.ts
npm run test:browser             # Chromium end-to-end tests of sidecar/client.js
npm run test:docs                # README, SKILL.md, plugin.json and marketplace checks

npm run validate                 # claude plugin validate .: manifest, hooks module and types
npm run test:hooks               # claude plugin test .: hooks module suites (hooks/*.test.ts; the node suites are *.spec.ts)
```

To try it in a session from this checkout:

```bash
claude --plugin-dir ./plugins/artifact-callbacks
```

CI runs all of the above in [`.github/workflows/artifact-callbacks.yml`](../../.github/workflows/artifact-callbacks.yml).

## License

[MIT](../../LICENSE)
