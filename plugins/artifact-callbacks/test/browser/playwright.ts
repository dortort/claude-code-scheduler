// The slice of Playwright's API the browser suite uses. Playwright is the
// preinstalled global (`require('playwright')`), not a dev dependency, so its own
// typings are not resolvable here; these mirror its signatures for what we call.

export interface Cookie {
  name: string
  value: string
  domain: string
  path: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

export interface Dialog {
  message (): string
  accept (promptText?: string): Promise<void>
  dismiss (): Promise<void>
}

export interface Locator {
  first (): Locator
  waitFor (options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }): Promise<void>
  textContent (options?: { timeout?: number }): Promise<string | null>
  getAttribute (name: string, options?: { timeout?: number }): Promise<string | null>
}

export interface Timeout { timeout?: number }

export interface Page {
  goto (url: string, options?: Timeout): Promise<unknown>
  url (): string
  click (selector: string, options?: Timeout): Promise<void>
  dblclick (selector: string, options?: Timeout): Promise<void>
  check (selector: string, options?: Timeout): Promise<void>
  fill (selector: string, value: string, options?: Timeout): Promise<void>
  press (selector: string, key: string, options?: Timeout): Promise<void>
  locator (selector: string): Locator
  evaluate<R> (fn: () => R | Promise<R>): Promise<R>
  evaluate<R, A> (fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>
  waitForFunction<A> (fn: (arg: A) => unknown, arg?: A, options?: Timeout): Promise<unknown>
  waitForSelector (selector: string, options?: Timeout): Promise<unknown>
  waitForEvent (event: 'load', options?: Timeout): Promise<unknown>
  on (event: 'pageerror', listener: (err: Error) => void): Page
  once (event: 'dialog', listener: (dialog: Dialog) => void): Page
}

export interface BrowserContext {
  newPage (): Promise<Page>
  cookies (urls?: string | string[]): Promise<Cookie[]>
  close (): Promise<void>
}

export interface Browser {
  newContext (): Promise<BrowserContext>
  close (): Promise<void>
}

export interface BrowserType {
  launch (): Promise<Browser>
}
