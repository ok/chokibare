const { writeFile } = require('fs/promises')
const { suite, isBare } = require('./helpers')

const s = suite()

s.test('smoke: a watched directory reports one added file, then closes', async (t, h) => {
  const { chokidar, EV } = h
  const watcher = h.cwatch(h.currentDir, { ignoreInitial: true, alwaysStat: true })
  t.ok(watcher instanceof chokidar.FSWatcher)
  const spy = h.createSpy()
  watcher.on(EV.ADD, spy)
  await h.waitForWatcher(watcher)
  await h.delay()
  const file = h.dpath('add.txt')
  await writeFile(file, h.time())
  await h.waitFor([spy])
  t.is(spy.callCount, 1)
  t.ok(h.calledWith(spy, [file]))
  t.ok(spy.calls[0][1], 'stats are passed with alwaysStat')
  t.comment(`module under test: ${h.source}${isBare ? ' (Bare)' : ' (Node)'}`)
  await watcher.close()
})

s.run()
