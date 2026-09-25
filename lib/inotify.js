// chokibare original: Linux inotify budget and per-arm verification (DV11). bare-fs discards the
// result of uv_fs_event_start() (holepunchto/bare-fs#51), so a watch armed past
// fs.inotify.max_user_watches is a handle that
// never fires and never errors. The kernel's own view of the process's watches is readable from
// /proc/self/fdinfo/<inotify fd>, one line per watch: "inotify wd:%x ino:%lx sdev:%x ...". This
// module checks that every armed directory shows up there and reports the ones that do not.
'use strict'

const fs = require('fs')
const rt = require('./bare-runtime')

// Watches held back for the rest of the user's processes; max_user_watches is a per-user count.
const RESERVE = 512
// Arms are verified in batches so an initial walk of N directories reads fdinfo O(N / batch) times.
const FLUSH_MS = 50

const FDINFO_LINE = /^inotify wd:[0-9a-f]+ ino:([0-9a-f]+) sdev:([0-9a-f]+) /gm

const state = {
  limit: -1, // lazily read; 0 = unknown or unlimited
  reserve: RESERVE,
  armed: 0, // native handles this process holds, all watchers together
  known: new Set(), // stat keys already verified (a re-watch of the same inode adds no line)
  pending: [], // { path, key, onFail } in arm order, awaiting the next flush
  before: null, // fdinfo multiset taken before the first arm of the current batch
  flushTimer: null
}

function isLinux() {
  return rt.platform === 'linux'
}

// Verification is only needed where the runtime hides the failure: Bare on Linux. Once a bare-fs
// release fixes holepunchto/bare-fs#51 (a failed start throws), gate it off by version here.
function needsVerification() {
  return rt.isBare && isLinux()
}

function readLimit() {
  if (state.limit !== -1) return state.limit
  try {
    state.limit =
      parseInt(fs.readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8'), 10) || 0
  } catch {
    state.limit = 0
  }
  return state.limit
}

// fdinfo prints the superblock's kernel dev_t, MKDEV(major, minor) = (major << 20) | minor, while
// lstat().dev is the userspace 64-bit encoding. Computed with multiplication: 0xfff << 20 overflows
// int32 in JS.
function devKey(dev) {
  const major = Math.floor(dev / 0x100) & 0xfff
  const minor = (dev & 0xff) | (Math.floor(dev / 0x1000) & 0xfff00)
  return (major * 0x100000 + minor).toString(16)
}

function statKey(stats) {
  return devKey(Number(stats.dev)) + ':' + BigInt(stats.ino).toString(16)
}

// The kernel's watch table for this process as a multiset of "sdev:ino" keys, or null when /proc
// cannot be read (then nothing can be verified and nothing is reported).
function snapshot(proc = procfs) {
  let fds
  try {
    fds = proc.readdir('/proc/self/fd')
  } catch {
    return null
  }
  const lines = new Map()
  for (const fd of fds) {
    let target
    try {
      target = proc.readlink('/proc/self/fd/' + fd)
    } catch {
      continue // the readdir's own fd is gone by now; others may close under us
    }
    if (target !== 'anon_inode:inotify') continue
    let info
    try {
      info = proc.readFile('/proc/self/fdinfo/' + fd)
    } catch {
      continue
    }
    for (const m of info.matchAll(FDINFO_LINE)) {
      const key = m[2] + ':' + m[1]
      lines.set(key, (lines.get(key) || 0) + 1)
    }
  }
  return lines
}

function total(multiset) {
  let n = 0
  for (const count of multiset.values()) n += count
  return n
}

// Decide which arms of a batch the kernel actually holds. `batch` is in arm order with `isNew`
// meaning "first arm of this inode in this process". A key found in `after` is verified. Keys that
// are never found can still be real: on btrfs fdinfo shows the superblock device and reuses inode
// numbers across subvolumes, so stat-derived keys do not match there. For those, the growth of the
// line count covers them in arm order; whatever the growth does not cover failed. Past the limit
// the dead arms are the last ones (S1), so this attributes failures to the tail of the batch.
function reconcile(batch, before, after) {
  const verified = []
  const failed = []
  const unmatched = []
  let matchedNew = 0
  for (const entry of batch) {
    if (after.has(entry.key)) {
      verified.push(entry)
      if (entry.isNew && !before.has(entry.key)) matchedNew++
    } else if (entry.isNew) {
      unmatched.push(entry)
    } else {
      verified.push(entry) // a re-watch of a known inode never adds a line
    }
  }
  const growth = Math.max(0, total(after) - total(before) - matchedNew)
  const covered = Math.min(growth, unmatched.length)
  for (let i = 0; i < unmatched.length; i++) {
    if (i < covered) verified.push(unmatched[i])
    else failed.push(unmatched[i])
  }
  return { verified, failed }
}

function enospc(path) {
  const err = new Error(`ENOSPC: inotify watch was not registered for '${path}'`)
  err.code = 'ENOSPC'
  err.path = path
  return err
}

function flush() {
  state.flushTimer = null
  const batch = state.pending
  state.pending = []
  const before = state.before || new Map()
  state.before = null
  const after = snapshot()
  if (after === null) return // /proc unreadable: cannot verify, do not guess
  // An arm closed before the flush has no line to find; it was cancelled, not dead.
  const live = batch.filter((entry) => !entry.cancelled)
  const { verified, failed } = reconcile(live, before, after)
  for (const entry of verified) state.known.add(entry.key)
  for (const entry of failed) entry.onFail(enospc(entry.path))
}

// Budget pre-check before every native arm on Linux; false means refuse (the caller reports ENOSPC).
// Cheap and optimistic (the limit is shared with every other process of the user); verify() is
// the real check.
function take() {
  if (!needsVerification()) return true // Node reports the failure itself; stay verbatim there
  const max = readLimit()
  if (max && state.armed + 1 > max - state.reserve) return false
  if (state.pending.length === 0 && state.before === null) {
    state.before = snapshot() // the kernel's table before this batch's first arm
  }
  state.armed++
  return true
}

function release() {
  if (needsVerification() && state.armed > 0) state.armed--
}

// Register an arm for verification at the next flush. onFail(error) is called with an ENOSPC
// error if the kernel does not hold the watch. Returns a cancel function for the caller to run
// when the handle closes before the flush (its line is then legitimately gone).
function verify(path, onFail) {
  if (!needsVerification()) return () => {}
  let stats
  try {
    stats = fs.lstatSync(path)
  } catch {
    return () => {} // vanished between arm and verify; the parent's re-read handles it
  }
  const key = statKey(stats)
  const isNew = !state.known.has(key) && !state.pending.some((p) => p.key === key)
  const entry = { path, key, isNew, onFail, cancelled: false }
  state.pending.push(entry)
  if (state.flushTimer === null) {
    state.flushTimer = setTimeout(flush, FLUSH_MS)
    if (state.flushTimer.unref) state.flushTimer.unref()
  }
  return () => {
    entry.cancelled = true
  }
}

function forget(path) {
  // Called on close; the key stays in `known` only while some handle may still hold it. Without
  // per-inode refcounts the safe choice is to keep it: a re-watch is then treated as "not new"
  // and never mis-attributed, at the cost of one unverifiable re-arm after a full close.
  void path
}

function facts() {
  return {
    armed: state.armed,
    limit: readLimit(),
    reserve: state.reserve,
    verified: state.known.size
  }
}

// Test seam.
function _reset({ limit, reserve } = {}) {
  if (state.flushTimer !== null) clearTimeout(state.flushTimer)
  state.limit = limit === undefined ? -1 : limit
  state.reserve = reserve === undefined ? RESERVE : reserve
  state.armed = 0
  state.known.clear()
  state.pending = []
  state.before = null
  state.flushTimer = null
}

const procfs = {
  readdir: (p) => fs.readdirSync(p),
  readlink: (p) => fs.readlinkSync(p),
  readFile: (p) => fs.readFileSync(p, 'utf8')
}

module.exports = {
  RESERVE,
  take,
  release,
  verify,
  forget,
  facts,
  needsVerification,
  devKey,
  statKey,
  snapshot,
  reconcile,
  _reset
}
