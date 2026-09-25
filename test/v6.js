// Port of chokidar src/v6.test.ts @ 74adf65 (registerV6Tests). Titles are `<describe> › <it>`.
const fs = require('fs')
const {
  lstat,
  realpath,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile: write
} = require('fs/promises')
const sp = require('path')
const rt = require('../lib/bare-runtime')
const {
  suite,
  isBare,
  isMacos,
  isWindows,
  isIBMi,
  canUseRecursiveWatch,
  VirtualScheduler,
  createFakeNativeWatcher
} = require('./helpers')

const s = suite()

// ---------------------------------------------------------------------------------------------
// configuration normalization

s.test(
  'configuration normalization › should stop walking up when a missing path is its own parent',
  async (t, h) => {
    const { chokidar, internals } = h
    const watcher = new chokidar.FSWatcher()
    h.WATCHERS.push(watcher)
    const root = sp.parse(rt.cwd()).root
    const addCalls = await internals(watcher).walkMissingRoot(root)

    t.is(addCalls, 1)
  }
)

s.test(
  'configuration normalization › should use defaults for explicitly undefined options',
  (t, h) => {
    const { chokidar } = h
    const watcher = new chokidar.FSWatcher({
      persistent: undefined,
      ignoreInitial: undefined,
      ignorePermissionErrors: undefined,
      pollingInterval: undefined,
      pollingBinaryInterval: undefined,
      interval: undefined,
      binaryInterval: undefined,
      followSymlinks: undefined,
      backend: undefined,
      usePolling: undefined,
      atomic: undefined
    })
    h.WATCHERS.push(watcher)
    t.is(watcher.options.persistent, true)
    t.is(watcher.options.ignoreInitial, false)
    t.is(watcher.options.ignorePermissionErrors, false)
    t.is(watcher.options.pollingInterval, 100)
    t.is(watcher.options.pollingBinaryInterval, 300)
    t.is(watcher.options.interval, 100)
    t.is(watcher.options.binaryInterval, 300)
    t.is(watcher.options.followSymlinks, true)
    t.is(watcher.options.backend, h.isIBMi ? 'polling' : 'auto')
    t.is(watcher.options.usePolling, h.isIBMi)
    t.is(
      watcher.options.backendStrategy,
      h.isIBMi
        ? 'polling'
        : h.isMacos || h.isWindows
          ? 'native-recursive-preferred'
          : 'native-per-directory'
    )
    t.is(watcher.options.atomic, !h.isIBMi)
  }
)

s.test(
  'configuration normalization › should normalize deprecated polling interval aliases with new-name precedence',
  (t, h) => {
    const { chokidar } = h
    const legacy = new chokidar.FSWatcher({ interval: 25, binaryInterval: 75 })
    const preferred = new chokidar.FSWatcher({
      pollingInterval: 10,
      pollingBinaryInterval: 30,
      interval: 25,
      binaryInterval: 75
    })
    h.WATCHERS.push(legacy, preferred)

    t.is(legacy.options.pollingInterval, 25)
    t.is(legacy.options.pollingBinaryInterval, 75)
    t.is(legacy.options.interval, 25)
    t.is(legacy.options.binaryInterval, 75)
    t.is(preferred.options.pollingInterval, 10)
    t.is(preferred.options.pollingBinaryInterval, 30)
    t.is(preferred.options.interval, 10)
    t.is(preferred.options.binaryInterval, 30)
  }
)

s.test(
  'configuration normalization › should treat depth Infinity as an unbounded auto backend (#1452)',
  (t, h) => {
    const { chokidar } = h
    const watcher = new chokidar.FSWatcher({ depth: Number.POSITIVE_INFINITY })
    h.WATCHERS.push(watcher)

    t.is(watcher.options.depth, undefined)
    t.is(watcher.options.backend, h.isIBMi ? 'polling' : 'auto')
    t.is(
      watcher.options.backendStrategy,
      h.isIBMi
        ? 'polling'
        : h.isMacos || h.isWindows
          ? 'native-recursive-preferred'
          : 'native-per-directory'
    )
  }
)

// Bare: mutates process.env.CHOKIDAR_USEPOLLING, which Bare has no equivalent for.
s.test(
  'configuration normalization › should default atomic based on the final polling selection',
  { skip: isIBMi || isBare },
  async (t, h) => {
    const { chokidar } = h
    const previous = process.env.CHOKIDAR_USEPOLLING
    delete process.env.CHOKIDAR_USEPOLLING
    try {
      const autoWatcher = new chokidar.FSWatcher({ usePolling: false })
      const perDirectoryWatcher = new chokidar.FSWatcher({ backend: 'native' })
      const backendPollingWatcher = new chokidar.FSWatcher({
        backend: 'polling',
        usePolling: false
      })
      const pollingWatcher = new chokidar.FSWatcher({ usePolling: true })
      const explicitWatcher = new chokidar.FSWatcher({ usePolling: true, atomic: true })
      const recursiveWatcher = new chokidar.FSWatcher({ backend: 'native-recursive' })
      const depthLimitedRecursiveWatcher = new chokidar.FSWatcher({
        backend: 'native-recursive',
        depth: 1
      })
      const pollingRecursiveWatcher = new chokidar.FSWatcher({
        usePolling: true,
        backend: 'native-recursive'
      })
      h.WATCHERS.push(
        autoWatcher,
        perDirectoryWatcher,
        backendPollingWatcher,
        pollingWatcher,
        explicitWatcher,
        recursiveWatcher,
        depthLimitedRecursiveWatcher,
        pollingRecursiveWatcher
      )

      t.is(autoWatcher.options.atomic, true)
      t.is(autoWatcher.options.backend, 'auto')
      t.is(
        autoWatcher.options.backendStrategy,
        h.isMacos || h.isWindows ? 'native-recursive-preferred' : 'native-per-directory'
      )
      t.is(perDirectoryWatcher.options.backendStrategy, 'native-per-directory')
      t.is(backendPollingWatcher.options.usePolling, true)
      t.is(backendPollingWatcher.options.atomic, false)
      t.is(pollingWatcher.options.atomic, false)
      t.is(pollingWatcher.options.backend, 'polling')
      t.is(explicitWatcher.options.atomic, true)
      t.is(recursiveWatcher.options.backendStrategy, 'native-recursive-preferred')
      t.is(depthLimitedRecursiveWatcher.options.backendStrategy, 'native-per-directory')
      t.is(pollingRecursiveWatcher.options.backendStrategy, 'polling')
    } finally {
      if (previous === undefined) delete process.env.CHOKIDAR_USEPOLLING
      else process.env.CHOKIDAR_USEPOLLING = previous
    }
  }
)

s.test('configuration normalization › should validate timing and depth options', async (t, h) => {
  const { chokidar } = h
  const invalid = [
    { backend: 'invalid' },
    { pollingInterval: 0 },
    { pollingBinaryInterval: Number.POSITIVE_INFINITY },
    { interval: 0 },
    { binaryInterval: Number.POSITIVE_INFINITY },
    { atomic: -1 },
    { atomic: Number.NaN },
    { atomic: 'invalid' },
    { depth: -1 },
    { depth: 1.5 },
    { awaitWriteFinish: { pollInterval: 0 } },
    { awaitWriteFinish: { stabilityThreshold: -1 } }
  ]
  // .all: the validation errors are TypeErrors, which plain t.exception rethrows
  for (const options of invalid) {
    await t.exception.all(() => new chokidar.FSWatcher(options), /must be/)
  }

  const watcher = new chokidar.FSWatcher({ atomic: 0, depth: 0 })
  h.WATCHERS.push(watcher)
  t.is(watcher.options.atomic, 0)
  t.is(watcher.options.depth, 0)
})

// Bare: mutates process.env.CHOKIDAR_INTERVAL, which Bare has no equivalent for.
s.test(
  'configuration normalization › should reject an invalid CHOKIDAR_INTERVAL override',
  { skip: isBare },
  async (t, h) => {
    const { chokidar } = h
    const previous = process.env.CHOKIDAR_INTERVAL
    process.env.CHOKIDAR_INTERVAL = 'not-a-number'
    try {
      await t.exception.all(() => new chokidar.FSWatcher(), /pollingInterval must be/)
    } finally {
      if (previous === undefined) delete process.env.CHOKIDAR_INTERVAL
      else process.env.CHOKIDAR_INTERVAL = previous
    }
  }
)

s.test(
  'configuration normalization › should own immutable option containers without freezing caller data',
  (t, h) => {
    const { chokidar, internals } = h
    const ignored = ['first']
    const awaitWriteFinish = { pollInterval: 25, stabilityThreshold: 50 }
    const watcher = new chokidar.FSWatcher({ ignored, awaitWriteFinish })
    h.WATCHERS.push(watcher)

    ignored.push('second')
    awaitWriteFinish.pollInterval = 1
    t.is(watcher.options.ignored.length, 1)
    t.is(watcher.options.awaitWriteFinish.pollInterval, 25)
    t.ok(Object.isFrozen(watcher.options.ignored))
    t.ok(Object.isFrozen(watcher.options.awaitWriteFinish))
    t.is(Object.isFrozen(ignored), false)
    t.is(Object.isFrozen(awaitWriteFinish), false)

    const ownedMatcherPath = sp.join(h.currentDir, 'owned-matcher')
    const mutatedMatcherPath = sp.join(h.currentDir, 'caller-mutated')
    const matcher = { path: ownedMatcherPath, recursive: true }
    const matcherWatcher = new chokidar.FSWatcher({ ignored: matcher })
    h.WATCHERS.push(matcherWatcher)
    matcher.path = mutatedMatcherPath
    t.is(internals(matcherWatcher).isIgnored(sp.join(ownedMatcherPath, 'child.txt')), true)
    t.is(internals(matcherWatcher).isIgnored(sp.join(mutatedMatcherPath, 'child.txt')), false)
    t.ok(Object.isFrozen(matcherWatcher.options.ignored[0]))
    t.is(Object.isFrozen(matcher), false)
  }
)

s.test('configuration normalization › should clone global and sticky regex matchers', (t, h) => {
  const { chokidar, internals } = h
  const matcher = /.*ignored\.txt$/gy
  matcher.lastIndex = 3
  Object.freeze(matcher)
  const watcher = new chokidar.FSWatcher({ ignored: matcher })
  h.WATCHERS.push(watcher)

  t.is(internals(watcher).isIgnored('/tmp/ignored.txt'), true)
  t.is(internals(watcher).isIgnored('/tmp/ignored.txt'), true)
  t.is(matcher.lastIndex, 3)
})

s.test(
  'configuration normalization › should treat a legal child with a dot-dot prefix as inside its parent',
  (t, h) => {
    const { chokidar, internals } = h
    const root = sp.resolve('/watched-root')
    const watcher = new chokidar.FSWatcher({
      ignored: { path: root, recursive: true }
    })
    h.WATCHERS.push(watcher)

    t.is(internals(watcher).isIgnored(sp.join(root, '..legal-child')), true)
    t.is(internals(watcher).isIgnored(sp.resolve(root, '..', 'outside')), false)
  }
)

// ---------------------------------------------------------------------------------------------
// platform regressions

s.test(
  'platform regressions › should allow renaming a watched directory containing a subdirectory (#1380)',
  async (t, h) => {
    const source = h.dpath('nested-rename')
    const child = sp.join(source, 'subfolder', 'file.txt')
    const destination = h.dpath('nested-renamed')
    const renamedChild = sp.join(destination, 'subfolder', 'file.txt')
    await h.mkdir(sp.dirname(child), { recursive: true })
    await write(child, 'nested')

    const watcher = h.cwatch(h.currentDir, { ignoreInitial: true })
    await h.waitForWatcher(watcher)
    t.is(
      watcher.options.backendStrategy,
      h.isIBMi
        ? 'polling'
        : h.isMacos || h.isWindows
          ? 'native-recursive-preferred'
          : 'native-per-directory'
    )
    await h.delay(100)

    await rename(source, destination)
    t.is((await lstat(renamedChild)).isFile(), true)
  }
)

s.test(
  'platform regressions › should retain exact target fallbacks for explicitly watched macOS files',
  { skip: !isMacos },
  async (t, h) => {
    const { EV, backendTesting } = h
    const target = h.dpath('macos-followed-target.txt')
    const link = h.dpath('macos-followed-link.txt')
    await write(target, 'initial')
    await symlink(target, link)
    for (const [watchedPath, resourcePath] of [
      [target, sp.resolve(target)],
      [link, await realpath(target)]
    ]) {
      const watcher = h.cwatch(watchedPath, { backend: 'native-recursive', atomic: false })
      const errorSpy = h.createSpy()
      watcher.on(EV.ERROR, errorSpy)
      await h.waitForWatcher(watcher)

      const failure = Object.assign(new Error('simulated exact-target failure'), { code: 'EIO' })
      t.is(await backendTesting.failNativeWatch(resourcePath, failure), true)
      await h.waitFor([[errorSpy, 1, [failure]]])
    }
  }
)

// ---------------------------------------------------------------------------------------------
// lifecycle and policy ownership

s.test(
  'lifecycle and policy ownership › should route rejected add work to the watcher error event (#1378)',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    const watcher = new chokidar.FSWatcher()
    h.WATCHERS.push(watcher)
    const failure = Object.assign(new Error('watch limit reached'), { code: 'ENOSPC' })
    const errorSpy = h.createSpy()
    watcher.on(EV.ERROR, errorSpy)
    internals(watcher).handler.addRoot = async () => {
      throw failure
    }

    t.is(watcher.add(h.dpath('rejected-add')), watcher)
    await h.waitFor([[errorSpy, 1, [failure]]])
    t.is(errorSpy.callCount, 1)
    t.is(errorSpy.calls[0][0], failure)
    await internals(watcher).drainTasks()
  }
)

s.test(
  'lifecycle and policy ownership › should replay distinct rapid changes but collapse duplicate observations',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const filePath = h.dpath('change-observations.txt')
    await write(filePath, 'first')
    const firstStats = await lstat(filePath)
    const scheduler = new VirtualScheduler()

    const duplicateWatcher = new chokidar.FSWatcher({ atomic: false }, scheduler)
    h.WATCHERS.push(duplicateWatcher)
    const duplicateSpy = h.createSpy()
    duplicateWatcher.on(EV.CHANGE, duplicateSpy)
    await internals(duplicateWatcher).emitEvent(EV.CHANGE, filePath, firstStats)
    await internals(duplicateWatcher).emitEvent(EV.CHANGE, filePath, firstStats)
    scheduler.advanceBy(50)
    t.is(duplicateSpy.callCount, 1)

    const distinctWatcher = new chokidar.FSWatcher({ atomic: false }, scheduler)
    h.WATCHERS.push(distinctWatcher)
    const distinctSpy = h.createSpy()
    distinctWatcher.on(EV.CHANGE, distinctSpy)
    await internals(distinctWatcher).emitEvent(EV.CHANGE, filePath, firstStats)
    await write(filePath, 'second-with-a-different-size')
    const secondStats = await lstat(filePath)
    await internals(distinctWatcher).emitEvent(EV.CHANGE, filePath, secondStats)
    scheduler.advanceBy(50)
    t.is(distinctSpy.callCount, 2)
  }
)

s.test(
  'lifecycle and policy ownership › should make close terminal and suppress a late ready event',
  async (t, h) => {
    const { EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const watcher = h.cwatch(h.currentDir)
    const closePromise = watcher.close()
    const readySpy = h.createSpy()
    watcher.on(EV.READY, readySpy)

    await t.exception(() => watcher.add(h.currentDir), /Cannot add paths after FSWatcher\.close/)
    t.is(watcher.close(), closePromise)
    await closePromise
    await h.delay()
    t.is(readySpy.called, false)
    t.is(internals(watcher).abortController.signal.aborted, true)
  }
)

s.test(
  'lifecycle and policy ownership › should give atomic unlinks independent deadlines',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    const scheduler = new VirtualScheduler()
    const watcher = new chokidar.FSWatcher({ atomic: 120 }, scheduler)
    h.WATCHERS.push(watcher)
    const spy = h.createSpy()
    watcher.on(EV.ALL, spy)

    await internals(watcher).emitEvent(EV.UNLINK, 'first.txt')
    scheduler.advanceBy(70)
    await internals(watcher).emitEvent(EV.UNLINK, 'second.txt')
    scheduler.advanceBy(50)

    t.ok(h.calledWith(spy, [EV.UNLINK, 'first.txt']))
    t.is(h.calledWith(spy, [EV.UNLINK, 'second.txt']), false)
    scheduler.advanceBy(70)
    t.ok(h.calledWith(spy, [EV.UNLINK, 'second.txt']))
    t.is(scheduler.activeCount, 0)
  }
)

s.test(
  'lifecycle and policy ownership › should unref policy timers for a non-persistent watcher',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    const scheduler = new VirtualScheduler()
    const watcher = new chokidar.FSWatcher({ atomic: 100, persistent: false }, scheduler)
    h.WATCHERS.push(watcher)

    await internals(watcher).emitEvent(EV.UNLINK, 'non-persistent.txt')

    t.is(scheduler.activeCount, 1)
    t.is(scheduler.referencedCount, 0)
  }
)

s.test(
  'lifecycle and policy ownership › should cancel pending policy timers on close',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const filePath = h.dpath('pending.txt')
    await write(filePath, 'pending')
    const scheduler = new VirtualScheduler()
    const watcher = new chokidar.FSWatcher(
      {
        atomic: 1000,
        awaitWriteFinish: { pollInterval: 1000, stabilityThreshold: 1000 }
      },
      scheduler
    )
    h.WATCHERS.push(watcher)

    await internals(watcher).emitEvent(EV.UNLINK, filePath)
    internals(watcher).awaitWriteFinish(filePath, 1000, EV.ADD, () => {})
    internals(watcher).throttle(EV.CHANGE, filePath, 1000)
    t.is(internals(watcher).pendingUnlinks.size, 1)
    t.is(internals(watcher).pendingWrites.size, 1)
    t.ok(internals(watcher).throttled.size > 0)
    t.is(scheduler.activeCount, 3)

    await watcher.close()
    t.is(internals(watcher).pendingUnlinks.size, 0)
    t.is(internals(watcher).pendingWrites.size, 0)
    t.is(internals(watcher).throttled.size, 0)
    t.is(scheduler.activeCount, 0)
  }
)

s.test(
  'lifecycle and policy ownership › should cancel canonical policy timers on unwatch',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const filePath = h.dpath('unwatch-policy.txt')
    await write(filePath, 'pending')
    const scheduler = new VirtualScheduler()
    const watcher = new chokidar.FSWatcher(
      {
        cwd: h.currentDir,
        atomic: 1000,
        awaitWriteFinish: { pollInterval: 1000, stabilityThreshold: 1000 }
      },
      scheduler
    )
    h.WATCHERS.push(watcher)

    await internals(watcher).emitEvent(EV.UNLINK, filePath)
    internals(watcher).awaitWriteFinish(filePath, 1000, EV.ADD, () => {})
    internals(watcher).throttle(EV.ADD, filePath, 1000)
    internals(watcher).throttle(EV.CHANGE, filePath, 1000)
    internals(watcher).throttle('watch', filePath, 1000)
    internals(watcher).throttle('remove', filePath, 1000)
    internals(watcher).throttle(
      'readdir',
      `${internals(watcher).logicalKey(sp.dirname(filePath))}\0${sp.basename(filePath)}`,
      1000
    )
    t.is(scheduler.activeCount, 7)

    watcher.unwatch(sp.basename(filePath))

    t.is(internals(watcher).pendingUnlinks.size, 0)
    t.is(internals(watcher).pendingWrites.size, 0)
    t.is(scheduler.activeCount, 0)
  }
)

s.test(
  'lifecycle and policy ownership › should close every owned polling resource below an unwatched directory',
  async (t, h) => {
    const { chokidar, internals } = h
    await h.mkdir(h.dpath('owned/subdir'), { recursive: true })
    await write(h.dpath('owned/subdir/file.txt'), 'value')
    const scheduler = new VirtualScheduler()
    const watcher = new chokidar.FSWatcher(
      { usePolling: true, pollingInterval: 100, ignoreInitial: true, cwd: h.currentDir },
      scheduler
    )
    h.WATCHERS.push(watcher)
    const ready = h.waitForWatcher(watcher)
    watcher.add('owned')
    await ready
    t.ok(scheduler.activeCount >= 3)

    watcher.unwatch('owned')
    await internals(watcher).drainTasks()

    t.is(scheduler.activeCount, 0)
    t.is(
      [...internals(watcher).closers.keys()].some((path) =>
        path.startsWith(internals(watcher).logicalKey(h.dpath('owned')))
      ),
      false
    )
  }
)

s.test(
  'lifecycle and policy ownership › should stabilize awaitWriteFinish with virtual time',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const filePath = h.dpath('stable.txt')
    await write(filePath, 'stable')
    const scheduler = new VirtualScheduler()
    const watcher = new chokidar.FSWatcher(
      {
        awaitWriteFinish: { pollInterval: 10, stabilityThreshold: 30 }
      },
      scheduler
    )
    h.WATCHERS.push(watcher)
    internals(watcher).readyEmitted = true
    const spy = h.createSpy()
    watcher.on(EV.ADD, spy)

    await internals(watcher).emitEvent(EV.ADD, filePath)
    for (let elapsed = 10; elapsed <= 30; elapsed += 10) {
      scheduler.advanceBy(10)
      await internals(watcher).drainTasks()
    }

    t.ok(h.calledWith(spy, [filePath]))
    t.is(internals(watcher).pendingWrites.size, 0)
    t.is(scheduler.activeCount, 0)
  }
)

s.test(
  'lifecycle and policy ownership › should clean up a deleted AWF-pending add without emitting unlink',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const filePath = h.dpath('deleted-during-awf.txt')
    await write(filePath, 'pending')
    const scheduler = new VirtualScheduler()
    const watcher = new chokidar.FSWatcher(
      {
        atomic: false,
        awaitWriteFinish: { pollInterval: 100, stabilityThreshold: 500 }
      },
      scheduler
    )
    h.WATCHERS.push(watcher)
    internals(watcher).readyEmitted = true
    internals(watcher).directoryEntry(h.currentDir).add(sp.basename(filePath))
    internals(watcher).directoryEntry(h.dpath('another-awf-directory'))
    const closer = h.createSpy()
    internals(watcher).addPathCloser(filePath, closer)
    const allSpy = h.createSpy()
    watcher.on(EV.ALL, allSpy)

    await internals(watcher).emitEvent(EV.ADD, filePath)
    t.is(internals(watcher).pendingWrites.size, 1)
    await unlink(filePath)
    scheduler.advanceBy(100)
    await internals(watcher).drainTasks()
    internals(watcher).removePath(h.currentDir, sp.basename(filePath), false)

    t.is(h.getCallsWith(allSpy, [EV.UNLINK, filePath]).length, 0)
    t.is(h.getCallsWith(allSpy, [EV.ADD, filePath]).length, 0)
    t.is(internals(watcher).pendingWrites.size, 0)
    t.is(internals(watcher).directoryEntry(h.currentDir).has(sp.basename(filePath)), false)
    t.is(internals(watcher).closers.has(internals(watcher).logicalKey(filePath)), false)
    t.is(closer.callCount, 1)
  }
)

s.test(
  'lifecycle and policy ownership › should await tasks and closers handed off after close starts',
  async (t, h) => {
    const { chokidar, internals } = h
    const watcher = new chokidar.FSWatcher()
    h.WATCHERS.push(watcher)
    let release
    let closerFinished = false
    const barrier = new Promise((resolve) => {
      release = resolve
    })
    internals(watcher).trackTask(
      (async () => {
        await barrier
        internals(watcher).addPathCloser('late.txt', async () => {
          await h.delay(20)
          closerFinished = true
        })
      })()
    )

    const closePromise = watcher.close()
    release()
    await closePromise
    t.is(closerFinished, true)
    t.is(internals(watcher).tasks.size, 0)
    t.is(internals(watcher).state, 'CLOSED')
  }
)

s.test(
  'lifecycle and policy ownership › should let a re-add supersede an in-flight initial scan',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    await write(h.dpath('existing.txt'), 'existing')
    const watcher = new chokidar.FSWatcher({
      backend: 'native',
      ignoreInitial: true,
      atomic: false
    })
    h.WATCHERS.push(watcher)
    const handler = internals(watcher).handler
    const originalRead = handler.readDirectory.bind(handler)
    let releaseFirst
    let firstReadStarted
    const firstRead = new Promise((resolve) => {
      firstReadStarted = resolve
    })
    const barrier = new Promise((resolve) => {
      releaseFirst = resolve
    })
    let intercepted = false
    handler.readDirectory = async (...args) => {
      if (!intercepted) {
        intercepted = true
        firstReadStarted()
        await barrier
      }
      return originalRead(...args)
    }

    const ready = h.waitForWatcher(watcher)
    watcher.add(h.currentDir)
    await firstRead
    watcher.unwatch(h.currentDir)
    watcher.add(h.currentDir)

    const key = internals(watcher).logicalKey(h.currentDir)
    for (let attempt = 0; attempt < 100 && !internals(watcher).closers.has(key); attempt++) {
      await h.delay(10)
    }
    t.ok(internals(watcher).closers.has(key), 'the replacement subscription was not registered')
    releaseFirst()
    await ready
    await internals(watcher).drainTasks()
    t.is(internals(watcher).closers.get(key)?.length, 1)

    const addSpy = h.createSpy()
    watcher.on(EV.ADD, addSpy)
    const added = h.dpath('after-readd.txt')
    await write(added, 'after')
    await h.waitFor([[addSpy, 1, [added]]])
    t.is(h.getCallsWith(addSpy, [added]).length, 1)
  }
)

s.test(
  'lifecycle and policy ownership › should suppress raw callbacks after close',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    const watcher = new chokidar.FSWatcher()
    h.WATCHERS.push(watcher)
    await watcher.close()
    const spy = h.createSpy()
    watcher.on(EV.RAW, spy)

    internals(watcher).emitRaw(EV.CHANGE, null, { watchedPath: h.currentDir })
    t.is(spy.called, false)
  }
)

// ---------------------------------------------------------------------------------------------
// owned polling

s.test('owned polling › should use the normal interval for extensionless paths', async (t, h) => {
  const { chokidar } = h
  await h.mkdir(h.currentDir, { recursive: true })
  const filePath = h.dpath('extensionless')
  await write(filePath, 'value')
  const scheduler = new VirtualScheduler()
  const watcher = new chokidar.FSWatcher(
    {
      usePolling: true,
      pollingInterval: 10,
      pollingBinaryInterval: 100,
      persistent: false,
      ignoreInitial: true
    },
    scheduler
  )
  h.WATCHERS.push(watcher)
  const ready = h.waitForWatcher(watcher)
  watcher.add(filePath)
  await ready

  t.is(scheduler.nextDelay, 10)
  t.is(scheduler.referencedCount, 0)
})

s.test('owned polling › should use the binary interval for recognized extensions', async (t, h) => {
  const { chokidar } = h
  await h.mkdir(h.currentDir, { recursive: true })
  const filePath = h.dpath('image.png')
  await write(filePath, 'value')
  const scheduler = new VirtualScheduler()
  const watcher = new chokidar.FSWatcher(
    {
      usePolling: true,
      pollingInterval: 10,
      pollingBinaryInterval: 100,
      persistent: false,
      ignoreInitial: true
    },
    scheduler
  )
  h.WATCHERS.push(watcher)
  const ready = h.waitForWatcher(watcher)
  watcher.add(filePath)
  await ready

  t.is(scheduler.nextDelay, 100)
  t.is(scheduler.referencedCount, 0)
})

s.test(
  'owned polling › should detect deletion of an empty directly watched directory',
  async (t, h) => {
    const { EV } = h
    const watchedDir = h.dpath('empty-polling-root')
    await h.mkdir(watchedDir, { recursive: true })
    const watcher = h.cwatch(watchedDir, {
      usePolling: true,
      pollingInterval: 10,
      ignoreInitial: true
    })
    await h.waitForWatcher(watcher)
    const unlinkDirSpy = h.createSpy()
    watcher.on(EV.UNLINK_DIR, unlinkDirSpy)

    await h.rmr(watchedDir)
    await h.waitFor([[unlinkDirSpy, 1, [watchedDir]]])
    t.is(h.getCallsWith(unlinkDirSpy, [watchedDir]).length, 1)
  }
)

s.test(
  'owned polling › should detect a missed symlink unlink through the deletion monitor',
  { skip: isWindows || isIBMi },
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const targetPath = h.dpath('monitored-target.txt')
    const filePath = h.dpath('monitored-symlink.txt')
    await write(targetPath, 'value')
    await symlink(targetPath, filePath)
    const scheduler = new VirtualScheduler()
    const watcher = new chokidar.FSWatcher(
      { usePolling: false, pollingInterval: 25, ignoreInitial: true, atomic: false },
      scheduler
    )
    h.WATCHERS.push(watcher)
    internals(watcher).directoryEntry(h.currentDir).add(sp.basename(filePath))
    const closer = internals(watcher).handler.watchSymlinkDeletion(filePath, true)
    t.ok(closer)
    internals(watcher).addPathCloser(filePath, closer)
    const unlinkSpy = h.createSpy()
    watcher.on(EV.UNLINK, unlinkSpy)

    await unlink(filePath)
    scheduler.advanceBy(25)
    await h.delay()
    await internals(watcher).drainTasks()

    t.is(h.getCallsWith(unlinkSpy, [filePath]).length, 1)
    await watcher.close()
    t.is(scheduler.activeCount, 0)
  }
)

s.test(
  'owned polling › should monitor a non-followed symlink without an exact native file handle',
  { skip: isWindows || isIBMi },
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const targetPath = h.dpath('monitored-target-dir')
    const linkPath = h.dpath('monitored-dir-link')
    await h.mkdir(targetPath)
    await symlink(targetPath, linkPath)
    const scheduler = new VirtualScheduler()
    const watcher = new chokidar.FSWatcher(
      {
        usePolling: false,
        followSymlinks: false,
        pollingInterval: 25,
        ignoreInitial: true,
        atomic: false
      },
      scheduler
    )
    h.WATCHERS.push(watcher)
    const handler = internals(watcher).handler
    const fileCloser = handler.handleFile(linkPath, await lstat(linkPath), true)
    const deletionCloser = handler.watchSymlinkDeletion(linkPath, true)
    t.is(fileCloser, undefined)
    t.ok(deletionCloser)
    internals(watcher).addPathCloser(linkPath, deletionCloser)
    const unlinkSpy = h.createSpy()
    watcher.on(EV.UNLINK, unlinkSpy)

    await unlink(linkPath)
    scheduler.advanceBy(25)
    await h.delay()
    await internals(watcher).drainTasks()

    t.is(h.getCallsWith(unlinkSpy, [linkPath]).length, 1)
    await watcher.close()
    t.is(scheduler.activeCount, 0)
  }
)

s.test(
  'owned polling › should use directory resources rather than one native handle per regular file',
  { skip: isIBMi },
  async (t, h) => {
    const { EV, backendTesting } = h
    const root = h.dpath('directory-resource-tree')
    const nested = sp.join(root, 'nested')
    await h.mkdir(nested, { recursive: true })
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        write(sp.join(index % 2 === 0 ? root : nested, `file-${index}.txt`), 'initial')
      )
    )
    const before = backendTesting.nativeResourceCount()
    const watcher = h.cwatch(root, { backend: 'native', atomic: false })
    await h.waitForWatcher(watcher)

    const resources = backendTesting.nativeResourceCount() - before
    t.ok(resources <= (h.isWindows ? 3 : 2), `opened ${resources} native resources`)

    const changed = sp.join(nested, 'file-1.txt')
    const spy = h.createSpy()
    watcher.on(EV.CHANGE, spy)
    await write(changed, 'changed')
    await h.waitFor([[spy, 1, [changed]]])
  }
)

s.test(
  'owned polling › should retire an exact file fallback and suppress its delayed directory echo',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, EV, internals, backendTesting } = h
    const filePath = h.dpath('mapped-file-handoff.txt')
    await write(filePath, 'initial')
    const scheduler = new VirtualScheduler()
    const listeners = []
    let watcher
    backendTesting.setNativeWatchFactory((_path, _options, listener) => {
      listeners.push(listener)
      return createFakeNativeWatcher()
    })

    try {
      watcher = new chokidar.FSWatcher(
        { backend: 'native', ignoreInitial: true, atomic: false },
        scheduler
      )
      h.WATCHERS.push(watcher)
      const state = internals(watcher)
      const initialStats = await lstat(filePath)
      state.handler.handleFile(filePath, initialStats, true, false, undefined, false, true)
      const closer = state.handler.subscribeMappedFile(
        filePath,
        filePath,
        state.createHelper(filePath),
        1,
        true
      )
      t.ok(closer)
      state.addPathCloser(filePath, closer)

      const [directoryListener, exactListener] = listeners
      t.ok(directoryListener)
      t.ok(exactListener)
      t.is(backendTesting.nativeResourceCount(), 2)

      const changes = h.createSpy()
      watcher.on(EV.CHANGE, changes)
      await write(filePath, 'first changed value')
      exactListener(EV.CHANGE, sp.basename(filePath))
      await state.drainTasks()
      t.is(h.getCallsWith(changes, [filePath]).length, 1)
      t.is(backendTesting.nativeResourceCount(), 1)

      scheduler.advanceBy(100)
      await h.delay(25)
      directoryListener(EV.CHANGE, sp.basename(filePath))
      await state.drainTasks()
      t.is(h.getCallsWith(changes, [filePath]).length, 1)

      scheduler.advanceBy(100)
      await write(filePath, 'second changed value is distinct')
      await h.delay(20)
      directoryListener(EV.CHANGE, sp.basename(filePath))
      await state.drainTasks()
      t.is(h.getCallsWith(changes, [filePath]).length, 2)

      scheduler.advanceBy(100)
      exactListener(EV.CHANGE, sp.basename(filePath))
      await state.drainTasks()
      t.is(h.getCallsWith(changes, [filePath]).length, 2)

      const parentFirstPath = h.dpath('mapped-file-parent-first.txt')
      await write(parentFirstPath, 'initial')
      state.handler.handleFile(
        parentFirstPath,
        await lstat(parentFirstPath),
        true,
        false,
        undefined,
        false,
        true
      )
      const parentFirstCloser = state.handler.subscribeMappedFile(
        parentFirstPath,
        parentFirstPath,
        state.createHelper(parentFirstPath),
        1,
        true
      )
      t.ok(parentFirstCloser)
      state.addPathCloser(parentFirstPath, parentFirstCloser)
      const parentFirstExact = listeners[2]
      t.ok(parentFirstExact)
      t.is(backendTesting.nativeResourceCount(), 2)

      await write(parentFirstPath, 'changed through parent')
      await h.delay(20)
      directoryListener(EV.CHANGE, sp.basename(parentFirstPath))
      await state.drainTasks()
      t.is(h.getCallsWith(changes, [parentFirstPath]).length, 1)
      t.is(backendTesting.nativeResourceCount(), 1)

      scheduler.advanceBy(100)
      parentFirstExact(EV.CHANGE, sp.basename(parentFirstPath))
      await state.drainTasks()
      t.is(h.getCallsWith(changes, [parentFirstPath]).length, 1)
    } finally {
      if (watcher) await watcher.close()
      backendTesting.setNativeWatchFactory()
    }
  }
)

s.test(
  'owned polling › should deterministically renegotiate interval and persistence',
  async (t, h) => {
    const { chokidar } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const filePath = h.dpath('virtual-shared.txt')
    await write(filePath, 'before')
    const scheduler = new VirtualScheduler()
    const slow = new chokidar.FSWatcher(
      { usePolling: true, pollingInterval: 80, persistent: false, ignoreInitial: true },
      scheduler
    )
    const fast = new chokidar.FSWatcher(
      { usePolling: true, pollingInterval: 10, persistent: true, ignoreInitial: true },
      scheduler
    )
    h.WATCHERS.push(slow, fast)
    const slowReady = h.waitForWatcher(slow)
    slow.add(filePath)
    await slowReady
    t.is(scheduler.activeCount, 1)
    t.is(scheduler.nextDelay, 80)
    t.is(scheduler.referencedCount, 0)

    const fastReady = h.waitForWatcher(fast)
    fast.add(filePath)
    await fastReady
    t.is(scheduler.activeCount, 1)
    t.is(scheduler.nextDelay, 10)
    t.is(scheduler.referencedCount, 1)

    await fast.close()
    t.is(scheduler.activeCount, 1)
    t.is(scheduler.nextDelay, 80)
    t.is(scheduler.referencedCount, 0)
    await slow.close()
    t.is(scheduler.activeCount, 0)
  }
)

s.test(
  'owned polling › should detect polling changes and clean up under virtual time',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const filePath = h.dpath('virtual-change.txt')
    await write(filePath, 'before')
    const scheduler = new VirtualScheduler()
    const watcher = new chokidar.FSWatcher(
      { usePolling: true, pollingInterval: 25, ignoreInitial: true },
      scheduler
    )
    h.WATCHERS.push(watcher)
    const ready = h.waitForWatcher(watcher)
    watcher.add(filePath)
    await ready
    const spy = h.createSpy()
    watcher.on(EV.CHANGE, spy)

    await write(filePath, 'after-with-a-different-size')
    const changed = new Promise((resolve) => watcher.once(EV.CHANGE, () => resolve()))
    scheduler.advanceBy(25)
    await changed
    await internals(watcher).drainTasks()

    t.ok(h.calledWith(spy, [filePath]))
    await watcher.close()
    t.is(scheduler.activeCount, 0)
  }
)

// Bare: bare-fs has no fs.watchFile/unwatchFile to install the external listener with.
s.test(
  'owned polling › should preserve an external fs.watchFile listener',
  { skip: isBare },
  async (t, h) => {
    await h.mkdir(h.currentDir, { recursive: true })
    const filePath = h.dpath('external.txt')
    await write(filePath, 'before')
    const externalSpy = h.createSpy()
    fs.watchFile(filePath, { interval: 10 }, externalSpy)
    try {
      const watcher = h.cwatch(filePath, {
        usePolling: true,
        pollingInterval: 10,
        ignoreInitial: true
      })
      await h.waitForWatcher(watcher)
      await watcher.close()

      await write(filePath, 'after')
      await h.waitFor([externalSpy])
      t.ok(externalSpy.called)
    } finally {
      fs.unwatchFile(filePath, externalSpy)
    }
  }
)

s.test(
  'owned polling › should preserve slower subscribers when a faster subscriber closes',
  async (t, h) => {
    const { EV } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const filePath = h.dpath('shared.txt')
    await write(filePath, 'before')
    const slow = h.cwatch(filePath, {
      usePolling: true,
      pollingInterval: 80,
      ignoreInitial: true
    })
    const fast = h.cwatch(filePath, {
      usePolling: true,
      pollingInterval: 10,
      ignoreInitial: true
    })
    await Promise.all([h.waitForWatcher(slow), h.waitForWatcher(fast)])
    await fast.close()
    const spy = h.createSpy()
    slow.on(EV.CHANGE, spy)

    await write(filePath, 'after')
    await h.waitFor([spy])
    t.ok(h.calledWith(spy, [filePath]))
  }
)

s.test(
  'owned polling › should prevent a stale polling closer from closing a successor resource',
  async (t, h) => {
    const { EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const filePath = h.dpath('successor.txt')
    await write(filePath, 'before')
    const first = h.cwatch(filePath, {
      usePolling: true,
      pollingInterval: 10,
      ignoreInitial: true
    })
    await h.waitForWatcher(first)
    const staleCloser = [...internals(first).closers.values()].flat()[0]
    t.ok(staleCloser)
    await first.close()

    const successor = h.cwatch(filePath, {
      usePolling: true,
      pollingInterval: 10,
      ignoreInitial: true
    })
    await h.waitForWatcher(successor)
    const spy = h.createSpy()
    successor.on(EV.CHANGE, spy)
    staleCloser()

    await write(filePath, 'after')
    await h.waitFor([spy])
    t.ok(h.calledWith(spy, [filePath]))
  }
)

s.test('owned polling › should detect a backwards mtime change', async (t, h) => {
  const { EV } = h
  await h.mkdir(h.currentDir, { recursive: true })
  const filePath = h.dpath('backwards-mtime.txt')
  await write(filePath, 'same-size')
  const future = new Date(Date.now() + 60_000)
  await utimes(filePath, future, future)
  const watcher = h.cwatch(filePath, {
    usePolling: true,
    pollingInterval: 10,
    ignoreInitial: true
  })
  await h.waitForWatcher(watcher)
  const spy = h.createSpy()
  watcher.on(EV.CHANGE, spy)

  const past = new Date(Date.now() - 60_000)
  await utimes(filePath, past, past)
  await h.waitFor([spy])
  t.ok(h.calledWith(spy, [filePath]))
})

s.test(
  'owned polling › should detect reliable inode replacement with equal size and mtime',
  { skip: isWindows },
  async (t, h) => {
    const { EV } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const filePath = h.dpath('inode.txt')
    const replacementPath = h.dpath('replacement.txt')
    const timestamp = new Date(Date.now() - 60_000)
    await write(filePath, 'same-size')
    await write(replacementPath, 'new-value')
    await utimes(filePath, timestamp, timestamp)
    await utimes(replacementPath, timestamp, timestamp)
    const watcher = h.cwatch(filePath, {
      usePolling: true,
      pollingInterval: 10,
      ignoreInitial: true
    })
    await h.waitForWatcher(watcher)
    const spy = h.createSpy()
    watcher.on(EV.CHANGE, spy)

    await rename(replacementPath, filePath)
    await h.waitFor([spy])
    t.ok(h.calledWith(spy, [filePath]))
  }
)

// ---------------------------------------------------------------------------------------------
// native resource generations

s.test(
  'native resource generations › should detect deletion of an empty directly watched native directory',
  { skip: isIBMi },
  async (t, h) => {
    const { EV } = h
    const watchedDir = h.dpath('empty-native-root')
    await h.mkdir(watchedDir, { recursive: true })
    const watcher = h.cwatch(watchedDir, {
      usePolling: false,
      backend: 'native',
      ignoreInitial: true
    })
    await h.waitForWatcher(watcher)
    const unlinkDirSpy = h.createSpy()
    watcher.on(EV.UNLINK_DIR, unlinkDirSpy)

    await h.rmr(watchedDir)
    await h.waitFor([[unlinkDirSpy, 1, [watchedDir]]])
    t.is(h.getCallsWith(unlinkDirSpy, [watchedDir]).length, 1)
  }
)

s.test(
  'native resource generations › should not let stale native closers kill a successor after failure',
  { skip: isIBMi },
  async (t, h) => {
    const { EV, backendTesting } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const first = h.cwatch(h.currentDir, {
      usePolling: false,
      backend: 'native',
      ignoreInitial: true
    })
    const second = h.cwatch(h.currentDir, {
      usePolling: false,
      backend: 'native',
      ignoreInitial: true
    })
    await Promise.all([h.waitForWatcher(first), h.waitForWatcher(second)])
    const firstError = h.createSpy()
    const secondError = h.createSpy()
    first.on(EV.ERROR, firstError)
    second.on(EV.ERROR, secondError)
    const failure = Object.assign(new Error('simulated native failure'), { code: 'EIO' })

    t.is(await backendTesting.failNativeWatch(h.currentDir, failure), true)
    t.is(firstError.callCount, 1)
    t.is(secondError.callCount, 1)

    const successor = h.cwatch(h.currentDir, {
      usePolling: false,
      backend: 'native',
      ignoreInitial: true
    })
    await h.waitForWatcher(successor)
    await Promise.all([first.close(), second.close()])
    const addSpy = h.createSpy()
    successor.on(EV.ADD, addSpy)
    const filePath = h.dpath('native-successor.txt')

    await write(filePath, 'successor')
    await h.waitFor([[addSpy, 1, [filePath]]])
    t.is(h.getCallsWith(addSpy, [filePath]).length, 1)
  }
)

// ---------------------------------------------------------------------------------------------
// scanner finalization

s.test('scanner finalization › should allow callers to override scanner depth', async (t, h) => {
  const { chokidar, EV, internals } = h
  await h.mkdir(h.dpath('subdir'), { recursive: true })
  await write(h.dpath('subdir/nested.txt'), 'nested')
  const watcher = new chokidar.FSWatcher()
  h.WATCHERS.push(watcher)
  const entries = []
  const stream = internals(watcher).createScanStream(h.currentDir, { depth: 1 })
  t.ok(stream)
  await new Promise((resolve, reject) => {
    stream.on('data', (entry) => entries.push(entry.path))
    stream.once(EV.ERROR, reject)
    stream.once('end', resolve)
  })

  t.ok(entries.includes(sp.join('subdir', 'nested.txt')))
  t.is(internals(watcher).streams.size, 0)
})

s.test(
  'scanner finalization › should settle an interrupted directory scan and release the stream',
  async (t, h) => {
    const { chokidar, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const watcher = new chokidar.FSWatcher()
    h.WATCHERS.push(watcher)
    const helper = internals(watcher).createHelper(h.currentDir)
    const pending = internals(watcher).handler.readDirectory(
      h.currentDir,
      true,
      helper,
      undefined,
      h.currentDir,
      0
    )
    internals(watcher).streams.forEach((stream) => stream.destroy())
    await pending

    t.is(internals(watcher).streams.size, 0)
  }
)

s.test(
  'scanner finalization › should settle and report an errored directory scan',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const watcher = new chokidar.FSWatcher()
    h.WATCHERS.push(watcher)
    const errorSpy = h.createSpy()
    watcher.on(EV.ERROR, errorSpy)
    const helper = internals(watcher).createHelper(h.currentDir)
    const pending = internals(watcher).handler.readDirectory(
      h.currentDir,
      true,
      helper,
      undefined,
      h.currentDir,
      0
    )
    const stream = [...internals(watcher).streams][0]
    t.ok(stream)
    const failure = Object.assign(new Error('simulated scanner failure'), { code: 'EIO' })
    stream.destroy(failure)
    await pending

    t.is(errorSpy.callCount, 1)
    t.is(errorSpy.calls[0][0], failure)
    t.is(internals(watcher).streams.size, 0)
  }
)

// ---------------------------------------------------------------------------------------------
// reconciliation regressions

s.test(
  'reconciliation regressions › should ignore an unchanged ambiguous parent invalidation for a direct native file',
  async (t, h) => {
    const { EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const file = h.dpath('direct-parent-invalidation.txt')
    await write(file, 'unchanged')
    const watcher = h.cwatch(file, { backend: 'native', atomic: false })
    await h.waitForWatcher(watcher)
    const state = internals(watcher)
    t.is(state.observed.get(state.logicalKey(file))?.transition, 'add')
    const spy = h.createSpy()
    watcher.on(EV.CHANGE, spy)
    const parent = sp.dirname(file)

    await state.handler.reconcileNativeTrigger(
      parent,
      state.createHelper(parent),
      {
        kind: 'native',
        resource: parent,
        rawEvent: 'rename',
        relativePath: null,
        sequence: 1,
        observedAt: Date.now()
      },
      file
    )

    t.is(spy.callCount, 0)
  }
)

s.test(
  'reconciliation regressions › should replay the latest invalidation coalesced during reconciliation',
  async (t, h) => {
    const { chokidar, internals } = h
    const watcher = new chokidar.FSWatcher()
    h.WATCHERS.push(watcher)
    const calls = []
    let release
    let markStarted
    const barrier = new Promise((resolve) => {
      release = resolve
    })
    const started = new Promise((resolve) => {
      markStarted = resolve
    })
    const scope = h.dpath('coalesced')

    const first = internals(watcher).enqueueReconciliation(scope, async () => {
      calls.push('first')
      markStarted()
      await barrier
    })
    await started
    const second = internals(watcher).enqueueReconciliation(scope, async () => {
      calls.push('second')
    })
    const third = internals(watcher).enqueueReconciliation(scope, async () => {
      calls.push('third')
    })
    release()
    await Promise.all([first, second, third])

    t.alike(calls, ['first', 'third'])
  }
)

// Bare: changes the working directory with process.chdir, which Bare has no equivalent for.
s.test(
  'reconciliation regressions › should remove a relative child that shares its root basename',
  { skip: isBare },
  async (t, h) => {
    const { EV } = h
    await h.mkdir(h.dpath('foo/foo'), { recursive: true })
    const originalCwd = rt.cwd()
    process.chdir(h.currentDir)
    try {
      const watcher = h.cwatch('foo', { ignoreInitial: true })
      await h.waitForWatcher(watcher)
      const spy = h.createSpy()
      watcher.on(EV.UNLINK_DIR, spy)

      await h.delay(100)
      await h.rmr(sp.join('foo', 'foo'))
      await h.waitFor([[spy, 1, [sp.join('foo', 'foo')]]])
      t.ok(h.calledWith(spy, [sp.join('foo', 'foo')]))
      await watcher.close()
    } finally {
      process.chdir(originalCwd)
    }
  }
)

s.test(
  'reconciliation regressions › should retain backend ownership while publishing ADD',
  async (t, h) => {
    const { chokidar, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const filePath = h.dpath('throttled-add.txt')
    await write(filePath, 'value')
    const scheduler = new VirtualScheduler()
    const watcher = new chokidar.FSWatcher(
      { usePolling: true, pollingInterval: 25, atomic: false },
      scheduler
    )
    h.WATCHERS.push(watcher)
    const closer = internals(watcher).handler.handleFile(
      filePath,
      await lstat(filePath),
      false,
      true
    )

    t.is(typeof closer, 'function')
    t.is(internals(watcher).directoryEntry(h.currentDir).has(sp.basename(filePath)), true)
    t.ok(scheduler.activeCount >= 1)
    internals(watcher).addPathCloser(filePath, closer)
    await watcher.close()
    t.is(scheduler.activeCount, 0)
  }
)

s.test(
  'reconciliation regressions › should keep rapid add-unlink-recreate events truthful with and without atomic mode',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    for (const atomic of [false, true]) {
      const watcher = new chokidar.FSWatcher({ atomic })
      h.WATCHERS.push(watcher)
      const filePath = h.dpath(`rapid-final-${atomic}.txt`)
      await write(filePath, 'first')
      internals(watcher).directoryEntry(h.currentDir).add(sp.basename(filePath))
      internals(watcher).directoryEntry(h.dpath(`ownership-${atomic}`))
      const allSpy = h.createSpy()
      watcher.on(EV.ALL, allSpy)

      await unlink(filePath)
      internals(watcher).removePath(h.currentDir, sp.basename(filePath), false)
      await write(filePath, 'second')
      internals(watcher).handler.handleFile(filePath, await lstat(filePath), false, false)

      if (atomic) {
        t.is(h.getCallsWith(allSpy, [EV.UNLINK, filePath]).length, 0)
        t.is(h.getCallsWith(allSpy, [EV.ADD, filePath]).length, 0)
        t.is(h.getCallsWith(allSpy, [EV.CHANGE, filePath]).length, 1)
      } else {
        t.is(h.getCallsWith(allSpy, [EV.UNLINK, filePath]).length, 1)
        t.is(h.getCallsWith(allSpy, [EV.ADD, filePath]).length, 1)
        t.is(h.getCallsWith(allSpy, [EV.CHANGE, filePath]).length, 0)
      }
    }
  }
)

// ---------------------------------------------------------------------------------------------
// recursive native reconciliation

s.test(
  'recursive native reconciliation › should collapse one native write burst and retain a later write',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const file = h.dpath('recursive-write-burst.txt')
    await write(file, 'initial')
    const scheduler = new VirtualScheduler()
    const watcher = new chokidar.FSWatcher(
      { backend: 'native-recursive', atomic: false },
      scheduler
    )
    h.WATCHERS.push(watcher)
    const root = sp.resolve(h.currentDir)
    const helper = internals(watcher).createHelper(root)
    helper.recursiveRoot = root
    internals(watcher).directoryEntry(root).add(sp.basename(file))
    internals(watcher).recordObserved(file, await lstat(file), 'add', undefined, true)
    internals(watcher).tree.clearInitialCreates(root)
    const spy = h.createSpy()
    watcher.on(EV.CHANGE, spy)
    const trigger = (sequence) => ({
      kind: 'native',
      resource: root,
      rawEvent: 'change',
      relativePath: sp.basename(file),
      sequence,
      observedAt: scheduler.now()
    })

    await write(file, 'one phase')
    await internals(watcher).handler.reconcileNativeTrigger(root, helper, trigger(1))
    await write(file, 'one write, final phase')
    await internals(watcher).handler.reconcileNativeTrigger(root, helper, trigger(2))
    scheduler.advanceBy(50)
    t.is(spy.callCount, 1)

    await write(file, 'a distinct later write')
    await internals(watcher).handler.reconcileNativeTrigger(root, helper, trigger(3))
    t.is(spy.callCount, 2)
  }
)

s.test(
  'recursive native reconciliation › should ignore a recursive invalidation whose stat fact is unchanged',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const file = h.dpath('recursive-unchanged.txt')
    await write(file, 'unchanged')
    const watcher = new chokidar.FSWatcher({ backend: 'native-recursive', atomic: false })
    h.WATCHERS.push(watcher)
    const root = sp.resolve(h.currentDir)
    const helper = internals(watcher).createHelper(root)
    helper.recursiveRoot = root
    internals(watcher).directoryEntry(root).add(sp.basename(file))
    internals(watcher).recordObserved(file, await lstat(file), 'add', undefined, true)
    internals(watcher).tree.clearInitialCreates(root)
    const spy = h.createSpy()
    watcher.on(EV.CHANGE, spy)

    await internals(watcher).handler.reconcileNativeTrigger(root, helper, {
      kind: 'native',
      resource: root,
      rawEvent: 'change',
      relativePath: sp.basename(file),
      sequence: 1,
      observedAt: Date.now()
    })

    t.is(spy.callCount, 0)
  }
)

s.test(
  'recursive native reconciliation › should serialize out-of-order rename and change reconciliation for one root',
  async (t, h) => {
    const { chokidar, internals } = h
    const watcher = new chokidar.FSWatcher()
    h.WATCHERS.push(watcher)
    const root = sp.resolve(h.currentDir)
    const resource = root
    const renameTrigger = {
      kind: 'native',
      resource,
      rawEvent: 'rename',
      relativePath: 'renamed.txt',
      sequence: 1,
      observedAt: Date.now()
    }
    const changeTrigger = {
      ...renameTrigger,
      rawEvent: 'change',
      relativePath: 'changed.txt',
      sequence: 2
    }
    const commits = []
    let release
    const barrier = new Promise((resolve) => {
      release = resolve
    })
    const first = internals(watcher).handler.reconcileBackendTrigger(
      root,
      true,
      renameTrigger,
      async () => {
        await barrier
        commits.push('rename')
      }
    )
    const second = internals(watcher).handler.reconcileBackendTrigger(
      root,
      true,
      changeTrigger,
      async () => {
        commits.push('change')
      }
    )

    await h.delay()
    t.alike(commits, [])
    release()
    await Promise.all([first, second])
    t.alike(commits, ['rename', 'change'])
  }
)

s.test(
  'recursive native reconciliation › should not coalesce directory and exact-file scopes for one candidate',
  async (t, h) => {
    const { chokidar, internals } = h
    const watcher = new chokidar.FSWatcher()
    h.WATCHERS.push(watcher)
    const file = h.dpath('scope-change.txt')
    const resource = sp.resolve(h.currentDir)
    const commits = []
    const directoryTrigger = {
      kind: 'native',
      resource,
      rawEvent: 'change',
      relativePath: sp.basename(file),
      sequence: 1,
      observedAt: Date.now()
    }
    const fileTrigger = {
      ...directoryTrigger,
      resource: sp.resolve(file),
      relativePath: null,
      sequence: 2
    }

    const directory = internals(watcher).handler.reconcileBackendTrigger(
      h.currentDir,
      true,
      directoryTrigger,
      () => {
        commits.push('directory')
      }
    )
    const exact = internals(watcher).handler.reconcileBackendTrigger(
      file,
      false,
      fileTrigger,
      () => {
        commits.push('file')
      }
    )
    await Promise.all([directory, exact])

    t.alike(commits.sort(), ['directory', 'file'])
  }
)

s.test(
  'recursive native reconciliation › should reconcile a null filename from the logical root',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const missing = h.dpath('missing-after-null.txt')
    await write(missing, 'present')
    const watcher = new chokidar.FSWatcher({ atomic: false })
    h.WATCHERS.push(watcher)
    internals(watcher).directoryEntry(h.currentDir).add(sp.basename(missing))
    const helper = internals(watcher).createHelper(h.currentDir)
    helper.recursiveRoot = h.currentDir
    await unlink(missing)
    const spy = h.createSpy()
    watcher.on(EV.UNLINK, spy)

    await internals(watcher).handler.reconcileNativeTrigger(h.currentDir, helper, {
      kind: 'native',
      resource: sp.resolve(h.currentDir),
      rawEvent: 'rename',
      relativePath: null,
      sequence: 1,
      observedAt: Date.now()
    })

    t.ok(h.calledWith(spy, [missing]))
  }
)

s.test(
  'recursive native reconciliation › should purge a missing subtree from a descendant-only recursive invalidation',
  async (t, h) => {
    const { chokidar, EV, internals } = h
    const root = sp.resolve(h.currentDir)
    const outer = h.dpath('subdir')
    const removed = h.dpath('subdir/subdir2')
    const descendant = h.dpath('subdir/subdir2/subdir3')
    await h.mkdir(descendant, { recursive: true })
    const watcher = new chokidar.FSWatcher({ backend: 'native-recursive', atomic: false })
    h.WATCHERS.push(watcher)
    const helper = internals(watcher).createHelper(root)
    helper.recursiveRoot = root
    internals(watcher).directoryEntry(root).add(sp.basename(outer))
    internals(watcher).directoryEntry(outer).add(sp.basename(removed))
    internals(watcher).directoryEntry(removed).add(sp.basename(descendant))
    internals(watcher).directoryEntry(descendant)
    const spy = h.createSpy()
    watcher.on(EV.UNLINK_DIR, spy)

    await h.rmr(removed)
    await internals(watcher).handler.reconcileNativeTrigger(root, helper, {
      kind: 'native',
      resource: root,
      rawEvent: 'rename',
      relativePath: sp.relative(root, descendant),
      sequence: 1,
      observedAt: Date.now()
    })

    t.is(spy.callCount, 2)
    t.ok(h.calledWith(spy, [descendant]))
    t.ok(h.calledWith(spy, [removed]))
  }
)

s.test(
  'recursive native reconciliation › should preserve relative presentation paths in recursive mode',
  { skip: isIBMi },
  async (t, h) => {
    const { EV } = h
    const relativeRoot = sp.relative(rt.cwd(), h.currentDir)
    const watcher = h.cwatch(relativeRoot, {
      backend: 'native-recursive',
      ignoreInitial: true,
      atomic: false
    })
    await h.waitForWatcher(watcher)
    const addSpy = h.createSpy()
    watcher.on(EV.ADD, addSpy)
    const absoluteFile = h.dpath('relative-recursive.txt')
    const presentedFile = sp.join(relativeRoot, 'relative-recursive.txt')

    await write(absoluteFile, 'relative')
    await h.waitFor([[addSpy, 1, [presentedFile]]])
    t.is(h.getCallsWith(addSpy, [presentedFile]).length, 1)
  }
)

s.test(
  'recursive native reconciliation › should match the normalized per-directory trace in recursive mode',
  { skip: isIBMi || !canUseRecursiveWatch },
  async (t, h) => {
    const { EV } = h
    const captureTrace = async (name, backend) => {
      const root = h.dpath(name)
      await h.mkdir(root, { recursive: true })
      const watcher = h.cwatch(root, {
        backend,
        ignoreInitial: true,
        atomic: false
      })
      await h.waitForWatcher(watcher)
      const spy = h.createSpy()
      const rawSpy = h.createSpy()
      watcher.on(EV.ALL, spy)
      watcher.on(EV.RAW, rawSpy)
      const file = sp.join(root, 'trace.txt')
      const directory = sp.join(root, 'trace-dir')
      const child = sp.join(directory, 'inside.txt')
      const waitForStage = async (stage, event, path) => {
        try {
          await h.waitFor([[spy, 1, [event, path]]])
        } catch {
          const normalized = spy.calls.map(
            ([seenEvent, seenPath]) => `${seenEvent}:${sp.relative(root, seenPath)}`
          )
          const raw = rawSpy.calls.map(
            ([rawEvent, rawPath]) => `${rawEvent}:${rawPath === null ? '<null>' : rawPath}`
          )
          throw new Error(
            `timeout during ${name}/${stage}; events=${JSON.stringify(normalized)}; ` +
              `raw=${JSON.stringify(raw)}`
          )
        }
      }

      await write(file, 'one')
      await waitForStage('add file', EV.ADD, file)
      await h.delay(60)
      await write(file, 'two-with-a-different-size')
      await waitForStage('change file', EV.CHANGE, file)
      await unlink(file)
      await waitForStage('unlink file', EV.UNLINK, file)
      await h.mkdir(directory)
      await waitForStage('add directory', EV.ADD_DIR, directory)
      await write(child, 'inside')
      await waitForStage('add child', EV.ADD, child)
      await unlink(child)
      await waitForStage('unlink child', EV.UNLINK, child)
      await h.rmr(directory)
      await waitForStage('unlink directory', EV.UNLINK_DIR, directory)
      await h.delay(100)

      const normalized = spy.calls.map(([event, path]) => `${event}:${sp.relative(root, path)}`)
      const raw = rawSpy.calls.map(([event, path]) => `${event}:${path === null ? '<null>' : path}`)
      await watcher.close()
      return { normalized, raw }
    }

    const perDirectory = await captureTrace('trace-per-directory', 'native')
    const recursive = await captureTrace('trace-recursive', 'native-recursive')
    const expected = [
      'add:trace.txt',
      'change:trace.txt',
      'unlink:trace.txt',
      'addDir:trace-dir',
      `add:${sp.join('trace-dir', 'inside.txt')}`,
      `unlink:${sp.join('trace-dir', 'inside.txt')}`,
      'unlinkDir:trace-dir'
    ]

    t.alike(perDirectory.normalized, expected)
    t.alike(recursive.normalized, expected, `recursive raw trace: ${JSON.stringify(recursive.raw)}`)
  }
)

s.test(
  'recursive native reconciliation › should replay one recursive create during initial scan with raw emitted once',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, EV, internals, backendTesting } = h
    for (const ignoreInitial of [false, true]) {
      const root = h.dpath(`initial-replay-${ignoreInitial}`)
      await h.mkdir(root, { recursive: true })
      const watcher = new chokidar.FSWatcher({
        backend: 'native-recursive',
        ignoreInitial,
        atomic: false
      })
      h.WATCHERS.push(watcher)
      const handler = internals(watcher).handler
      let publish
      backendTesting.setRecursiveWatchFactory((_path, _options, listener) => {
        publish = listener
        return createFakeNativeWatcher()
      })
      const originalRead = handler.scanRecursiveTree.bind(handler)
      let readStarted
      let releaseRead
      const started = new Promise((resolve) => {
        readStarted = resolve
      })
      const barrier = new Promise((resolve) => {
        releaseRead = resolve
      })
      let intercepted = false
      handler.scanRecursiveTree = async (...args) => {
        if (!intercepted) {
          intercepted = true
          readStarted()
          await barrier
        }
        return originalRead(...args)
      }
      const rawSpy = h.createSpy()
      const addSpy = h.createSpy()
      const addDirSpy = h.createSpy()
      const changeSpy = h.createSpy()
      watcher
        .on(EV.RAW, rawSpy)
        .on(EV.ADD, addSpy)
        .on(EV.ADD_DIR, addDirSpy)
        .on(EV.CHANGE, changeSpy)

      try {
        const ready = h.waitForWatcher(watcher)
        watcher.add(root)
        await started
        const created = sp.join(root, 'during.txt')
        await write(created, 'during scan')
        publish('rename', 'during.txt')
        const populated = sp.join(root, 'populated')
        const populatedChild = sp.join(populated, 'child.txt')
        await h.mkdir(populated)
        await write(populatedChild, 'populated during scan')
        publish('rename', 'populated')
        releaseRead()
        await ready
        await internals(watcher).drainTasks()

        t.is(rawSpy.callCount, 2)
        t.is(h.getCallsWith(addSpy, [created]).length, 1)
        t.is(h.getCallsWith(addDirSpy, [populated]).length, 1)
        t.is(h.getCallsWith(addSpy, [populatedChild]).length, 1)
        t.is(h.getCallsWith(changeSpy, [created]).length, 0)
      } finally {
        await watcher.close()
        backendTesting.setRecursiveWatchFactory()
      }
    }
  }
)

s.test(
  'recursive native reconciliation › should collapse recursive initialization buffer overflow to one root reconciliation',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, internals, backendTesting } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const watcher = new chokidar.FSWatcher({
      backend: 'native-recursive',
      ignoreInitial: true
    })
    h.WATCHERS.push(watcher)
    const handler = internals(watcher).handler
    let publish
    backendTesting.setRecursiveWatchFactory((_path, _options, listener) => {
      publish = listener
      return createFakeNativeWatcher()
    })
    const originalRead = handler.scanRecursiveTree.bind(handler)
    const originalReconcile = handler.reconcileNativeTrigger.bind(handler)
    let releaseRead = () => {}
    let readStarted
    const started = new Promise((resolve) => {
      readStarted = resolve
    })
    const barrier = new Promise((resolve) => {
      releaseRead = resolve
    })
    let intercepted = false
    handler.scanRecursiveTree = async (...args) => {
      if (!intercepted) {
        intercepted = true
        readStarted()
        await barrier
      }
      return originalRead(...args)
    }
    const reconciled = []
    handler.reconcileNativeTrigger = async (...args) => {
      reconciled.push({ relativePath: args[2].relativePath, sequence: args[2].sequence })
      return originalReconcile(...args)
    }

    try {
      const ready = h.waitForWatcher(watcher)
      watcher.add(h.currentDir)
      await started
      for (let index = 0; index <= 1024; index++) {
        publish('change', `overflow-${index}.txt`)
      }
      releaseRead()
      await ready

      t.alike(reconciled, [{ relativePath: null, sequence: Number.MAX_SAFE_INTEGER }])
    } finally {
      releaseRead()
      await watcher.close()
      backendTesting.setRecursiveWatchFactory()
    }
  }
)

s.test(
  'recursive native reconciliation › should classify only unsupported recursive construction errors as fallback',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, EV, internals, backendTesting } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const first = new chokidar.FSWatcher({ backend: 'native-recursive', ignoreInitial: true })
    const second = new chokidar.FSWatcher({ backend: 'native-recursive', ignoreInitial: true })
    h.WATCHERS.push(first, second)
    let attempts = 0
    backendTesting.setRecursiveWatchFactory(() => {
      attempts += 1
      throw Object.assign(new Error('recursive unsupported'), {
        code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'
      })
    })
    try {
      const firstReady = h.waitForWatcher(first)
      first.add(h.currentDir)
      await firstReady
      const secondReady = h.waitForWatcher(second)
      second.add(h.currentDir)
      await secondReady

      t.is(attempts, 1)
      t.is(internals(first).recursiveRoots.size, 0)
      t.is(internals(second).recursiveRoots.size, 0)
      const addSpy = h.createSpy()
      first.on(EV.ADD, addSpy)
      const added = h.dpath('unsupported-fallback.txt')
      await write(added, 'fallback')
      await h.waitFor([[addSpy, 1, [added]]])
    } finally {
      await Promise.all([first.close(), second.close()])
      backendTesting.setRecursiveWatchFactory()
    }
  }
)

s.test(
  'recursive native reconciliation › should report operational recursive construction errors',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, EV, internals, backendTesting } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const watcher = new chokidar.FSWatcher({
      backend: 'native-recursive',
      ignoreInitial: true
    })
    h.WATCHERS.push(watcher)
    backendTesting.setRecursiveWatchFactory(() => {
      throw Object.assign(new Error('recursive permission denied'), { code: 'EACCES' })
    })
    try {
      const errorSpy = h.createSpy()
      watcher.on(EV.ERROR, errorSpy)
      const ready = new Promise((resolve) => watcher.once(EV.READY, resolve))
      watcher.add(h.currentDir)
      await Promise.all([ready, h.waitFor([errorSpy])])

      t.is(errorSpy.callCount, 1)
      t.is(internals(watcher).recursiveRoots.size, 0)
    } finally {
      await watcher.close()
      backendTesting.setRecursiveWatchFactory()
    }
  }
)

s.test(
  'recursive native reconciliation › should recompute recursive persistence across shared subscribers',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, internals, backendTesting } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const first = new chokidar.FSWatcher({
      backend: 'native-recursive',
      persistent: false,
      ignoreInitial: true
    })
    const second = new chokidar.FSWatcher({
      backend: 'native-recursive',
      persistent: true,
      ignoreInitial: true
    })
    h.WATCHERS.push(first, second)
    let refs = 0
    let unrefs = 0
    backendTesting.setRecursiveWatchFactory((path, options, listener) => {
      const resource = fs.watch(path, options, listener)
      const ref = resource.ref.bind(resource)
      const unref = resource.unref.bind(resource)
      resource.ref = () => {
        refs += 1
        return ref()
      }
      resource.unref = () => {
        unrefs += 1
        return unref()
      }
      return resource
    })
    try {
      const firstReady = h.waitForWatcher(first)
      first.add(h.currentDir)
      await firstReady
      if (internals(first).recursiveRoots.size === 0) return
      t.is(unrefs, 1)

      const secondReady = h.waitForWatcher(second)
      second.add(h.currentDir)
      await secondReady
      t.is(refs, 1)

      await second.close()
      t.is(unrefs, 2)
    } finally {
      await Promise.all([first.close(), second.close()])
      backendTesting.setRecursiveWatchFactory()
    }
  }
)

s.test(
  'recursive native reconciliation › should reconcile populated directories moved into and removed from the tree',
  { skip: isIBMi },
  async (t, h) => {
    const { EV } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const source = sp.join(h.FIXTURES_PATH, `move-source-${h.testId}`)
    await h.mkdir(source, { recursive: true })
    await write(sp.join(source, 'inside.txt'), 'inside')
    const destination = h.dpath('moved')
    const inside = sp.join(destination, 'inside.txt')
    const watcher = h.cwatch(h.currentDir, {
      backend: 'native-recursive',
      ignoreInitial: true,
      atomic: false
    })
    await h.waitForWatcher(watcher)
    const spy = h.createSpy()
    watcher.on(EV.ALL, spy)

    await rename(source, destination)
    await h.waitFor([
      [spy, 1, [EV.ADD_DIR, destination]],
      [spy, 1, [EV.ADD, inside]]
    ])
    await h.rmr(destination)
    await h.waitFor([
      [spy, 1, [EV.UNLINK, inside]],
      [spy, 1, [EV.UNLINK_DIR, destination]]
    ])

    t.is(h.getCallsWith(spy, [EV.ADD, inside]).length, 1)
  }
)

s.test(
  'recursive native reconciliation › should preserve distinct logical projections for symlink aliases',
  { skip: isIBMi },
  async (t, h) => {
    const { EV } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const target = sp.join(h.FIXTURES_PATH, `alias-target-${h.testId}`)
    const firstAlias = h.dpath('first-alias')
    const secondAlias = h.dpath('second-alias')
    await h.mkdir(target, { recursive: true })
    await symlink(target, firstAlias, h.isWindows ? 'junction' : undefined)
    await symlink(target, secondAlias, h.isWindows ? 'junction' : undefined)
    const watcher = h.cwatch(h.currentDir, {
      backend: 'native-recursive',
      followSymlinks: true,
      ignoreInitial: true,
      atomic: false
    })

    try {
      await h.waitForWatcher(watcher)
      const addSpy = h.createSpy()
      watcher.on(EV.ADD, addSpy)
      const targetFile = sp.join(target, 'aliased.txt')
      const firstProjection = sp.join(firstAlias, 'aliased.txt')
      const secondProjection = sp.join(secondAlias, 'aliased.txt')

      await write(targetFile, 'aliased')
      await h.waitFor([
        [addSpy, 1, [firstProjection]],
        [addSpy, 1, [secondProjection]]
      ])

      t.is(h.getCallsWith(addSpy, [firstProjection]).length, 1)
      t.is(h.getCallsWith(addSpy, [secondProjection]).length, 1)
    } finally {
      await watcher.close()
      await h.rmr(target)
    }
  }
)

s.test(
  'recursive native reconciliation › should replace a followed symlink projection when its target changes',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, EV, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const firstTarget = sp.join(h.FIXTURES_PATH, `first-link-target-${h.testId}`)
    const secondTarget = sp.join(h.FIXTURES_PATH, `second-link-target-${h.testId}`)
    const link = h.dpath('replacement-link')
    const oldProjection = sp.join(link, 'old.txt')
    const newProjection = sp.join(link, 'new.txt')
    await h.mkdir(firstTarget, { recursive: true })
    await h.mkdir(secondTarget, { recursive: true })
    await write(sp.join(firstTarget, 'old.txt'), 'old')
    await write(sp.join(secondTarget, 'new.txt'), 'new')
    await symlink(firstTarget, link, h.isWindows ? 'junction' : undefined)
    const watcher = new chokidar.FSWatcher({
      backend: 'native-recursive',
      followSymlinks: true,
      ignoreInitial: true,
      atomic: false
    })
    h.WATCHERS.push(watcher)
    const linkKey = internals(watcher).logicalKey(link)
    internals(watcher).directoryEntry(h.currentDir).add(sp.basename(link))
    internals(watcher).directoryEntry(link).add('old.txt')
    internals(watcher).symlinkPaths.set(linkKey, firstTarget)
    internals(watcher).recordObserved(link, await lstat(firstTarget), 'add', undefined, true)
    internals(watcher).tree.clearInitialCreates(h.currentDir)
    const allSpy = h.createSpy()
    watcher.on(EV.ALL, allSpy)

    try {
      await h.rmr(link)
      await symlink(secondTarget, link, h.isWindows ? 'junction' : undefined)
      const helper = internals(watcher).createHelper(h.currentDir)
      helper.recursiveRoot = h.currentDir
      await internals(watcher).handler.reconcileNativeTrigger(h.currentDir, helper, {
        kind: 'native',
        resource: sp.resolve(h.currentDir),
        rawEvent: 'rename',
        relativePath: sp.basename(link),
        sequence: 1,
        observedAt: Date.now()
      })
      await internals(watcher).drainTasks()

      t.is(h.getCallsWith(allSpy, [EV.UNLINK, oldProjection]).length, 1)
      t.is(h.getCallsWith(allSpy, [EV.UNLINK_DIR, link]).length, 1)
      t.is(h.getCallsWith(allSpy, [EV.ADD_DIR, link]).length, 1)
      t.is(h.getCallsWith(allSpy, [EV.ADD, newProjection]).length, 1)
      t.is(internals(watcher).directoryEntry(link).has('old.txt'), false)
      t.is(internals(watcher).directoryEntry(link).has('new.txt'), true)
      t.is(internals(watcher).symlinkPaths.get(linkKey), await realpath(secondTarget))
    } finally {
      await watcher.close()
      await Promise.all([h.rmr(firstTarget), h.rmr(secondTarget)])
    }
  }
)

s.test(
  'recursive native reconciliation › should keep recursive create-delete-recreate state truthful',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, EV, internals, backendTesting } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const watcher = new chokidar.FSWatcher({
      backend: 'native-recursive',
      ignoreInitial: true,
      atomic: false
    })
    h.WATCHERS.push(watcher)
    let publish
    backendTesting.setRecursiveWatchFactory((_path, _options, listener) => {
      publish = listener
      return createFakeNativeWatcher()
    })
    const file = h.dpath('recursive-recreated.txt')
    const addSpy = h.createSpy()
    const unlinkSpy = h.createSpy()
    watcher.on(EV.ADD, addSpy).on(EV.UNLINK, unlinkSpy)

    try {
      const ready = h.waitForWatcher(watcher)
      watcher.add(h.currentDir)
      await ready

      await write(file, 'first')
      publish('rename', sp.basename(file))
      await internals(watcher).drainTasks()
      await unlink(file)
      publish('rename', sp.basename(file))
      await internals(watcher).drainTasks()
      await write(file, 'second')
      publish('rename', sp.basename(file))
      await internals(watcher).drainTasks()

      t.is(h.getCallsWith(addSpy, [file]).length, 2)
      t.is(h.getCallsWith(unlinkSpy, [file]).length, 1)
      t.is(internals(watcher).directoryEntry(h.currentDir).has(sp.basename(file)), true)
      t.is(internals(watcher).observed.has(internals(watcher).logicalKey(file)), true)
      t.is((await lstat(file)).isFile(), true)
    } finally {
      await watcher.close()
      backendTesting.setRecursiveWatchFactory()
    }
  }
)

s.test(
  'recursive native reconciliation › should keep an exact-root recursive subscriber alive when another closes',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, EV, internals, backendTesting } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const first = new chokidar.FSWatcher({
      backend: 'native-recursive',
      ignoreInitial: true
    })
    const second = new chokidar.FSWatcher({
      backend: 'native-recursive',
      ignoreInitial: true
    })
    h.WATCHERS.push(first, second)
    const closeSpy = h.createSpy()
    let factoryCalls = 0
    let publish
    backendTesting.setRecursiveWatchFactory((_path, _options, listener) => {
      factoryCalls += 1
      publish = listener
      const resource = createFakeNativeWatcher()
      const close = resource.close.bind(resource)
      resource.close = () => {
        closeSpy()
        close()
      }
      return resource
    })

    try {
      const firstReady = h.waitForWatcher(first)
      first.add(h.currentDir)
      await firstReady
      const secondReady = h.waitForWatcher(second)
      second.add(h.currentDir)
      await secondReady
      t.is(factoryCalls, 1)

      await first.close()
      t.is(closeSpy.callCount, 0)
      const spy = h.createSpy()
      second.on(EV.ADD, spy)
      const file = h.dpath('still-watched.txt')
      await write(file, 'value')
      publish('rename', sp.basename(file))
      await internals(second).drainTasks()

      t.is(h.getCallsWith(spy, [file]).length, 1)
    } finally {
      await Promise.allSettled([first.close(), second.close()])
      t.is(closeSpy.callCount, 1)
      backendTesting.setRecursiveWatchFactory()
    }
  }
)

s.test(
  'recursive native reconciliation › should use one native handle for a wide recursive tree (#1385, #1452)',
  { skip: isIBMi },
  async (t, h) => {
    const { internals, backendTesting } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const directoryCount = 64
    const directories = Array.from({ length: directoryCount }, (_, index) =>
      h.dpath(`wide-${index}`)
    )
    await Promise.all(directories.map((directory) => h.mkdir(directory)))
    await Promise.all(
      directories.map((directory, index) =>
        write(sp.join(directory, `file-${index}.txt`), 'watched')
      )
    )
    let factoryCalls = 0
    const closeSpy = h.createSpy()
    backendTesting.setRecursiveWatchFactory(() => {
      factoryCalls += 1
      const resource = createFakeNativeWatcher()
      const close = resource.close.bind(resource)
      resource.close = () => {
        closeSpy()
        close()
      }
      return resource
    })
    const watcher = h.cwatch(h.currentDir, {
      backend: 'native-recursive',
      ignoreInitial: true
    })

    try {
      await h.waitForWatcher(watcher)
      t.is(watcher.options.backend, 'native-recursive')
      t.is(factoryCalls, 1)
      t.is(internals(watcher).recursiveRoots.size, 1)
      t.ok(Object.keys(watcher.getWatched()).length >= directoryCount + 1)
    } finally {
      await watcher.close()
      t.is(closeSpy.callCount, 1)
      backendTesting.setRecursiveWatchFactory()
    }
  }
)

s.test(
  'recursive native reconciliation › should transactionally fall back after a recursive handle fails',
  { skip: isIBMi },
  async (t, h) => {
    const { EV, internals, backendTesting } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const watcher = h.cwatch(h.currentDir, {
      backend: 'native-recursive',
      ignoreInitial: true,
      atomic: false
    })
    await h.waitForWatcher(watcher)
    if (internals(watcher).recursiveRoots.size === 0) return
    const errorSpy = h.createSpy()
    watcher.on(EV.ERROR, errorSpy)

    const simulated = Object.assign(new Error('simulated recursive failure'), {
      code: 'EIO'
    })
    t.is(backendTesting.failRecursiveWatch(h.currentDir, simulated), true)
    await h.waitFor([errorSpy])
    t.is(internals(watcher).recursiveRoots.size, 0)

    const file = h.dpath('after-fallback.txt')
    const addSpy = h.createSpy()
    watcher.on(EV.ADD, addSpy)
    await write(file, 'after fallback')
    await h.waitFor([[addSpy, 1, [file]]])
    t.is(h.getCallsWith(addSpy, [file]).length, 1)
  }
)

s.test(
  'recursive native reconciliation › should close while buffered recursive triggers are replaying',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, EV, internals, backendTesting } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const watcher = new chokidar.FSWatcher({
      backend: 'native-recursive',
      ignoreInitial: true,
      atomic: false
    })
    h.WATCHERS.push(watcher)
    const handler = internals(watcher).handler
    let publish
    backendTesting.setRecursiveWatchFactory((_path, _options, listener) => {
      publish = listener
      return createFakeNativeWatcher()
    })
    const originalRead = handler.scanRecursiveTree.bind(handler)
    const originalReconcile = handler.reconcileNativeTrigger.bind(handler)
    let releaseRead = () => {}
    let releaseReplay = () => {}
    let readStarted
    let replayStarted
    const readBarrier = new Promise((resolve) => {
      releaseRead = resolve
    })
    const replayBarrier = new Promise((resolve) => {
      releaseReplay = resolve
    })
    const reading = new Promise((resolve) => {
      readStarted = resolve
    })
    const replaying = new Promise((resolve) => {
      replayStarted = resolve
    })
    let blockedRead = false
    let blockedReplay = false
    handler.scanRecursiveTree = async (...args) => {
      if (!blockedRead) {
        blockedRead = true
        readStarted()
        await readBarrier
      }
      return originalRead(...args)
    }
    handler.reconcileNativeTrigger = async (...args) => {
      if (!blockedReplay) {
        blockedReplay = true
        replayStarted()
        await replayBarrier
      }
      return originalReconcile(...args)
    }
    const allSpy = h.createSpy()
    const readySpy = h.createSpy()
    watcher.on(EV.ALL, allSpy).on(EV.READY, readySpy)

    try {
      watcher.add(h.currentDir)
      await reading
      await write(h.dpath('during-replay.txt'), 'buffered')
      publish('rename', 'during-replay.txt')
      releaseRead()
      await replaying
      const closing = watcher.close()
      releaseReplay()
      await closing

      t.is(internals(watcher).state, 'CLOSED')
      t.is(internals(watcher).tasks.size, 0)
      t.is(internals(watcher).recursiveRoots.size, 0)
      t.is(allSpy.called, false)
      t.is(readySpy.called, false)
    } finally {
      releaseRead()
      releaseReplay()
      await watcher.close()
      backendTesting.setRecursiveWatchFactory()
    }
  }
)

s.test(
  'recursive native reconciliation › should close while recursive runtime fallback is being established',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, internals, backendTesting } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const watcher = new chokidar.FSWatcher({
      backend: 'native-recursive',
      ignoreInitial: true
    })
    h.WATCHERS.push(watcher)
    const handler = internals(watcher).handler
    backendTesting.setRecursiveWatchFactory(() => createFakeNativeWatcher())
    let releaseFallback = () => {}
    try {
      const ready = h.waitForWatcher(watcher)
      watcher.add(h.currentDir)
      await ready

      const originalDir = handler.handleDirectory.bind(handler)
      let fallbackStarted
      const fallback = new Promise((resolve) => {
        fallbackStarted = resolve
      })
      const barrier = new Promise((resolve) => {
        releaseFallback = resolve
      })
      let intercepted = false
      handler.handleDirectory = async (...args) => {
        const helper = args[5]
        if (!intercepted && helper.recursiveDisabled) {
          intercepted = true
          fallbackStarted()
          await barrier
        }
        return originalDir(...args)
      }

      const failure = Object.assign(new Error('close during fallback'), { code: 'EIO' })
      t.is(backendTesting.failRecursiveWatch(h.currentDir, failure), true)
      await fallback
      const closing = watcher.close()
      releaseFallback()
      await closing

      t.is(internals(watcher).state, 'CLOSED')
      t.is(internals(watcher).tasks.size, 0)
      t.is(internals(watcher).recursiveRoots.size, 0)
      t.is(internals(watcher).closers.size, 0)
    } finally {
      releaseFallback()
      await watcher.close()
      backendTesting.setRecursiveWatchFactory()
    }
  }
)

s.test(
  'recursive native reconciliation › should close a followed-symlink child subscription during closer handoff',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, internals, backendTesting } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const target = sp.join(h.FIXTURES_PATH, `child-target-${h.testId}`)
    const link = h.dpath('child-link')
    await h.mkdir(target, { recursive: true })
    await write(sp.join(target, 'inside.txt'), 'inside')
    await symlink(target, link, h.isWindows ? 'junction' : undefined)
    const watcher = new chokidar.FSWatcher({
      backend: 'native-recursive',
      followSymlinks: true,
      ignoreInitial: true
    })
    h.WATCHERS.push(watcher)
    const handler = internals(watcher).handler
    backendTesting.setRecursiveWatchFactory(() => createFakeNativeWatcher())
    const originalDir = handler.handleDirectory.bind(handler)
    let releaseChild = () => {}
    let childCreated
    const childHandoff = new Promise((resolve) => {
      childCreated = resolve
    })
    const barrier = new Promise((resolve) => {
      releaseChild = resolve
    })
    let intercepted = false
    handler.handleDirectory = async (...args) => {
      const closer = await originalDir(...args)
      if (!intercepted && sp.resolve(args[0]) === sp.resolve(link)) {
        intercepted = true
        childCreated()
        await barrier
      }
      return closer
    }

    try {
      watcher.add(h.currentDir)
      await childHandoff
      const closing = watcher.close()
      releaseChild()
      await closing

      t.is(internals(watcher).state, 'CLOSED')
      t.is(internals(watcher).tasks.size, 0)
      t.is(internals(watcher).closers.size, 0)
      t.is(internals(watcher).recursiveRoots.size, 0)
    } finally {
      releaseChild()
      await watcher.close()
      backendTesting.setRecursiveWatchFactory()
      await h.rmr(target)
    }
  }
)

s.test(
  'recursive native reconciliation › should close a recursive subscription created during an initial scan race',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const watcher = new chokidar.FSWatcher({ backend: 'native-recursive' })
    h.WATCHERS.push(watcher)
    const handler = internals(watcher).handler
    const originalRead = handler.scanRecursiveTree.bind(handler)
    let release
    const barrier = new Promise((resolve) => {
      release = resolve
    })
    let intercepted = false
    handler.scanRecursiveTree = async (...args) => {
      if (!intercepted) {
        intercepted = true
        await barrier
      }
      return originalRead(...args)
    }

    watcher.add(h.currentDir)
    await h.delay()
    const closed = watcher.close()
    release()
    await closed

    t.is(internals(watcher).state, 'CLOSED')
    t.is(internals(watcher).tasks.size, 0)
  }
)

s.test(
  'recursive native reconciliation › should close a recursive subscription unwatched during its initial scan',
  { skip: isIBMi },
  async (t, h) => {
    const { chokidar, internals } = h
    await h.mkdir(h.currentDir, { recursive: true })
    const watcher = new chokidar.FSWatcher({ backend: 'native-recursive' })
    h.WATCHERS.push(watcher)
    const handler = internals(watcher).handler
    const originalRead = handler.scanRecursiveTree.bind(handler)
    let release
    const barrier = new Promise((resolve) => {
      release = resolve
    })
    let intercepted = false
    handler.scanRecursiveTree = async (...args) => {
      if (!intercepted) {
        intercepted = true
        await barrier
      }
      return originalRead(...args)
    }

    watcher.add(h.currentDir)
    await h.delay()
    watcher.unwatch(h.currentDir)
    release()
    await internals(watcher).drainTasks()

    t.is(internals(watcher).recursiveRoots.size, 0)
    t.is(internals(watcher).closers.has(internals(watcher).logicalKey(h.currentDir)), false)
  }
)

s.run()
