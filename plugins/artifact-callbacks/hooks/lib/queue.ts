// The mod-side queue and confirm policy, as pure functions over plain data.

import type {
  ArtifactCallbacksEventRecord as EventRecord,
  ArtifactCallbacksEventState as EventState,
  ArtifactCallbacksPending as Pending,
} from '../../types'

/** Pending events (queued or awaiting approval) the mod holds at most. */
export const MAX_PENDING = 5
/** A repeat of the same page + action + data within this window is merged. */
export const COALESCE_MS = 1500
/** How long an event waits for Run or Discard before it expires. */
export const APPROVAL_MS = 5 * 60 * 1000
/** Event records kept (newest first to stay). */
export const MAX_RECORDS = 200

export type ConfirmPolicy = 'first-per-page' | 'always' | 'never'

export function parsePolicy(value: unknown): ConfirmPolicy {
  return value === 'always' || value === 'never' ? value : 'first-per-page'
}

export const TERMINAL_STATES: readonly EventState[] = ['done', 'rejected', 'dropped', 'expired']

export function isTerminal(state: EventState): boolean {
  return TERMINAL_STATES.includes(state)
}

/** JSON with object keys sorted at every depth, so equal data compares equal. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return null
    seen.add(v)
    if (Array.isArray(v)) return v.map(walk)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(v).sort()) out[key] = walk((v as Record<string, unknown>)[key])
    return out
  }
  try {
    return JSON.stringify(walk(value ?? {})) ?? '{}'
  } catch {
    return '{}'
  }
}

/** Whether an event from `page` must wait for Run under `policy`. */
export function needsApproval(policy: ConfirmPolicy, trusted: readonly string[], page: string): boolean {
  if (policy === 'never') return false
  if (policy === 'always') return true
  return !trusted.includes(page)
}

/**
 * The earlier event a new one merges into: same page, action and data,
 * received within COALESCE_MS, itself not a duplicate and still live.
 */
export function findCoalesceTarget(
  records: readonly EventRecord[],
  incoming: { page: string; action: string; dataKey: string; receivedAt: number },
): EventRecord | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i]
    if (r === undefined) continue
    if (r.coalescedInto !== null) continue
    if (r.page !== incoming.page || r.action !== incoming.action || r.dataKey !== incoming.dataKey) continue
    const age = incoming.receivedAt - r.receivedAt
    if (age < 0 || age > COALESCE_MS) continue
    if (r.state === 'dropped' || r.state === 'rejected' || r.state === 'expired') continue
    return r
  }
  return undefined
}

/** Events the mod holds that have not started a turn. */
export function queueDepth(queue: readonly Pending[]): number {
  return queue.length
}

export function isQueueFull(queue: readonly Pending[]): boolean {
  return queue.length >= MAX_PENDING
}

/** The first pending event that may be submitted now (approved, in order). */
export function nextSubmittable(
  queue: readonly Pending[],
  records: readonly EventRecord[],
): Pending | undefined {
  for (const p of queue) {
    const r = records.find(x => x.id === p.id)
    if (r?.state === 'queued') return p
  }
  return undefined
}

/** The oldest event waiting for Run or Discard, for the band. */
export function firstAwaiting(records: readonly EventRecord[]): EventRecord | undefined {
  return records.find(r => r.state === 'awaiting-approval' && r.coalescedInto === null)
}

export type RecordPatch = Partial<
  Pick<EventRecord, 'state' | 'turnStartedAt' | 'turnEndedAt' | 'note' | 'expiresAt' | 'turnId'>
>

/**
 * Applies `patch` to the record `id`, and mirrors its state and turn times
 * onto every duplicate coalesced into it (they keep their own note).
 */
export function patchRecord(records: readonly EventRecord[], id: string, patch: RecordPatch): EventRecord[] {
  return records.map(r => {
    if (r.id === id) return { ...r, ...patch }
    if (r.coalescedInto === id) {
      const mirrored: RecordPatch = {}
      if (patch.state !== undefined) mirrored.state = patch.state
      if (patch.turnStartedAt !== undefined) mirrored.turnStartedAt = patch.turnStartedAt
      if (patch.turnEndedAt !== undefined) mirrored.turnEndedAt = patch.turnEndedAt
      return { ...r, ...mirrored }
    }
    return r
  })
}

/**
 * Keeps at most `max` records: the oldest terminal ones go first; records
 * still in play are never dropped.
 */
export function trimRecords(records: readonly EventRecord[], max: number = MAX_RECORDS): EventRecord[] {
  if (records.length <= max) return [...records]
  let excess = records.length - max
  const drop = new Set<string>()
  for (const r of records) {
    if (excess === 0) break
    if (isTerminal(r.state)) {
      drop.add(r.id)
      excess -= 1
    }
  }
  return records.filter(r => !drop.has(r.id))
}

/** A fresh record for an event the listener reported. */
export function newRecord(fields: {
  id: string
  page: string
  action: string
  label: string | null
  receivedAt: number
  dataKey: string
  state: EventState
  note?: string | null
  coalescedInto?: string | null
  expiresAt?: number | null
}): EventRecord {
  return {
    id: fields.id,
    state: fields.state,
    page: fields.page,
    action: fields.action,
    label: fields.label,
    receivedAt: fields.receivedAt,
    turnStartedAt: null,
    turnEndedAt: null,
    note: fields.note ?? null,
    coalescedInto: fields.coalescedInto ?? null,
    expiresAt: fields.expiresAt ?? null,
    turnId: null,
    dataKey: fields.dataKey,
  }
}
