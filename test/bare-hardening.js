// B-series (plan §8.3): what chokibare adds on top of chokidar v6's own suites — handle budgets,
// the self-closing bare-fs watcher, path-length refusal — plus the mirall-shaped regressions the
// port exists for. Runs on both runtimes through the public API; cases that need a runtime fact
// are skipped where it does not hold.
const fs = require('fs')
const path = require('path')
const { suite, isBare, isLinux, isMacos, isWindows } = require('./helpers')
const backend = require('../lib/backend')
const { facts } = require('..')

const s = suite()

function collect(watcher) {
  const events = []
  watcher.on('all', (ev, p) => events.push([ev, p]))
  watcher.on('error', (err) => events.push(['error', err]))
  return events
}

const count = (events, ev, p) =>
  events.filter(([e, q]) => e === ev && (p === undefined || q === p)).length

s.test('B08 handle budget: 20 dirs × 50 files never cost a handle per file', async (t, h) => {
  const before = facts().nativeWatches
  for (let d = 0; d < 20; d++) {
    const dir = h.dpath(`d${d}`)
    fs.mkdirSync(dir)
    for (let f = 0; f < 50; f++) fs.writeFileSync(path.join(dir, `f${f}.txt`), '1')
  }
  const fdBefore = isMacos && isBare ? fs.readdirSync('/dev/fd').length : 0
  const watcher = h.cwatch(h.currentDir, { ignoreInitial: true })
  await h.waitForWatcher(watcher)
  const handles = facts().nativeWatches - before
  const strategy = watcher.options.backendStrategy
  if (strategy === 'native-recursive-preferred') {
    t.ok(handles <= 2, `recursive root: ${handles} handle(s), never 1,020`)
  } else {
    t.ok(handles >= 21 && handles <= 22, `per-directory: root + 20 dirs = ${handles}, never 1,020`)
  }
  if (isMacos && isBare) {
    const fdDuring = fs.readdirSync('/dev/fd').length
    t.ok(fdDuring - fdBefore <= 2, `no kqueue fd per file: /dev/fd grew by ${fdDuring - fdBefore}`)
  }
  await watcher.close()
  t.is(facts().nativeWatches, before, 'all handles released on close')
})

s.test(
  'B12 a watcher that closed itself before its error still yields one error and a clean registry',
  async (t, h) => {
    // bare-fs's Watcher closes itself, then emits 'error'. Reproduce that sequence on a real
    // per-directory handle: close it ourselves, then emit the error it would have emitted.
    const { backendTesting } = h
    const created = []
    const system = (p, opts, listener) => {
      const w = fs.watch(p, opts, listener)
      created.push(w)
      return w
    }
    backendTesting.setNativeWatchFactory(system)
    t.teardown(() => backendTesting.setNativeWatchFactory(undefined))
    const watcher = h.cwatch(h.currentDir, { ignoreInitial: true, backend: 'native' })
    const events = collect(watcher)
    await h.waitForWatcher(watcher)
    t.ok(created.length >= 1, 'the root handle went through the factory')
    const handle = created[0]
    const before = facts().nativeWatches
    handle.close() // what bare-fs does first
    const err = Object.assign(new Error('EPERM: simulated backend failure'), { code: 'EPERM' })
    handle.emit('error', err) // …then this
    await new Promise((resolve) => setTimeout(resolve, 100))
    t.is(count(events, 'error'), 1, 'exactly one error event')
    t.is(events.find(([e]) => e === 'error')[1].code, 'EPERM')
    t.ok(facts().nativeWatches < before, 'the failed resource left the registry')
    await watcher.close()
  }
)

s.test(
  'B25 a watch path over 4096 bytes is refused with ENAMETOOLONG, never truncated',
  { skip: !isBare },
  async (t, h) => {
    const long = path.join(h.currentDir, 'x'.repeat(4200))
    const errors = []
    const sub = backend.setFsWatchListener(
      long,
      long,
      { persistent: true },
      { listener() {}, errHandler: (e) => errors.push(e), rawEmitter() {}, publish() {} },
      { aborted: false }
    )
    t.is(sub, undefined, 'no subscription')
    t.is(errors.length, 1)
    t.is(errors[0].code, 'ENAMETOOLONG')
    t.is(errors[0].path, long)
  }
)

// ---------------------------------------------------------------------------------------------
// mirall-shaped regressions: the behaviours the app relies on, through the public API

s.test('M1 an in-place edit is one change, never add or unlink (every platform)', async (t, h) => {
  const file = h.dpath('change.txt')
  const watcher = h.cwatch(h.currentDir, { ignoreInitial: true })
  const events = collect(watcher)
  await h.waitForWatcher(watcher)
  await h.delay()
  fs.writeFileSync(file, 'edited')
  await h.waitFor([[wrapSpy(events, 'change', file), 1]])
  t.is(count(events, 'add', file), 0)
  t.is(count(events, 'unlink', file), 0)
})

s.test(
  'M2 a rename-over save with atomic is one change, never a transient unlink',
  async (t, h) => {
    const file = h.dpath('change.txt')
    const tmpFile = h.dpath('change.txt.tmp')
    const watcher = h.cwatch(h.currentDir, { ignoreInitial: true, atomic: true })
    const events = collect(watcher)
    await h.waitForWatcher(watcher)
    await h.delay()
    fs.writeFileSync(tmpFile, 'new content')
    fs.renameSync(tmpFile, file)
    await h.waitFor([[wrapSpy(events, 'change', file), 1]])
    await h.delay(300)
    t.is(count(events, 'unlink', file), 0, 'the target never unlinks')
  }
)

s.test('M3 a deleted subtree yields one unlink per file, then unlinkDir', async (t, h) => {
  const sub = h.dpath('sub')
  fs.mkdirSync(path.join(sub, 'deep'), { recursive: true })
  fs.writeFileSync(path.join(sub, 'a.txt'), '1')
  fs.writeFileSync(path.join(sub, 'deep', 'b.txt'), '2')
  const watcher = h.cwatch(h.currentDir, { ignoreInitial: true })
  const events = collect(watcher)
  await h.waitForWatcher(watcher)
  await h.delay()
  fs.rmSync(sub, { recursive: true, force: true })
  // `atomic` (on by default for native watching) parks unlink events for 100 ms; unlinkDir is not
  // parked, so wait for every event before counting.
  const expected = [
    ['unlink', path.join(sub, 'a.txt')],
    ['unlink', path.join(sub, 'deep', 'b.txt')],
    ['unlinkDir', path.join(sub, 'deep')],
    ['unlinkDir', sub]
  ]
  await h.waitFor(expected.map(([ev, p]) => [wrapSpy(events, ev, p), 1]))
  await h.delay(200)
  for (const [ev, p] of expected) {
    t.is(count(events, ev, p), 1, `${ev} ${path.relative(h.currentDir, p)}`)
  }
})

s.test(
  'M4 a vanished root yields one unlink per file (the fast root-gone signal)',
  { skip: isWindows },
  async (t, h) => {
    const root = h.dpath('mount')
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(root, 'a.txt'), '1')
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), '2')
    const watcher = h.cwatch(root, { ignoreInitial: true })
    const events = collect(watcher)
    await h.waitForWatcher(watcher)
    await h.delay()
    fs.rmSync(root, { recursive: true, force: true })
    await h.waitFor([[wrapSpy(events, 'unlink', path.join(root, 'a.txt')), 1]])
    await h.waitFor([[wrapSpy(events, 'unlink', path.join(root, 'sub', 'b.txt')), 1]])
    t.pass('every file under the vanished root was unlinked')
  }
)

s.test(
  'M5 a file written right after mkdir -p of its new parents is reported (arm before scan)',
  async (t, h) => {
    const watcher = h.cwatch(h.currentDir, { ignoreInitial: true })
    const events = collect(watcher)
    await h.waitForWatcher(watcher)
    await h.delay()
    const file = h.dpath(path.join('a', 'b', 'c', 'f.txt'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'x')
    await h.waitFor([[wrapSpy(events, 'add', file), 1]])
    t.ok(count(events, 'add', file) <= 2, `reported ${count(events, 'add', file)} time(s)`)
  }
)

s.test(
  'M6 a write burst with awaitWriteFinish settles to one change with the final size',
  async (t, h) => {
    const file = h.dpath('change.txt')
    const watcher = h.cwatch(h.currentDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
      alwaysStat: true
    })
    const changes = []
    watcher.on('change', (p, stats) => changes.push([p, stats && stats.size]))
    await h.waitForWatcher(watcher)
    await h.delay()
    for (let i = 0; i < 500; i++) fs.appendFileSync(file, 'x')
    await new Promise((resolve) => setTimeout(resolve, 900))
    t.is(changes.length, 1, `one settled change: ${JSON.stringify(changes)}`)
    t.is(changes[0][1], fs.statSync(file).size, 'with the final size')
  }
)

s.test(
  'M7 Linux under Bare: the inotify verifier confirms every armed directory',
  { skip: !isBare || !isLinux },
  async (t, h) => {
    for (let d = 0; d < 30; d++) fs.mkdirSync(h.dpath(`d${d}`))
    const watcher = h.cwatch(h.currentDir, { ignoreInitial: true })
    const events = collect(watcher)
    await h.waitForWatcher(watcher)
    await new Promise((resolve) => setTimeout(resolve, 200)) // past the verifier's flush
    t.is(count(events, 'error'), 0, 'no ENOSPC below the limit')
    const f = facts().inotify
    t.ok(f.verified >= 31, `root + 30 dirs verified by the kernel: ${f.verified}`)
  }
)

// A spy-shaped view over the recorded events, for the harness's waitFor()
function wrapSpy(events, ev, p) {
  return {
    calls: [],
    get callCount() {
      return count(events, ev, p)
    }
  }
}

s.run()
