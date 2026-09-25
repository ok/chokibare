// Port of chokidar src/index.test.ts @ 74adf65: the public API case and the shared suite
// `runTests(baseopts)`, registered once per backend exactly as upstream registers it.
'use strict'

const {
  appendFile,
  readFile: read,
  rename,
  symlink,
  unlink,
  writeFile: write
} = require('fs/promises')
const sp = require('path')
const rt = require('../lib/bare-runtime')
const { suite, isBare, isMacos, isWindows, isIBMi, canUseRecursiveWatch } = require('./helpers')

function normalizeTestPath(path) {
  return sp.normalize(path).replace(/\\/g, '/')
}

// Upstream's main() chdirs into the fixture root, so its bare relative paths start there. Here the
// working directory stays put, so the same paths are spelled relative to it.
function fixturesRelative(FIXTURES_PATH, ...parts) {
  return sp.join(sp.relative(rt.cwd(), FIXTURES_PATH), ...parts)
}

const s = suite()

s.test('should expose public API methods', (t, h) => {
  t.ok(typeof h.chokidar.FSWatcher === 'function')
  t.ok(typeof h.chokidar.watch === 'function')
})

if (!isIBMi) {
  registerSharedSuite(s, { backend: 'native' }, 'fs.watch (non-polling)')
}
if (!isIBMi && canUseRecursiveWatch) {
  registerSharedSuite(s, { backend: 'native-recursive' }, 'fs.watch (recursive preferred)')
}
registerSharedSuite(s, { usePolling: true, interval: 10 }, 'owned polling')

s.run()

function registerSharedSuite(s, baseopts, label) {
  const macosFswatch = isMacos && !baseopts.usePolling
  baseopts.persistent = true

  const title = (...parts) => [label, ...parts].join(' › ')

  // Upstream beforeEach(clean): a fresh copy of baseopts per test, plus the suite's slow delay.
  function clean(h) {
    h.setSlowDelay(macosFswatch ? 100 : undefined)
    const options = {}
    Object.keys(baseopts).forEach((key) => {
      options[key] = baseopts[key]
    })
    return options
  }

  // describe('watch a directory') beforeEach/afterEach around the test body.
  async function watchDirectory(t, h, options, body) {
    options.ignoreInitial = true
    options.alwaysStat = true
    const readySpy = h.createSpy(function readySpy() {})
    const rawSpy = h.createSpy(function rawSpy() {})
    const watcher = h.cwatch(h.currentDir, options).on(h.EV.READY, readySpy).on(h.EV.RAW, rawSpy)
    await h.waitForWatcher(watcher)
    try {
      await body({ watcher, readySpy, rawSpy })
    } finally {
      await h.waitFor([readySpy])
      await watcher.close()
      t.is(readySpy.callCount, 1)
    }
  }

  // describe('watch symlinks') beforeEach/afterEach around the test body.
  async function watchSymlinks(h, body) {
    const linkedDir = sp.resolve(h.currentDir, '..', `${h.testId}-link`)
    await symlink(h.currentDir, linkedDir, isWindows ? 'dir' : undefined)
    await h.mkdir(h.dpath('subdir'))
    await write(h.dpath('subdir/add.txt'), 'b')
    try {
      await body(linkedDir)
    } finally {
      await unlink(linkedDir)
    }
  }

  // describe('depth') beforeEach.
  async function depthFixture(h) {
    await h.mkdir(h.dpath('subdir'))
    await write(h.dpath('subdir/add.txt'), 'b')
    await h.delay()
    await h.mkdir(h.dpath('subdir/subsub'))
    await write(h.dpath('subdir/subsub/ab.txt'), 'b')
    await h.delay()
  }

  // describe('ignorePermissionErrors') beforeEach.
  async function permissionFixture(h) {
    const filePath = h.dpath('add.txt')
    const PERM_R = 0o200
    await write(filePath, 'b', { mode: PERM_R })
    await h.delay()
    return filePath
  }

  // describe('unwatch') beforeEach.
  async function unwatchFixture(h, options) {
    options.ignoreInitial = true
    await h.mkdir(h.dpath('subdir'))
    await h.delay()
  }

  // ------------------------------------------------------------------------------------------
  // watch a directory

  s.test(
    title('watch a directory', 'should produce an instance of chokidar.FSWatcher'),
    async (t, h) => {
      const options = clean(h)
      await watchDirectory(t, h, options, ({ watcher }) => {
        t.ok(watcher instanceof h.chokidar.FSWatcher)
      })
    }
  )

  s.test(title('watch a directory', 'should expose public API methods'), async (t, h) => {
    const options = clean(h)
    await watchDirectory(t, h, options, ({ watcher }) => {
      t.ok(typeof watcher.on === 'function')
      t.ok(typeof watcher.emit === 'function')
      t.ok(typeof watcher.add === 'function')
      t.ok(typeof watcher.close === 'function')
      t.ok(typeof watcher.getWatched === 'function')
    })
  })

  s.test(
    title('watch a directory', 'should emit `add` event when file was added'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher, rawSpy }) => {
        const testPath = h.dpath('add.txt')
        const spy = h.createSpy(function addSpy() {})
        watcher.on(EV.ADD, spy)
        await h.delay()
        await write(testPath, h.time())
        await h.waitFor([spy])
        t.is(spy.callCount, 1)
        t.ok(h.calledWith(spy, [testPath]))
        t.ok(spy.calls[0][1]) // stats
        t.ok(rawSpy.called)
      })
    }
  )

  s.test(
    title(
      'watch a directory',
      'should emit nine `add` events when nine files were added in one directory'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher }) => {
        const paths = []
        for (let i = 1; i <= 9; i++) {
          paths.push(h.dpath(`add${i}.txt`))
        }

        const spy = h.createSpy()
        watcher.on(EV.ADD, (path) => {
          spy(path)
        })

        await write(paths[0], h.time())
        await write(paths[1], h.time())
        await write(paths[2], h.time())
        await write(paths[3], h.time())
        await write(paths[4], h.time())
        await h.delay(100)

        await write(paths[5], h.time())
        await write(paths[6], h.time())

        await h.delay(150)
        await write(paths[7], h.time())
        await write(paths[8], h.time())

        await h.waitFor([[spy, 4]])

        await h.delay(1000)
        await h.waitFor([[spy, 9]])
        paths.forEach((path) => {
          t.ok(h.calledWith(spy, [path]))
        })
      })
    }
  )

  s.test(
    title(
      'watch a directory',
      'should emit thirtythree `add` events when thirtythree files were added in nine directories'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher, readySpy, rawSpy }) => {
        await watcher.close()

        const test1Path = h.dpath('add1.txt')
        const testb1Path = h.dpath('b/add1.txt')
        const testc1Path = h.dpath('c/add1.txt')
        const testd1Path = h.dpath('d/add1.txt')
        const teste1Path = h.dpath('e/add1.txt')
        const testf1Path = h.dpath('f/add1.txt')
        const testg1Path = h.dpath('g/add1.txt')
        const testh1Path = h.dpath('h/add1.txt')
        const testi1Path = h.dpath('i/add1.txt')
        const test2Path = h.dpath('add2.txt')
        const testb2Path = h.dpath('b/add2.txt')
        const testc2Path = h.dpath('c/add2.txt')
        const test3Path = h.dpath('add3.txt')
        const testb3Path = h.dpath('b/add3.txt')
        const testc3Path = h.dpath('c/add3.txt')
        const test4Path = h.dpath('add4.txt')
        const testb4Path = h.dpath('b/add4.txt')
        const testc4Path = h.dpath('c/add4.txt')
        const test5Path = h.dpath('add5.txt')
        const testb5Path = h.dpath('b/add5.txt')
        const testc5Path = h.dpath('c/add5.txt')
        const test6Path = h.dpath('add6.txt')
        const testb6Path = h.dpath('b/add6.txt')
        const testc6Path = h.dpath('c/add6.txt')
        const test7Path = h.dpath('add7.txt')
        const testb7Path = h.dpath('b/add7.txt')
        const testc7Path = h.dpath('c/add7.txt')
        const test8Path = h.dpath('add8.txt')
        const testb8Path = h.dpath('b/add8.txt')
        const testc8Path = h.dpath('c/add8.txt')
        const test9Path = h.dpath('add9.txt')
        const testb9Path = h.dpath('b/add9.txt')
        const testc9Path = h.dpath('c/add9.txt')
        await h.mkdir(h.dpath('b'))
        await h.mkdir(h.dpath('c'))
        await h.mkdir(h.dpath('d'))
        await h.mkdir(h.dpath('e'))
        await h.mkdir(h.dpath('f'))
        await h.mkdir(h.dpath('g'))
        await h.mkdir(h.dpath('h'))
        await h.mkdir(h.dpath('i'))

        await h.delay()

        readySpy.reset()
        const watcher2 = h.cwatch(h.currentDir, options).on(EV.READY, readySpy).on(EV.RAW, rawSpy)
        const spy = await h.aspy(watcher2, EV.ADD, null, true)

        const filesToWrite = [
          test1Path,
          test2Path,
          test3Path,
          test4Path,
          test5Path,
          test6Path,
          test7Path,
          test8Path,
          test9Path,
          testb1Path,
          testb2Path,
          testb3Path,
          testb4Path,
          testb5Path,
          testb6Path,
          testb7Path,
          testb8Path,
          testb9Path,
          testc1Path,
          testc2Path,
          testc3Path,
          testc4Path,
          testc5Path,
          testc6Path,
          testc7Path,
          testc8Path,
          testc9Path,
          testd1Path,
          teste1Path,
          testf1Path,
          testg1Path,
          testh1Path,
          testi1Path
        ]

        let currentCallCount = 0

        for (const fileToWrite of filesToWrite) {
          await write(fileToWrite, h.time())
          await h.waitFor([[spy, ++currentCallCount]])
        }

        t.ok(h.calledWith(spy, [test1Path]))
        t.ok(h.calledWith(spy, [test2Path]))
        t.ok(h.calledWith(spy, [test3Path]))
        t.ok(h.calledWith(spy, [test4Path]))
        t.ok(h.calledWith(spy, [test5Path]))
        t.ok(h.calledWith(spy, [test6Path]))
        t.ok(h.calledWith(spy, [test7Path]))
        t.ok(h.calledWith(spy, [test8Path]))
        t.ok(h.calledWith(spy, [test9Path]))
        t.ok(h.calledWith(spy, [testb1Path]))
        t.ok(h.calledWith(spy, [testb2Path]))
        t.ok(h.calledWith(spy, [testb3Path]))
        t.ok(h.calledWith(spy, [testb4Path]))
        t.ok(h.calledWith(spy, [testb5Path]))
        t.ok(h.calledWith(spy, [testb6Path]))
        t.ok(h.calledWith(spy, [testb7Path]))
        t.ok(h.calledWith(spy, [testb8Path]))
        t.ok(h.calledWith(spy, [testb9Path]))
        t.ok(h.calledWith(spy, [testc1Path]))
        t.ok(h.calledWith(spy, [testc2Path]))
        t.ok(h.calledWith(spy, [testc3Path]))
        t.ok(h.calledWith(spy, [testc4Path]))
        t.ok(h.calledWith(spy, [testc5Path]))
        t.ok(h.calledWith(spy, [testc6Path]))
        t.ok(h.calledWith(spy, [testc7Path]))
        t.ok(h.calledWith(spy, [testc8Path]))
        t.ok(h.calledWith(spy, [testc9Path]))
        t.ok(h.calledWith(spy, [testd1Path]))
        t.ok(h.calledWith(spy, [teste1Path]))
        t.ok(h.calledWith(spy, [testf1Path]))
        t.ok(h.calledWith(spy, [testg1Path]))
        t.ok(h.calledWith(spy, [testh1Path]))
        t.ok(h.calledWith(spy, [testi1Path]))
      })
    }
  )

  s.test(
    title('watch a directory', 'should emit `addDir` event when directory was added'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher, rawSpy }) => {
        const testDir = h.dpath('subdir')
        const spy = h.createSpy(function addDirSpy() {})
        watcher.on(EV.ADD_DIR, spy)
        t.is(spy.called, false)
        await h.mkdir(testDir)
        await h.waitFor([spy])
        t.is(spy.callCount, 1)
        t.ok(h.calledWith(spy, [testDir]))
        t.ok(spy.calls[0][1]) // stats
        t.ok(rawSpy.called)
      })
    }
  )

  s.test(
    title('watch a directory', 'should emit `change` event when file was changed'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher, rawSpy }) => {
        const testPath = h.dpath('change.txt')
        const spy = h.createSpy(function changeSpy() {})
        watcher.on(EV.CHANGE, spy)
        t.is(spy.called, false)
        await write(testPath, h.time())
        await h.waitFor([spy])
        t.ok(h.calledWith(spy, [testPath]))
        t.ok(spy.calls[0][1]) // stats
        t.ok(rawSpy.called)
        t.is(h.getCallsWith(spy, [testPath]).length, 1)
      })
    }
  )

  s.test(
    title('watch a directory', 'should emit every observable change for rapid writes'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher }) => {
        const testPath = h.dpath('change.txt')
        const spy = h.createSpy(function quickChangeSpy() {})
        watcher.on(EV.CHANGE, spy)

        await write(testPath, h.time())
        await h.delay(10)
        await write(testPath, h.time())

        // Recursive FSEvents may batch both writes into one native notification.
        // Distinct observed notifications are covered by the event-policy unit test.
        const expected = isMacos && baseopts.backend === 'native-recursive' ? 1 : 2
        await h.waitFor([[spy, expected, [testPath]]])
        t.ok(h.getCallsWith(spy, [testPath]).length >= expected)
      })
    }
  )

  s.test(
    title(
      'watch a directory',
      'should not emit `change` after `unlink` when changes were throttled'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher }) => {
        const testPath = h.dpath('change.txt')
        const changeSpy = h.createSpy(function throttledChangeSpy() {})
        const unlinkSpy = h.createSpy(function throttledUnlinkSpy() {})
        watcher.on(EV.CHANGE, changeSpy).on(EV.UNLINK, unlinkSpy)

        await write(testPath, h.time())
        await h.delay(10)
        await write(testPath, h.time())
        await h.delay(10)
        await unlink(testPath)

        await h.waitFor([[unlinkSpy, 1, [testPath]]])
        const changeCallsAtUnlink = h.getCallsWith(changeSpy, [testPath]).length

        await h.delay(120)
        t.is(h.getCallsWith(changeSpy, [testPath]).length, changeCallsAtUnlink)
      })
    }
  )

  s.test(
    title('watch a directory', 'should emit `unlink` event when file was removed'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher, rawSpy }) => {
        const testPath = h.dpath('unlink.txt')
        const spy = h.createSpy(function unlinkSpy() {})
        watcher.on(EV.UNLINK, spy)
        t.is(spy.called, false)
        await unlink(testPath)
        await h.waitFor([spy])
        t.ok(h.calledWith(spy, [testPath]))
        t.is(!spy.calls[0][1], true) // no stats
        t.ok(rawSpy.called)
        t.is(spy.callCount, 1)
      })
    }
  )

  s.test(
    title('watch a directory', 'should emit `unlinkDir` event when a directory was removed'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher, rawSpy }) => {
        const testDir = h.dpath('subdir')
        const spy = h.createSpy(function unlinkDirSpy() {})

        await h.mkdir(testDir)
        await h.delay(300)
        watcher.on(EV.UNLINK_DIR, spy)

        await h.rmr(testDir)
        await h.waitFor([spy])
        t.ok(h.calledWith(spy, [testDir]))
        t.is(!spy.calls[0][1], true) // no stats
        t.ok(rawSpy.called)
        t.is(spy.callCount, 1)
      })
    }
  )

  s.test(
    title(
      'watch a directory',
      'should emit two `unlinkDir` event when two nested directories were removed'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher, rawSpy }) => {
        const testDir = h.dpath('subdir')
        const testDir2 = h.dpath('subdir/subdir2')
        const testDir3 = h.dpath('subdir/subdir2/subdir3')
        const spy = h.createSpy(function unlinkDirSpy() {})

        await h.mkdir(testDir)
        await h.mkdir(testDir2)
        await h.mkdir(testDir3)
        await h.delay(300)

        watcher.on(EV.UNLINK_DIR, spy)

        await h.rmr(testDir2)
        await h.waitFor([[spy, 2]])

        t.ok(h.calledWith(spy, [testDir2]))
        t.ok(h.calledWith(spy, [testDir3]))
        t.is(!spy.calls[0][1], true) // no stats
        t.ok(rawSpy.called)
        t.is(spy.callCount, 2)
      })
    }
  )

  s.test(
    title('watch a directory', 'should emit `unlink` and `add` events when a file is renamed'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher, rawSpy }) => {
        const unlinkSpy = h.createSpy(function unlink() {})
        const addSpy = h.createSpy(function add() {})
        const testPath = h.dpath('change.txt')
        const newPath = h.dpath('moved.txt')
        watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD, addSpy)
        t.is(unlinkSpy.called, false)
        t.is(addSpy.called, false)

        await h.delay()
        await rename(testPath, newPath)
        await h.waitFor([unlinkSpy, addSpy])
        t.ok(h.calledWith(unlinkSpy, [testPath]))
        t.is(!unlinkSpy.calls[0][1], true) // no stats
        t.is(addSpy.callCount, 1)
        t.ok(h.calledWith(addSpy, [newPath]))
        t.ok(addSpy.calls[0][1]) // stats
        t.ok(rawSpy.called)
        if (!macosFswatch) t.is(unlinkSpy.callCount, 1)
      })
    }
  )

  s.test(
    title(
      'watch a directory',
      'should emit `add`, not `change`, when previously deleted file is re-added'
    ),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher }) => {
        const unlinkSpy = h.createSpy(function unlink() {})
        const addSpy = h.createSpy(function add() {})
        const changeSpy = h.createSpy(function change() {})
        const testPath = h.dpath('add.txt')
        watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD, addSpy).on(EV.CHANGE, changeSpy)
        await write(testPath, 'hello')
        await h.waitFor([[addSpy, 1, [testPath]]])
        t.is(unlinkSpy.called, false)
        t.is(h.calledWith(changeSpy, [testPath]), false)
        await unlink(testPath)
        await h.waitFor([[unlinkSpy, 1, [testPath]]])
        t.ok(h.calledWith(unlinkSpy, [testPath]))

        await h.delay(100)
        await write(testPath, h.time())
        await h.waitFor([[addSpy, 2, [testPath]]])
        t.ok(h.calledWith(addSpy, [testPath]))
        t.is(h.calledWith(changeSpy, [testPath]), false)
        t.is(addSpy.callCount, 2)
      })
    }
  )

  s.test(
    title('watch a directory', 'should not emit `unlink` for previously moved files'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher }) => {
        const unlinkSpy = h.createSpy(function unlink() {})
        const testPath = h.dpath('change.txt')
        const newPath1 = h.dpath('moved.txt')
        const newPath2 = h.dpath('moved-again.txt')
        watcher.on(EV.UNLINK, unlinkSpy)
        await rename(testPath, newPath1)

        await h.delay(300)
        await rename(newPath1, newPath2)
        await h.waitFor([[unlinkSpy, 1, [newPath1]]])
        t.is(h.getCallsWith(unlinkSpy, [testPath]).length, 1)
        t.is(h.getCallsWith(unlinkSpy, [newPath1]).length, 1)
        t.is(h.getCallsWith(unlinkSpy, [newPath2]).length, 0)
      })
    }
  )

  s.test(
    title('watch a directory', 'should survive ENOENT for missing subdirectories'),
    async (t, h) => {
      const options = clean(h)
      await watchDirectory(t, h, options, ({ watcher }) => {
        const testDir = h.dpath('notadir')
        watcher.add(testDir)
      })
    }
  )

  s.test(
    title('watch a directory', 'should notice when a file appears in a new directory'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher, rawSpy }) => {
        const testDir = h.dpath('subdir')
        const testPath = h.dpath('subdir/add.txt')
        const spy = h.createSpy(function addSpy() {})
        watcher.on(EV.ADD, spy)
        t.is(spy.called, false)
        await h.mkdir(testDir)
        await write(testPath, h.time())
        await h.waitFor([spy])
        t.is(spy.callCount, 1)
        t.ok(h.calledWith(spy, [testPath]))
        t.ok(spy.calls[0][1]) // stats
        t.ok(rawSpy.called)
      })
    }
  )

  s.test(
    title('watch a directory', 'should watch removed and re-added directories'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher }) => {
        const unlinkSpy = h.createSpy(function unlinkSpy() {})
        const addSpy = h.createSpy(function addSpy() {})
        const parentPath = h.dpath('subdir2')
        const subPath = h.dpath('subdir2/subsub')
        watcher.on(EV.UNLINK_DIR, unlinkSpy).on(EV.ADD_DIR, addSpy)
        await h.mkdir(parentPath)

        await h.waitFor([[addSpy, 1, [parentPath]]])
        await h.rmr(parentPath)
        await h.waitFor([[unlinkSpy, 1, [parentPath]]])
        t.ok(h.calledWith(unlinkSpy, [parentPath]))
        await h.mkdir(parentPath)

        await h.waitFor([[addSpy, 2]])
        await h.mkdir(subPath)
        await h.waitFor([[addSpy, 3]])
        t.ok(h.calledWith(addSpy, [parentPath]))
        t.ok(h.calledWith(addSpy, [subPath]))
      })
    }
  )

  s.test(
    title('watch a directory', 'should emit `unlinkDir` and `add` when dir is replaced by file'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher }) => {
        options.ignoreInitial = true
        const unlinkSpy = h.createSpy(function unlinkSpy() {})
        const addSpy = h.createSpy(function addSpy() {})
        const testPath = h.dpath('dirFile')
        await h.mkdir(testPath)
        await h.delay(300)
        watcher.on(EV.UNLINK_DIR, unlinkSpy).on(EV.ADD, addSpy)

        await h.rmr(testPath)
        await h.waitFor([unlinkSpy])

        await write(testPath, 'file content')
        await h.waitFor([addSpy])

        t.ok(h.calledWith(unlinkSpy, [testPath]))
        t.ok(h.calledWith(addSpy, [testPath]))
      })
    }
  )

  s.test(
    title('watch a directory', 'should emit `unlink` and `addDir` when file is replaced by dir'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchDirectory(t, h, options, async ({ watcher }) => {
        options.ignoreInitial = true
        const unlinkSpy = h.createSpy(function unlinkSpy() {})
        const addSpy = h.createSpy(function addSpy() {})
        const testPath = h.dpath('fileDir')
        await write(testPath, 'file content')
        watcher.on(EV.UNLINK, unlinkSpy).on(EV.ADD_DIR, addSpy)

        await h.delay(300)
        await unlink(testPath)
        await h.delay(300)
        await h.mkdir(testPath)

        await h.waitFor([addSpy, unlinkSpy])
        t.ok(h.calledWith(unlinkSpy, [testPath]))
        t.ok(h.calledWith(addSpy, [testPath]))
      })
    }
  )

  // ------------------------------------------------------------------------------------------
  // watch individual files

  s.test(
    title('watch individual files', 'should emit `ready` when three files were added'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const readySpy = h.createSpy(function readySpy() {})
      const watcher = h.cwatch(h.currentDir, options).on(EV.READY, readySpy)
      const path1 = h.dpath('add1.txt')
      const path2 = h.dpath('add2.txt')
      const path3 = h.dpath('add3.txt')

      watcher.add(path1)
      watcher.add(path2)
      watcher.add(path3)

      await h.waitForWatcher(watcher)
      // callCount is 1 on macOS, 4 on Ubuntu
      t.ok(readySpy.callCount >= 1)
    }
  )

  s.test(title('watch individual files', 'should detect changes'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    const testPath = h.dpath('change.txt')
    const watcher = h.cwatch(testPath, options)
    const spy = await h.aspy(watcher, EV.CHANGE)
    await write(testPath, h.time())
    await h.waitFor([spy])
    t.ok(h.alwaysCalledWith(spy, [testPath]))
  })

  s.test(title('watch individual files', 'should detect unlinks'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    const testPath = h.dpath('unlink.txt')
    const watcher = h.cwatch(testPath, options)
    const spy = await h.aspy(watcher, EV.UNLINK)

    await h.delay()
    await unlink(testPath)
    await h.waitFor([spy])
    t.ok(h.calledWith(spy, [testPath]))
  })

  s.test(title('watch individual files', 'should detect unlink and re-add'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    options.ignoreInitial = true
    const unlinkSpy = h.createSpy(function unlinkSpy() {})
    const addSpy = h.createSpy(function addSpy() {})
    const testPath = h.dpath('unlink.txt')
    const watcher = h.cwatch([testPath], options).on(EV.UNLINK, unlinkSpy).on(EV.ADD, addSpy)
    await h.waitForWatcher(watcher)

    await h.delay()
    await unlink(testPath)
    await h.waitFor([unlinkSpy])
    t.ok(h.calledWith(unlinkSpy, [testPath]))

    await h.delay()
    await write(testPath, 're-added')
    await h.waitFor([addSpy])
    t.ok(h.calledWith(addSpy, [testPath]))
  })

  s.test(title('watch individual files', 'should ignore unwatched siblings'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    const testPath = h.dpath('add.txt')
    const siblingPath = h.dpath('change.txt')
    const watcher = h.cwatch(testPath, options)
    const spy = await h.aspy(watcher, EV.ALL)

    await h.delay()
    await write(siblingPath, h.time())
    await write(testPath, h.time())
    await h.waitFor([[spy, 1, [EV.ADD, testPath]]])
    t.ok(h.calledWith(spy, [EV.ADD, testPath]))
    t.ok(
      spy.calls.every((call) => call[1] === testPath),
      JSON.stringify(spy.calls.map((call) => call.slice(0, 2)))
    )
  })

  s.test(title('watch individual files', 'should detect safe-edit'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    const testPath = h.dpath('change.txt')
    const safePath = h.dpath('tmp.txt')
    await write(testPath, h.time())
    const watcher = h.cwatch(testPath, options)
    const spy = await h.aspy(watcher, EV.ALL)

    await h.delay()
    await write(safePath, h.time())
    await rename(safePath, testPath)
    await h.delay(300)
    await write(safePath, h.time())
    await rename(safePath, testPath)
    await h.delay(300)
    await write(safePath, h.time())
    await rename(safePath, testPath)
    await h.delay(300)
    await h.waitFor([spy])
    t.is(h.getCallsWith(spy, [EV.CHANGE, testPath]).length, 3)
  })

  // PR 682 is failing: upstream registers this block with describe.skip.
  const gh682 = (name) =>
    title('watch individual files', 'Skipping gh-682: should detect unlink', name)

  s.test(
    gh682('should detect unlink while watching a non-existent second file in another directory'),
    { skip: true },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const testPath = h.dpath('unlink.txt')
      const otherDirPath = h.dpath('other-dir')
      const otherPath = h.dpath('other-dir/other.txt')
      await h.mkdir(otherDirPath)
      const watcher = h.cwatch([testPath, otherPath], options)
      // intentionally for this test don't write write(otherPath, 'other');
      const spy = await h.aspy(watcher, EV.UNLINK)

      await h.delay()
      await unlink(testPath)
      await h.waitFor([spy])
      t.ok(h.calledWith(spy, [testPath]))
    }
  )

  s.test(
    gh682('should detect unlink and re-add while watching a second file'),
    { skip: true },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = true
      const unlinkSpy = h.createSpy(function unlinkSpy() {})
      const addSpy = h.createSpy(function addSpy() {})
      const testPath = h.dpath('unlink.txt')
      const otherPath = h.dpath('other.txt')
      await write(otherPath, 'other')
      const watcher = h
        .cwatch([testPath, otherPath], options)
        .on(EV.UNLINK, unlinkSpy)
        .on(EV.ADD, addSpy)
      await h.waitForWatcher(watcher)

      await h.delay()
      await unlink(testPath)
      await h.waitFor([unlinkSpy])

      await h.delay()
      t.ok(h.calledWith(unlinkSpy, [testPath]))

      await h.delay()
      await write(testPath, 're-added')
      await h.waitFor([addSpy])
      t.ok(h.calledWith(addSpy, [testPath]))
    }
  )

  s.test(
    gh682(
      'should detect unlink and re-add while watching a non-existent second file in another directory'
    ),
    { skip: true },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = true
      const unlinkSpy = h.createSpy(function unlinkSpy() {})
      const addSpy = h.createSpy(function addSpy() {})
      const testPath = h.dpath('unlink.txt')
      const otherDirPath = h.dpath('other-dir')
      const otherPath = h.dpath('other-dir/other.txt')
      await h.mkdir(otherDirPath)
      // intentionally for this test don't write write(otherPath, 'other');
      const watcher = h
        .cwatch([testPath, otherPath], options)
        .on(EV.UNLINK, unlinkSpy)
        .on(EV.ADD, addSpy)
      await h.waitForWatcher(watcher)

      await h.delay()
      await unlink(testPath)
      await h.waitFor([unlinkSpy])

      await h.delay()
      t.ok(h.calledWith(unlinkSpy, [testPath]))

      await h.delay()
      await write(testPath, 're-added')
      await h.waitFor([addSpy])
      t.ok(h.calledWith(addSpy, [testPath]))
    }
  )

  s.test(
    gh682(
      'should detect unlink and re-add while watching a non-existent second file in the same directory'
    ),
    { skip: true },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = true
      const unlinkSpy = h.createSpy(function unlinkSpy() {})
      const addSpy = h.createSpy(function addSpy() {})
      const testPath = h.dpath('unlink.txt')
      const otherPath = h.dpath('other.txt')
      // intentionally for this test don't write write(otherPath, 'other');
      const watcher = h
        .cwatch([testPath, otherPath], options)
        .on(EV.UNLINK, unlinkSpy)
        .on(EV.ADD, addSpy)
      await h.waitForWatcher(watcher)

      await h.delay()
      await unlink(testPath)
      await h.waitFor([unlinkSpy])

      await h.delay()
      t.ok(h.calledWith(unlinkSpy, [testPath]))

      await h.delay()
      await write(testPath, 're-added')
      await h.waitFor([addSpy])
      t.ok(h.calledWith(addSpy, [testPath]))
    }
  )

  s.test(gh682('should detect two unlinks and one re-add'), { skip: true }, async (t, h) => {
    const options = clean(h)
    const { EV } = h
    options.ignoreInitial = true
    const unlinkSpy = h.createSpy(function unlinkSpy() {})
    const addSpy = h.createSpy(function addSpy() {})
    const testPath = h.dpath('unlink.txt')
    const otherPath = h.dpath('other.txt')
    await write(otherPath, 'other')
    const watcher = h
      .cwatch([testPath, otherPath], options)
      .on(EV.UNLINK, unlinkSpy)
      .on(EV.ADD, addSpy)
    await h.waitForWatcher(watcher)

    await h.delay()
    await unlink(otherPath)

    await h.delay()
    await unlink(testPath)
    await h.waitFor([[unlinkSpy, 2]])

    await h.delay()
    t.ok(h.calledWith(unlinkSpy, [otherPath]))
    t.ok(h.calledWith(unlinkSpy, [testPath]))

    await h.delay()
    await write(testPath, 're-added')
    await h.waitFor([addSpy])
    t.ok(h.calledWith(addSpy, [testPath]))
  })

  s.test(
    gh682(
      'should detect unlink and re-add while watching a second file and a non-existent third file'
    ),
    { skip: true },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = true
      const unlinkSpy = h.createSpy(function unlinkSpy() {})
      const addSpy = h.createSpy(function addSpy() {})
      const testPath = h.dpath('unlink.txt')
      const otherPath = h.dpath('other.txt')
      const other2Path = h.dpath('other2.txt')
      await write(otherPath, 'other')
      // intentionally for this test don't write write(other2Path, 'other2');
      const watcher = h
        .cwatch([testPath, otherPath, other2Path], options)
        .on(EV.UNLINK, unlinkSpy)
        .on(EV.ADD, addSpy)
      await h.waitForWatcher(watcher)
      await h.delay()
      await unlink(testPath)

      await h.waitFor([unlinkSpy])
      await h.delay()
      t.ok(h.calledWith(unlinkSpy, [testPath]))

      await h.delay()
      await write(testPath, 're-added')
      await h.waitFor([addSpy])
      t.ok(h.calledWith(addSpy, [testPath]))
    }
  )

  // ------------------------------------------------------------------------------------------
  // renamed directory

  s.test(
    title('renamed directory', 'should emit `add` for a file in a renamed directory'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = true
      const testDir = h.dpath('subdir')
      const testPath = h.dpath('subdir/add.txt')
      const renamedDir = h.dpath('subdir-renamed')
      const expectedPath = sp.join(renamedDir, 'add.txt')
      await h.mkdir(testDir)
      await write(testPath, h.time())
      const watcher = h.cwatch(h.currentDir, options)
      const spy = await h.aspy(watcher, EV.ADD)

      await h.delay(1000)
      await rename(testDir, renamedDir)
      await h.waitFor([[spy, 1, [expectedPath]]])
      t.ok(h.calledWith(spy, [expectedPath]))
    }
  )

  // ------------------------------------------------------------------------------------------
  // watch non-existent paths

  s.test(
    title('watch non-existent paths', 'should watch non-existent file and detect add'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const testPath = h.dpath('add.txt')
      const watcher = h.cwatch(testPath, options)
      const spy = await h.aspy(watcher, EV.ADD)

      await h.delay()
      await write(testPath, h.time())
      await h.waitFor([spy])
      t.ok(h.calledWith(spy, [testPath]))
    }
  )

  s.test(
    title('watch non-existent paths', 'should watch non-existent dir and detect addDir/add'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const testDir = h.dpath('subdir')
      const testPath = h.dpath('subdir/add.txt')
      const watcher = h.cwatch(testDir, options)
      const spy = await h.aspy(watcher, EV.ALL)
      t.is(spy.called, false)

      await h.delay()
      await h.mkdir(testDir)
      await h.waitFor([[spy, 1, [EV.ADD_DIR]]])
      await write(testPath, 'hello')
      await h.waitFor([[spy, 1, [EV.ADD]]])
      t.ok(h.calledWith(spy, [EV.ADD_DIR, testDir]))
      t.ok(h.calledWith(spy, [EV.ADD, testPath]))
    }
  )

  // ------------------------------------------------------------------------------------------
  // not watch glob patterns

  s.test(
    title('not watch glob patterns', 'should not confuse glob-like filenames with globs'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const filePath = h.dpath('nota[glob].txt')
      await write(filePath, 'b')
      await h.delay()
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      t.ok(h.calledWith(spy, [EV.ADD, filePath]))

      await h.delay()
      await write(filePath, h.time())
      await h.waitFor([[spy, 1, [EV.CHANGE, filePath]]])
      t.ok(h.calledWith(spy, [EV.CHANGE, filePath]))
    }
  )

  s.test(
    title(
      'not watch glob patterns',
      'should treat glob-like directory names as literal directory names when globbing is disabled'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const filePath = h.dpath('nota[glob]/a.txt')
      const watchPath = h.dpath('nota[glob]')
      const testDir = h.dpath('nota[glob]')
      const matchingDir = h.dpath('notag')
      const matchingFile = h.dpath('notag/b.txt')
      const matchingFile2 = h.dpath('notal')
      await h.mkdir(testDir)
      await write(filePath, 'b')
      await h.mkdir(matchingDir)
      await write(matchingFile, 'c')
      await write(matchingFile2, 'd')
      const watcher = h.cwatch(watchPath, options)
      const spy = await h.aspy(watcher, EV.ALL)

      t.ok(h.calledWith(spy, [EV.ADD, filePath]))
      t.is(h.calledWith(spy, [EV.ADD_DIR, matchingDir]), false)
      t.is(h.calledWith(spy, [EV.ADD, matchingFile]), false)
      t.is(h.calledWith(spy, [EV.ADD, matchingFile2]), false)
      await h.delay()
      await write(filePath, h.time())

      await h.waitFor([[spy, 1, [EV.CHANGE, filePath]]])
      t.ok(h.calledWith(spy, [EV.CHANGE, filePath]))
    }
  )

  s.test(
    title('not watch glob patterns', 'should treat glob-like filenames as literal filenames'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const filePath = h.dpath('nota[glob]')
      // This isn't using getGlobPath because it isn't treated as a glob
      const watchPath = h.dpath('nota[glob]')
      const matchingDir = h.dpath('notag')
      const matchingFile = h.dpath('notag/a.txt')
      const matchingFile2 = h.dpath('notal')
      await write(filePath, 'b')
      await h.mkdir(matchingDir)
      await write(matchingFile, 'c')
      await write(matchingFile2, 'd')
      const watcher = h.cwatch(watchPath, options)
      const spy = await h.aspy(watcher, EV.ALL)

      t.ok(h.calledWith(spy, [EV.ADD, filePath]))
      t.is(h.calledWith(spy, [EV.ADD_DIR, matchingDir]), false)
      t.is(h.calledWith(spy, [EV.ADD, matchingFile]), false)
      t.is(h.calledWith(spy, [EV.ADD, matchingFile2]), false)
      await h.delay()
      await write(filePath, h.time())

      await h.waitFor([[spy, 1, [EV.CHANGE, filePath]]])
      t.ok(h.calledWith(spy, [EV.CHANGE, filePath]))
    }
  )

  // ------------------------------------------------------------------------------------------
  // watch symlinks (upstream registers none of these on Windows)

  s.test(
    title('watch symlinks', 'should watch symlinked dirs'),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async (linkedDir) => {
        const dirSpy = h.createSpy(function dirSpy() {})
        const addSpy = h.createSpy(function addSpy() {})
        const watcher = h.cwatch(linkedDir, options).on(EV.ADD_DIR, dirSpy).on(EV.ADD, addSpy)
        await h.waitForWatcher(watcher)

        t.ok(h.calledWith(dirSpy, [linkedDir]))
        t.ok(h.calledWith(addSpy, [sp.join(linkedDir, 'change.txt')]))
        t.ok(h.calledWith(addSpy, [sp.join(linkedDir, 'unlink.txt')]))
      })
    }
  )

  s.test(
    title('watch symlinks', 'should watch symlinked files'),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async () => {
        const changePath = h.dpath('change.txt')
        const linkPath = h.dpath('link.txt')
        await symlink(changePath, linkPath)
        const watcher = h.cwatch(linkPath, options)
        const spy = await h.aspy(watcher, EV.ALL)

        await write(changePath, h.time())
        await h.waitFor([[spy, 1, [EV.CHANGE]]])
        t.ok(h.calledWith(spy, [EV.ADD, linkPath]))
        t.ok(h.calledWith(spy, [EV.CHANGE, linkPath]))
      })
    }
  )

  s.test(
    title('watch symlinks', 'should follow symlinked files within a normal dir'),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async () => {
        const changePath = h.dpath('change.txt')
        const linkPath = h.dpath('subdir/link.txt')
        await symlink(changePath, linkPath)
        const watcher = h.cwatch(h.dpath('subdir'), options)
        const spy = await h.aspy(watcher, EV.ALL)

        await write(changePath, h.time())
        await h.waitFor([[spy, 1, [EV.CHANGE, linkPath]]])
        t.ok(h.calledWith(spy, [EV.ADD, linkPath]))
        t.ok(h.calledWith(spy, [EV.CHANGE, linkPath]))
      })
    }
  )

  s.test(
    title('watch symlinks', 'should watch paths with a symlinked parent'),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async (linkedDir) => {
        const testDir = sp.join(linkedDir, 'subdir')
        const testFile = sp.join(testDir, 'add.txt')
        const watcher = h.cwatch(testDir, options)
        const spy = await h.aspy(watcher, EV.ALL)

        t.ok(h.calledWith(spy, [EV.ADD_DIR, testDir]))
        t.ok(h.calledWith(spy, [EV.ADD, testFile]))
        await write(h.dpath('subdir/add.txt'), h.time())
        await h.waitFor([[spy, 1, [EV.CHANGE]]])
        t.ok(h.calledWith(spy, [EV.CHANGE, testFile]))
      })
    }
  )

  s.test(
    title(
      'watch symlinks',
      'should become ready without recursing indefinitely on circular symlinks'
    ),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      await watchSymlinks(h, async () => {
        await symlink(h.currentDir, h.dpath('subdir/circular'), isWindows ? 'dir' : undefined)
        const watcher = h.cwatch(h.currentDir, options)
        await h.waitForWatcher(watcher)
        t.ok(Object.keys(watcher.getWatched()).length < 10)
      })
    }
  )

  s.test(
    title('watch symlinks', 'should recognize changes following symlinked dirs'),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async (linkedDir) => {
        const linkedFilePath = sp.join(linkedDir, 'change.txt')
        const watcher = h.cwatch(linkedDir, options)
        const spy = await h.aspy(watcher, EV.CHANGE)
        await write(h.dpath('change.txt'), h.time())
        await h.waitFor([[spy, 1, [linkedFilePath]]])
        t.ok(h.calledWith(spy, [linkedFilePath]))
      })
    }
  )

  s.test(
    title('watch symlinks', 'should follow newly created symlinks'),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async () => {
        options.ignoreInitial = true
        const watcher = h.cwatch(h.currentDir, options)
        const spy = await h.aspy(watcher, EV.ALL)
        await h.delay()
        await symlink(h.dpath('subdir'), h.dpath('link'), isWindows ? 'dir' : undefined)
        await h.waitFor([
          [spy, 1, [EV.ADD, h.dpath('link/add.txt')]],
          [spy, 1, [EV.ADD_DIR, h.dpath('link')]]
        ])
        t.ok(h.calledWith(spy, [EV.ADD_DIR, h.dpath('link')]))
        t.ok(h.calledWith(spy, [EV.ADD, h.dpath('link/add.txt')]))
      })
    }
  )

  s.test(
    title('watch symlinks', 'should watch symlinks as files when followSymlinks:false'),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async (linkedDir) => {
        options.followSymlinks = false
        const watcher = h.cwatch(linkedDir, options)
        const spy = await h.aspy(watcher, EV.ALL)
        t.is(h.calledWith(spy, [EV.ADD_DIR]), false)
        t.ok(h.calledWith(spy, [EV.ADD, linkedDir]))
        t.is(spy.callCount, 1)
      })
    }
  )

  s.test(
    title(
      'watch symlinks',
      'should suppress an initial symlink and detect its unlink when followSymlinks:false'
    ),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async (linkedDir) => {
        options.followSymlinks = false
        options.ignoreInitial = true
        const watcher = h.cwatch(linkedDir, options)
        const spy = await h.aspy(watcher, EV.ALL)

        t.is(h.calledWith(spy, [EV.ADD, linkedDir]), false)
        await h.delay(100)
        await unlink(linkedDir)
        await h.waitFor([[spy, 1, [EV.UNLINK, linkedDir]]])
        t.ok(h.calledWith(spy, [EV.UNLINK, linkedDir]))
        await symlink(h.currentDir, linkedDir, isWindows ? 'dir' : undefined)
      })
    }
  )

  s.test(
    title('watch symlinks', 'should report broken symlinks when followSymlinks:false'),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async () => {
        options.followSymlinks = false
        const targetDir = h.dpath('subdir/nonexistent')
        await h.mkdir(targetDir)
        await symlink(targetDir, h.dpath('subdir/broken'), isWindows ? 'dir' : undefined)
        await h.rmr(targetDir)
        await h.delay()

        const watcher = h.cwatch(h.dpath('subdir'), options)
        const spy = await h.aspy(watcher, EV.ALL)

        t.is(spy.callCount, 3)
        t.ok(h.calledWith(spy, [EV.ADD_DIR, h.dpath('subdir')]))
        t.ok(h.calledWith(spy, [EV.ADD, h.dpath('subdir/add.txt')]))
        t.ok(h.calledWith(spy, [EV.ADD, h.dpath('subdir/broken')]))
      })
    }
  )

  s.test(
    title(
      'watch symlinks',
      'should watch symlinks within a watched dir as files when followSymlinks:false'
    ),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async () => {
        options.followSymlinks = false
        // Create symlink in linkPath
        const linkPath = h.dpath('link')
        await symlink(h.dpath('subdir'), linkPath)
        const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
        await h.delay(300)
        await h.delay(options.usePolling ? 1200 : 300)
        await write(h.dpath('subdir/add.txt'), h.time())
        await unlink(linkPath)
        await symlink(h.dpath('subdir/add.txt'), linkPath)
        await h.waitFor([[spy, 1, [EV.CHANGE, linkPath]]])
        t.is(h.calledWith(spy, [EV.ADD_DIR, linkPath]), false)
        t.is(h.calledWith(spy, [EV.ADD, h.dpath('link/add.txt')]), false)
        t.ok(h.calledWith(spy, [EV.ADD, linkPath]))
        t.ok(h.calledWith(spy, [EV.CHANGE, linkPath]))
      })
    }
  )

  s.test(
    title('watch symlinks', 'should not reuse watcher when following a symlink to elsewhere'),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async () => {
        const linkedPath = h.dpath('outside')
        const linkedFilePath = sp.join(linkedPath, 'text.txt')
        const linkPath = h.dpath('subdir/subsub')
        await h.mkdir(linkedPath)
        await write(linkedFilePath, 'b')
        await symlink(linkedPath, linkPath)
        const watcher2 = h.cwatch(h.dpath('subdir'), options)
        await h.waitForWatcher(watcher2)

        await h.delay(options.usePolling ? 900 : undefined)
        const watchedPath = h.dpath('subdir/subsub/text.txt')
        const watcher = h.cwatch(watchedPath, options)
        const spy = await h.aspy(watcher, EV.ALL)

        await h.delay()
        await write(linkedFilePath, h.time())
        await h.waitFor([[spy, 1, [EV.CHANGE]]])
        t.ok(h.calledWith(spy, [EV.CHANGE, watchedPath]))
      })
    }
  )

  s.test(
    title('watch symlinks', 'should emit ready event even when broken symlinks are encountered'),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async () => {
        const targetDir = h.dpath('subdir/nonexistent')
        await h.mkdir(targetDir)
        await symlink(targetDir, h.dpath('subdir/broken'), isWindows ? 'dir' : undefined)
        await h.rmr(targetDir)
        const readySpy = h.createSpy(function readySpy() {})
        const watcher = h.cwatch(h.dpath('subdir'), options).on(EV.READY, readySpy)
        await h.waitForWatcher(watcher)
        t.is(readySpy.callCount, 1)
      })
    }
  )

  s.test(
    title(
      'watch symlinks',
      'should emit ready event when a symlink target path passes through a file'
    ),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await watchSymlinks(h, async () => {
        options.followSymlinks = false
        // Resolving this link fails with ENOTDIR rather than the ENOENT of a
        // dangling one, because its target path descends into a regular file.
        await symlink(h.dpath('subdir/add.txt/nope'), h.dpath('subdir/notdir'))
        const readySpy = h.createSpy(function readySpy() {})
        const watcher = h.cwatch(h.dpath('subdir'), options).on(EV.READY, readySpy)
        await h.waitForWatcher(watcher)
        t.is(readySpy.callCount, 1)
      })
    }
  )

  // ------------------------------------------------------------------------------------------
  // watch arrays of paths/globs

  s.test(
    title('watch arrays of paths/globs', 'should watch all paths in an array'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const testPath = h.dpath('change.txt')
      const testDir = h.dpath('subdir')
      await h.mkdir(testDir)
      const watcher = h.cwatch([testDir, testPath], options)
      const spy = await h.aspy(watcher, EV.ALL)
      t.ok(h.calledWith(spy, [EV.ADD, testPath]))
      t.ok(h.calledWith(spy, [EV.ADD_DIR, testDir]))
      t.is(h.calledWith(spy, [EV.ADD, h.dpath('unlink.txt')]), false)
      await write(testPath, h.time())
      await h.waitFor([[spy, 1, [EV.CHANGE]]])
      t.ok(h.calledWith(spy, [EV.CHANGE, testPath]))
    }
  )

  s.test(
    title(
      'watch arrays of paths/globs',
      'should watch changes to every file in an absolute path array (#1366)'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const first = sp.resolve(h.dpath('change.txt'))
      const second = sp.resolve(h.dpath('unlink.txt'))
      t.ok(sp.isAbsolute(first))
      t.ok(sp.isAbsolute(second))
      options.ignoreInitial = true
      const watcher = h.cwatch([first, second], options)
      const spy = await h.aspy(watcher, EV.CHANGE)

      await write(first, 'first absolute change')
      await h.waitFor([[spy, 1, [first]]])
      await write(second, 'second absolute change')
      await h.waitFor([[spy, 1, [second]]])

      t.is(h.getCallsWith(spy, [first]).length, 1)
      t.is(h.getCallsWith(spy, [second]).length, 1)
    }
  )

  s.test(
    title('watch arrays of paths/globs', 'should accommodate nested arrays in input'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const testPath = h.dpath('change.txt')
      const testDir = h.dpath('subdir')
      await h.mkdir(testDir)
      const watcher = h.cwatch([[testDir], [testPath]], options)
      const spy = await h.aspy(watcher, EV.ALL)
      t.ok(h.calledWith(spy, [EV.ADD, testPath]))
      t.ok(h.calledWith(spy, [EV.ADD_DIR, testDir]))
      t.is(h.calledWith(spy, [EV.ADD, h.dpath('unlink.txt')]), false)
      await write(testPath, h.time())
      await h.waitFor([[spy, 1, [EV.CHANGE]]])
      t.ok(h.calledWith(spy, [EV.CHANGE, testPath]))
    }
  )

  s.test(
    title('watch arrays of paths/globs', 'should throw if provided any non-string paths'),
    async (t, h) => {
      const options = clean(h)
      // exception.all: brittle rethrows a TypeError from plain t.exception as an uncaught native.
      await t.exception.all(h.cwatch.bind(null, [[h.currentDir], /notastring/], options), {
        name: /^TypeError$/,
        message: /non-string/i
      })
    }
  )

  // ------------------------------------------------------------------------------------------
  // watch options › ignoreInitial

  s.test(
    title(
      'watch options',
      'ignoreInitial',
      'false',
      'should emit `add` events for preexisting files'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = false
      const watcher = h.cwatch(h.currentDir, options)
      const spy = await h.aspy(watcher, EV.ADD)
      t.is(spy.callCount, 2)
    }
  )

  s.test(
    title('watch options', 'ignoreInitial', 'false', 'should emit `addDir` event for watched dir'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = false
      const watcher = h.cwatch(h.currentDir, options)
      const spy = await h.aspy(watcher, EV.ADD_DIR)
      t.is(spy.callCount, 1)
      t.ok(h.calledWith(spy, [h.currentDir]))
    }
  )

  s.test(
    title(
      'watch options',
      'ignoreInitial',
      'false',
      'should emit `addDir` events for preexisting dirs'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = false
      await h.mkdir(h.dpath('subdir'))
      await h.mkdir(h.dpath('subdir/subsub'))
      const watcher = h.cwatch(h.currentDir, options)
      const spy = await h.aspy(watcher, EV.ADD_DIR)
      t.ok(h.calledWith(spy, [h.currentDir]))
      t.ok(h.calledWith(spy, [h.dpath('subdir')]))
      t.ok(h.calledWith(spy, [h.dpath('subdir/subsub')]))
      t.is(spy.calls.length, 3)
    }
  )

  s.test(
    title('watch options', 'ignoreInitial', 'true', 'should ignore initial add events'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = true
      const watcher = h.cwatch(h.currentDir, options)
      const spy = await h.aspy(watcher, EV.ADD)
      await h.delay()
      t.is(spy.called, false)
    }
  )

  s.test(
    title(
      'watch options',
      'ignoreInitial',
      'true',
      'should ignore add events on a subsequent .add()'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = true
      const watcher = h.cwatch(h.dpath('subdir'), options)
      const spy = await h.aspy(watcher, EV.ADD)
      watcher.add(h.currentDir)
      await h.delay(1000)
      t.is(spy.called, false)
    }
  )

  s.test(
    title(
      'watch options',
      'ignoreInitial',
      'true',
      'should notice when a file appears in an empty directory'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = true
      const testDir = h.dpath('subdir')
      const testPath = h.dpath('subdir/add.txt')
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ADD)
      t.is(spy.called, false)
      await h.mkdir(testDir)
      await write(testPath, h.time())
      await h.waitFor([spy])
      t.is(spy.callCount, 1)
      t.ok(h.calledWith(spy, [testPath]))
    }
  )

  s.test(
    title(
      'watch options',
      'ignoreInitial',
      'true',
      'should emit a change on a preexisting file as a change'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = true
      const testPath = h.dpath('change.txt')
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      t.is(spy.called, false)
      await write(testPath, h.time())
      await h.waitFor([[spy, 1, [EV.CHANGE, testPath]]])
      t.ok(h.calledWith(spy, [EV.CHANGE, testPath]))
      t.is(h.calledWith(spy, [EV.ADD]), false)
    }
  )

  s.test(
    title(
      'watch options',
      'ignoreInitial',
      'true',
      'should not emit for preexisting dirs when depth is 0'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.ignoreInitial = true
      options.depth = 0
      const testPath = h.dpath('add.txt')
      await h.mkdir(h.dpath('subdir'))

      await h.delay(200)
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      await write(testPath, h.time())
      await h.waitFor([spy])

      await h.delay(200)
      t.ok(h.calledWith(spy, [EV.ADD, testPath]))
      t.is(h.calledWith(spy, [EV.ADD_DIR]), false)
    }
  )

  // ------------------------------------------------------------------------------------------
  // watch options › ignored

  s.test(title('watch options', 'ignored', 'should check ignore after stating'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    options.ignored = (path, stats) => {
      if (normalizeTestPath(path) === normalizeTestPath(testDir) || !stats) return false
      return stats.isDirectory()
    }
    const testDir = h.dpath('subdir')
    await h.mkdir(testDir)
    await write(sp.join(testDir, 'add.txt'), '')
    await h.mkdir(sp.join(testDir, 'subsub'))
    await write(sp.join(testDir, 'subsub', 'ab.txt'), '')
    const watcher = h.cwatch(testDir, options)
    const spy = await h.aspy(watcher, EV.ADD)
    t.is(spy.callCount, 1)
    t.ok(h.calledWith(spy, [sp.join(testDir, 'add.txt')]))
  })

  s.test(
    title('watch options', 'ignored', 'should not choke on an ignored watch path'),
    async (t, h) => {
      const options = clean(h)
      options.ignored = () => {
        return true
      }
      await h.waitForWatcher(h.cwatch(h.currentDir, options))
    }
  )

  s.test(
    title('watch options', 'ignored', 'should ignore the contents of ignored dirs'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const testDir = h.dpath('subdir')
      const testFile = sp.join(testDir, 'add.txt')
      options.ignored = testDir
      await h.mkdir(testDir)
      await write(testFile, 'b')
      const watcher = h.cwatch(h.currentDir, options)
      const spy = await h.aspy(watcher, EV.ALL)

      await h.delay()
      await write(testFile, h.time())

      await h.delay(300)
      t.is(h.calledWith(spy, [EV.ADD_DIR, testDir]), false)
      t.is(h.calledWith(spy, [EV.ADD, testFile]), false)
      t.is(h.calledWith(spy, [EV.CHANGE, testFile]), false)
    }
  )

  // Bare: needs process.chdir, which Bare does not have.
  s.test(
    title('watch options', 'ignored', 'should ignore relative paths without explicit cwd'),
    { skip: isBare },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const testDir = h.dpath('ignored-dir')
      const testFile = sp.join(testDir, 'add.txt')
      options.ignored = 'ignored-dir'
      await h.mkdir(testDir)
      await write(testFile, 'b')
      const prevCwd = rt.cwd()
      process.chdir(h.currentDir)
      try {
        const watcher = h.cwatch(h.currentDir, options)
        const spy = await h.aspy(watcher, EV.ALL)

        await h.delay()
        await write(testFile, h.time())

        await h.delay(300)
        t.is(h.calledWith(spy, [EV.ADD_DIR, testDir]), false)
        t.is(h.calledWith(spy, [EV.ADD, testFile]), false)
        t.is(h.calledWith(spy, [EV.CHANGE, testFile]), false)
      } finally {
        process.chdir(prevCwd)
      }
    }
  )

  // Bare: needs process.chdir, which Bare does not have.
  s.test(
    title(
      'watch options',
      'ignored',
      'should ignore relative paths from a symlinked working directory'
    ),
    { skip: isWindows || isBare },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const alias = `${h.currentDir}-alias`
      const testDir = sp.join(alias, 'ignored-dir')
      const testFile = sp.join(testDir, 'add.txt')
      options.ignored = 'ignored-dir'
      await h.mkdir(h.dpath('ignored-dir'))
      await write(h.dpath('ignored-dir/add.txt'), 'b')
      await symlink(h.currentDir, alias, 'dir')
      const prevCwd = rt.cwd()
      let watcher
      process.chdir(alias)
      try {
        watcher = h.cwatch(alias, options)
        const spy = await h.aspy(watcher, EV.ALL)

        await write(testFile, h.time())
        await h.delay(300)
        t.is(h.calledWith(spy, [EV.ADD_DIR, testDir]), false)
        t.is(h.calledWith(spy, [EV.ADD, testFile]), false)
        t.is(h.calledWith(spy, [EV.CHANGE, testFile]), false)
      } finally {
        process.chdir(prevCwd)
        await watcher?.close()
        await unlink(alias)
      }
    }
  )

  s.test(
    title('watch options', 'ignored', 'should ignore contents of relative dir with cwd set'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const testDir = h.dpath('subdir')
      const testFile = sp.join(testDir, 'add.txt')
      options.ignored = 'subdir'
      options.cwd = h.currentDir
      await h.mkdir(testDir)
      await write(testFile, 'b')
      const watcher = h.cwatch(h.currentDir, options)
      const spy = await h.aspy(watcher, EV.ALL)

      await h.delay()
      await write(testFile, h.time())

      await h.delay(300)
      t.is(h.calledWith(spy, [EV.ADD_DIR, testDir]), false)
      t.is(h.calledWith(spy, [EV.ADD, testFile]), false)
      t.is(h.calledWith(spy, [EV.CHANGE, testFile]), false)
    }
  )

  s.test(title('watch options', 'ignored', 'should allow regex/fn ignores'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    options.cwd = h.currentDir
    options.ignored = /add/

    await write(h.dpath('add.txt'), 'b')
    const watcher = h.cwatch(h.currentDir, options)
    const spy = await h.aspy(watcher, EV.ALL)

    await h.delay()
    await write(h.dpath('add.txt'), h.time())
    await write(h.dpath('change.txt'), h.time())

    await h.waitFor([[spy, 1, [EV.CHANGE, 'change.txt']]])
    t.is(h.calledWith(spy, [EV.ADD, 'add.txt']), false)
    t.is(h.calledWith(spy, [EV.CHANGE, 'add.txt']), false)
    t.ok(h.calledWith(spy, [EV.ADD, 'change.txt']))
    t.ok(h.calledWith(spy, [EV.CHANGE, 'change.txt']))
  })

  // ------------------------------------------------------------------------------------------
  // watch options › depth

  s.test(title('watch options', 'depth', 'should not recurse if depth is 0'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    await depthFixture(h)
    options.depth = 0
    const watcher = h.cwatch(h.currentDir, options)
    const spy = await h.aspy(watcher, EV.ALL)
    await write(h.dpath('subdir/add.txt'), h.time())
    await h.waitFor([[spy, 4]])
    t.ok(h.calledWith(spy, [EV.ADD_DIR, h.currentDir]))
    t.ok(h.calledWith(spy, [EV.ADD_DIR, h.dpath('subdir')]))
    t.ok(h.calledWith(spy, [EV.ADD, h.dpath('change.txt')]))
    t.ok(h.calledWith(spy, [EV.ADD, h.dpath('unlink.txt')]))
    t.is(h.calledWith(spy, [EV.CHANGE, h.dpath('subdir/add.txt')]), false)
    if (!macosFswatch) {
      t.is(spy.calls.filter(([event]) => event === EV.ADD || event === EV.ADD_DIR).length, 4)
    }
  })

  s.test(title('watch options', 'depth', 'should recurse to specified depth'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    await depthFixture(h)
    options.depth = 1
    const addPath = h.dpath('subdir/add.txt')
    const changePath = h.dpath('change.txt')
    const ignoredPath = h.dpath('subdir/subsub/ab.txt')
    const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
    await h.delay()
    await write(h.dpath('change.txt'), h.time())
    await write(addPath, h.time())
    await write(ignoredPath, h.time())
    await h.waitFor([
      [spy, 1, [EV.CHANGE, addPath]],
      [spy, 1, [EV.CHANGE, changePath]]
    ])
    t.ok(h.calledWith(spy, [EV.ADD_DIR, h.dpath('subdir/subsub')]))
    t.ok(h.calledWith(spy, [EV.CHANGE, changePath]))
    t.ok(h.calledWith(spy, [EV.CHANGE, addPath]))
    t.is(h.calledWith(spy, [EV.ADD, ignoredPath]), false)
    t.is(h.calledWith(spy, [EV.CHANGE, ignoredPath]), false)
    if (!macosFswatch) {
      t.is(h.getCallsWith(spy, [EV.CHANGE, changePath]).length, 1)
      t.is(h.getCallsWith(spy, [EV.CHANGE, addPath]).length, 1)
    }
  })

  s.test(
    title('watch options', 'depth', 'should respect depth setting when following symlinks'),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await depthFixture(h)
      options.depth = 1
      await symlink(h.dpath('subdir'), h.dpath('link'), isWindows ? 'dir' : undefined)
      await h.delay()
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      t.ok(h.calledWith(spy, [EV.ADD_DIR, h.dpath('link')]))
      t.ok(h.calledWith(spy, [EV.ADD_DIR, h.dpath('link/subsub')]))
      t.ok(h.calledWith(spy, [EV.ADD, h.dpath('link/add.txt')]))
      t.is(h.calledWith(spy, [EV.ADD, h.dpath('link/subsub/ab.txt')]), false)
    }
  )

  s.test(
    title('watch options', 'depth', 'should respect depth setting when following a new symlink'),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await depthFixture(h)
      options.depth = 1
      options.ignoreInitial = true
      const linkPath = h.dpath('link')
      const dirPath = h.dpath('link/subsub')
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      await symlink(h.dpath('subdir'), linkPath, isWindows ? 'dir' : undefined)
      await h.waitFor([
        [spy, 3],
        [spy, 1, [EV.ADD_DIR, dirPath]]
      ])
      t.ok(h.calledWith(spy, [EV.ADD_DIR, linkPath]))
      t.ok(h.calledWith(spy, [EV.ADD_DIR, dirPath]))
      t.ok(h.calledWith(spy, [EV.ADD, h.dpath('link/add.txt')]))
      t.is(spy.calls.length, 3)
    }
  )

  s.test(
    title('watch options', 'depth', 'should correctly handle dir events when depth is 0'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await depthFixture(h)
      options.depth = 0
      const subdir2 = h.dpath('subdir2')
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      t.ok(h.calledWith(spy, [EV.ADD_DIR, h.currentDir]))
      t.ok(h.calledWith(spy, [EV.ADD_DIR, h.dpath('subdir')]))
      await h.mkdir(subdir2)
      await h.waitFor([[spy, 3, [EV.ADD_DIR]]])
      t.is(h.getCallsWith(spy, [EV.ADD_DIR]).length, 3)

      await h.rmr(subdir2)
      await h.waitFor([[spy, 1, [EV.UNLINK_DIR]]])
      await h.delay()
      t.ok(h.calledWith(spy, [EV.UNLINK_DIR, subdir2]))
      t.is(h.getCallsWith(spy, [EV.UNLINK_DIR]).length, 1)
    }
  )

  // ------------------------------------------------------------------------------------------
  // watch options › atomic

  // describe('atomic') beforeEach.
  function atomicOptions(options) {
    options.atomic = true
    options.ignoreInitial = true
  }

  s.test(
    title('watch options', 'atomic', 'should ignore vim/emacs/Sublime swapfiles'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      atomicOptions(options)
      const swapPaths = [h.dpath('.change.txt.swp'), h.dpath('add.txt~'), h.dpath('.subl5f4.tmp')]
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      await write(swapPaths[0], 'a') // vim
      await write(swapPaths[1], 'a') // vim/emacs
      await write(swapPaths[2], 'a') // sublime
      await h.delay(300)
      await write(swapPaths[0], 'c')
      await write(swapPaths[1], 'c')
      await write(swapPaths[2], 'c')
      await h.delay(300)
      await unlink(swapPaths[0])
      await unlink(swapPaths[1])
      await unlink(swapPaths[2])
      await h.delay(300)
      t.is(
        spy.calls.some(([, path]) => swapPaths.includes(path)),
        false
      )
    }
  )

  s.test(title('watch options', 'atomic', 'should ignore stale tilde files'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    atomicOptions(options)
    options.ignoreInitial = false
    await write(h.dpath('old.txt~'), 'a')
    await h.delay()
    const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
    t.is(h.calledWith(spy, [h.dpath('old.txt')]), false)
    t.is(h.calledWith(spy, [h.dpath('old.txt~')]), false)
  })

  // ------------------------------------------------------------------------------------------
  // watch options › cwd

  s.test(title('watch options', 'cwd', 'should emit relative paths based on cwd'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    options.cwd = h.currentDir
    const watcher = h.cwatch('.', options)
    const spy = await h.aspy(watcher, EV.ALL)
    await unlink(h.dpath('unlink.txt'))
    await write(h.dpath('change.txt'), h.time())
    await h.waitFor([
      [spy, 1, [EV.UNLINK, 'unlink.txt']],
      [spy, 1, [EV.CHANGE, 'change.txt']]
    ])
    t.ok(h.calledWith(spy, [EV.ADD, 'change.txt']))
    t.ok(h.calledWith(spy, [EV.ADD, 'unlink.txt']))
    t.ok(h.calledWith(spy, [EV.CHANGE, 'change.txt']))
    t.ok(h.calledWith(spy, [EV.UNLINK, 'unlink.txt']))
  })

  s.test(
    title('watch options', 'cwd', 'should emit `addDir` with alwaysStat for renamed directory'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.cwd = h.currentDir
      options.alwaysStat = true
      options.ignoreInitial = true
      const spy = h.createSpy()
      const testDir = h.dpath('subdir')
      const renamedDir = h.dpath('subdir-renamed')

      await h.mkdir(testDir)
      const watcher = h.cwatch('.', options)

      await new Promise((resolve) => {
        setTimeout(async () => {
          watcher.on(EV.ADD_DIR, spy)
          await rename(testDir, renamedDir)
          resolve()
        }, 1000)
      })

      await h.waitFor([spy])
      t.is(spy.callCount, 1)
      t.ok(h.calledWith(spy, ['subdir-renamed']))
      t.ok(spy.calls[0][1]) // stats
    }
  )

  s.test(
    title('watch options', 'cwd', 'should allow separate watchers to have different cwds'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      options.cwd = h.currentDir
      const options2 = {}
      Object.keys(options).forEach((key) => {
        options2[key] = options[key]
      })
      options2.cwd = h.dpath('subdir')
      const watcher = h.cwatch(h.gpath('.'), options)
      const spy1 = await h.aspy(watcher, EV.ALL)

      await h.delay()
      const watcher2 = h.cwatch(h.currentDir, options2)
      const spy2 = await h.aspy(watcher2, EV.ALL)

      await unlink(h.dpath('unlink.txt'))
      await write(h.dpath('change.txt'), h.time())
      await h.waitFor([
        [spy1, 1, [EV.CHANGE, 'change.txt']],
        [spy1, 1, [EV.UNLINK, 'unlink.txt']],
        [spy2, 1, [EV.CHANGE, sp.join('..', 'change.txt')]],
        [spy2, 1, [EV.UNLINK, sp.join('..', 'unlink.txt')]]
      ])
      t.ok(h.calledWith(spy1, [EV.CHANGE, 'change.txt']))
      t.ok(h.calledWith(spy1, [EV.UNLINK, 'unlink.txt']))
      t.ok(h.calledWith(spy2, [EV.ADD, sp.join('..', 'change.txt')]))
      t.ok(h.calledWith(spy2, [EV.ADD, sp.join('..', 'unlink.txt')]))
      t.ok(h.calledWith(spy2, [EV.CHANGE, sp.join('..', 'change.txt')]))
      t.ok(h.calledWith(spy2, [EV.UNLINK, sp.join('..', 'unlink.txt')]))
    }
  )

  s.test(title('watch options', 'cwd', 'should ignore files even with cwd'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    options.cwd = h.currentDir
    options.ignored = ['ignored-option.txt', 'ignored.txt']
    const files = ['.']
    await write(h.dpath('change.txt'), 'hello')
    await write(h.dpath('ignored.txt'), 'ignored')
    await write(h.dpath('ignored-option.txt'), 'ignored option')
    const watcher = h.cwatch(files, options)

    const spy = await h.aspy(watcher, EV.ALL)
    await write(h.dpath('ignored.txt'), h.time())
    await write(h.dpath('ignored-option.txt'), h.time())
    await unlink(h.dpath('ignored.txt'))
    await unlink(h.dpath('ignored-option.txt'))
    await h.delay()
    await write(h.dpath('change.txt'), EV.CHANGE)
    await h.waitFor([[spy, 1, [EV.CHANGE, 'change.txt']]])
    t.ok(h.calledWith(spy, [EV.ADD, 'change.txt']))
    t.is(h.calledWith(spy, [EV.ADD, 'ignored.txt']), false)
    t.is(h.calledWith(spy, [EV.ADD, 'ignored-option.txt']), false)
    t.is(h.calledWith(spy, [EV.CHANGE, 'ignored.txt']), false)
    t.is(h.calledWith(spy, [EV.CHANGE, 'ignored-option.txt']), false)
    t.is(h.calledWith(spy, [EV.UNLINK, 'ignored.txt']), false)
    t.is(h.calledWith(spy, [EV.UNLINK, 'ignored-option.txt']), false)
    t.ok(h.calledWith(spy, [EV.CHANGE, 'change.txt']))
  })

  // ------------------------------------------------------------------------------------------
  // watch options › ignorePermissionErrors

  s.test(
    title(
      'watch options',
      'ignorePermissionErrors',
      'false',
      'should attempt observation and report actual permission errors'
    ),
    { skip: isWindows },
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const filePath = await permissionFixture(h)
      options.ignorePermissionErrors = false
      const addSpy = h.createSpy()
      const watcher = h.cwatch(h.currentDir, options).on(EV.ADD, addSpy)
      const outcome = await new Promise((resolve) => {
        watcher.once(EV.ERROR, (error) => resolve(error))
        watcher.once(EV.READY, () => resolve(undefined))
      })

      if (outcome) {
        t.ok(['EACCES', 'EPERM'].includes(outcome.code || ''))
      } else {
        t.ok(h.calledWith(addSpy, [filePath]))
      }
    }
  )

  s.test(
    title(
      'watch options',
      'ignorePermissionErrors',
      'true',
      'should watch unreadable files if possible'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      const filePath = await permissionFixture(h)
      options.ignorePermissionErrors = true
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      t.ok(h.calledWith(spy, [EV.ADD, filePath]))
    }
  )

  s.test(
    title(
      'watch options',
      'ignorePermissionErrors',
      'true',
      'should not choke on non-existent files'
    ),
    async (t, h) => {
      const options = clean(h)
      await permissionFixture(h)
      options.ignorePermissionErrors = true
      const watcher = h.cwatch(h.dpath('nope.txt'), options)
      await h.waitForWatcher(watcher)
    }
  )

  // ------------------------------------------------------------------------------------------
  // watch options › awaitWriteFinish

  // describe('awaitWriteFinish') beforeEach.
  function awaitWriteFinishOptions(options) {
    options.awaitWriteFinish = { stabilityThreshold: 500 }
    options.ignoreInitial = true
  }

  s.test(
    title('watch options', 'awaitWriteFinish', 'should use default options if none given'),
    (t, h) => {
      const options = clean(h)
      awaitWriteFinishOptions(options)
      options.awaitWriteFinish = true
      const watcher = h.cwatch(h.currentDir, options)
      t.is(watcher.options.awaitWriteFinish.pollInterval, 100)
      t.is(watcher.options.awaitWriteFinish.stabilityThreshold, 2000)
    }
  )

  s.test(
    title(
      'watch options',
      'awaitWriteFinish',
      'should not emit add event before a file is fully written'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      awaitWriteFinishOptions(options)
      const testPath = h.dpath('add.txt')
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      await write(testPath, 'hello')
      await h.delay(200)
      t.is(h.calledWith(spy, [EV.ADD]), false)
    }
  )

  s.test(
    title(
      'watch options',
      'awaitWriteFinish',
      'should wait for the file to be fully written before emitting the add event'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      awaitWriteFinishOptions(options)
      const testPath = h.dpath('add.txt')
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      await write(testPath, 'hello')

      await h.delay(300)
      t.is(h.calledWith(spy, [EV.ADD, testPath]), false)
      await h.waitFor([[spy, 1, [EV.ADD, testPath]]])
      t.ok(h.calledWith(spy, [EV.ADD, testPath]))
    }
  )

  s.test(
    title('watch options', 'awaitWriteFinish', 'should emit with the final stats'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      awaitWriteFinishOptions(options)
      const testPath = h.dpath('add.txt')
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      await write(testPath, 'hello ')

      await h.delay(300)
      appendFile(testPath, 'world!')

      await h.waitFor([[spy, 1, [EV.ADD, testPath]]])
      const addCalls = h.getCallsWith(spy, [EV.ADD, testPath])
      t.is(addCalls[0][2].size, 12)
    }
  )

  s.test(
    title(
      'watch options',
      'awaitWriteFinish',
      'should not emit change event while a file has not been fully written'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      awaitWriteFinishOptions(options)
      const testPath = h.dpath('add.txt')
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      await write(testPath, 'hello')
      await h.delay(100)
      await write(testPath, 'edit')
      await h.delay(200)
      t.is(h.calledWith(spy, [EV.CHANGE, testPath]), false)
    }
  )

  s.test(
    title(
      'watch options',
      'awaitWriteFinish',
      'should not emit change event before an existing file is fully updated'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      awaitWriteFinishOptions(options)
      const testPath = h.dpath('change.txt')
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      await write(testPath, 'hello')
      await h.delay(300)
      t.is(h.calledWith(spy, [EV.CHANGE, testPath]), false)
    }
  )

  s.test(
    title(
      'watch options',
      'awaitWriteFinish',
      'should wait for an existing file to be fully updated before emitting the change event'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      awaitWriteFinishOptions(options)
      const testPath = h.dpath('change.txt')
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      write(testPath, 'hello')

      await h.delay(300)
      t.is(h.calledWith(spy, [EV.CHANGE, testPath]), false)
      await h.waitFor([[spy, 1, [EV.CHANGE, testPath]]])
      t.ok(h.calledWith(spy, [EV.CHANGE, testPath]))
    }
  )

  s.test(
    title(
      'watch options',
      'awaitWriteFinish',
      'should emit change event after the file is fully written'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      awaitWriteFinishOptions(options)
      const testPath = h.dpath('add.txt')
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      await h.delay()
      await write(testPath, 'hello')

      await h.waitFor([[spy, 1, [EV.ADD, testPath]]])
      t.ok(h.calledWith(spy, [EV.ADD, testPath]))
      await write(testPath, 'edit')
      await h.waitFor([[spy, 1, [EV.CHANGE, testPath]]])
      t.ok(h.calledWith(spy, [EV.CHANGE, testPath]))
    }
  )

  s.test(
    title(
      'watch options',
      'awaitWriteFinish',
      'should not raise any event for a file that was deleted before fully written'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      awaitWriteFinishOptions(options)
      const testPath = h.dpath('add.txt')
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      await write(testPath, 'hello')
      await h.delay(100)
      await unlink(testPath)
      await h.delay(400)
      t.alike(
        spy.calls.filter((call) => typeof call[0] === 'string' && call[1] === testPath),
        []
      )
    }
  )

  s.test(
    title('watch options', 'awaitWriteFinish', 'should be compatible with the cwd option'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      awaitWriteFinishOptions(options)
      const testPath = h.dpath('subdir/add.txt')
      const filename = sp.basename(testPath)
      options.cwd = sp.dirname(testPath)
      await h.mkdir(options.cwd)

      await h.delay(200)
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)

      await h.delay(400)
      await write(testPath, 'hello')

      await h.waitFor([[spy, 1, [EV.ADD, filename]]])
      t.ok(h.calledWith(spy, [EV.ADD, filename]))
    }
  )

  s.test(
    title('watch options', 'awaitWriteFinish', 'should still emit initial add events'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      awaitWriteFinishOptions(options)
      options.ignoreInitial = false
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      t.ok(h.calledWith(spy, [EV.ADD]))
      t.ok(h.calledWith(spy, [EV.ADD_DIR]))
    }
  )

  s.test(
    title(
      'watch options',
      'awaitWriteFinish',
      'should emit an unlink event when a file is updated and deleted just after that'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      awaitWriteFinishOptions(options)
      const testPath = h.dpath('subdir/add.txt')
      const filename = sp.basename(testPath)
      options.cwd = sp.dirname(testPath)
      await h.mkdir(options.cwd)
      await h.delay()
      await write(testPath, 'hello')
      await h.delay()
      const spy = await h.aspy(h.cwatch(h.currentDir, options), EV.ALL)
      await write(testPath, 'edit')
      await h.delay()
      await unlink(testPath)
      await h.waitFor([[spy, 1, [EV.UNLINK]]])
      t.ok(h.calledWith(spy, [EV.UNLINK, filename]))
      t.is(h.calledWith(spy, [EV.CHANGE, filename]), false)
    }
  )

  // ------------------------------------------------------------------------------------------
  // getWatched

  s.test(title('getWatched', 'should return the watched paths'), async (t, h) => {
    const options = clean(h)
    const expected = {}
    expected[sp.dirname(h.currentDir)] = [h.testId.toString()]
    expected[h.currentDir] = ['change.txt', 'unlink.txt']
    const watcher = h.cwatch(h.currentDir, options)
    await h.waitForWatcher(watcher)
    t.alike(watcher.getWatched(), expected)
  })

  s.test(
    title('getWatched', 'should set keys relative to cwd & include added paths'),
    async (t, h) => {
      const options = clean(h)
      options.cwd = h.currentDir
      const expected = {
        '.': ['change.txt', 'subdir', 'unlink.txt'],
        '..': [h.testId.toString()],
        subdir: []
      }
      await h.mkdir(h.dpath('subdir'))
      const watcher = h.cwatch(h.currentDir, options)
      await h.waitForWatcher(watcher)
      t.alike(watcher.getWatched(), expected)
    }
  )

  // ------------------------------------------------------------------------------------------
  // unwatch

  s.test(title('unwatch', 'should stop watching unwatched paths'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    await unwatchFixture(h, options)
    const watchPaths = [h.dpath('subdir'), h.dpath('change.txt')]
    const changedFile = h.dpath('change.txt')
    const watcher = h.cwatch(watchPaths, options)
    const spy = await h.aspy(watcher, EV.ALL)
    watcher.unwatch(h.dpath('subdir'))

    await h.delay()
    await write(h.dpath('subdir/add.txt'), h.time())
    await write(changedFile, h.time())
    await h.waitFor([[spy, 1, [EV.CHANGE, changedFile]]])

    await h.delay(300)
    t.ok(h.calledWith(spy, [EV.CHANGE, changedFile]))
    t.is(h.calledWith(spy, [EV.ADD]), false)
  })

  s.test(
    title('unwatch', 'should ignore unwatched paths that are a subset of watched paths'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await unwatchFixture(h, options)
      const subdirRel = sp.relative(rt.cwd(), h.dpath('subdir'))
      const unlinkFile = h.dpath('unlink.txt')
      const addFile = h.dpath('subdir/add.txt')
      const changedFile = h.dpath('change.txt')
      const watcher = h.cwatch(h.currentDir, options)
      const spy = await h.aspy(watcher, EV.ALL)

      // test with both relative and absolute paths
      watcher.unwatch([subdirRel, h.gpath('unlink.txt')])

      await h.delay()
      await unlink(unlinkFile)
      await write(addFile, h.time())
      await write(changedFile, h.time())
      await h.waitFor([[spy, 1, [EV.CHANGE, changedFile]]])

      await h.delay(300)
      t.ok(h.calledWith(spy, [EV.CHANGE, changedFile]))
      t.is(h.calledWith(spy, [EV.ADD, addFile]), false)
      t.is(h.calledWith(spy, [EV.UNLINK, unlinkFile]), false)
    }
  )

  s.test(title('unwatch', 'should unwatch relative paths'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    await unwatchFixture(h, options)
    const fixturesDir = sp.relative(rt.cwd(), h.currentDir)
    const subdir = sp.join(fixturesDir, 'subdir')
    const changeFile = sp.join(fixturesDir, 'change.txt')
    const watchPaths = [subdir, changeFile]
    const watcher = h.cwatch(watchPaths, options)
    const spy = await h.aspy(watcher, EV.ALL)

    await h.delay()
    watcher.unwatch(subdir)
    await write(h.dpath('subdir/add.txt'), h.time())
    await write(h.dpath('change.txt'), h.time())
    await h.waitFor([[spy, 1, [EV.CHANGE, changeFile]]])

    await h.delay(300)
    t.ok(h.calledWith(spy, [EV.CHANGE, changeFile]))
    t.is(h.calledWith(spy, [EV.ADD]), false)
  })

  s.test(
    title(
      'unwatch',
      'should watch paths that were unwatched and added again with another spelling'
    ),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await unwatchFixture(h, options)
      const spy = h.createSpy()
      const watchPaths = [h.dpath('change.txt')]
      const watcher = h.cwatch(watchPaths, options)
      await h.waitForWatcher(watcher)
      await h.delay()
      watcher.unwatch(sp.relative(rt.cwd(), h.dpath('change.txt')))
      await h.delay()
      watcher.on(EV.ALL, spy).add(h.dpath('change.txt'))

      await h.delay(100)
      await write(h.dpath('change.txt'), h.time())
      await h.waitFor([spy])
      t.ok(h.calledWith(spy, [EV.CHANGE, h.dpath('change.txt')]))
    }
  )

  s.test(
    title('unwatch', 'should unwatch paths that are relative to options.cwd'),
    async (t, h) => {
      const options = clean(h)
      const { EV } = h
      await unwatchFixture(h, options)
      options.cwd = h.currentDir
      const watcher = h.cwatch('.', options)
      const spy = await h.aspy(watcher, EV.ALL)
      watcher.unwatch(['subdir', h.dpath('unlink.txt')])

      await h.delay()
      await unlink(h.dpath('unlink.txt'))
      await write(h.dpath('subdir/add.txt'), h.time())
      await write(h.dpath('change.txt'), h.time())
      await h.waitFor([spy])

      await h.delay(300)
      t.ok(h.calledWith(spy, [EV.CHANGE, 'change.txt']))
      t.is(h.calledWith(spy, [EV.ADD]), false)
      t.is(h.calledWith(spy, [EV.UNLINK]), false)
    }
  )

  // ------------------------------------------------------------------------------------------
  // env variable option override (Bare: these mutate process.env, which Bare does not have)

  const usePollingEnv = (name) => title('env variable option override', 'CHOKIDAR_USEPOLLING', name)

  s.test(
    usePollingEnv('should make options.usePolling `true` when CHOKIDAR_USEPOLLING is set to true'),
    { skip: isBare },
    async (t, h) => {
      const options = clean(h)
      try {
        options.usePolling = false
        process.env.CHOKIDAR_USEPOLLING = 'true'
        const watcher = h.cwatch(h.currentDir, options)
        await h.waitForWatcher(watcher)
        t.is(watcher.options.usePolling, true)
      } finally {
        delete process.env.CHOKIDAR_USEPOLLING
      }
    }
  )

  s.test(
    usePollingEnv('should make options.usePolling `true` when CHOKIDAR_USEPOLLING is set to 1'),
    { skip: isBare },
    async (t, h) => {
      const options = clean(h)
      try {
        options.usePolling = false
        process.env.CHOKIDAR_USEPOLLING = '1'

        const watcher = h.cwatch(h.currentDir, options)
        await h.waitForWatcher(watcher)
        t.is(watcher.options.usePolling, true)
      } finally {
        delete process.env.CHOKIDAR_USEPOLLING
      }
    }
  )

  s.test(
    usePollingEnv(
      'should make options.usePolling `false` when CHOKIDAR_USEPOLLING is set to false'
    ),
    { skip: isBare },
    async (t, h) => {
      const options = clean(h)
      try {
        options.usePolling = true
        process.env.CHOKIDAR_USEPOLLING = 'false'

        const watcher = h.cwatch(h.currentDir, options)
        await h.waitForWatcher(watcher)
        t.is(watcher.options.usePolling, false)
      } finally {
        delete process.env.CHOKIDAR_USEPOLLING
      }
    }
  )

  s.test(
    usePollingEnv('should make options.usePolling `false` when CHOKIDAR_USEPOLLING is set to 0'),
    { skip: isBare },
    async (t, h) => {
      const options = clean(h)
      try {
        options.usePolling = true
        process.env.CHOKIDAR_USEPOLLING = 'false'

        const watcher = h.cwatch(h.currentDir, options)
        await h.waitForWatcher(watcher)
        t.is(watcher.options.usePolling, false)
      } finally {
        delete process.env.CHOKIDAR_USEPOLLING
      }
    }
  )

  s.test(
    usePollingEnv(
      'should not attenuate options.usePolling when CHOKIDAR_USEPOLLING is set to an arbitrary value'
    ),
    { skip: isBare },
    async (t, h) => {
      const options = clean(h)
      try {
        options.usePolling = true
        process.env.CHOKIDAR_USEPOLLING = 'foo'

        const watcher = h.cwatch(h.currentDir, options)
        await h.waitForWatcher(watcher)
        t.is(watcher.options.usePolling, true)
      } finally {
        delete process.env.CHOKIDAR_USEPOLLING
      }
    }
  )

  // Upstream guards this block with `if (options && options.usePolling)` at registration, before
  // any beforeEach has assigned `options`, so upstream never registers it: skip: true keeps that.
  s.test(
    title(
      'env variable option override',
      'CHOKIDAR_INTERVAL',
      'should make polling intervals = CHOKIDAR_INTERVAL when it is set'
    ),
    { skip: true },
    async (t, h) => {
      const options = clean(h)
      try {
        options.interval = 100
        process.env.CHOKIDAR_INTERVAL = '1500'

        const watcher = h.cwatch(h.currentDir, options)
        await h.waitForWatcher(watcher)
        t.is(watcher.options.pollingInterval, 1500)
        t.is(watcher.options.interval, 1500)
      } finally {
        delete process.env.CHOKIDAR_INTERVAL
      }
    }
  )

  // ------------------------------------------------------------------------------------------
  // reproduction of bug in issue #1040

  s.test(
    title(
      'reproduction of bug in issue #1040',
      'should detect change on symlink folders when consolidateThreshhold is reached'
    ),
    async (t, h) => {
      clean(h)
      const CURR = sp.join(h.FIXTURES_PATH, h.testId.toString())
      const fixturesPathRel = sp.join(CURR, 'test-case-1040')
      const linkPath = sp.join(fixturesPathRel, 'symlinkFolder')
      const packagesPath = sp.join(fixturesPathRel, 'packages')
      await h.mkdir(fixturesPathRel, { recursive: true })
      await h.mkdir(linkPath)
      await h.mkdir(packagesPath)

      // Init chokidar
      const watcher = h.cwatch([])

      // Add more than 10 folders to cap consolidateThreshhold
      for (let i = 0; i < 20; i += 1) {
        const folderPath = sp.join(packagesPath, `folder${i}`)
        await h.mkdir(folderPath)
        const filePath = sp.join(folderPath, `file${i}.js`)
        await write(sp.resolve(filePath), 'file content')
        const symlinkPath = sp.join(linkPath, `folder${i}`)
        await symlink(sp.resolve(folderPath), symlinkPath, isWindows ? 'dir' : undefined)
        watcher.add(sp.resolve(sp.join(symlinkPath, `file${i}.js`)))
      }

      // Wait to be sure that we have no other event than the update file
      await h.delay(300)

      const eventsWaiter = h.waitForEvents(watcher, 1)

      // Update a random generated file to fire an event
      const randomFilePath = sp.join(packagesPath, 'folder17', 'file17.js')
      await write(sp.resolve(randomFilePath), 'file content changer zeri ezhriez')

      // Wait chokidar watch
      await h.delay(300)

      const events = await eventsWaiter

      t.is(events.length, 1)
    }
  )

  // ------------------------------------------------------------------------------------------
  // reproduction of bug in issue #1024

  s.test(
    title(
      'reproduction of bug in issue #1024',
      'should detect changes to folders, even if they were deleted before'
    ),
    async (t, h) => {
      clean(h)
      const id = h.testId.toString()
      const absoluteWatchedDir = sp.join(h.FIXTURES_PATH, id, 'test')
      const relativeWatcherDir = fixturesRelative(h.FIXTURES_PATH, id, 'test')
      const watcher = h.cwatch(relativeWatcherDir, {
        persistent: true
      })
      try {
        const eventsWaiter = h.waitForEvents(watcher, 5)
        const testSubDir = sp.join(absoluteWatchedDir, 'dir')
        const testSubDirFile = sp.join(absoluteWatchedDir, 'dir', 'file')

        // Command sequence from https://github.com/paulmillr/chokidar/issues/1042.
        await h.delay()
        await h.mkdir(absoluteWatchedDir)
        await h.mkdir(testSubDir)
        // The following delay is essential otherwise the call of mkdir and rm will be equalize
        await h.delay(300)
        await h.rmr(testSubDir)
        // The following delay is essential otherwise the call of rm and mkdir will be equalize
        await h.delay(300)
        await h.mkdir(testSubDir)
        await h.delay(300)
        await write(testSubDirFile, '')
        await h.delay(300)

        const events = await eventsWaiter

        t.alike(events, [
          `[ALL] addDir: ${fixturesRelative(h.FIXTURES_PATH, id, 'test')}`,
          `[ALL] addDir: ${fixturesRelative(h.FIXTURES_PATH, id, 'test', 'dir')}`,
          `[ALL] unlinkDir: ${fixturesRelative(h.FIXTURES_PATH, id, 'test', 'dir')}`,
          `[ALL] addDir: ${fixturesRelative(h.FIXTURES_PATH, id, 'test', 'dir')}`,
          `[ALL] add: ${fixturesRelative(h.FIXTURES_PATH, id, 'test', 'dir', 'file')}`
        ])
      } finally {
        watcher.close()
      }
    }
  )

  s.test(
    title(
      'reproduction of bug in issue #1024',
      'should detect changes to symlink folders, even if they were deleted before'
    ),
    async (t, h) => {
      clean(h)
      const id = h.testId.toString()
      const relativeWatcherDir = fixturesRelative(h.FIXTURES_PATH, id, 'test')
      const linkedRelativeWatcherDir = fixturesRelative(h.FIXTURES_PATH, id, 'test-link')
      await symlink(
        sp.resolve(relativeWatcherDir),
        linkedRelativeWatcherDir,
        isWindows ? 'dir' : undefined
      )
      await h.delay()
      const watcher = h.cwatch(linkedRelativeWatcherDir, {
        persistent: true
      })
      try {
        const eventsWaiter = h.waitForEvents(watcher, 5)
        const testSubDir = sp.join(relativeWatcherDir, 'dir')
        const testSubDirFile = sp.join(relativeWatcherDir, 'dir', 'file')

        // Command sequence from https://github.com/paulmillr/chokidar/issues/1042.
        await h.delay()
        await h.mkdir(relativeWatcherDir)
        await h.mkdir(testSubDir)
        // The following delay is essential otherwise the call of mkdir and rm will be equalize
        await h.delay(300)
        await h.rmr(testSubDir)
        // The following delay is essential otherwise the call of rm and mkdir will be equalize
        await h.delay(300)
        await h.mkdir(testSubDir)
        await h.delay(300)
        await write(testSubDirFile, '')
        await h.delay(300)

        const events = await eventsWaiter

        t.alike(events, [
          `[ALL] addDir: ${fixturesRelative(h.FIXTURES_PATH, id, 'test-link')}`,
          `[ALL] addDir: ${fixturesRelative(h.FIXTURES_PATH, id, 'test-link', 'dir')}`,
          `[ALL] unlinkDir: ${fixturesRelative(h.FIXTURES_PATH, id, 'test-link', 'dir')}`,
          `[ALL] addDir: ${fixturesRelative(h.FIXTURES_PATH, id, 'test-link', 'dir')}`,
          `[ALL] add: ${fixturesRelative(h.FIXTURES_PATH, id, 'test-link', 'dir', 'file')}`
        ])
      } finally {
        watcher.close()
      }
    }
  )

  // ------------------------------------------------------------------------------------------

  s.test(title('should close the fs.watch handle of a deleted watched directory'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    const id = h.testId.toString()
    const watchedDir = sp.join(h.FIXTURES_PATH, id, 'to-delete')
    await h.mkdir(watchedDir, { recursive: true })
    await write(sp.join(watchedDir, 'a.txt'), 'a')
    await h.delay()

    const watcher = new h.chokidar.FSWatcher(options)
    watcher.add(watchedDir)
    h.WATCHERS.push(watcher)

    await h.waitForWatcher(watcher)

    const closers = h.internals(watcher).closers
    const dirHasCloser = () =>
      [...closers.keys()].some((key) => sp.resolve(key) === sp.resolve(watchedDir))

    // Sanity check: the watched directory has a registered fs.watch closer.
    t.ok(dirHasCloser(), 'expected a closer to be registered for the watched directory')

    const unlinkDirSpy = h.createSpy(function unlinkDirSpy() {})
    watcher.on(EV.UNLINK_DIR, unlinkDirSpy)

    await h.rmr(watchedDir)
    await h.waitFor([[unlinkDirSpy, 1, [watchedDir]]])

    // The closer must have been invoked and removed; otherwise the underlying
    // fs.watch handle is leaked and keeps firing events on the deleted path.
    t.ok(!dirHasCloser(), 'fs.watch handle of the deleted watched directory was leaked')
  })

  // ------------------------------------------------------------------------------------------
  // close

  s.test(
    title('close', 'should reuse a live subscription when a directory is added repeatedly'),
    async (t, h) => {
      const options = clean(h)
      const watcher = h.cwatch(h.currentDir, options)
      watcher.add(h.currentDir)
      await h.waitForWatcher(watcher)
      const key = h.internals(watcher).logicalKey(h.currentDir)
      t.is(h.internals(watcher).closers.get(key)?.length, 1)

      watcher.add(h.currentDir)
      await h.delay(100)
      t.is(h.internals(watcher).closers.get(key)?.length, 1)
    }
  )

  s.test(title('close', 'should ignore further events on close'), async (t, h) => {
    const options = clean(h)
    const { EV } = h
    const spy = h.createSpy()
    const watcher = h.cwatch(h.currentDir, options)
    await h.waitForWatcher(watcher)

    watcher.on(EV.ALL, spy)
    await watcher.close()

    await write(h.dpath('add.txt'), h.time())
    await write(h.dpath('add.txt'), 'hello')
    await h.delay(300)
    await unlink(h.dpath('add.txt'))

    t.is(spy.called, false)
  })

  s.test(
    title('close', 'should not ignore further events on close with existing watchers'),
    async (t, h) => {
      clean(h)
      const { EV } = h
      const spy = h.createSpy()
      const watcher1 = h.cwatch(h.currentDir)
      const watcher2 = h.cwatch(h.currentDir)
      await Promise.all([h.waitForWatcher(watcher1), h.waitForWatcher(watcher2)])

      // The EV_ADD event should be called on the second watcher even if the first watcher is closed
      watcher2.on(EV.ADD, spy)
      await watcher1.close()

      await write(h.dpath('add.txt'), 'hello')
      // Ensures EV_ADD is called. Immediately removing the file causes it to be skipped
      await h.delay(200)
      await unlink(h.dpath('add.txt'))

      t.ok(spy.calls.some((call) => call[0].includes('add.txt')))
    }
  )

  // Bare: spawns a Node child process through child_process.
  s.test(
    title('close', 'should not prevent the process from exiting'),
    { skip: isBare },
    async (t, h) => {
      clean(h)
      const { pathToFileURL } = require('url')
      function rmSlashes(str) {
        return str.replace(/\\/g, '\\\\')
      }
      // The child imports the module under test: the oracle build, or this package's entry.
      const entry =
        h.source === 'oracle'
          ? sp.join(rt.env('CHOKIBARE_ORACLE'), 'index.js')
          : sp.join(__dirname, '..', 'index.js')
      const chokidarPath = rmSlashes(pathToFileURL(entry).href)

      const scriptFile = h.dpath('script.js')
      const completionFile = h.dpath('child-closed.txt')
      const scriptContent = `
      import * as chokidar from "${chokidarPath}";
      import { writeFile } from "node:fs/promises";
      const watcher = chokidar.watch("${rmSlashes(scriptFile)}");
      await new Promise((resolve, reject) => {
        watcher.once("error", reject);
        watcher.once("ready", async () => {
          await watcher.close();
          await writeFile("${rmSlashes(completionFile)}", "closed");
          resolve();
        });
      });`
      await write(scriptFile, scriptContent)
      await h.exec(`node ${scriptFile}`)
      t.is(await read(completionFile, 'utf8'), 'closed')
    }
  )

  s.test(title('close', 'should always return the same promise'), async (t, h) => {
    const options = clean(h)
    const watcher = h.cwatch(h.currentDir, options)
    const closePromise = watcher.close()
    t.ok(closePromise instanceof Promise)
    t.is(watcher.close(), closePromise)
    await closePromise
  })
}
