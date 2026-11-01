// Shared setup for the Chromium end-to-end tests: a real listener (the Node one
// unless CB_LISTENER_CMD says otherwise) plus Playwright's Chromium.
import { createRequire } from 'node:module'
import http from 'node:http'
import { startListener, waitFor, sleep } from '../conformance/harness.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

export { startListener, waitFor, sleep }

export async function launch () {
  return chromium.launch()
}

/** Page markup that loads the client from the listener (relative, same origin). */
export function page (body, head = '') {
  return `<!doctype html><html><head><meta charset="utf-8">${head}<script src="/_cb/client.js"></script></head><body>${body}</body></html>`
}

/** Events emitted on stdout so far. */
export function events (L) {
  return L.lines.filter((l) => l.type === 'event')
}

/** Wait until stdout settles (marker round-trip), then return all event lines. */
export async function settledEvents (L, ms = 300) {
  await sleep(ms)
  await L.marker()
  return events(L)
}

/** Open a page in a fresh context and speed up the client's polling. */
export async function open (browser, url, { context } = {}) {
  const ctx = context || await browser.newContext()
  const p = await ctx.newPage()
  p.on('pageerror', (err) => { p.__errors = (p.__errors || []).concat(String(err)) })
  await p.goto(url)
  await p.waitForFunction(() => !!window.ArtifactCallbacks)
  await p.evaluate(() => { window.ArtifactCallbacks.config.pollMinMs = 80; window.ArtifactCallbacks.config.pollMaxMs = 200 })
  return { ctx, page: p }
}

/** A plain HTTP server on another port, serving `routes` (path -> html) and recording requests. */
export async function otherServer (routes, host = '127.0.0.1') {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      const html = routes[req.url.split('?')[0]]
      if (html === undefined) {
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
  })
  await new Promise((resolve) => server.listen(0, host, resolve))
  return { server, port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) }
}

export function attr (p, selector, name) {
  return p.locator(selector).getAttribute(name)
}

export async function waitAttr (p, selector, name, value, timeout = 5000) {
  await p.waitForFunction(([s, n, v]) => {
    const el = document.querySelector(s)
    return el && el.getAttribute(n) === v
  }, [selector, name, value], { timeout })
}
