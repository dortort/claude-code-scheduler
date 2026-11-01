// Shared setup for the Chromium end-to-end tests: a real listener (the Node one
// unless CB_LISTENER_CMD says otherwise) plus Playwright's Chromium.
import { createRequire } from 'node:module'
import http from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { startListener, waitFor, sleep } from '../conformance/harness.ts'
import type { Line, Listener } from '../conformance/harness.ts'
import type { Browser, BrowserContext, BrowserType, Page } from './playwright.ts'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: BrowserType }

export { startListener, waitFor, sleep }
export type { Browser, BrowserContext, Page, Line, Listener }

export async function launch (): Promise<Browser> {
  return chromium.launch()
}

/** Page markup that loads the client from the listener (relative, same origin). */
export function page (body: string, head = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}<script src="/_cb/client.js"></script></head><body>${body}</body></html>`
}

/** Events emitted on stdout so far. */
export function events (L: Listener): Line[] {
  return L.lines.filter((l) => l.type === 'event')
}

/** Wait until stdout settles (marker round-trip), then return all event lines. */
export async function settledEvents (L: Listener, ms = 300): Promise<Line[]> {
  await sleep(ms)
  await L.marker()
  return events(L)
}

/** A page with the uncaught errors it raised. */
export type TrackedPage = Page & { __errors?: string[] }

/** Open a page in a fresh context and speed up the client's polling. */
export async function open (browser: Browser, url: string, { context }: { context?: BrowserContext } = {}): Promise<{ ctx: BrowserContext; page: TrackedPage }> {
  const ctx = context || await browser.newContext()
  const p: TrackedPage = await ctx.newPage()
  p.on('pageerror', (err) => { p.__errors = (p.__errors || []).concat(String(err)) })
  await p.goto(url)
  await p.waitForFunction(() => !!window.ArtifactCallbacks)
  await p.evaluate(() => { window.ArtifactCallbacks.config.pollMinMs = 80; window.ArtifactCallbacks.config.pollMaxMs = 200 })
  return { ctx, page: p }
}

export interface SeenRequest { method: string | undefined; url: string | undefined; headers: IncomingHttpHeaders; body: string }

export interface OtherServer {
  server: http.Server
  port: number
  seen: SeenRequest[]
  close (): Promise<void>
}

/** A plain HTTP server on another port, serving `routes` (path -> html) and recording requests. */
export async function otherServer (routes: { [path: string]: string }, host = '127.0.0.1'): Promise<OtherServer> {
  const seen: SeenRequest[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d: Buffer) => { body += d })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      const html = routes[String(req.url).split('?')[0] ?? '']
      if (html === undefined) {
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  return {
    server,
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

export function attr (p: Page, selector: string, name: string): Promise<string | null> {
  return p.locator(selector).getAttribute(name)
}

export async function waitAttr (p: Page, selector: string, name: string, value: string, timeout = 5000): Promise<void> {
  await p.waitForFunction(([s, n, v]) => {
    const el = document.querySelector(s)
    return el && el.getAttribute(n) === v
  }, [selector, name, value] as const, { timeout })
}
