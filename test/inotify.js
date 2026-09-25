// lib/inotify.js pure logic: key encoding, fdinfo parsing, batch reconciliation. Runs everywhere;
// the Linux integration lives in test/enospc.js.
const test = require('brittle')
const inotify = require('../lib/inotify')

test('inotify: dev → sdev matches the kernel encoding (S1 data points)', (t) => {
  t.is(inotify.devKey(67), '43', 'overlay root 0:67')
  t.is(inotify.devKey(94), '5e', 'tmpfs 0:94')
  t.is(inotify.devKey(69), '45', 'tmpfs 0:69')
  t.is(inotify.devKey(1792), '700000', 'ext4 on /dev/loop0 7:0 → major shifted by 20')
  t.is(inotify.statKey({ dev: 67, ino: 0x17cbcc }), '43:17cbcc')
  t.is(inotify.statKey({ dev: 67n, ino: 0x17cbccn }), '43:17cbcc', 'bigint stats')
})

test('inotify: snapshot parses only the inotify fd and tolerates ENOENT per entry', (t) => {
  const fdinfo = [
    'pos:\t0',
    'flags:\t02004000',
    'mnt_id:\t17',
    'ino:\t32',
    'inotify wd:3e8 ino:17d584 sdev:43 mask:fc6 ignored_mask:0 fhandle-bytes:20 fhandle-type:f8 f_handle:00',
    'inotify wd:3e9 ino:100 sdev:47 mask:fc6 ignored_mask:0 fhandle-bytes:8 fhandle-type:4d f_handle:00',
    'inotify wd:3ea ino:100 sdev:47 mask:fc6 ignored_mask:0 fhandle-bytes:8 fhandle-type:4d f_handle:01',
    ''
  ].join('\n')
  const proc = {
    readdir: () => ['0', '1', '15', '16'],
    readlink: (p) => {
      if (p.endsWith('/15')) return 'anon_inode:inotify'
      if (p.endsWith('/16')) {
        const err = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      }
      return '/dev/null'
    },
    readFile: (p) => (p.endsWith('/15') ? fdinfo : '')
  }
  const snap = inotify.snapshot(proc)
  t.is(snap.get('43:17d584'), 1)
  t.is(snap.get('47:100'), 2, 'btrfs: two watches share one (sdev, ino)')
  t.is(snap.size, 2)
})

test('inotify: snapshot is null when /proc is unreadable', (t) => {
  const proc = {
    readdir: () => {
      throw new Error('ENOENT')
    }
  }
  t.is(inotify.snapshot(proc), null)
})

function batchOf(n, dev = 67, from = 1) {
  const batch = []
  for (let i = 0; i < n; i++) {
    const key = inotify.statKey({ dev, ino: from + i })
    batch.push({ path: '/d/' + i, key, isNew: true })
  }
  return batch
}

function lines(keys) {
  const m = new Map()
  for (const k of keys) m.set(k, (m.get(k) || 0) + 1)
  return m
}

test('inotify: every key present → all verified', (t) => {
  const batch = batchOf(5)
  const { verified, failed } = inotify.reconcile(batch, new Map(), lines(batch.map((b) => b.key)))
  t.is(verified.length, 5)
  t.is(failed.length, 0)
})

test('inotify: past the limit the dead arms are the unmatched tail', (t) => {
  const batch = batchOf(100)
  const after = lines(batch.slice(0, 40).map((b) => b.key))
  const { verified, failed } = inotify.reconcile(batch, new Map(), after)
  t.is(verified.length, 40)
  t.is(failed.length, 60)
  t.alike(
    failed.map((f) => f.path),
    batch.slice(40).map((b) => b.path)
  )
})

test('inotify: btrfs — no key matches but the count grows → verified by count', (t) => {
  const batch = batchOf(10, 77) // stat says 0:77, fdinfo says the superblock 0:71
  const after = lines(Array.from({ length: 10 }, (_, i) => '47:' + (0x100 + i).toString(16)))
  const { verified, failed } = inotify.reconcile(batch, new Map(), after)
  t.is(verified.length, 10)
  t.is(failed.length, 0)
})

test('inotify: btrfs past the limit — growth covers the head, the tail fails', (t) => {
  const batch = batchOf(10, 77)
  const after = lines(Array.from({ length: 7 }, (_, i) => '47:' + (0x100 + i).toString(16)))
  const { verified, failed } = inotify.reconcile(batch, new Map(), after)
  t.is(verified.length, 7)
  t.alike(
    failed.map((f) => f.path),
    ['/d/7', '/d/8', '/d/9']
  )
})

test('inotify: a re-watch of a known inode is never counted as new', (t) => {
  const first = batchOf(3)
  const again = { ...first[1], path: '/alias/1', isNew: false }
  const before = lines(first.map((b) => b.key))
  const after = lines(first.map((b) => b.key)) // no growth: the kernel shares the wd
  const { verified, failed } = inotify.reconcile([again], before, after)
  t.is(verified.length, 1)
  t.is(failed.length, 0)
})

test('inotify: growth already explained by matched new keys is not credited to the unmatched', (t) => {
  const batch = batchOf(4)
  // three matched (new), one unmatched; total grew by exactly 3 → the unmatched one failed
  const after = lines(batch.slice(0, 3).map((b) => b.key))
  const { verified, failed } = inotify.reconcile(batch, new Map(), after)
  t.is(verified.length, 3)
  t.alike(
    failed.map((f) => f.path),
    ['/d/3']
  )
})

test('inotify: take()/release() budget and facts()', (t) => {
  inotify._reset({ limit: inotify.RESERVE + 2 })
  const linux = require('../lib/bare-runtime').platform === 'linux'
  t.ok(inotify.take())
  t.ok(inotify.take())
  t.is(inotify.take(), !linux, 'third arm exceeds limit − reserve on Linux; elsewhere no budget')
  inotify.release()
  t.ok(inotify.take())
  t.is(inotify.facts().reserve, inotify.RESERVE)
  inotify._reset()
})
