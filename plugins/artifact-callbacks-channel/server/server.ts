// Entry point: the stdio MCP server Claude Code starts from .mcp.json
// (`node ${CLAUDE_PLUGIN_ROOT}/server/server.ts`). Node >= 22.18 stdlib only;
// nothing is ever written to stdout except MCP messages.
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Adapter } from './lib/adapter.ts'
import { configFromEnv } from './lib/config.ts'
import { serveMcp } from './lib/mcp.ts'
import { Peer } from './lib/rpc.ts'

const here = dirname(fileURLToPath(import.meta.url))
const log = (message: string): void => {
  process.stderr.write(`artifact-callbacks-channel: ${message}\n`)
}

const cfg = configFromEnv(process.env, process.cwd())
const adapter = new Adapter({
  ...cfg,
  listener: process.env.CB_CHANNEL_LISTENER || resolve(here, '..', 'sidecar', 'listener.ts'),
  node: process.execPath,
  runDir: join(cfg.projectDir, '.claude', '.artifact-callbacks', `channel-${process.pid}-${randomBytes(4).toString('hex')}`),
  secret: randomBytes(32).toString('hex'),
  log,
})

let stopping = false
async function shutdown (code: number): Promise<void> {
  if (stopping) return
  stopping = true
  try {
    await adapter.stop()
  } catch (err) {
    log(`stop: ${(err as Error).message}`)
  }
  process.exit(code)
}

// The listener starts before stdin is read, so initialize can wait for its port.
await adapter.start()

const peer = new Peer({
  input: process.stdin,
  output: process.stdout,
  onClose: () => void shutdown(0),
  log,
})
serveMcp({ peer, adapter })
process.on('SIGTERM', () => void shutdown(0))
process.on('SIGINT', () => void shutdown(0))
process.on('SIGHUP', () => void shutdown(0))
process.stdout.on('error', () => void shutdown(0))

