// Globals the browser suite reads and writes inside page.evaluate() callbacks:
// the client's window.ArtifactCallbacks API (sidecar/client.js) and the
// scratch variables the tests park on window.

interface CbTestHandle {
  id: string | null
  state: string | null
  reason: string | null
  note: string | null
  done: Promise<CbTestHandle>
  on (type: 'state' | 'text', cb: (value: string, handle: CbTestHandle) => void): CbTestHandle
  off (type: 'state' | 'text', cb: (value: string, handle: CbTestHandle) => void): CbTestHandle
  onDone (cb: (handle: CbTestHandle) => void): CbTestHandle
  stream (): CbTestHandle
}

/** What a rejected `done` carries. */
interface CbTestEventError extends Error {
  state?: string
  reason?: string | null
  handle?: CbTestHandle
}

interface CbTestApi {
  __cb: true
  version: 1
  send (action: string, data?: object | null, opts?: {
    label?: string | null
    prompt?: string | null
    page?: string
    idempotencyKey?: string
    toast?: boolean
    onState?: (state: string, handle: CbTestHandle) => void
  }): Promise<CbTestHandle>
  onDone (cb: (handle: CbTestHandle) => void): void
  page (): string
  toast (text: string, kind?: string, action?: { label: string; run: () => void }): HTMLElement | null
  config: { pollMinMs: number; pollMaxMs: number; retryMs: number; toastMs: number }
}

interface Window {
  ArtifactCallbacks: CbTestApi
  __states: string[]
  __globalDone: (string | null)[]
  __handleDone: (string | null)[]
  __ev: CbTestHandle
  __donePromise: Promise<string>
  __p: Promise<string>
  __text: string[]
  __st: string[]
  __t: string[]
  __done: unknown
  __results: { [name: string]: string }
  __marker: number | undefined
}
