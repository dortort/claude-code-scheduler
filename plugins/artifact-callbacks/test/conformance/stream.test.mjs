// M5: GET /_cb/events/<id>/stream (server-sent events from the reply-stream file).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startListener, makeDirs, waitFor, sleep, assertBaseHeaders } from './harness.mjs'

const PAGE = '<!doctype html><button data-cb-action="ask">Ask</button>'

/** Open an SSE stream; collects frames { event, data } and comments. */
function openStream (L, id, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: L.host, cookie: `${L.cookieName}=${L.cookieValue}`, 'sec-fetch-site': 'same-origin', accept: 'text/event-stream', ...headers }
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k]
    const req = http.request({ host: '127.0.0.1', port: L.port, path: `/_cb/events/${id}/stream`, headers: h, agent: false })
    req.once('error', reject)
    req.once('response', (res) => {
      const S = { res, status: res.statusCode, headers: res.headers, frames: [], comments: [], raw: '', ended: false }
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (d) => {
        S.raw += d
        buf += d
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          let event = 'message'
          const data = []
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) S.comments.push(line.slice(1).trim())
            else if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
          }
          if (data.length) S.frames.push({ event, data: JSON.parse(data.join('\n')) })
        }
      })
      S.closed = new Promise((r) => res.once('close', () => { S.ended = true; r() }))
      S.destroy = () => req.destroy()
      resolve(S)
    })
    req.end()
  })
}

async function setup (env = {}) {
  const L = await startListener({ env: { CB_STREAM_DIR: undefined, ...env } })
  await L.serve('p.html', PAGE)
  const id = (await L.post({ v: 1, action: 'ask' })).json.id
  return { L, id }
}

describe('reply stream', () => {
  test('replays the file, tails new lines, closes after end', async () => {
    const dirs = makeDirs()
    const L = await startListener({ dirs, env: { CB_STREAM_DIR: dirs.streams } })
    try {
      await L.serve('p.html', PAGE)
      const id = (await L.post({ v: 1, action: 'ask' })).json.id
      const file = join(dirs.streams, `${id}.ndjson`)
      writeFileSync(file, JSON.stringify({ type: 'state', state: 'running' }) + '\n' + JSON.stringify({ type: 'text', text: 'Hello' }) + '\n')
      const S = await openStream(L, id)
      assert.equal(S.status, 200)
      assert.match(S.headers['content-type'], /^text\/event-stream/)
      assertBaseHeaders(assert, { headers: S.headers })
      await waitFor(() => S.frames.length >= 2, { what: 'replayed frames' })
      assert.deepEqual(S.frames, [
        { event: 'state', data: { type: 'state', state: 'running' } },
        { event: 'text', data: { type: 'text', text: 'Hello' } }
      ])
      // tail: a line written in two pieces, with multibyte text split across writes
      const line = JSON.stringify({ type: 'text', text: ', wörld ✓\nline2' }) + '\n'
      const bytes = Buffer.from(line)
      appendFileSync(file, bytes.subarray(0, 20))
      await sleep(400)
      assert.equal(S.frames.length, 2)
      appendFileSync(file, bytes.subarray(20))
      await waitFor(() => S.frames.length >= 3, { what: 'tailed frame' })
      assert.deepEqual(S.frames[2], { event: 'text', data: { type: 'text', text: ', wörld ✓\nline2' } })
      // junk lines and unknown types are skipped
      appendFileSync(file, 'not json\n{"type":"other"}\n[1]\n')
      appendFileSync(file, JSON.stringify({ type: 'end' }) + '\n' + JSON.stringify({ type: 'text', text: 'after end' }) + '\n')
      await Promise.race([S.closed, sleep(3000).then(() => { throw new Error('stream did not close after end') })])
      assert.deepEqual(S.frames.slice(3), [{ event: 'end', data: { type: 'end' } }])
    } finally {
      await L.cleanup()
    }
  })

  test('closes with state + end when status.json reaches a terminal state', async () => {
    const dirs = makeDirs()
    const L = await startListener({ dirs, env: { CB_STREAM_DIR: dirs.streams } })
    try {
      await L.serve('p.html', PAGE)
      const id = (await L.post({ v: 1, action: 'ask' })).json.id
      const S = await openStream(L, id)
      await sleep(300)
      assert.equal(S.frames.length, 0)
      assert.equal(S.ended, false)
      writeFileSync(join(dirs.streams, `${id}.ndjson`), JSON.stringify({ type: 'text', text: 'partial answer' }) + '\n')
      await waitFor(() => S.frames.length >= 1, { what: 'text frame' })
      L.writeStatus({ events: { [id]: { id, state: 'done', page: 'p.html', action: 'ask', turnStartedAt: 1, turnEndedAt: 2, note: null } } })
      await Promise.race([S.closed, sleep(3000).then(() => { throw new Error('did not close on terminal state') })])
      assert.deepEqual(S.frames, [
        { event: 'text', data: { type: 'text', text: 'partial answer' } },
        { event: 'state', data: { type: 'state', state: 'done' } },
        { event: 'end', data: { type: 'end' } }
      ])
    } finally {
      await L.cleanup()
    }
  })

  test('a terminal state already announced by the file is not repeated', async () => {
    const dirs = makeDirs()
    const L = await startListener({ dirs, env: { CB_STREAM_DIR: dirs.streams } })
    try {
      await L.serve('p.html', PAGE)
      const id = (await L.post({ v: 1, action: 'ask' })).json.id
      writeFileSync(join(dirs.streams, `${id}.ndjson`), JSON.stringify({ type: 'state', state: 'done' }) + '\n')
      L.writeStatus({ events: { [id]: { id, state: 'done', page: 'p.html', action: 'ask' } } })
      const S = await openStream(L, id)
      await S.closed
      assert.deepEqual(S.frames.map((f) => f.event), ['state', 'end'])
    } finally {
      await L.cleanup()
    }
  })

  test('a dropped event ends at once', async () => {
    const L = await startListener()
    try {
      await L.serve('p.html', PAGE)
      L.writeStatus({ paused: true })
      const id = (await L.post({ v: 1, action: 'ask' })).json.id
      const S = await openStream(L, id)
      await Promise.race([S.closed, sleep(3000).then(() => { throw new Error('did not close') })])
      assert.deepEqual(S.frames, [
        { event: 'state', data: { type: 'state', state: 'dropped' } },
        { event: 'end', data: { type: 'end' } }
      ])
    } finally {
      await L.cleanup()
    }
  })

  test('without CB_STREAM_DIR the stream still ends on a terminal state', async () => {
    const { L, id } = await setup()
    try {
      const S = await openStream(L, id)
      L.writeStatus({ events: { [id]: { id, state: 'expired', page: 'p.html', action: 'ask' } } })
      await Promise.race([S.closed, sleep(3000).then(() => { throw new Error('did not close') })])
      assert.deepEqual(S.frames.map((f) => [f.event, f.data.state]), [['state', 'expired'], ['end', undefined]])
    } finally {
      await L.cleanup()
    }
  })

  test('sends : ping comments (CB_STREAM_PING_MS) and outlives the request timeout', async () => {
    const { L, id } = await setup({ CB_STREAM_PING_MS: '150', CB_REQUEST_TIMEOUT_MS: '300' })
    try {
      const S = await openStream(L, id)
      await waitFor(() => S.comments.filter((c) => c === 'ping').length >= 3, { what: 'pings' })
      await sleep(500)
      assert.equal(S.ended, false)
      S.destroy()
    } finally {
      await L.cleanup()
    }
  })

  test('auth as for polling; unknown id → 404', async () => {
    const { L, id } = await setup()
    try {
      let S = await openStream(L, id, { cookie: undefined })
      assert.equal(S.status, 403)
      await S.closed
      assert.equal(S.raw, '')
      S = await openStream(L, id, { origin: 'https://evil.example' })
      assert.equal(S.status, 403)
      await S.closed
      S = await openStream(L, id, { 'sec-fetch-site': 'cross-site' })
      assert.equal(S.status, 403)
      await S.closed
      S = await openStream(L, 'ev_zzzzzzzzzz')
      assert.equal(S.status, 404)
      await S.closed
      for (const reason of ['auth', 'origin', 'sec-fetch-site']) {
        await L.waitLine((l) => l.type === 'rejected' && l.reason === reason && l.path === `/_cb/events/${id}/stream`)
      }
    } finally {
      await L.cleanup()
    }
  })

  test('client disconnect stops the stream without crashing the listener', async () => {
    const { L, id } = await setup()
    try {
      const S = await openStream(L, id)
      S.destroy()
      await sleep(600)
      assert.equal(L.exit, null)
      assert.equal((await L.req({ path: '/_cb/health' })).status, 200)
    } finally {
      await L.cleanup()
    }
  })
})

