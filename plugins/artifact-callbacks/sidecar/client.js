/*
 * Artifact Callbacks browser client. Served by the listener at /_cb/client.js.
 * Classic script: <script src="/_cb/client.js" defer></script>
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
  if (window.ArtifactCallbacks && window.ArtifactCallbacks.__cb) return

  var TERMINAL = { done: 1, rejected: 1, dropped: 1, expired: 1 }
  var FAILED = { rejected: 1, dropped: 1, expired: 1 }
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
  var config = { pollMinMs: 400, pollMaxMs: 3000, retryMs: 400, toastMs: 4000 }
  var doneListeners = []

  // -------------------------------------------------------------------------
  // environment

  function meta (name) {
    var m = document.querySelector('meta[name="' + name + '"]')
    return m ? m.getAttribute('content') || '' : null
  }

  function env () {
    var token = meta('cb-token')
    var local = location.protocol === 'http:' || location.protocol === 'https:'
    var e = { token: token || null, endpoint: '' }
    if (e.token && !local) {
      var m = /^(http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5})\/?$/.exec(meta('cb-endpoint') || '')
      e.endpoint = m ? m[1] : null
    }
    return e
  }

  function currentPage () {
    var p = meta('cb-page')
    if (p) return p
    var path = location.pathname
    try { path = decodeURIComponent(path) } catch (err) {}
    return path
  }

  function newKey () {
    var c = window.crypto
    if (c && typeof c.randomUUID === 'function') return c.randomUUID()
    var a = new Uint8Array(16)
    if (c && c.getRandomValues) c.getRandomValues(a)
    else for (var i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256)
    var s = ''
    for (var j = 0; j < 16; j++) s += (a[j] < 16 ? '0' : '') + a[j].toString(16)
    return s
  }

  function api (method, path, body) {
    var e = env()
    if (e.endpoint === null) return Promise.reject(new Error('cb-endpoint meta is missing or not a loopback URL'))
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

  var toastBox = null

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

  var DROP_TEXT = {
    paused: 'Not sent: callbacks are paused in Claude Code.',
    'queue-full': 'Not sent: too many events are already waiting. Try again shortly.',
    'rate-limit': 'Not sent: too many events in the last minute. Try again shortly.'
  }

  function failureText (h) {
    if (h.state === 'dropped') return DROP_TEXT[h.reason] || 'Not sent (' + (h.reason || 'dropped') + ').'
    if (h.state === 'expired') return 'Expired: nobody approved this event in Claude Code.'
    if (h.reason === 'network') return 'Could not reach Claude Code. Is the session still running?'
    if (h.reason === 'too-large') return 'Not sent: too much data.'
    if (h.reason === 'forbidden') return 'Rejected by Claude Code. Open the page from its link again.'
    if (h.reason && h.reason !== 'rejected') return 'Rejected: ' + h.reason
    return 'Discarded in Claude Code.'
  }

  // -------------------------------------------------------------------------
  // handle

  function Handle (action, label, opts) {
    var self = this
    this.action = action
    this.label = label
    this.id = null
    this.state = null
    this.reason = null
    this.note = null
    this._toast = opts.toast !== false
    this._l = { state: [], text: [] }
    this._timer = null
    this._stream = null
    this.done = new Promise(function (resolve, reject) {
      self._resolve = resolve
      self._reject = reject
    })
    this.done.catch(function () {}) // observing is optional
  }

  Handle.prototype.on = function (type, cb) {
    if (!this._l[type]) throw new Error('unknown event type: ' + type)
    this._l[type].push(cb)
    var self = this
    if (type === 'state' && this.state) setTimeout(function () { cb(self.state, self) }, 0)
    if (type === 'text') this.stream()
    return this
  }

  Handle.prototype.off = function (type, cb) {
    var l = this._l[type] || []
    var i = l.indexOf(cb)
    if (i >= 0) l.splice(i, 1)
    return this
  }

  Handle.prototype.onDone = function (cb) {
    var self = this
    this.done.then(function () { cb(self) }, function () {})
    return this
  }

  Handle.prototype._emit = function (type, value) {
    var l = this._l[type].slice()
    for (var i = 0; i < l.length; i++) {
      try { l[i](value, this) } catch (err) { setTimeout(function () { throw err }, 0) }
    }
  }

  Handle.prototype._set = function (state, extra) {
    if (extra) {
      if (extra.reason !== undefined) this.reason = extra.reason
      if (extra.note !== undefined) this.note = extra.note
    }
    if (state === this.state || (this.state && TERMINAL[this.state])) return
    this.state = state
    this._emit('state', state)
    if (!TERMINAL[state]) return
    clearTimeout(this._timer)
    if (state === 'done') {
      if (this._toast) toast('Done: ' + (this.label || this.action), 'ok')
      this._resolve(this)
      for (var i = 0; i < doneListeners.length; i++) {
        try { doneListeners[i](this) } catch (err) { setTimeout(function () { throw err }, 0) }
      }
    } else {
      if (this._toast && this.reason !== 'template-changed') toast(failureText(this), 'error')
      var e = new Error('event ' + state + (this.reason ? ': ' + this.reason : ''))
      e.state = state
      e.reason = this.reason
      e.handle = this
      this._reject(e)
    }
  }

  Handle.prototype._poll = function () {
    var self = this
    var delay = config.pollMinMs
    var failures = 0
    function tick () {
      if (TERMINAL[self.state]) return
      api('GET', '/_cb/events/' + encodeURIComponent(self.id)).then(function (r) {
        if (r.status === 200 && r.json && typeof r.json.state === 'string') {
          failures = 0
          if (r.json.state !== self.state) delay = config.pollMinMs
          self._set(r.json.state, r.json)
        } else {
          failures++
        }
      }, function () { failures++ }).then(function () {
        if (TERMINAL[self.state]) return
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

  function onFrame (h, name, data) {
    var obj
    try { obj = JSON.parse(data) } catch (err) { return false }
    if (name === 'text' && typeof obj.text === 'string') h._emit('text', obj.text)
    else if (name === 'state' && typeof obj.state === 'string') h._set(obj.state)
    else if (name === 'end') return true
    return false
  }

  Handle.prototype.stream = function () {
    if (this._stream || !this.id || this.state === 'dropped') return this
    var self = this
    var url = '/_cb/events/' + encodeURIComponent(this.id) + '/stream'
    var e = env()
    if (!e.token && typeof EventSource === 'function') {
      var es = new EventSource(url)
      this._stream = es
      es.addEventListener('text', function (m) { onFrame(self, 'text', m.data) })
      es.addEventListener('state', function (m) { onFrame(self, 'state', m.data) })
      es.addEventListener('end', function () { es.close() })
      es.onerror = function () { es.close() } // never auto-reconnect: it would replay the text
      return this
    }
    if (e.endpoint === null) return this
    // Token mode: EventSource cannot send X-CB-Token, so read the SSE body with fetch.
    var ctl = typeof AbortController === 'function' ? new AbortController() : null
    this._stream = { close: function () { if (ctl) ctl.abort() } }
    fetch(e.endpoint + url, {
      headers: e.token ? { 'X-CB-Token': e.token } : {},
      credentials: e.endpoint ? 'omit' : 'same-origin',
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      if (res.status !== 200 || !res.body) return
      var reader = res.body.getReader()
      var dec = new TextDecoder()
      var buf = ''
      function pump () {
        return reader.read().then(function (r) {
          if (r.done) return
          buf += dec.decode(r.value, { stream: true }).replace(/\r\n?/g, '\n')
          var i
          while ((i = buf.indexOf('\n\n')) >= 0) {
            var frame = buf.slice(0, i)
            buf = buf.slice(i + 2)
            var name = 'message'
            var data = []
            frame.split('\n').forEach(function (line) {
              if (line.indexOf('event:') === 0) name = line.slice(6).trim()
              else if (line.indexOf('data:') === 0) data.push(line.slice(5).replace(/^ /, ''))
            })
            if (data.length && onFrame(self, name, data.join('\n'))) { self._stream.close(); return }
          }
          return pump()
        })
      }
      return pump()
    }).catch(function () {})
    return this
  }

  // -------------------------------------------------------------------------
  // send

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

  function send (action, data, opts) {
    opts = opts || {}
    var label = opts.label == null ? undefined : String(opts.label).slice(0, 200)
    var h = new Handle(action, label, opts)
    if (opts.onState) h.on('state', opts.onState)
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
        if (!TERMINAL[h.state]) h._poll()
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

  function inFlight (el) {
    var s = el.getAttribute('data-cb-state')
    return s === 'queued' || s === 'running'
  }

  function text (el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim()
  }

  function labelFor (el, submitter) {
    var l = el.getAttribute('data-cb-label')
    if (l) return l
    if (el.tagName === 'FORM') {
      if (submitter) l = text(submitter) || submitter.value || ''
      return l || el.getAttribute('aria-label') || ''
    }
    return text(el) || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || ''
  }

  function formFields (form, submitter) {
    var out = {}
    var counts = {}
    var els = form.elements
    var i, el
    for (i = 0; i < els.length; i++) {
      el = els[i]
      if (el.name && el.type === 'checkbox') counts[el.name] = (counts[el.name] || 0) + 1
    }
    for (i = 0; i < els.length; i++) {
      el = els[i]
      var name = el.name
      if (!name || el.disabled || (el.matches && el.matches('fieldset[disabled] *'))) continue
      var type = (el.type || '').toLowerCase()
      if (type === 'submit' || type === 'image') {
        if (el === submitter) out[name] = el.value
        continue
      }
      if (type === 'button' || type === 'reset' || type === 'file' || el.tagName === 'FIELDSET' || el.tagName === 'OUTPUT') continue
      if (type === 'checkbox') {
        if (counts[name] > 1) {
          if (!Array.isArray(out[name])) out[name] = []
          if (el.checked) out[name].push(el.value)
        } else {
          out[name] = !!el.checked
        }
      } else if (type === 'radio') {
        if (el.checked) out[name] = el.value
        else if (!(name in out)) out[name] = null
      } else if (type === 'select-multiple') {
        var vals = []
        for (var k = 0; k < el.options.length; k++) if (el.options[k].selected) vals.push(el.options[k].value)
        out[name] = vals
      } else if (name in out) {
        out[name] = [].concat(out[name], el.value)
      } else {
        out[name] = el.value
      }
    }
    return out
  }

  function fire (el, submitter) {
    if (inFlight(el)) return
    var action = el.getAttribute('data-cb-action')
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
      var fields = formFields(el, submitter)
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
    var t = e.target
    if (!t || !t.closest) return
    var el = t.closest('[data-cb-action]')
    if (!el || el.tagName === 'FORM') return
    e.preventDefault()
    fire(el)
  })

  document.addEventListener('submit', function (e) {
    var form = e.target
    if (!form || !form.hasAttribute || !form.hasAttribute('data-cb-action') || e.defaultPrevented) return
    e.preventDefault()
    fire(form, e.submitter || null)
  })

  window.ArtifactCallbacks = {
    __cb: true,
    version: 1,
    send: send,
    onDone: function (cb) { doneListeners.push(cb) },
    page: currentPage,
    toast: toast,
    config: config
  }
})()
