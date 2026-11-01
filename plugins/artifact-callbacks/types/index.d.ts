// The Artifact Callbacks mod's session state: what it keeps in `$.state`
// under its own name so that it survives hot reloads of the hooks module.
// Nothing here is written to `$.store`: trust never carries across sessions.

/** The life cycle of one page event, as the page polls it. */
export type ArtifactCallbacksEventState =
  | 'queued'
  | 'awaiting-approval'
  | 'running'
  | 'done'
  | 'rejected'
  | 'dropped'
  | 'expired'

/** One event the listener reported, as the mod tracks it. */
export type ArtifactCallbacksEventRecord = {
  /** `ev_` + 10 chars, minted by the sidecar. */
  id: string
  state: ArtifactCallbacksEventState
  /** The served page, relative to the artifacts folder (`triage.html`). */
  page: string
  action: string
  label: string | null
  /** When the sidecar accepted it (ms since the epoch). */
  receivedAt: number
  turnStartedAt: number | null
  turnEndedAt: number | null
  /** `interrupted`, `reload`, `coalesced`, `paused`, `queue-full`, ... */
  note: string | null
  /** For a coalesced duplicate: the id of the event whose state it mirrors. */
  coalescedInto: string | null
  /** While awaiting approval: when the wait expires (ms since the epoch). */
  expiresAt: number | null
  /** The turn this event owns once it started. */
  turnId: string | null
  /** Canonical JSON of the event's data, for coalescing double clicks. */
  dataKey: string
}

/** An event held by the mod that has not started a turn yet. */
export type ArtifactCallbacksPending = {
  id: string
  page: string
  action: string
  /** Canonical JSON of the event's data, for coalescing. */
  dataKey: string
  /** The rendered prompt text (framed by the engine as the plugin's message). */
  text: string
  /** The hidden context: the raw event JSON, labelled as page data. */
  context: string
  receivedAt: number
}

/** Where the listener stands. */
export type ArtifactCallbacksListenerState =
  | 'off'
  | 'starting'
  | 'up'
  | 'restarting'
  | 'down'
  | 'stopped'

/** The sidecar listener, as the status line and `/callbacks` report it. */
export type ArtifactCallbacksListener = {
  state: ArtifactCallbacksListenerState
  /** The bound port once ready, else the port it will try to keep. */
  port: number | null
  pid: number | null
  /**
   * Why it is down or off, in words for the person. A failed Node check
   * starts with its code: `node-missing: ...` or `node-too-old: ...`,
   * followed by the found and minimum versions.
   */
  reason: string | null
  /** Restarts made since the listener was last healthy. */
  restarts: number
  /** The Node version `node --version` reported (`v22.18.0`), once checked. */
  nodeVersion: string | null
}

/** Per-session facts fixed at start: paths, platform and the cookie secret. */
export type ArtifactCallbacksSession = {
  cwd: string
  runDir: string
  artifactsDir: string
  statusFile: string
  streamDir: string
  platform: 'darwin' | 'linux' | 'win32'
  /** HMAC key shared with the sidecar; host memory only, never on disk. */
  secret: string
}

declare module 'claude-code' {
  interface PluginState {
    'artifact-callbacks': {
      events: ArtifactCallbacksEventRecord[]
      trusted: string[]
      listener: ArtifactCallbacksListener
      paused: boolean
      queue: ArtifactCallbacksPending[]
      session: ArtifactCallbacksSession | null
    }
  }
}
