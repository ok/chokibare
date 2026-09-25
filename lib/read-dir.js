// chokibare original: directory listing that replaces readdirp for the engine (chokidar v6 uses
// readdirp 5.0.0, a Node Readable; bare-fs has no Node streams). Same entry shape, options,
// filters, depth counting, exploration order, warn-vs-error rule and end/close sequence, on a
// plain EventEmitter. Behaviour mirrors readdirp/index.js @ 5.0.0 line for line where it matters.
'use strict'

const EventEmitter = require('events')
const { lstat, readdir, realpath, stat } = require('fs/promises')
const sp = require('path')
const rt = require('./bare-runtime')

const EntryTypes = {
  FILE_TYPE: 'files',
  DIR_TYPE: 'directories',
  FILE_DIR_TYPE: 'files_directories',
  EVERYTHING_TYPE: 'all'
}

const defaultOptions = {
  root: '.',
  fileFilter: (_entryInfo) => true,
  directoryFilter: (_entryInfo) => true,
  type: EntryTypes.FILE_TYPE,
  lstat: false,
  depth: 2147483648,
  alwaysStat: false
}
Object.freeze(defaultOptions)

const RECURSIVE_ERROR_CODE = 'READDIRP_RECURSIVE_ERROR'
const NORMAL_FLOW_ERRORS = new Set(['ENOENT', 'EPERM', 'EACCES', 'ELOOP', RECURSIVE_ERROR_CODE])
const ALL_TYPES = [
  EntryTypes.DIR_TYPE,
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE,
  EntryTypes.FILE_TYPE
]
const DIR_TYPES = new Set([
  EntryTypes.DIR_TYPE,
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE
])
const FILE_TYPES = new Set([
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE,
  EntryTypes.FILE_TYPE
])

const isNormalFlowError = (error) => NORMAL_FLOW_ERRORS.has(error.code)

// readdirp asks Node for bigint stats on Windows (inode numbers exceed 2^53). bare-fs has no
// bigint option, so under Bare on Windows inodes are the truncated Number form.
const wantBigintFsStats = rt.platform === 'win32' && !rt.isBare

const emptyFn = (_entryInfo) => true

const normalizeFilter = (filter) => {
  if (filter === undefined) return emptyFn
  if (typeof filter === 'function') return filter
  if (typeof filter === 'string') {
    const fl = filter.trim()
    return (entry) => entry.basename === fl
  }
  if (Array.isArray(filter)) {
    const trItems = filter.map((item) => item.trim())
    return (entry) => trItems.some((f) => entry.basename === f)
  }
  return emptyFn
}

/**
 * Readdir stream, emitting `data` for each entry as it is listed, then `end` and `close`; on
 * `destroy()` only `close`; on a fatal error `error` then `close`. Listing starts on the next
 * microtask so listeners attached right after construction see every entry.
 */
class ReadDirStream extends EventEmitter {
  constructor(options = {}) {
    super()
    const opts = { ...defaultOptions, ...options }
    const { root, type } = opts
    this.destroyed = false
    this._fileFilter = normalizeFilter(opts.fileFilter)
    this._directoryFilter = normalizeFilter(opts.directoryFilter)
    const statMethod = opts.lstat ? lstat : stat
    this._stat = wantBigintFsStats ? (path) => statMethod(path, { bigint: true }) : statMethod
    this._maxDepth =
      opts.depth !== null && opts.depth !== undefined && Number.isSafeInteger(opts.depth)
        ? opts.depth
        : defaultOptions.depth
    this._wantsDir = type ? DIR_TYPES.has(type) : false
    this._wantsFile = type ? FILE_TYPES.has(type) : false
    this._wantsEverything = type === EntryTypes.EVERYTHING_TYPE
    this._root = sp.resolve(root)
    this._isDirent = !opts.alwaysStat
    this._statsProp = this._isDirent ? 'dirent' : 'stats'
    this._rdOptions = { encoding: 'utf8', withFileTypes: this._isDirent }
    // Launch with one parent, the root dir (readdir starts immediately, like readdirp).
    this.parents = [this._exploreDir(root, 1)]
    queueMicrotask(() => this._run())
  }

  destroy(error) {
    if (this.destroyed) return
    this.destroyed = true
    queueMicrotask(() => {
      if (error) this.emit('error', error)
      this.emit('close')
    })
  }

  async _run() {
    try {
      while (!this.destroyed) {
        const parent = this.parents.pop()
        if (!parent) {
          this._end()
          return
        }
        const { files, depth, path } = await parent
        if (this.destroyed) return
        if (!files) continue
        for (const dirent of files) {
          const entry = await this._formatEntry(dirent, path)
          if (!entry) continue
          if (this.destroyed) return
          const entryType = await this._getEntryType(entry)
          if (this.destroyed) return
          if (entryType === 'directory' && this._directoryFilter(entry)) {
            if (depth <= this._maxDepth) {
              this.parents.push(this._exploreDir(entry.fullPath, depth + 1))
            }
            if (this._wantsDir) this.emit('data', entry)
          } else if (
            (entryType === 'file' || this._includeAsFile(entry)) &&
            this._fileFilter(entry)
          ) {
            if (this._wantsFile) this.emit('data', entry)
          }
        }
      }
    } catch (error) {
      this.destroy(error)
    }
  }

  _end() {
    if (this.destroyed) return
    this.emit('end')
    // autoDestroy: a finished stream closes itself
    this.destroyed = true
    queueMicrotask(() => this.emit('close'))
  }

  async _exploreDir(path, depth) {
    let files
    try {
      files = await readdir(path, this._rdOptions)
    } catch (error) {
      this._onError(error)
    }
    return { files, depth, path }
  }

  async _formatEntry(dirent, path) {
    let entry
    const basename = this._isDirent ? dirent.name : dirent
    try {
      const fullPath = sp.resolve(sp.join(path, basename))
      entry = { path: sp.relative(this._root, fullPath), fullPath, basename }
      entry[this._statsProp] = this._isDirent ? dirent : await this._stat(fullPath)
    } catch (err) {
      this._onError(err)
      return
    }
    return entry
  }

  _onError(err) {
    if (isNormalFlowError(err) && !this.destroyed) {
      this.emit('warn', err)
    } else {
      this.destroy(err)
    }
  }

  async _getEntryType(entry) {
    const stats = entry[this._statsProp]
    if (stats.isFile()) return 'file'
    if (stats.isDirectory()) return 'directory'
    if (stats && stats.isSymbolicLink()) {
      const full = entry.fullPath
      try {
        const entryRealPath = await realpath(full)
        const entryRealPathStats = await lstat(entryRealPath)
        if (entryRealPathStats.isFile()) return 'file'
        if (entryRealPathStats.isDirectory()) {
          const len = entryRealPath.length
          if (full.startsWith(entryRealPath) && full.substr(len, 1) === sp.sep) {
            const recursiveError = new Error(
              `Circular symlink detected: "${full}" points to "${entryRealPath}"`
            )
            recursiveError.code = RECURSIVE_ERROR_CODE
            return this._onError(recursiveError)
          }
          return 'directory'
        }
      } catch (error) {
        this._onError(error)
        return ''
      }
    }
  }

  _includeAsFile(entry) {
    const stats = entry && entry[this._statsProp]
    return stats && this._wantsEverything && !stats.isDirectory()
  }
}

/**
 * Reads all files and directories in the given root recursively, emitting entries as they are
 * listed. Same signature and validation as readdirp(root, options).
 */
function readDir(root, options = {}) {
  let type = options.entryType || options.type
  if (type === 'both') type = EntryTypes.FILE_DIR_TYPE // backwards-compatibility
  if (type) options.type = type
  if (!root) {
    throw new Error('readdirp: root argument is required. Usage: readdirp(root, options)')
  } else if (typeof root !== 'string') {
    throw new TypeError('readdirp: root argument must be a string. Usage: readdirp(root, options)')
  } else if (type && !ALL_TYPES.includes(type)) {
    throw new Error(`readdirp: Invalid type passed. Use one of ${ALL_TYPES.join(', ')}`)
  }
  options.root = root
  return new ReadDirStream(options)
}

module.exports = { readDir, ReadDirStream, EntryTypes }
