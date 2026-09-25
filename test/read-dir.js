// lib/read-dir.js against readdirp 5.0.0 semantics, on both runtimes.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const tmp = require('test-tmp')
const { readDir } = require('../lib/read-dir')
const { isWindows } = require('./helpers')

function collect(stream) {
  const events = []
  return new Promise((resolve, reject) => {
    stream.on('data', (entry) => events.push(['data', entry]))
    stream.on('warn', (err) => events.push(['warn', err.code]))
    stream.on('error', (err) => events.push(['error', err.code || err.message]))
    stream.once('end', () => events.push(['end']))
    stream.once('close', () => {
      events.push(['close'])
      resolve(events)
    })
    setTimeout(() => reject(new Error('read-dir: no close')), 5000)
  })
}

async function fixture(t) {
  const root = await tmp(t)
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
  fs.writeFileSync(path.join(root, 'top.txt'), '1')
  fs.writeFileSync(path.join(root, 'a', 'mid.txt'), '2')
  fs.writeFileSync(path.join(root, 'a', 'b', 'deep.txt'), '3')
  return root
}

const v6Options = () => ({ type: 'all', alwaysStat: true, lstat: true, depth: 0 })

test('read-dir: depth 0 lists one level with stats, then end, then close', async (t) => {
  const root = await fixture(t)
  const events = await collect(readDir(root, v6Options()))
  const data = events.filter(([e]) => e === 'data').map(([, entry]) => entry)
  t.alike(
    data.map((e) => e.path).sort(),
    ['a', 'top.txt'],
    'root entries only, paths relative to root'
  )
  for (const entry of data) {
    t.is(entry.fullPath, path.resolve(root, entry.path))
    t.is(entry.basename, path.basename(entry.path))
    t.ok(entry.stats && typeof entry.stats.isDirectory === 'function', 'alwaysStat gives stats')
  }
  t.alike(
    events.filter(([e]) => e !== 'data').map(([e]) => e),
    ['end', 'close'],
    'end before close'
  )
})

test('read-dir: unbounded depth walks the whole tree, directories included', async (t) => {
  const root = await fixture(t)
  const events = await collect(readDir(root, { ...v6Options(), depth: undefined }))
  const paths = events
    .filter(([e]) => e === 'data')
    .map(([, entry]) => entry.path.split(path.sep).join('/'))
    .sort()
  t.alike(paths, ['a', 'a/b', 'a/b/deep.txt', 'a/mid.txt', 'top.txt'])
})

test('read-dir: depth 1 stops one level below the root', async (t) => {
  const root = await fixture(t)
  const events = await collect(readDir(root, { ...v6Options(), depth: 1 }))
  const paths = events
    .filter(([e]) => e === 'data')
    .map(([, entry]) => entry.path.split(path.sep).join('/'))
    .sort()
  t.alike(paths, ['a', 'a/b', 'a/mid.txt', 'top.txt'])
})

test('read-dir: filters prune directories and files', async (t) => {
  const root = await fixture(t)
  const events = await collect(
    readDir(root, {
      ...v6Options(),
      depth: undefined,
      directoryFilter: (entry) => entry.basename !== 'b',
      fileFilter: (entry) => entry.basename !== 'top.txt'
    })
  )
  const paths = events
    .filter(([e]) => e === 'data')
    .map(([, entry]) => entry.path.split(path.sep).join('/'))
    .sort()
  t.alike(paths, ['a', 'a/mid.txt'], 'b pruned with its subtree; top.txt filtered')
})

test('read-dir: a missing root is a warn, then end and close, never error', async (t) => {
  const root = await tmp(t)
  const events = await collect(readDir(path.join(root, 'missing'), v6Options()))
  t.alike(
    events.map(([e, x]) => (e === 'warn' ? `warn:${x}` : e)),
    ['warn:ENOENT', 'end', 'close']
  )
})

test('read-dir: destroy() closes without end and stops emitting', async (t) => {
  const root = await fixture(t)
  const stream = readDir(root, { ...v6Options(), depth: undefined })
  const seen = []
  stream.on('data', (entry) => {
    seen.push(entry.path)
    stream.destroy()
  })
  const events = await collect(stream)
  t.is(seen.length, 1, 'no data after destroy')
  t.absent(
    events.some(([e]) => e === 'end'),
    'no end after destroy'
  )
  t.is(events.filter(([e]) => e === 'close').length, 1)
  t.ok(stream.destroyed)
})

test(
  'read-dir: a symlink to a directory is reported as a directory but never descended at depth 0',
  {
    skip: isWindows
  },
  async (t) => {
    const root = await fixture(t)
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'link-to-a'))
    const events = await collect(readDir(root, v6Options()))
    const link = events.find(([e, entry]) => e === 'data' && entry.path === 'link-to-a')[1]
    t.ok(link.stats.isSymbolicLink(), 'lstat: the entry carries the link stats')
    t.absent(
      events.some(([e, entry]) => e === 'data' && entry.path.startsWith('link-to-a' + path.sep)),
      'not descended'
    )
  }
)

test('read-dir: a circular symlink is a warn, not an error', { skip: isWindows }, async (t) => {
  const root = await fixture(t)
  fs.symlinkSync(root, path.join(root, 'a', 'loop'))
  const events = await collect(readDir(root, { ...v6Options(), depth: undefined }))
  t.ok(events.some(([e, code]) => e === 'warn' && code === 'READDIRP_RECURSIVE_ERROR'))
  t.absent(events.some(([e]) => e === 'error'))
  t.ok(events.some(([e]) => e === 'end'))
})

test('read-dir: validation matches readdirp', async (t) => {
  await t.exception(() => readDir(''), /root argument is required/)
  await t.exception(() => readDir(42), /must be a string/)
  await t.exception(() => readDir('.', { type: 'bogus' }), /Invalid type/)
})
