// F-series: the bare-fs / libuv facts chokibare's defences rest on, pinned so an upstream change
// fails here first (plan §8.4). Bare only; each case names the workaround it justifies.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const tmp = require('test-tmp')
const { isBare, isLinux, isMacos, isWindows } = require('./helpers')

const bare = { skip: !isBare }
const bareLinux = { skip: !isBare || !isLinux }
const bareMac = { skip: !isBare || !isMacos }

function record(watcher) {
  const events = []
  const errors = []
  watcher.on('change', (kind, name) => events.push([kind, name === undefined ? null : name]))
  watcher.on('error', (err) => errors.push(err))
  return { events, errors }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until(cond, ms = 3000) {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) return false
    await sleep(20)
  }
  return true
}

test('F1 a non-recursive watch reports a create as rename', bare, async (t) => {
  const dir = await tmp(t)
  const w = fs.watch(dir)
  t.teardown(() => w.close())
  const { events } = record(w)
  await sleep(isMacos ? 150 : 30)
  fs.writeFileSync(path.join(dir, 'a.txt'), '1')
  t.ok(await until(() => events.some(([, n]) => n === 'a.txt')), 'the create was reported')
  t.ok(
    events.some(([k, n]) => n === 'a.txt' && k === 'rename'),
    `kinds seen: ${JSON.stringify(events)}`
  )
})

test(
  'F2 Linux: recursive: true sees no nested create (libuv ignores the flag) → DV11',
  bareLinux,
  async (t) => {
    const dir = await tmp(t)
    fs.mkdirSync(path.join(dir, 'sub'))
    const w = fs.watch(dir, { recursive: true })
    t.teardown(() => w.close())
    const { events, errors } = record(w)
    await sleep(30)
    fs.writeFileSync(path.join(dir, 'sub', 'nested.txt'), '1')
    await sleep(300)
    t.absent(
      events.some(([, n]) => n && n.includes('nested')),
      `nested create invisible: ${JSON.stringify(events)}`
    )
    t.is(errors.length, 0)
  }
)

test(
  'F3 darwin: recursive: true reports a nested create by its relative path',
  bareMac,
  async (t) => {
    const dir = await tmp(t)
    fs.mkdirSync(path.join(dir, 'sub'))
    const w = fs.watch(dir, { recursive: true })
    t.teardown(() => w.close())
    const { events } = record(w)
    await sleep(150)
    fs.writeFileSync(path.join(dir, 'sub', 'nested.txt'), '1')
    t.ok(
      await until(() => events.some(([, n]) => n === path.join('sub', 'nested.txt'))),
      `relative nested path reported: ${JSON.stringify(events)}`
    )
  }
)

test(
  'F4 a watch on a missing path neither throws nor errors nor fires (bare-fs#51 canary) → DV11',
  bare,
  async (t) => {
    const dir = await tmp(t)
    const missing = path.join(dir, 'does-not-exist')
    let w
    let threw = false
    try {
      w = fs.watch(missing)
    } catch {
      threw = true
    }
    if (threw) {
      t.fail(
        'bare-fs now throws on a missing path: holepunchto/bare-fs#51 is fixed — gate needsVerification() by version'
      )
      return
    }
    t.teardown(() => w.close())
    const { events, errors } = record(w)
    fs.mkdirSync(missing)
    fs.writeFileSync(path.join(missing, 'a.txt'), '1')
    await sleep(300)
    t.is(events.length, 0, 'dead handle: nothing fires')
    t.is(errors.length, 0, 'dead handle: no error')
  }
)

test(
  'F5 a watcher on a removed directory stays open, does not error, reports the removal',
  { skip: !isBare || isWindows },
  async (t) => {
    const dir = await tmp(t)
    const sub = path.join(dir, 'gone')
    fs.mkdirSync(sub)
    const w = fs.watch(sub)
    t.teardown(() => w.close())
    const { events, errors } = record(w)
    await sleep(isMacos ? 150 : 30)
    fs.rmdirSync(sub)
    await until(() => events.length > 0)
    await sleep(200)
    t.is(errors.length, 0, 'no error event')
    t.ok(events.length > 0, `removal reported: ${JSON.stringify(events)}`)
  }
)

test('F6 a rename is rename on both names, never change on the target', bare, async (t) => {
  const dir = await tmp(t)
  fs.writeFileSync(path.join(dir, 'a.txt'), '1')
  const w = fs.watch(dir)
  t.teardown(() => w.close())
  const { events } = record(w)
  await sleep(isMacos ? 150 : 30)
  fs.renameSync(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'))
  t.ok(await until(() => events.some(([, n]) => n === 'b.txt')), 'target named')
  await sleep(100)
  t.ok(events.some(([k, n]) => n === 'b.txt' && k === 'rename'))
  t.absent(
    events.some(([k, n]) => n === 'b.txt' && k === 'change'),
    'never change on the target'
  )
})

test(
  'F7 Linux: an in-place write arrives as change with the child name → DV3',
  bareLinux,
  async (t) => {
    const dir = await tmp(t)
    fs.writeFileSync(path.join(dir, 'a.txt'), '1')
    const w = fs.watch(dir)
    t.teardown(() => w.close())
    const { events } = record(w)
    await sleep(30)
    fs.writeFileSync(path.join(dir, 'a.txt'), '22')
    t.ok(
      await until(() => events.some(([k, n]) => n === 'a.txt' && k === 'change')),
      JSON.stringify(events)
    )
  }
)

test('F9 darwin: an in-place edit under a recursive watch is reported', bareMac, async (t) => {
  const dir = await tmp(t)
  fs.writeFileSync(path.join(dir, 'a.txt'), '1')
  const w = fs.watch(dir, { recursive: true })
  t.teardown(() => w.close())
  const { events } = record(w)
  await sleep(150)
  fs.writeFileSync(path.join(dir, 'a.txt'), '22')
  t.ok(await until(() => events.some(([, n]) => n === 'a.txt')), JSON.stringify(events))
})

test(
  'F11 darwin: a per-file watch holds one fd; a directory watch holds none (S6)',
  bareMac,
  async (t) => {
    const dir = await tmp(t)
    const files = []
    for (let i = 0; i < 20; i++) {
      const f = path.join(dir, `f${i}.txt`)
      fs.writeFileSync(f, '1')
      files.push(f)
    }
    const before = fs.readdirSync('/dev/fd').length
    const watchers = files.map((f) => fs.watch(f))
    const during = fs.readdirSync('/dev/fd').length
    const dirWatcher = fs.watch(dir)
    const withDir = fs.readdirSync('/dev/fd').length
    for (const w of watchers) w.close()
    dirWatcher.close()
    await sleep(50)
    const after = fs.readdirSync('/dev/fd').length
    t.is(during - before, 20, 'one fd per file watch')
    t.is(withDir - during, 0, 'a directory watch costs no fd')
    t.is(after, before, 'all released on close')
  }
)

test(
  'F13 darwin per-file watch: a same-size overwrite is rename; an atime-only read is nothing',
  bareMac,
  async (t) => {
    const dir = await tmp(t)
    const f = path.join(dir, 'a.txt')
    fs.writeFileSync(f, 'abcd')
    const w = fs.watch(f)
    t.teardown(() => w.close())
    const { events } = record(w)
    await sleep(50)
    fs.readFileSync(f)
    await sleep(200)
    t.is(events.length, 0, 'a read fires nothing (B18)')
    const fd = fs.openSync(f, 'r+')
    fs.writeSync(fd, Buffer.from('wxyz'), 0, 4, 0)
    fs.closeSync(fd)
    t.ok(await until(() => events.length > 0), 'the overwrite fires')
    t.ok(
      events.every(([k]) => k === 'rename'),
      `kqueue NOTE_WRITE maps to rename: ${JSON.stringify(events)}`
    )
  }
)
