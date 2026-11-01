// @ts-check
/*
 * Artifact Callbacks browser client. Served by the listener at /_cb/client.js.
 * Classic script: <script src="/_cb/client.js" defer></script>
 * Plain JavaScript (browsers cannot run TypeScript), type-checked by
 * `tsc --checkJs` through the JSDoc annotations below.
 *
 * Declarative wiring (click / submit, delegated from document):
 *   data-cb-action   on a button, link or form: the action name (required)
 *   data-cb-data     JSON object merged into `data` (form fields are merged over it)
 *   data-cb-prompt   prompt template, verified by the listener against the page on disk
 *   data-cb-label    label sent with the event (default: element text, or the submit button's text for forms)
 *   data-cb-confirm  text for a window.confirm() before sending; Cancel sends nothing
 * While an event is in flight the element carries data-cb-state:
 *   queued | running | done | rejected
 * plus data-cb-detail with the precise state when it differs:
 *   sending (no answer yet) and awaiting-approval show as queued;
 *   dropped and expired show as rejected (data-cb-reason names why, e.g. paused).
 * Clicks on an element whose state is queued or running are ignored.
 *
 * Imperative API (window.ArtifactCallbacks):
 *   const ev = await ArtifactCallbacks.send(action, data?, { label?, prompt?, page?, idempotencyKey?, toast? })
 *   ev.id, ev.state, ev.reason
 *   ev.on('state', s => ...)   replays the current state, then each change
 *   ev.on('text', t => ...)    Claude's reply text as it streams (opens the stream)
 *   ev.stream()                open the reply stream explicitly
 *   ev.done                    resolves on done; rejects on rejected / dropped / expired
 *   ev.onDone(cb)
 *   ArtifactCallbacks.onDone(cb)  cb(handle) whenever any event from this page is done
 *
 * file:// pages (token mode, only when the user enabled allowFileOrigin):
 *   <meta name="cb-token" content="...">        per-page token
 *   <meta name="cb-endpoint" content="http://127.0.0.1:<port>">
 *   <meta name="cb-page" content="triage.html"> optional, page path relative to the artifacts folder
 * Other: <meta name="cb-toast" content="off"> silences the toast.
 */

(function () {
  'use strict'

  /**
   * @typedef {(value: string, handle: Handle) => void} Listener  state or text listener
   * @typedef {(handle: Handle) => void} DoneListener
   * @typedef {{ label?: string | null, prompt?: string | null, page?: string, idempotencyKey?: string,
   *   toast?: boolean, onState?: Listener }} SendOptions
   * @typedef {{ v: 1, action: string, data: object, page: string, idempotencyKey: string,
   *   label?: string, prompt?: string }} EventBody
   * @typedef {{ status: number, json: any }} ApiResult  `json` is the parsed response body, or null
   * @typedef {{ token: string | null, endpoint: string | null }} Env  endpoint '' = same origin, null = unusable
   * @typedef {{ label: string, run: () => void }} ToastAction
   * @typedef {{ close: () => void }} Closable
   * @typedef {Error & { state?: string, reason?: string | null, handle?: Handle }} EventError
   * @typedef {{ reason?: string | null, note?: string | null }} StateExtra
   * @typedef {Element & { value?: string }} Labelled  an element that may carry a value (button, input)
   * @typedef {Element & { name?: string, type?: string, value: string, checked?: boolean,
   *   disabled?: boolean, options?: HTMLOptionsCollection }} FormControl
   * @typedef {{ pollMinMs: number, pollMaxMs: number, retryMs: number, toastMs: number }} ClientConfig
   * @typedef {{ __cb: true, version: 1,
   *   send: (action: string, data?: object | null, opts?: SendOptions) => Promise<Handle>,
   *   onDone: (cb: DoneListener) => void, page: () => string,
   *   toast: (text: string, kind?: string, action?: ToastAction) => HTMLElement | null,
   *   config: ClientConfig }} ArtifactCallbacksApi
   */

  // window.ArtifactCallbacks is this script's own global; the DOM typings do not know it.
  var cbWindow = /** @type {{ ArtifactCallbacks?: ArtifactCallbacksApi }} */ (/** @type {unknown} */ (window))
  if (cbWindow.ArtifactCallbacks && cbWindow.ArtifactCallbacks.__cb) return

  /** @type {Record<string, number>} */
  var TERMINAL = { done: 1, rejected: 1, dropped: 1, expired: 1 }
  /** @type {Record<string, number>} */
  var FAILED = { rejected: 1, dropped: 1, expired: 1 }
  /** @type {Record<string, string>} */
  var ELEMENT_STATE = {
    sending: 'queued',
    queued: 'queued',
    'awaiting-approval': 'queued',
    running: 'running',
    done: 'done',
    rejected: 'rejected',
    dropped: 'rejected',
    expired: 'rejected'
  }
  /** @type {ClientConfig} */
  var config = { pollMinMs: 400, pollMaxMs: 3000, retryMs: 400, toastMs: 4000 }
  /** @type {DoneListener[]} */
  var doneListeners = []

  // -------------------------------------------------------------------------
  // environment

  /** @param {string} name @returns {string | null} */
  function meta (name) {
    var m = document.querySelector('meta[name="' + name + '"]')
    return m ? m.getAttribute('content') || '' : null
  }

  /** @returns {Env} */
  function env () {
    var token = meta('cb-token')
    var local = location.protocol === 'http:' || location.protocol === 'https:'
    /** @type {Env} */
    var e = { token: token || null, endpoint: '' }
    if (e.token && !local) {
      var m = /^(http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5})\/?$/.exec(meta('cb-endpoint') || '')
      e.endpoint = m ? /** @type {string} */ (m[1]) : null
    }
    return e
  }

  /** @returns {string} */
  function currentPage () {
    var p = meta('cb-page')
    if (p) return p
    var path = location.pathname
    try { path = decodeURIComponent(path) } catch (err) {}
    return path
  }

  /** @returns {string} */
  function newKey () {
    var c = window.crypto
    if (c && typeof c.randomUUID === 'function') return c.randomUUID()
    var a = new Uint8Array(16)
    if (c && c.getRandomValues) c.getRandomValues(a)
    else for (var i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256)
    var s = ''
    for (var j = 0; j < 16; j++) {
      var b = /** @type {number} */ (a[j])
      s += (b < 16 ? '0' : '') + b.toString(16)
    }
    return s
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {EventBody} [body]
   * @returns {Promise<ApiResult>}
   */
  function api (method, path, body) {
    var e = env()
    if (e.endpoint === null) return Promise.reject(new Error('cb-endpoint meta is missing or not a loopback URL'))
    /** @type {Record<string, string>} */
    var headers = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (e.token) headers['X-CB-Token'] = e.token
    return fetch(e.endpoint + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: e.endpoint ? 'omit' : 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      return res.text().then(function (t) {
        var j = null
        try { j = JSON.parse(t) } catch (err) {}
        return { status: res.status, json: j }
      })
    })
  }

  // -------------------------------------------------------------------------
  // toast

  /** @type {HTMLElement | null} */
  var toastBox = null

  /**
   * @param {string} text
   * @param {string} [kind] info (default), ok or error
   * @param {ToastAction} [action] a button on the toast; the toast then stays until used or dismissed
   * @returns {HTMLElement | null}
   */
  function toast (text, kind, action) {
    if (meta('cb-toast') === 'off' || !document.body) return null
    if (!toastBox || !toastBox.isConnected) {
      toastBox = document.createElement('div')
      toastBox.setAttribute('data-cb-toasts', '')
      toastBox.setAttribute('aria-live', 'polite')
      toastBox.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;' +
        'flex-direction:column;gap:8px;max-width:min(360px,calc(100vw - 32px));pointer-events:none;' +
        'font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif'
      document.body.appendChild(toastBox)
    }
    var el = document.createElement('div')
    el.setAttribute('data-cb-toast', kind || 'info')
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status')
    var bg = kind === 'error' ? '#8a1c1c' : kind === 'ok' ? '#1d5b33' : '#26282c'
    el.style.cssText = 'pointer-events:auto;background:' + bg + ';color:#fff;padding:8px 12px;border-radius:8px;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center;opacity:.96'
    var span = document.createElement('span')
    span.textContent = text
    el.appendChild(span)
    function remove () { if (el.parentNode) el.parentNode.removeChild(el) }
    if (action) {
      var b = document.createElement('button')
      b.type = 'button'
      b.textContent = action.label
      b.setAttribute('data-cb-toast-action', '')
      b.style.cssText = 'font:inherit;background:#fff;color:#111;border:0;border-radius:6px;padding:3px 10px;cursor:pointer'
      b.addEventListener('click', function () { remove(); action.run() })
      el.appendChild(b)
      var x = document.createElement('button')
      x.type = 'button'
      x.textContent = '×'
      x.setAttribute('aria-label', 'Dismiss')
      x.style.cssText = 'font:inherit;background:transparent;color:#fff;border:0;cursor:pointer;padding:0 2px'
      x.addEventListener('click', remove)
      el.appendChild(x)
    } else {
      setTimeout(remove, config.toastMs)
    }
    toastBox.appendChild(el)
    return el
  }

  /** @type {Record<string, string>} */
  var DROP_TEXT = {
    paused: 'Not sent: callbacks are paused in Claude Code.',
    'queue-full': 'Not sent: too many events are already waiting. Try again shortly.',
    'rate-limit': 'Not sent: too many events in the last minute. Try again shortly.'
  }

  /** @param {Handle} h @returns {string} */
  function failureText (h) {
    if (h.state === 'dropped') return DROP_TEXT[String(h.reason)] || 'Not sent (' + (h.reason || 'dropped') + ').'
    if (h.state === 'expired') return 'Expired: nobody approved this event in Claude Code.'
    if (h.reason === 'network') return 'Could not reach Claude Code. Is the session still running?'
    if (h.reason === 'too-large') return 'Not sent: too much data.'
    if (h.reason === 'forbidden') return 'Rejected by Claude Code. Open the page from its link again.'
    if (h.reason && h.reason !== 'rejected') return 'Rejected: ' + h.reason
    return 'Discarded in Claude Code.'
  }

  /** @param {unknown} err */
  function rethrowLater (err) {
    setTimeout(function () { throw err }, 0)
  }

  // -------------------------------------------------------------------------
  // handle

  /** One event sent from this page: its id, state and listeners. */
  class Handle {
    /**
     * @param {string} action
     * @param {string | undefined} label
     * @param {SendOptions} opts
     */
    constructor (action, label, opts) {
      var self = this
      this.action = action
      this.label = label
      /** @type {string | null} */
      this.id = null
      /** @type {string | null} */
      this.state = null
      /** @type {string | null} */
      this.reason = null
      /** @type {string | null} */
      this.note = null
      this._toast = opts.toast !== false
      /** @type {{ state: Listener[], text: Listener[], [type: string]: Listener[] | undefined }} */
      this._l = { state: [], text: [] }
      /** @type {ReturnType<typeof setTimeout> | null} */
      this._timer = null
      /** @type {Closable | null} */
      this._stream = null
      /** True once the reply stream has ended (end frame, error or close). */
      this._streamEnded = false
      /** @type {string | null} A terminal state the reply stream announced, applied when it ends. */
      this._streamTerminal = null
      /** @type {{ state: string, extra: StateExtra | undefined } | null} A terminal state polling saw while the stream was open. */
      this._pending = null
      /** @type {(h: Handle) => void} */
      this._resolve = function () {}
      /** @type {(e: EventError) => void} */
      this._reject = function () {}
      /** @type {Promise<Handle>} */
      this.done = new Promise(function (resolve, reject) {
        self._resolve = resolve
        self._reject = reject
      })
      this.done.catch(function () {}) // observing is optional
    }

    /** @param {string} type state or text @param {Listener} cb @returns {this} */
    on (type, cb) {
      var l = this._l[type]
      if (!l) throw new Error('unknown event type: ' + type)
      l.push(cb)
      var self = this
      if (type === 'state' && this.state) setTimeout(function () { cb(/** @type {string} */ (self.state), self) }, 0)
      if (type === 'text') this.stream()
      return this
    }

    /** @param {string} type @param {Listener} cb @returns {this} */
    off (type, cb) {
      var l = this._l[type] || []
      var i = l.indexOf(cb)
      if (i >= 0) l.splice(i, 1)
      return this
    }

    /** @param {DoneListener} cb @returns {this} */
    onDone (cb) {
      var self = this
      this.done.then(function () { cb(self) }, function () {})
      return this
    }

    /** @param {'state' | 'text'} type @param {string} value */
    _emit (type, value) {
      var l = this._l[type].slice()
      for (var i = 0; i < l.length; i++) {
        try { /** @type {Listener} */ (l[i])(value, this) } catch (err) { rethrowLater(err) }
      }
    }

    /** @param {string} state @param {StateExtra} [extra] */
    _set (state, extra) {
      if (extra) {
        if (extra.reason !== undefined) this.reason = extra.reason
        if (extra.note !== undefined) this.note = extra.note
      }
      if (state === this.state || (this.state && TERMINAL[this.state])) return
      this.state = state
      this._emit('state', state)
      if (!TERMINAL[state]) return
      clearTimeout(this._timer || undefined)
      if (state === 'done') {
        if (this._toast) toast('Done: ' + (this.label || this.action), 'ok')
        this._resolve(this)
        for (var i = 0; i < doneListeners.length; i++) {
          try { /** @type {DoneListener} */ (doneListeners[i])(this) } catch (err) { rethrowLater(err) }
        }
      } else {
        if (this._toast && this.reason !== 'template-changed') toast(failureText(this), 'error')
        var e = /** @type {EventError} */ (new Error('event ' + state + (this.reason ? ': ' + this.reason : '')))
        e.state = state
        e.reason = this.reason
        e.handle = this
        this._reject(e)
      }
    }

    /**
     * Applies a state seen by polling. A terminal one waits while the reply
     * stream is open, so `done` never resolves before the reply's last text.
     * @param {string} state @param {StateExtra} [extra]
     */
    _finish (state, extra) {
      if (TERMINAL[state] && this._stream && !this._streamEnded) {
        this._pending = { state: state, extra: extra }
        return
      }
      this._set(state, extra)
    }

    /** A state frame from the reply stream; a terminal one is applied when the stream ends. @param {string} state */
    _streamState (state) {
      if (TERMINAL[state]) this._streamTerminal = state
      else this._set(state)
    }

    /** The reply stream is over (end frame, error or close): apply the terminal state it or polling saw. */
    _streamClosed () {
      if (this._streamEnded) return
      this._streamEnded = true
      if (this.state && TERMINAL[this.state]) return
      var self = this
      var pending = this._pending
      if (pending) {
        this._set(pending.state, pending.extra)
        return
      }
      var announced = this._streamTerminal
      if (!announced) return
      // The stream carries no note or reason: read them once before settling.
      api('GET', '/_cb/events/' + encodeURIComponent(String(this.id))).then(function (r) {
        var j = r.status === 200 && r.json && typeof r.json.state === 'string' ? r.json : null
        self._set(j && TERMINAL[j.state] ? j.state : /** @type {string} */ (announced), j || undefined)
      }, function () {
        self._set(/** @type {string} */ (announced))
      })
    }

    _poll () {
      var self = this
      var delay = config.pollMinMs
      var failures = 0
      function tick () {
        if (TERMINAL[String(self.state)]) return
        api('GET', '/_cb/events/' + encodeURIComponent(String(self.id))).then(function (r) {
          if (r.status === 200 && r.json && typeof r.json.state === 'string') {
            failures = 0
            if (r.json.state !== self.state) delay = config.pollMinMs
            self._finish(r.json.state, r.json)
          } else {
            failures++
          }
        }, function () { failures++ }).then(function () {
          if (TERMINAL[String(self.state)]) return
          if (failures >= 10) {
            if (self._toast) toast('Lost track of "' + (self.label || self.action) + '".', 'error')
            return
          }
          delay = Math.min(Math.round(delay * 1.5), config.pollMaxMs)
          self._timer = setTimeout(tick, delay)
        })
      }
      this._timer = setTimeout(tick, delay)
    }

    /** @returns {this} */
    stream () {
      if (this._stream || !this.id || this.state === 'dropped') return this
      var self = this
      var url = '/_cb/events/' + encodeURIComponent(this.id) + '/stream'
      var e = env()
      if (!e.token && typeof EventSource === 'function') {
        var es = new EventSource(url)
        this._stream = es
        es.addEventListener('text', function (m) { onFrame(self, 'text', m.data) })
        es.addEventListener('state', function (m) { onFrame(self, 'state', m.data) })
        es.addEventListener('end', function () { es.close(); self._streamClosed() })
        // Never auto-reconnect: it would replay the text.
        es.onerror = function () { es.close(); self._streamClosed() }
        return this
      }
      if (e.endpoint === null) return this
      // Token mode: EventSource cannot send X-CB-Token, so read the SSE body with fetch.
      var ctl = typeof AbortController === 'function' ? new AbortController() : null
      /** @type {Closable} */
      var closable = { close: function () { if (ctl) ctl.abort() } }
      this._stream = closable
      fetch(e.endpoint + url, {
        headers: e.token ? { 'X-CB-Token': e.token } : {},
        credentials: e.endpoint ? 'omit' : 'same-origin',
        cache: 'no-store',
        signal: ctl ? ctl.signal : undefined
      }).then(function (res) {
        if (res.status !== 200 || !res.body) { self._streamClosed(); return }
        var reader = res.body.getReader()
        var dec = new TextDecoder()
        var buf = ''
        /** @returns {Promise<void>} */
        function pump () {
          return reader.read().then(function (r) {
            if (r.done) { self._streamClosed(); return }
            buf += dec.decode(r.value, { stream: true }).replace(/\r\n?/g, '\n')
            var i
            while ((i = buf.indexOf('\n\n')) >= 0) {
              var frame = buf.slice(0, i)
              buf = buf.slice(i + 2)
              var name = 'message'
              /** @type {string[]} */
              var data = []
              frame.split('\n').forEach(function (line) {
                if (line.indexOf('event:') === 0) name = line.slice(6).trim()
                else if (line.indexOf('data:') === 0) data.push(line.slice(5).replace(/^ /, ''))
              })
              if (data.length && onFrame(self, name, data.join('\n'))) { closable.close(); self._streamClosed(); return }
            }
            return pump()
          })
        }
        return pump()
      }).catch(function () { self._streamClosed() })
      return this
    }
  }

  /**
   * Apply one SSE frame to the handle. Returns true on `end`.
   * @param {Handle} h @param {string} name @param {string} data
   * @returns {boolean}
   */
  function onFrame (h, name, data) {
    var obj
    try { obj = JSON.parse(data) } catch (err) { return false }
    if (name === 'text' && typeof obj.text === 'string') h._emit('text', obj.text)
    else if (name === 'state' && typeof obj.state === 'string') h._streamState(obj.state)
    else if (name === 'end') return true
    return false
  }

  // -------------------------------------------------------------------------
  // send

  /** @param {EventBody} body @param {number} retries @returns {Promise<ApiResult>} */
  function post (body, retries) {
    return api('POST', '/_cb/event', body).catch(function (err) {
      if (retries > 0) {
        return new Promise(function (r) { setTimeout(r, config.retryMs) }).then(function () { return post(body, retries - 1) })
      }
      throw err
    })
  }

  function promptReload () {
    toast('This page changed since you opened it. Reload to continue.', 'error', {
      label: 'Reload',
      run: function () { location.reload() }
    })
  }

  /**
   * @param {string} action
   * @param {object | null} [data]
   * @param {SendOptions} [opts]
   * @returns {Promise<Handle>}
   */
  function send (action, data, opts) {
    opts = opts || {}
    var label = opts.label == null ? undefined : String(opts.label).slice(0, 200)
    var h = new Handle(action, label, opts)
    if (opts.onState) h.on('state', opts.onState)
    /** @type {EventBody} */
    var body = {
      v: 1,
      action: action,
      data: data || {},
      page: opts.page || currentPage(),
      idempotencyKey: opts.idempotencyKey || newKey()
    }
    if (label !== undefined) body.label = label
    if (opts.prompt != null) body.prompt = String(opts.prompt)
    return post(body, 1).then(function (r) {
      var j = r.json || {}
      if (r.status === 202 && j.id) {
        h.id = j.id
        if (h._toast && !TERMINAL[j.state]) toast('Sent to Claude: ' + (label || action))
        h._set(j.state || 'queued')
        if (!TERMINAL[String(h.state)]) h._poll()
      } else if (r.status === 429 && j.id) {
        h.id = j.id
        h._set('dropped', { reason: j.reason || 'dropped' })
      } else if (r.status === 409) {
        h._set('rejected', { reason: 'template-changed' })
        promptReload()
      } else {
        var reason = r.status === 413 ? 'too-large' : r.status === 403 ? 'forbidden' : j.error || 'http-' + r.status
        h._set('rejected', { reason: reason })
      }
      return h
    }, function () {
      h._set('rejected', { reason: 'network' })
      return h
    })
  }

  // -------------------------------------------------------------------------
  // declarative wiring

  /** @param {Element} el @param {string} state @param {Handle} [h] */
  function setElementState (el, state, h) {
    el.setAttribute('data-cb-state', ELEMENT_STATE[state] || state)
    if (ELEMENT_STATE[state] && ELEMENT_STATE[state] !== state) el.setAttribute('data-cb-detail', state)
    else el.removeAttribute('data-cb-detail')
    if (h && h.reason && FAILED[state]) el.setAttribute('data-cb-reason', h.reason)
    else el.removeAttribute('data-cb-reason')
    if (h && h.id) el.setAttribute('data-cb-event', h.id)
    if (state === 'queued' || state === 'running' || state === 'sending' || state === 'awaiting-approval') el.setAttribute('aria-busy', 'true')
    else el.removeAttribute('aria-busy')
  }

  /** @param {Element} el */
  function inFlight (el) {
    var s = el.getAttribute('data-cb-state')
    return s === 'queued' || s === 'running'
  }

  /** @param {Element} el */
  function text (el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim()
  }

  /** @param {Labelled} el @param {Labelled | null} [submitter] @returns {string} */
  function labelFor (el, submitter) {
    var l = el.getAttribute('data-cb-label')
    if (l) return l
    if (el.tagName === 'FORM') {
      if (submitter) l = text(submitter) || submitter.value || ''
      return l || el.getAttribute('aria-label') || ''
    }
    return text(el) || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || ''
  }

  /**
   * The form's fields as JSON values: strings, booleans (lone checkbox),
   * string arrays (checkbox groups, multi-selects, repeated names) or null (unchecked radio group).
   * @param {HTMLFormElement} form
   * @param {Labelled | null} [submitter]
   * @returns {Record<string, any>}
   */
  function formFields (form, submitter) {
    /** @type {Record<string, any>} */
    var out = {}
    /** @type {Record<string, number>} */
    var counts = {}
    var els = form.elements
    var i, el
    for (i = 0; i < els.length; i++) {
      el = /** @type {FormControl} */ (els[i])
      if (el.name && el.type === 'checkbox') counts[el.name] = (counts[el.name] || 0) + 1
    }
    for (i = 0; i < els.length; i++) {
      el = /** @type {FormControl} */ (els[i])
      var name = el.name
      if (!name || el.disabled || (el.matches && el.matches('fieldset[disabled] *'))) continue
      var type = (el.type || '').toLowerCase()
      if (type === 'submit' || type === 'image') {
        if (el === submitter) out[name] = el.value
        continue
      }
      if (type === 'button' || type === 'reset' || type === 'file' || el.tagName === 'FIELDSET' || el.tagName === 'OUTPUT') continue
      if (type === 'checkbox') {
        if ((counts[name] || 0) > 1) {
          if (!Array.isArray(out[name])) out[name] = []
          if (el.checked) out[name].push(el.value)
        } else {
          out[name] = !!el.checked
        }
      } else if (type === 'radio') {
        if (el.checked) out[name] = el.value
        else if (!(name in out)) out[name] = null
      } else if (type === 'select-multiple') {
        /** @type {string[]} */
        var vals = []
        var options = /** @type {HTMLOptionsCollection} */ (el.options)
        for (var k = 0; k < options.length; k++) {
          var option = /** @type {HTMLOptionElement} */ (options[k])
          if (option.selected) vals.push(option.value)
        }
        out[name] = vals
      } else if (name in out) {
        out[name] = /** @type {string[]} */ ([]).concat(out[name], el.value)
      } else {
        out[name] = el.value
      }
    }
    return out
  }

  /** @param {Labelled} el @param {Labelled | null} [submitter] */
  function fire (el, submitter) {
    if (inFlight(el)) return
    var action = /** @type {string} */ (el.getAttribute('data-cb-action'))
    /** @type {Record<string, any>} */
    var data = {}
    var raw = el.getAttribute('data-cb-data')
    if (raw) {
      var parsed
      try { parsed = JSON.parse(raw) } catch (err) { parsed = null }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.error('[artifact-callbacks] data-cb-data must be a JSON object:', raw)
        toast('This control is miswired (bad data-cb-data).', 'error')
        return
      }
      data = parsed
    }
    if (el.tagName === 'FORM') {
      var fields = formFields(/** @type {HTMLFormElement} */ (/** @type {Element} */ (el)), submitter)
      for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) data[k] = fields[k]
    }
    var confirmText = el.getAttribute('data-cb-confirm')
    if (confirmText !== null && !window.confirm(confirmText || 'Send "' + action + '"?')) return
    var prompt = el.getAttribute('data-cb-prompt')
    setElementState(el, 'sending')
    send(action, data, {
      label: labelFor(el, submitter) || undefined,
      prompt: prompt === null ? undefined : prompt,
      onState: function (s, h) { setElementState(el, s, h) }
    })
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return
    var t = /** @type {Partial<Element> | null} */ (e.target)
    if (!t || !t.closest) return
    var el = t.closest('[data-cb-action]')
    if (!el || el.tagName === 'FORM') return
    e.preventDefault()
    fire(el)
  })

  document.addEventListener('submit', function (e) {
    var form = /** @type {Partial<HTMLFormElement> | null} */ (e.target)
    if (!form || !form.hasAttribute || !form.hasAttribute('data-cb-action') || e.defaultPrevented) return
    e.preventDefault()
    fire(/** @type {HTMLFormElement} */ (form), e.submitter || null)
  })

  cbWindow.ArtifactCallbacks = {
    __cb: true,
    version: 1,
    send: send,
    onDone: function (cb) { doneListeners.push(cb) },
    page: currentPage,
    toast: toast,
    config: config
  }
})()
