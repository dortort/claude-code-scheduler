# Artifact Callbacks: implementation contract

`SPEC.md` (next to this file) is the product spec. This file pins the interfaces
between components so they can be built and tested independently. Where the two
disagree, this file wins for wire details; the spec wins for behaviour.

## Repository layout

```text
plugins/artifact-callbacks/                 the mod (one plugin folder)
  .claude-plugin/plugin.json                name "artifact-callbacks", userConfig, "types"
  hooks/hooks.json                          { "modules": ["./register.tsx"] }
  hooks/register.tsx                        the hooks module
  hooks/lib/*.ts                            pure logic (template render, queue, limits, ids, paths)
  hooks/*.test.ts(x)                        `claude plugin test` suites
  types/index.d.ts                          PluginState contract
  sidecar/listener.mjs                      Node listener (stdlib only, Node >= 18)
  sidecar/listener.py                       Python 3.8+ stdlib listener (same contract)
  sidecar/client.js                         browser helper, served at /_cb/client.js
  skills/interactive-artifacts/SKILL.md     authoring guide
  test/                                     node:test suites (unit, conformance, browser e2e)
  test/conformance/                         HTTP conformance suite run against BOTH listeners
  package.json                              dev scripts only; the plugin ships no node_modules
plugins/artifact-callbacks-channel/         M5 channel adapter plugin (MCP server), own manifest
```

Only Node stdlib in `sidecar/*.mjs`, only Python stdlib in `listener.py`, no
build step for anything the plugin ships. Dev-time test tooling may use the
preinstalled Playwright (`require('playwright')`) and `node:test`.

## Sidecar process

Spawned by the mod with `$.process.spawn`. stdin is closed immediately; nothing is
ever sent on it. Configuration is environment only:

| Variable | Meaning |
| --- | --- |
| `CB_PORT` | Port to bind on `127.0.0.1`. `0` = random free port. |
| `CB_ROOT` | Absolute path of the artifacts folder (served under `/a/`). Created by the mod if missing. |
| `CB_STATUS_FILE` | Absolute path of `status.json`, written by the mod, read by the sidecar per request. |
| `CB_SECRET` | Random secret (>= 32 hex chars). Never logged, never sent to the browser. |
| `CB_ALLOW_FILE_ORIGIN` | `1` enables file:// token mode. Default off. |
| `CB_STREAM_DIR` | Optional (M5). Folder holding `<event id>.ndjson` reply-stream files written by the mod. |
| `CB_CLIENT_JS` | Optional override path of client.js (tests). Default: `client.js` beside the listener. |

Lifetime: binds `127.0.0.1` only (never `0.0.0.0`/`::`). Exits on SIGTERM/SIGINT,
when writing to stdout fails (EPIPE), and when its parent process goes away
(poll `ppid` once per second; a change means orphaned).

### stdout (NDJSON, one object per line, nothing else on stdout; diagnostics go to stderr)

```json
{"type":"ready","port":51234,"pid":4411}
{"type":"event","id":"ev_8f3k2a","receivedAt":1791821731946,"servedPage":"triage.html","body":{...validated body, page overwritten...}}
{"type":"rejected","reason":"origin","origin":"https://evil.example","path":"/_cb/event"}
{"type":"dropped","id":"ev_...","reason":"paused|queue-full|rate-limit","servedPage":"triage.html"}
{"type":"error","reason":"port-in-use|root-missing|bad-config","message":"..."}
```

`rejected.reason` is one of `host`, `origin`, `sec-fetch-site`, `content-type`,
`auth`, `page`, `body`, `too-large`, `template-changed`, `method`.
On `error` the process exits non-zero (exit code 2 for `port-in-use`).

Event ids: `ev_` + 10 chars of `[a-z0-9]`, from a CSPRNG.

### status.json (written by the mod, atomically: write `status.json.tmp` then rename)

```json
{
  "v": 1,
  "paused": false,
  "queueDepth": 1,
  "events": {
    "ev_8f3k2a": { "id": "ev_8f3k2a", "state": "running", "page": "triage.html", "action": "fix",
                   "turnStartedAt": 1791821732000, "turnEndedAt": null, "note": null }
  }
}
```

States: `queued`, `awaiting-approval`, `running`, `done`, `rejected`, `dropped`,
`expired`. `queueDepth` = events the mod holds that have not started a turn
(`queued` + `awaiting-approval`). The mod keeps at most the 200 newest records.
The sidecar must tolerate a missing or unparsable file (treat as
`{paused:false, queueDepth:0, events:{}}`, keep using the last good parse).

## HTTP routes (all on `http://127.0.0.1:<port>`)

Checks run in this order; the first failure answers.

1. **Host** (every route, every method): must be exactly `127.0.0.1:<port>` or
   `localhost:<port>`. Else `403`, empty body, stdout `rejected/host`.
2. Unknown route: `404` empty body. Wrong method on a known route: `405` empty body.
   `OPTIONS` anything: `403` empty body, never any `Access-Control-*` header.
3. No response ever carries `Access-Control-Allow-Origin`.
4. Every response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: same-origin`. Failed requests get a bare status with no body
   unless stated below.
5. Request timeout 10 s (headers and body).

| Route | Behaviour |
| --- | --- |
| `GET /_cb/health` | `200 {"ok":true,"paused":<from status.json>}` |
| `GET /_cb/client.js` | `200`, `text/javascript; charset=utf-8`, the client file. No secrets in it. |
| `GET /a/<path>` | Serve a regular file from `CB_ROOT`. URL-decoded path; reject `..` segments, NUL, backslashes, dotfile segments (`/.x`). `realpath` must be inside `realpath(CB_ROOT)` (symlinks pointing out → 404). Directories → 404 (no listings, no index). MIME by extension (html, js, mjs, css, json, svg, png, jpg, jpeg, gif, webp, ico, txt, md, woff, woff2, map; else `application/octet-stream`). For `.html`: set `Set-Cookie: cb_session=<cookie>; HttpOnly; SameSite=Strict; Path=/` and record the page path (relative to root, `/`-separated, e.g. `triage.html`, `sub/x.html`) in the served-pages set. |
| `POST /_cb/event` | See below. |
| `GET /_cb/events/<id>` | Auth as for POST steps a–d (Origin only checked when present). `200 {"id","state","turnStartedAt"?, "turnEndedAt"?, "note"?}` from status.json, else from the sidecar's own record of ids it issued (queued/dropped), else `404`. |
| `GET /_cb/events/<id>/stream` | M5. Same auth. `text/event-stream`. See Streaming. |

Cookie value: `HMAC-SHA256(key=CB_SECRET, msg=String(port))`, lowercase hex.
Page token (file mode): `HMAC-SHA256(key=CB_SECRET, msg="page:" + <page path relative to root>)`, lowercase hex.
Compare with constant-time equality.

### POST /_cb/event

a. **Origin**: header required. Allowed: `http://127.0.0.1:<port>`, `http://localhost:<port>`.
   `null` allowed only when `CB_ALLOW_FILE_ORIGIN=1` (token mode). Else `403` `rejected/origin`.
b. **Sec-Fetch-Site**: when present, must be `same-origin` (cookie mode). In token mode
   (`Origin: null`) it is not checked. Else `403` `rejected/sec-fetch-site`.
c. **Content-Type**: must be `application/json` (parameters like `; charset=utf-8` allowed). Else `403` `rejected/content-type`.
d. **Auth**: cookie mode: `cb_session` cookie must equal the cookie value. Token mode
   (`Origin: null`): `X-CB-Token` must equal the page token for `body.page` and that
   page file must exist under root. Else `403` `rejected/auth`.
e. **Size**: body over 16384 bytes → `413` `rejected/too-large` (stop reading; don't buffer more).
f. **Schema**: JSON object; `v` === 1; `action` matches `^[a-z0-9_-]{1,40}$`; `label`
   optional string ≤ 200 chars; `data` optional JSON object (default `{}`); `prompt`
   optional string ≤ 2000 chars; `idempotencyKey` optional string ≤ 100 chars; `page`
   optional string ≤ 300. Unknown keys dropped. Else `400 {"error":"<what>"}` `rejected/body`.
g. **Page**: cookie mode: the served page is the `Referer` path under `/a/` if it is in
   the served-pages set, else `body.page` (strip a leading `/a/` or `/`) if it is in the
   set; else `403` `rejected/page`. The body's `page` is overwritten with it. Token mode:
   `page` = `body.page` as verified by the token.
h. **Template**: when `prompt` is present, re-read the page file from disk, collect every
   `data-cb-prompt` attribute value (single-, double-quoted or unquoted, HTML entities
   decoded: named `&amp; &lt; &gt; &quot; &#39; &apos;` and numeric `&#N; &#xH;`), and
   require an exact match. Else `409 {"error":"template-changed"}` `rejected/template-changed`.
i. **Idempotency**: same `idempotencyKey` seen within 60 s → `202` with the original id and its
   current state; no new stdout line.
j. **Admission** (reads status.json fresh): `paused` → `429 {"id","state":"dropped","reason":"paused"}`;
   `queueDepth` >= 5 → `429 … "reason":"queue-full"`; rate limit (more than 10 events in the
   trailing 60 s for this page, or more than 30 for the session) → `429 … "reason":"rate-limit"`.
   Each emits a stdout `dropped` line and the sidecar remembers the id as `dropped`.
k. Accept: emit the stdout `event` line, remember the id as `queued`, answer
   `202 {"id":"ev_…","state":"queued"}`.

Coalescing (same page + action + data within 1.5 s) is done by the mod: the duplicate
submits no prompt; its record mirrors the first event's state and carries
`note: "coalesced"`.

### Streaming (M5)

The mod appends NDJSON lines to `<CB_STREAM_DIR>/<id>.ndjson`:
`{"type":"text","text":"..."}`, `{"type":"state","state":"running"}`, `{"type":"end"}`.
The sidecar's `/stream` route replays the file then tails it (poll 250 ms), sending
`event: text` / `event: state` / `event: end` SSE frames (`data:` = JSON), a `: ping`
comment every 15 s, and closes after `end` or when the event reaches a terminal state
in status.json.

## Mod-side rules (hooks/register.tsx)

- Does nothing unless `session.start` reports `isInteractive: true`, and stays off in
  remote/container sessions (detect `CLAUDE_CODE_REMOTE=true` via env exposure in the API,
  if any; otherwise document the limitation). Tests may override with an option.
- Runtime pick (`runtime` option): `auto` = `node --version` then `python3 --version`
  (`py -3 --version` on Windows) via `$.process.run`; argv
  `["node", "<root>/sidecar/listener.mjs"]` or `["python3", "<root>/sidecar/listener.py"]`.
- Run dir: a per-session folder outside the artifacts folder (e.g.
  `<cwd>/.claude/.artifact-callbacks/<session id>/`) holding `status.json` and `streams/`.
- Queue: FIFO depth cap 5, one event in flight (`current`), confirm policy, 5 min
  approval expiry, coalescing 1.5 s, pause/resume, `/clear` keeps everything,
  hot-reload marks a `running` event `done` with `note: "reload"`, Esc interrupt →
  `done` with `note: "interrupted"`.
- Prompt: rendered template in `text` (default template from SPEC), `{{data.x}}` values
  escaped (newlines → spaces, backticks/quotes neutralised, wrapped as quoted data) and capped
  at 500 chars, whole prompt capped at `maxPromptChars`. Submitted framed (never `asUser`);
  the mod's own `prompt.submit` hook attaches the raw event JSON as `context`.
- Supervision: sidecar exit → restart after 1 s, 5 s, 30 s, keeping the port when free;
  after 3 failures stay down and toast once.
- Compose section (`prompt.compose`, `scope: 'session'`) present only while the listener
  is up and not paused; it names the real port.
- `/callbacks` subcommands per SPEC; `open` uses `open` (macOS), `xdg-open` (Linux),
  `cmd /c start ""` (Windows).
- Status line `callbacks :<port> · <n> queued`; toast per accepted event `"<page> → <action>"`.
