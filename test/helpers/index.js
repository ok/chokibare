// Test harness. Mirrors the helpers of chokidar src/index.test.ts and src/v6.test.ts @ 74adf65
// (spies, waitFor, fixtures, VirtualScheduler) on top of brittle, and adds the oracle switch:
// with CHOKIDAR4BARE_ORACLE set, the suites run against the upstream chokidar build they were ported
// from, which is how the port is verified.
'use strict'

const test = require('brittle')
const EventEmitter = require('events')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const rt = require('../../lib/bare-runtime')

const isBare = rt.isBare
const isMacos = rt.platform === 'darwin'
const isWindows = rt.platform === 'win32'
const isLinux = rt.platform === 'linux'
const isIBMi = false // upstream: os.type() === 'OS400'; never true where chokidar4bare runs

function scale() {
  const s = Number(rt.env('CHOKIDAR4BARE_TEST_TIMEOUT_SCALE'))
  return s > 0 ? s : 1
}

const TEST_TIMEOUT = 32000 * scale() // ms, upstream index.test.ts:56

// ---------------------------------------------------------------------------------------------
// Module under test: chokidar4bare, or the upstream chokidar build when CHOKIDAR4BARE_ORACLE is set.

const ORACLE = rt.env('CHOKIDAR4BARE_ORACLE')
let loaded = null

async function load() {
  if (loaded) return loaded
  if (ORACLE) {
    if (isBare) throw new Error('CHOKIDAR4BARE_ORACLE: upstream chokidar runs on Node only')
    const { pathToFileURL } = require('url')
    const mod = (file) => import(pathToFileURL(path.join(ORACLE, file)).href)
    const [chokidar, runtime, testing] = await Promise.all([
      mod('index.js'),
      mod('runtime.js'),
      mod('testing.js')
    ])
    loaded = pack('oracle', chokidar, runtime, testing)
  } else {
    loaded = pack(
      'chokidar4bare',
      require('../..'),
      require('../../lib/runtime'),
      require('../../lib/testing')
    )
  }
  return loaded
}

function pack(source, chokidar, runtime, testing) {
  return {
    source,
    chokidar,
    EV: runtime.EVENTS,
    isIBMi: runtime.isIBMi,
    isMacos: runtime.isMacos,
    isWindows: runtime.isWindows,
    backendTesting: testing.backendTesting,
    internals: testing.inspectWatcher
  }
}

// ---------------------------------------------------------------------------------------------
// Spies (upstream index.test.ts:37-52, 100-118)

function createSpy(implementation) {
  const calls = []
  const wrapped = function (...args) {
    calls.push(args)
    return implementation ? implementation.apply(this, args) : undefined
  }
  wrapped.calls = calls
  wrapped.reset = () => {
    calls.length = 0
  }
  Object.defineProperties(wrapped, {
    called: { enumerable: true, get: () => calls.length > 0 },
    callCount: { enumerable: true, get: () => calls.length }
  })
  return wrapped
}

function getCallsWith(spy, args, strict) {
  return spy.calls.filter(
    (call) => (!strict || args.length === call.length) && args.every((arg, i) => call[i] === arg)
  )
}

function calledWith(spy, args, strict) {
  return getCallsWith(spy, args, strict).length > 0
}

function alwaysCalledWith(spy, args, strict) {
  return spy.calls.every(
    (call) => (!strict || args.length === call.length) && args.every((arg, i) => call[i] === arg)
  )
}

// ---------------------------------------------------------------------------------------------
// Waiting (upstream index.test.ts:120-236)

// spyOnReady
function aspy(watcher, eventName, spy = null, noStat = false) {
  if (typeof eventName !== 'string') throw new TypeError('aspy: eventName must be a String')
  if (spy === null) spy = createSpy()
  return new Promise((resolve, reject) => {
    const handler = noStat
      ? eventName === 'all'
        ? (event, p) => spy(event, p)
        : (p) => spy(p)
      : spy
    const timeout = setTimeout(() => reject(new Error('timeout')), TEST_TIMEOUT)
    watcher.on('error', (...args) => {
      clearTimeout(timeout)
      reject(...args)
    })
    watcher.on('ready', () => {
      clearTimeout(timeout)
      resolve(spy)
    })
    watcher.on(eventName, handler)
  })
}

function waitForWatcher(watcher) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), TEST_TIMEOUT)
    watcher.on('error', (...args) => {
      clearTimeout(timeout)
      reject(...args)
    })
    watcher.on('ready', (...args) => {
      clearTimeout(timeout)
      resolve(...args)
    })
  })
}

let USE_SLOW_DELAY // set per shared-suite run: 100 on macOS native, else undefined

function setSlowDelay(value) {
  USE_SLOW_DELAY = value
}

function delay(delayTime) {
  return new Promise((resolve) => setTimeout(resolve, delayTime || USE_SLOW_DELAY || 20))
}

function isSpyReady(spy) {
  if (Array.isArray(spy)) {
    const [spyFn, callCount, args] = spy
    if (args) return getCallsWith(spyFn, args).length >= callCount
    return spyFn.callCount >= callCount
  }
  return spy.callCount >= 1
}

function waitFor(spies) {
  if (spies.length === 0) throw new Error('need at least 1 spy')
  return new Promise((resolve, reject) => {
    const checkTimer = setInterval(() => {
      if (!spies.every(isSpyReady)) return
      clearInterval(checkTimer)
      clearTimeout(timeout)
      resolve()
    }, 20)
    const timeout = setTimeout(() => {
      clearInterval(checkTimer)
      reject(new Error('timeout waitFor, passed ms: ' + TEST_TIMEOUT))
    }, TEST_TIMEOUT)
  })
}

function waitForEvents(watcher, count) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('timeout waitForEvents, passed ms: ' + TEST_TIMEOUT)),
      TEST_TIMEOUT
    )
    const events = []
    const handler = (event, p) => {
      events.push(`[ALL] ${event}: ${p}`)
      if (events.length === count) {
        watcher.off('all', handler)
        clearTimeout(timeout)
        resolve(events)
      }
    }
    watcher.on('all', handler)
  })
}

// ---------------------------------------------------------------------------------------------
// Filesystem helpers (upstream index.test.ts:84-99)

function time() {
  return Date.now().toString()
}

function rmr(dir) {
  return fsp.rm(dir, { recursive: true, force: true })
}

function mkdir(dir, opts = {}) {
  return fsp.mkdir(dir, { mode: 0o755, ...opts })
}

// Upstream probes `fs.watch(root, { recursive: true })` and treats ERR_FEATURE_UNAVAILABLE_ON_PLATFORM
// as "no". bare-fs never throws there (libuv silently ignores the flag on Linux), so under Bare the
// answer is the known platform fact: recursive works on darwin and win32 only.
function detectRecursiveWatch() {
  if (isIBMi) return false
  if (isBare) return !isLinux
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chokidar4bare-recursive-probe-'))
  try {
    const watcher = fs.watch(root, { recursive: true })
    watcher.close()
    return true
  } catch (error) {
    if (error.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') return false
    throw error
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const canUseRecursiveWatch = detectRecursiveWatch()

// Node only: used by the "does not keep the process alive" cases; those skip under Bare.
const exec = isBare ? null : require('util').promisify(require('child_process').exec)

// ---------------------------------------------------------------------------------------------
// Fixtures. Upstream pre-creates every test's directory (with change.txt and unlink.txt) before
// any test runs, because creating them in beforeEach "increases chance of random failures"
// (index.test.ts:2372-2384). A suite here registers its cases first and creates the pool once.

// One root per suite: brittle may load every test file into one process, and each suite must own
// the fixtures it prepares.
let suiteCount = 0

function prepareFixtures(FIXTURES_PATH, count) {
  fs.rmSync(FIXTURES_PATH, { recursive: true, force: true })
  fs.mkdirSync(FIXTURES_PATH, { recursive: true })
  for (let id = 1; id <= count; id++) {
    const dir = path.join(FIXTURES_PATH, String(id))
    fs.mkdirSync(dir, { mode: 0o755 })
    fs.writeFileSync(path.join(dir, 'change.txt'), 'b')
    fs.writeFileSync(path.join(dir, 'unlink.txt'), 'b')
  }
}

// Per-test context: the equivalent of upstream's `testId`, `currentDir`, `dpath`, `cwatch`,
// `WATCHERS` and its afterEach (close every watcher, remove the directory).
function context(t, testId, ctx, FIXTURES_PATH) {
  const currentDir = path.join(FIXTURES_PATH, String(testId))
  const WATCHERS = []
  const h = {
    ...ctx,
    testId,
    currentDir,
    FIXTURES_PATH,
    WATCHERS,
    canUseRecursiveWatch,
    createSpy,
    calledWith,
    getCallsWith,
    alwaysCalledWith,
    aspy,
    waitFor,
    waitForWatcher,
    waitForEvents,
    delay,
    setSlowDelay,
    mkdir,
    rmr,
    exec,
    time,
    dpath(subPath) {
      return path.join(currentDir, subPath)
    },
    gpath(subPath) {
      return path.normalize(path.join(currentDir, subPath)).replace(/\\/g, '/')
    },
    cwatch(p = currentDir, opts) {
      const wt = ctx.chokidar.watch(p, opts)
      WATCHERS.push(wt)
      return wt
    },
    async cleanup() {
      await Promise.all(WATCHERS.map((w) => w.close()))
      await rmr(currentDir)
    }
  }
  return h
}

// A suite collects cases, then registers them with brittle once the fixture pool exists.
//   const s = suite(); s.test('name', async (t, h) => …); s.run()
function suite() {
  const cases = []
  const FIXTURES_PATH = path.join(os.tmpdir(), `chokidar4bare-${time()}-${++suiteCount}`)
  return {
    test(title, opts, fn) {
      if (typeof opts === 'function') {
        fn = opts
        opts = {}
      }
      cases.push({ title, opts, fn, testId: cases.length + 1 })
    },
    run() {
      prepareFixtures(FIXTURES_PATH, cases.length)
      for (const c of cases) {
        test(c.title, { timeout: TEST_TIMEOUT * 2, ...c.opts }, async (t) => {
          const ctx = await load()
          const h = context(t, c.testId, ctx, FIXTURES_PATH)
          try {
            await c.fn(t, h)
          } finally {
            await h.cleanup()
          }
        })
      }
      test('fixtures removed', async (t) => {
        await rmr(FIXTURES_PATH)
        t.pass()
      })
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Virtual time (upstream v6.test.ts:68-142) and the fake native watcher (:144-156)

class VirtualTimer {
  constructor(scheduler, callback, due, order) {
    this.active = true
    this.referenced = true
    this.scheduler = scheduler
    this.callback = callback
    this.due = due
    this.order = order
  }

  ref() {
    this.referenced = true
    return this
  }

  unref() {
    this.referenced = false
    return this
  }
}

class VirtualScheduler {
  constructor() {
    this.currentTime = 0
    this.nextOrder = 0
    this.timers = new Set()
  }

  now() {
    return this.currentTime
  }

  setTimeout(callback, delay) {
    const timer = new VirtualTimer(
      this,
      callback,
      this.currentTime + Math.max(0, delay),
      this.nextOrder++
    )
    this.timers.add(timer)
    return timer
  }

  clearTimeout(timer) {
    if (!(timer instanceof VirtualTimer) || timer.scheduler !== this) return
    timer.active = false
    this.timers.delete(timer)
  }

  advanceBy(duration) {
    const target = this.currentTime + duration
    while (true) {
      const next = [...this.timers]
        .filter((timer) => timer.active && timer.due <= target)
        .sort((left, right) => left.due - right.due || left.order - right.order)[0]
      if (!next) break
      this.currentTime = next.due
      next.active = false
      this.timers.delete(next)
      next.callback()
    }
    this.currentTime = target
  }

  get activeCount() {
    return this.timers.size
  }

  get referencedCount() {
    return [...this.timers].filter((timer) => timer.referenced).length
  }

  get nextDelay() {
    const due = Math.min(...[...this.timers].map((timer) => timer.due))
    return Number.isFinite(due) ? due - this.currentTime : undefined
  }
}

function createFakeNativeWatcher() {
  const resource = new EventEmitter()
  resource.close = () => {
    resource.emit('close')
  }
  resource.ref = () => resource
  resource.unref = () => resource
  return resource
}

module.exports = {
  load,
  suite,
  TEST_TIMEOUT,
  scale,
  isBare,
  isMacos,
  isWindows,
  isLinux,
  isIBMi,
  canUseRecursiveWatch,
  createSpy,
  calledWith,
  getCallsWith,
  alwaysCalledWith,
  aspy,
  waitFor,
  waitForWatcher,
  waitForEvents,
  delay,
  setSlowDelay,
  mkdir,
  rmr,
  time,
  exec,
  VirtualScheduler,
  VirtualTimer,
  createFakeNativeWatcher
}
