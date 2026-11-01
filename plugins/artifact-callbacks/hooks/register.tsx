// Artifact Callbacks: the hooks module. It runs the loopback sidecar for the
// session's life, turns the events it reports into prompts (one turn each,
// one at a time, behind the confirm policy), tracks their state for the page,
// tells Claude how to wire a page, and serves /callbacks.
//
// The logic is in ./lib/controller.ts; this file wires it to the engine.
// The engine needs `$` spelled at every call site, so the controller's
// Effects are built here, inside session.start, as closures over its `$`.

import type { Register } from 'claude-code'
import { configFrom, createController, type Effects, type Snapshot } from './lib/controller.ts'
import { firstAwaiting } from './lib/queue.ts'
import { COMPOSE_SECTION_ID } from './lib/status.ts'
import { PAGE_TOKEN_TOOL } from './lib/token.ts'

export const register: Register = (on, options) => {
  const cb = createController(configFrom(options))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started
    const isRemote = (await $.env.get('CLAUDE_CODE_REMOTE')) === 'true'
    const effects: Effects = {
      pluginRoot: $.plugin.root,
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      debug: text => $.ui.log(text, { to: 'debug' }),
      toast: text => $.ui.toast(text),
      status: text => $.ui.status(text),
      invalidateSections: () => $.ui.invalidate('prompt.section'),
      save: async (s: Snapshot) => {
        await Promise.all([
          $.state.set({ plugin: 'artifact-callbacks', key: 'events' }, s.events),
          $.state.set({ plugin: 'artifact-callbacks', key: 'trusted' }, s.trusted),
          $.state.set({ plugin: 'artifact-callbacks', key: 'listener' }, s.listener),
          $.state.set({ plugin: 'artifact-callbacks', key: 'paused' }, s.paused),
          $.state.set({ plugin: 'artifact-callbacks', key: 'queue' }, s.queue),
          $.state.set({ plugin: 'artifact-callbacks', key: 'session' }, s.session),
        ])
      },
      load: async () => {
        const [events, trusted, listener, paused, queue, session] = await Promise.all([
          $.state.get({ plugin: 'artifact-callbacks', key: 'events' }),
          $.state.get({ plugin: 'artifact-callbacks', key: 'trusted' }),
          $.state.get({ plugin: 'artifact-callbacks', key: 'listener' }),
          $.state.get({ plugin: 'artifact-callbacks', key: 'paused' }),
          $.state.get({ plugin: 'artifact-callbacks', key: 'queue' }),
          $.state.get({ plugin: 'artifact-callbacks', key: 'session' }),
        ])
        if (listener.value === undefined) return undefined
        return {
          events: events.value ?? [],
          trusted: trusted.value ?? [],
          listener: listener.value,
          paused: paused.value ?? false,
          queue: queue.value ?? [],
          session: session.value ?? null,
        }
      },
      write: (path, text) => $.fs.write(path, text),
      exists: path => $.fs.exists(path),
      list: async path => (await $.fs.list(path)).map(entry => ({ name: entry.name, kind: entry.kind })),
      run: (argv, init) => $.process.run(argv, init),
      spawn: request => $.process.spawn(request),
      submit: text => $.prompt.submit({ text }),
      appendContext: async text => {
        const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
        if ('deny' in appended && appended.deny !== undefined) throw new Error(appended.deny)
      },
      sessionId: () => $.session.id(),
      osVar: () => $.env.get('OS'),
    }
    if (!isRemote && cb.config.allowFileOrigin) {
      await $.tool.register({
        name: PAGE_TOKEN_TOOL,
        description:
          'Artifact Callbacks, file:// token mode: returns the head tags (cb-token, cb-endpoint, cb-page meta tags and ' +
          'the client script) for an interactive page the user will open straight from disk. Prefer the served ' +
          'http://127.0.0.1 link; use this only for file:// pages.',
        inputSchema: {
          type: 'object',
          properties: { page: { type: 'string', description: 'The page path relative to the artifacts folder, e.g. triage.html' } },
          required: ['page'],
        },
        isDeferred: false,
      })
    }
    if (!isRemote) {
      await $.command.register({
        name: 'callbacks',
        description: 'Artifact Callbacks: status, open a page, pause/resume, start/stop, rotate, trust',
        argumentHint: '[open <page>|pause|resume|start|stop|rotate|trust <page>|untrust <page>]',
        immediate: true,
      })
    }
    await cb.start(effects, e.cwd, isRemote)
    return started
  })

  // The mod's own prompt: attach the raw event JSON as hidden context.
  on('prompt.submit', async ($, e, next) => {
    const context = e.command === undefined ? cb.contextFor(e.text, e.origin) : undefined
    if (context === undefined) return next(e)
    return next({ ...e, context: [...(e.context ?? []), context] })
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await cb.turnStarted(e.turnId, e.text)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await cb.turnCompleted(e.turnId, e.reason, e.isAborted)
    return result
  })

  if (cb.config.streamReplies) {
    on('turn.step', async function* ($, e, next) {
      const stream = next(e)
      const id = e.agentId === undefined ? cb.streamingEvent(e.turnId) : undefined
      if (id === undefined) return yield* stream
      for await (const chunk of stream) {
        if (chunk.kind === 'text') cb.streamText(id, chunk.text)
        yield chunk
      }
      return await stream.result
    })
  }

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const text = cb.composeSection()
    if (text === undefined) return result
    return { ...result, sections: [...result.sections, { id: COMPOSE_SECTION_ID, text, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { value: events = [] } = await $.state.get({ plugin: 'artifact-callbacks', key: 'events' })
    const waiting = firstAwaiting(events)
    if (!waiting) return next(e)
    const more = events.filter(r => r.state === 'awaiting-approval' && r.coalescedInto === null).length - 1
    const { Box, Text, Button } = $.ui.resolve(e)
    const label = clip(waiting.label ?? waiting.action, 60)
    const hint = cb.config.policy === 'first-per-page' ? 'Run trusts this page for the session' : 'asked for every event'
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{clip(waiting.page, 60)}</Text> sent "{label}" (action: {waiting.action})
          {more > 0 ? <Text dimColor>{` · ${more} more waiting`}</Text> : null}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="cb-run" label="Run" variant="primary" onPress={() => cb.approve(waiting.id)} />
          <Button key="cb-discard" label="Discard" onPress={() => cb.discard(waiting.id)} />
          <Text dimColor>{hint}</Text>
        </Box>
      </Box>
    )
  })

  on('tool.call', { tool: 'mcp__artifact-callbacks__page_token' }, async ($, e) => {
    const { text, isError } = await cb.pageTokenTags((e as { page?: unknown }).page)
    return isError ? { deny: text } : { result: text }
  })

  on('command.run', { command: 'callbacks' }, async ($, e) => ({ text: await cb.command(e.args) }))
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
