// Derived from chokidar src/runtime.ts @ 74adf65 (https://github.com/paulmillr/chokidar, branch v6).
// MIT License. Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker.
'use strict'

const sp = require('path') // rt: S3
const rt = require('./bare-runtime')

const platform = rt.platform // rt: S6

const isWindows = platform === 'win32'
const isMacos = platform === 'darwin'
const isLinux = platform === 'linux'
const isFreeBSD = platform === 'freebsd'
const isIBMi = rt.osType() === 'OS400' // rt: S5

function errorCode(error) {
  return error?.code
}

function classifyError(error) {
  const code = errorCode(error)
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
  if (code === 'EPERM' || code === 'EACCES') return 'permission'
  if (code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') return 'recursive-unsupported'
  return 'other'
}

function isMissingError(error) {
  return classifyError(error) === 'missing'
}
function isPermissionError(error) {
  return classifyError(error) === 'permission'
}
function isRecursiveWatchUnsupported(error) {
  return classifyError(error) === 'recursive-unsupported'
}

const systemScheduler = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => {
    if (timer) clearTimeout(timer)
  }
})

const EVENTS = {
  ALL: 'all',
  READY: 'ready',
  ADD: 'add',
  CHANGE: 'change',
  ADD_DIR: 'addDir',
  UNLINK: 'unlink',
  UNLINK_DIR: 'unlinkDir',
  RAW: 'raw',
  ERROR: 'error'
}

const BACK_SLASH_RE = /\\/g
const DOUBLE_SLASH_RE = /\/\//g
function normalizePath(path) {
  if (typeof path !== 'string') throw new TypeError('string expected')
  const unix = path.replace(BACK_SLASH_RE, '/')
  const unc = unix.startsWith('//')
  let normalized = sp.normalize(unix).replace(BACK_SLASH_RE, '/').replace(DOUBLE_SLASH_RE, '/')
  if (unc && !normalized.startsWith('//')) normalized = `/${normalized}`
  return normalized
}
function logicalPathKey(path) {
  const resolved = sp.resolve(path)
  return isWindows || !resolved.includes('\\')
    ? resolved.replace(BACK_SLASH_RE, '/')
    : normalizePath(resolved)
}
function isInsideRelativePath(relative) {
  return relative !== '..' && !relative.startsWith(`..${sp.sep}`) && !sp.isAbsolute(relative)
}
function isSameOrInside(root, candidate) {
  const relative = sp.relative(root, candidate)
  return relative === '' || isInsideRelativePath(relative)
}
function isStrictlyInside(root, candidate) {
  const relative = sp.relative(root, candidate)
  return relative !== '' && isInsideRelativePath(relative)
}
function isMatcherObject(matcher) {
  return typeof matcher === 'object' && matcher !== null && !(matcher instanceof RegExp)
}
function cloneOwnedMatcher(matcher) {
  if (matcher instanceof RegExp) return new RegExp(matcher.source, matcher.flags)
  if (isMatcherObject(matcher)) return Object.freeze({ ...matcher })
  return matcher
}
function compileMatcher(matcher) {
  if (typeof matcher === 'function') return matcher
  if (typeof matcher === 'string') return (candidate) => matcher === candidate
  if (matcher instanceof RegExp) {
    return (candidate) => {
      matcher.lastIndex = 0
      return matcher.test(candidate)
    }
  }
  if (isMatcherObject(matcher)) {
    return (candidate) =>
      matcher.path === candidate ||
      Boolean(matcher.recursive && isStrictlyInside(matcher.path, candidate))
  }
  return () => false
}
function compileMatchers(matchers) {
  const patterns = matchers.map(compileMatcher)
  return (candidate, stats) => {
    if (patterns.length === 0) return false
    const normalized = normalizePath(candidate)
    return patterns.some((pattern) => pattern(normalized, stats))
  }
}
function normalizeMatcher(matcher, cwd = rt.cwd() /* rt: S7 */) {
  if (typeof matcher === 'string') {
    return normalizePath(sp.isAbsolute(matcher) ? matcher : sp.join(cwd, matcher))
  }
  if (isMatcherObject(matcher)) {
    return {
      path: normalizePath(sp.isAbsolute(matcher.path) ? matcher.path : sp.join(cwd, matcher.path)),
      recursive: matcher.recursive
    }
  }
  return matcher
}

const REPLACER_RE = /^\.[/\\]/
/** Temporary traversal scope; replaced by the observation engine's root scope. */
class WatchHelper {
  watchPath
  followSymlinks
  recursiveRoot
  recursiveDisabled
  observationTrigger
  realpathAncestry
  pathGeneration
  context

  constructor(path, follow, context) {
    this.context = context
    this.watchPath = path.replace(REPLACER_RE, '')
    this.followSymlinks = follow
    this.realpathAncestry = new Set()
    this.pathGeneration = context.capturePathGeneration()
  }
  fork(path) {
    const helper = new WatchHelper(path, this.followSymlinks, this.context)
    helper.filterPath = (entry) => this.filterPath(entry)
    helper.filterDir = (entry) => this.filterDir(entry)
    helper.recursiveRoot = this.recursiveRoot
    helper.recursiveDisabled = this.recursiveDisabled
    helper.observationTrigger = this.observationTrigger
    helper.realpathAncestry = new Set(this.realpathAncestry)
    helper.pathGeneration = this.pathGeneration
    return helper
  }
  withObservation(trigger) {
    const helper = Object.create(this)
    helper.observationTrigger = trigger
    return helper
  }
  filterPath(entry) {
    return entry.stats?.isSymbolicLink()
      ? this.filterDir(entry)
      : this.context.isntIgnored(sp.join(this.watchPath, entry.path), entry.stats)
  }
  filterDir(entry) {
    return this.context.isntIgnored(sp.join(this.watchPath, entry.path), entry.stats)
  }
}

// rt: S16
module.exports = {
  isWindows,
  isMacos,
  isLinux,
  isFreeBSD,
  isIBMi,
  errorCode,
  classifyError,
  isMissingError,
  isPermissionError,
  isRecursiveWatchUnsupported,
  systemScheduler,
  EVENTS,
  normalizePath,
  logicalPathKey,
  isSameOrInside,
  isStrictlyInside,
  isMatcherObject,
  cloneOwnedMatcher,
  compileMatchers,
  normalizeMatcher,
  WatchHelper
}
