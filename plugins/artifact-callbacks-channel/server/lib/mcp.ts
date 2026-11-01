// The MCP side: initialize (declaring the experimental claude/channel
// capability and tools), ping, tools/list, tools/call, and the channel
// notifications, held back until the client has sent notifications/initialized.
import { readFileSync } from 'node:fs'
import { INVALID_PARAMS, Peer, RpcError } from './rpc.ts'
import type { Params } from './rpc.ts'
import { CHANNEL_METHOD } from './adapter.ts'
import type { Adapter, ChannelMessage } from './adapter.ts'

/** Revisions this server speaks, newest first. 2026-07-28 is left out on purpose:
 * Claude Code does not register a channel server that negotiates it. */
export const PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05']

const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8')) as { name: string; version: string }
export const SERVER_INFO = { name: manifest.name, version: manifest.version }

/** How long initialize waits for the listener, so the instructions can name its port. */
export const READY_WAIT_MS = 3000

export interface McpOptions {
  peer: Peer
  adapter: Adapter
  readyWaitMs?: number
}

export function negotiate (requested: unknown): string {
  return typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : (PROTOCOL_VERSIONS[0] ?? '2025-06-18')
}

export function serveMcp ({ peer, adapter, readyWaitMs = READY_WAIT_MS }: McpOptions): void {
  let initialized = false
  const held: ChannelMessage[] = []

  const deliver = (m: ChannelMessage): void => {
    peer.notify(CHANNEL_METHOD, { content: m.content, meta: m.meta })
  }
  adapter.onMessage((m) => {
    if (initialized) deliver(m)
    else held.push(m)
  })

  peer.onRequest('initialize', async (params: Params) => {
    await adapter.supervisor.waitSettled(readyWaitMs)
    return {
      protocolVersion: negotiate(params.protocolVersion),
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      serverInfo: SERVER_INFO,
      instructions: adapter.instructions(),
    }
  })

  peer.onNotification('notifications/initialized', () => {
    if (initialized) return
    initialized = true
    for (const m of held.splice(0)) deliver(m)
  })

  peer.onRequest('ping', () => ({}))

  peer.onRequest('tools/list', () => ({ tools: adapter.tools() }))

  peer.onRequest('tools/call', async (params: Params) => {
    if (typeof params.name !== 'string') throw new RpcError(INVALID_PARAMS, 'name must be a string')
    const args = params.arguments
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      throw new RpcError(INVALID_PARAMS, 'arguments must be an object')
    }
    return adapter.call(params.name, (args ?? {}) as Record<string, unknown>)
  })
}
