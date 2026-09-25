// chokibare original: runtime shims so the ported chokidar modules stay mechanical (`process.X` → `rt.X`).
// Every Node-vs-Bare difference the port needs lives here and nowhere else.
'use strict'

const os = require('os')

const isBare = typeof Bare !== 'undefined'

// rt: S6 — `process.platform`
const platform = os.platform()

// rt: S7 — `process.cwd()`; bare-os exposes cwd(), Node's os module does not
function cwd() {
  return isBare ? os.cwd() : process.cwd()
}

// rt: S8 — `process.env[name]`; bare-os exposes getEnv(name)
function env(name) {
  const value = isBare ? os.getEnv(name) : process.env[name]
  return value === null ? undefined : value
}

// rt: S10 — `performance.now()`; upstream only ever compares deltas (25 ms / 10 ms windows)
function now() {
  return Date.now()
}

// rt: S5 — `os.type()`; only IBM i detection uses it (pruned in W17)
function osType() {
  return os.type()
}

// rt: S12 — `realpathSync.native`. Upstream needs the OS's own resolution on Windows: a watched
// path spelled with an 8.3 short name (C:\Users\RUNNER~1\…) makes libuv's fs-event assertion fire
// when the callback reports the long name. Node's JS `realpathSync` does not expand short names,
// `.native` does; bare-fs's `realpathSync` is libuv's native one already.
const fs = require('fs')
const realpathNative = fs.realpathSync.native
  ? (p) => fs.realpathSync.native(p)
  : (p) => fs.realpathSync(p)

// The bare-fs version this process runs on, or null under Node. Gates the §5 workarounds for
// bare-fs bugs once fixed releases exist.
function bareFsVersion() {
  if (!isBare) return null
  try {
    return require('bare-fs/package').version
  } catch {
    return null
  }
}

// rt: S11 — `AbortController`; upstream uses only `.signal.aborted` and `.abort()`, never listeners.
// Same shape as AbortController (`.signal.aborted`, `.abort()`), so call sites and the test seam
// stay verbatim; `.aborted` is a convenience alias for callers handed the flag itself.
class Flag {
  constructor() {
    this.signal = { aborted: false }
  }

  get aborted() {
    return this.signal.aborted
  }

  abort() {
    this.signal.aborted = true
  }
}

module.exports = { isBare, platform, cwd, env, now, osType, realpathNative, bareFsVersion, Flag }
