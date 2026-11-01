// Settings from the environment .mcp.json passes in. Claude Code substitutes
// ${CLAUDE_PROJECT_DIR} and ${user_config.KEY}; a reference it left as is (an
// older Claude Code, or the server started by hand) counts as unset.
import { isAbsolute, resolve } from 'node:path'
import { DEFAULT_MAX_PROMPT_CHARS } from '../shared/template.ts'

export const DEFAULT_ARTIFACTS_DIR = '.claude/artifacts'

export interface EnvConfig {
  projectDir: string
  artifactsDir: string
  port: number
  allowFileOrigin: boolean
  maxPromptChars: number
  backoffMs?: readonly number[]
  healthyMs?: number
  doneTimeoutMs?: number
  listenerEnv: Record<string, string>
}

type Env = Readonly<Record<string, string | undefined>>

/** The value, or undefined when it is empty or an unsubstituted `${...}`. */
export function setting (env: Env, name: string): string | undefined {
  const v = env[name]
  if (v === undefined) return undefined
  const t = v.trim()
  return t === '' || /^\$\{[^}]*\}$/.test(t) ? undefined : t
}

function int (v: string | undefined, min: number, max: number): number | undefined {
  if (v === undefined || !/^\d+$/.test(v)) return undefined
  const n = Number(v)
  return n >= min && n <= max ? n : undefined
}

function msList (v: string | undefined): number[] | undefined {
  if (v === undefined) return undefined
  const parts = v.split(',').map((p) => int(p.trim(), 0, 3_600_000))
  return parts.every((p): p is number => p !== undefined) ? parts : undefined
}

export function configFromEnv (env: Env, cwd: string): EnvConfig {
  const projectDir = resolve(setting(env, 'CB_PROJECT_DIR') ?? cwd)
  const dir = setting(env, 'CB_ARTIFACTS_DIR') ?? DEFAULT_ARTIFACTS_DIR
  const flag = setting(env, 'CB_ALLOW_FILE_ORIGIN')?.toLowerCase()
  const out: EnvConfig = {
    projectDir,
    artifactsDir: isAbsolute(dir) ? dir : resolve(projectDir, dir),
    port: int(setting(env, 'CB_PORT'), 0, 65535) ?? 0,
    allowFileOrigin: flag === 'true' || flag === '1',
    maxPromptChars: int(setting(env, 'CB_MAX_PROMPT_CHARS'), 1, 1_000_000) ?? DEFAULT_MAX_PROMPT_CHARS,
    listenerEnv: {},
  }
  // Test-only knobs.
  const backoff = msList(setting(env, 'CB_CHANNEL_BACKOFF_MS'))
  if (backoff) out.backoffMs = backoff
  const healthy = int(setting(env, 'CB_CHANNEL_HEALTHY_MS'), 1, 3_600_000)
  if (healthy !== undefined) out.healthyMs = healthy
  const doneTimeout = int(setting(env, 'CB_CHANNEL_DONE_TIMEOUT_MS'), 1, 86_400_000)
  if (doneTimeout !== undefined) out.doneTimeoutMs = doneTimeout
  for (const k of ['CB_STREAM_PING_MS', 'CB_REQUEST_TIMEOUT_MS']) {
    const v = setting(env, k)
    if (v !== undefined) out.listenerEnv[k] = v
  }
  return out
}
