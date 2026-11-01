// The sidecar's stdout: NDJSON pieces that may split lines anywhere.

export type ReadyLine = { type: 'ready'; port: number; pid: number }
export type EventLine = {
  type: 'event'
  id: string
  receivedAt: number
  servedPage: string
  body: {
    v?: number
    page?: string
    action: string
    label?: string
    data?: Record<string, unknown>
    prompt?: string
    idempotencyKey?: string
  }
}
export type RejectedLine = { type: 'rejected'; reason: string; origin?: string; path?: string }
export type DroppedLine = { type: 'dropped'; id: string; reason: string; servedPage?: string }
export type ErrorLine = { type: 'error'; reason: string; message?: string }
export type SidecarLine = ReadyLine | EventLine | RejectedLine | DroppedLine | ErrorLine

/** Collects pieces and hands back whole lines; a trailing partial line waits. */
export class LineSplitter {
  private buffer = ''

  push(text: string): string[] {
    this.buffer += text
    const parts = this.buffer.split('\n')
    this.buffer = parts.pop() ?? ''
    return parts.map(p => p.replace(/\r$/, '')).filter(p => p.trim() !== '')
  }

  /** What is left once the stream ended (a last line with no newline). */
  flush(): string[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest === '' ? [] : [rest]
  }
}

const EVENT_ID = /^ev_[a-z0-9]{10}$/
const ACTION = /^[a-z0-9_-]{1,40}$/

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Parses and checks one stdout line; undefined for anything malformed. */
export function parseLine(line: string): SidecarLine | undefined {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObject(v)) return undefined
  switch (v.type) {
    case 'ready':
      if (typeof v.port !== 'number' || !Number.isInteger(v.port) || v.port <= 0 || v.port > 65535) return undefined
      return { type: 'ready', port: v.port, pid: typeof v.pid === 'number' ? v.pid : 0 }
    case 'event': {
      if (typeof v.id !== 'string' || !EVENT_ID.test(v.id)) return undefined
      if (typeof v.servedPage !== 'string' || v.servedPage === '') return undefined
      const body = v.body
      if (!isObject(body) || typeof body.action !== 'string' || !ACTION.test(body.action)) return undefined
      const data = isObject(body.data) ? body.data : {}
      const out: EventLine = {
        type: 'event',
        id: v.id,
        receivedAt: typeof v.receivedAt === 'number' ? v.receivedAt : 0,
        servedPage: v.servedPage,
        body: { ...body, action: body.action, data },
      }
      if (typeof body.label !== 'string') delete out.body.label
      if (typeof body.prompt !== 'string') delete out.body.prompt
      return out
    }
    case 'rejected':
      return {
        type: 'rejected',
        reason: typeof v.reason === 'string' ? v.reason : 'unknown',
        ...(typeof v.origin === 'string' ? { origin: v.origin } : {}),
        ...(typeof v.path === 'string' ? { path: v.path } : {}),
      }
    case 'dropped':
      if (typeof v.id !== 'string' || !EVENT_ID.test(v.id)) return undefined
      return {
        type: 'dropped',
        id: v.id,
        reason: typeof v.reason === 'string' ? v.reason : 'unknown',
        ...(typeof v.servedPage === 'string' ? { servedPage: v.servedPage } : {}),
      }
    case 'error':
      return {
        type: 'error',
        reason: typeof v.reason === 'string' ? v.reason : 'unknown',
        ...(typeof v.message === 'string' ? { message: v.message } : {}),
      }
    default:
      return undefined
  }
}
