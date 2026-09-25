// Linux-only, run by the CI job that lowers the inotify limits (see .github/workflows/integrate.yml)
// or locally in a privileged container. Proves that a tree larger than the kernel will watch is
// reported, never silently half-watched (plan B03, F12).
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const tmp = require('test-tmp')
const { isBare, isLinux, TEST_TIMEOUT } = require('./helpers')
const rt = require('../lib/bare-runtime')

const enospc = isLinux && isBare && !!rt.env('CHOKIDAR4BARE_TEST_ENOSPC')

function until(cond, ms) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = setInterval(() => {
      if (cond()) {
        clearInterval(tick)
        resolve()
      } else if (Date.now() - started > ms) {
        clearInterval(tick)
        reject(new Error('until: timed out'))
      }
    }, 20)
  })
}

test(
  'B03 ENOSPC: every directory the kernel will not watch is reported, none is silent',
  { skip: !enospc, timeout: TEST_TIMEOUT * 2 },
  async (t) => {
    const { watch } = require('..')
    const limit = Number(fs.readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8'))
    if (!(limit > 0 && limit < 100000)) {
      t.fail(
        `max_user_watches must be lowered for this run (is ${limit}); refusing to build a tree that size`
      )
      return
    }
    // bare-fs ≥ 4.8.2 throws ENOSPC from fs.watch() past the limit (before 4.8.2 it returned a dead
    // handle); chokidar4bare reports each one as an error event through chokidar's native-error path.
    const root = await tmp(t)
    const dirs = limit + 64
    for (let i = 0; i < dirs; i++) fs.mkdirSync(path.join(root, 'd' + i))

    const errors = []
    const watcher = watch(root, { ignoreInitial: true })
    t.teardown(() => watcher.close())
    watcher.on('error', (err) => errors.push(err))
    await new Promise((resolve) => watcher.once('ready', resolve))
    await until(() => errors.length > 0, 10000)
    await new Promise((resolve) => setTimeout(resolve, 500)) // let the last flush report

    t.ok(errors.length >= 64, `at least the ${64} directories past the limit: ${errors.length}`)
    t.ok(
      errors.every((e) => e.code === 'ENOSPC'),
      'every error is ENOSPC'
    )
    const { nativeWatches } = require('..').facts()
    t.ok(
      nativeWatches + errors.length >= dirs + 1,
      `watched (${nativeWatches}) + reported (${errors.length}) covers root + ${dirs} dirs`
    )
    t.ok(
      nativeWatches <= limit,
      `live watches (${nativeWatches}) never exceed the limit (${limit})`
    )
  }
)

test(
  'F12 queue overflow: a burst past max_queued_events is neither an event nor an error',
  { skip: !enospc || !rt.env('CHOKIDAR4BARE_TEST_QOVERFLOW'), timeout: TEST_TIMEOUT },
  async (t) => {
    const queued = Number(fs.readFileSync('/proc/sys/fs/inotify/max_queued_events', 'utf8'))
    t.ok(queued <= 64, `max_queued_events lowered for this run: ${queued}`)
    const root = await tmp(t)
    const seen = []
    const errors = []
    const w = fs.watch(root)
    w.on('change', (kind, name) => seen.push([kind, name]))
    w.on('error', (err) => errors.push(err))
    t.teardown(() => w.close())
    // 2,000 creates in one tick: far more than the queue holds
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(root, 'f' + i), '')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    t.ok(seen.length < 2000, `events seen ${seen.length} < 2000: the overflow dropped the rest`)
    t.is(errors.length, 0, 'libuv discards IN_Q_OVERFLOW: no error reaches JS (plan §5.7)')
    t.comment(`kinds: ${JSON.stringify(seen.slice(0, 3))}`)
  }
)
