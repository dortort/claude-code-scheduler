// Minimal JSON-RPC 2.0 over stdio, as MCP's stdio transport frames it: one
// JSON message per line (UTF-8, no embedded newlines), requests answered by id,
// notifications never answered. Node stdlib only.
import { StringDecoder } from 'node:string_decoder'
import type { Readable, Writable } from 'node:stream'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type Params = Record<string, unknown>
export type Id = string | number

/** Standard JSON-RPC error codes. */
export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

/** Thrown by a request handler to answer with a JSON-RPC error. */
export class RpcError extends Error {
  readonly code: number
  constructor (code: number, message: string) {
    super(message)
    this.code = code
  }
}

export type RequestHandler = (params: Params) => unknown
export type NotificationHandler = (params: Params) => void

export interface PeerOptions {
  input: Readable
  output: Writable
  /** Called once when the input ends or errors (the client went away). */
  onClose?: () => void
  /** Diagnostics; never written to `output`. */
  log?: (message: string) => void
}

function isObject (v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isId (v: unknown): v is Id {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
}

/** One end of a JSON-RPC connection: dispatches incoming lines, writes outgoing ones. */
export class Peer {
  private readonly requests = new Map<string, RequestHandler>()
  private readonly notifications = new Map<string, NotificationHandler>()
  private readonly output: Writable
  private readonly log: (message: string) => void
  private buffer = ''
  private closed = false

  constructor (options: PeerOptions) {
    this.output = options.output
    this.log = options.log ?? (() => {})
    const decoder = new StringDecoder('utf8')
    const close = (): void => {
      if (this.closed) return
      this.closed = true
      const rest = this.buffer + decoder.end()
      this.buffer = ''
      if (rest.trim() !== '') this.receive(rest)
      options.onClose?.()
    }
    options.input.on('data', (chunk: Buffer | string) => {
      this.buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      let nl = this.buffer.indexOf('\n')
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        if (line.trim() !== '') this.receive(line)
        nl = this.buffer.indexOf('\n')
      }
    })
    options.input.on('end', close)
    options.input.on('close', close)
    options.input.on('error', close)
    this.output.on('error', (err: Error) => this.log(`stdout: ${err.message}`))
  }

  onRequest (method: string, handler: RequestHandler): void {
    this.requests.set(method, handler)
  }

  onNotification (method: string, handler: NotificationHandler): void {
    this.notifications.set(method, handler)
  }

  /** Sends a notification (no id, no answer expected). */
  notify (method: string, params?: Params): void {
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  get isClosed (): boolean {
    return this.closed
  }

  private send (message: Record<string, unknown>): void {
    if (this.output.destroyed || !this.output.writable) return
    this.output.write(`${JSON.stringify(message)}\n`)
  }

  private fail (id: Id | null, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  /** Handles one line: a request, a notification, or (ignored) a response. */
  receive (line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line.replace(/\r$/, ''))
    } catch {
      this.fail(null, PARSE_ERROR, 'Parse error')
      return
    }
    if (!isObject(msg) || msg.jsonrpc !== '2.0') {
      this.fail(isObject(msg) && isId(msg.id) ? msg.id : null, INVALID_REQUEST, 'Invalid Request')
      return
    }
    // A response to something we sent: this server sends no requests, so drop it.
    if (msg.method === undefined && ('result' in msg || 'error' in msg)) return
    if (typeof msg.method !== 'string') {
      this.fail(isId(msg.id) ? msg.id : null, INVALID_REQUEST, 'Invalid Request')
      return
    }
    if (msg.params !== undefined && !isObject(msg.params)) {
      if (isId(msg.id)) this.fail(msg.id, INVALID_PARAMS, 'params must be an object')
      return
    }
    const params: Params = isObject(msg.params) ? msg.params : {}
    if (!('id' in msg)) {
      const handler = this.notifications.get(msg.method)
      if (!handler) return
      try {
        handler(params)
      } catch (err) {
        this.log(`notification ${msg.method}: ${(err as Error).message}`)
      }
      return
    }
    if (!isId(msg.id)) {
      this.fail(null, INVALID_REQUEST, 'Invalid Request')
      return
    }
    const id = msg.id
    const handler = this.requests.get(msg.method)
    if (!handler) {
      this.fail(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`)
      return
    }
    Promise.resolve()
      .then(() => handler(params))
      .then(
        (result) => this.send({ jsonrpc: '2.0', id, result: result ?? {} }),
        (err: unknown) => {
          if (err instanceof RpcError) this.fail(id, err.code, err.message)
          else {
            this.log(`${msg.method}: ${(err as Error)?.stack ?? String(err)}`)
            this.fail(id, INTERNAL_ERROR, 'Internal error')
          }
        },
      )
  }
}
