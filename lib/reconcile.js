// Derived from chokidar src/reconcile.ts @ 74adf65 (https://github.com/paulmillr/chokidar, branch v6).
// MIT License. Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker.
'use strict'

const { realpath: fsrealpath, lstat, readlink, stat } = require('fs/promises') // rt: S2
const sp = require('path') // rt: S3
const {
  backendNow,
  isMissingObservation,
  setFsWatchListener,
  setPollingListener,
  subscribeRecursiveNative
} = require('./backend')
const { EVENTS, isMacos, isMissingError, isWindows, logicalPathKey } = require('./runtime')
const { resolveRecursiveCandidate } = require('./tree')

const EV = EVENTS
const RECURSIVE_TRIGGER_BUFFER_LIMIT = 1024

function sameMappedFileSnapshot(left, right) {
  if (left === false || right === false) return left === right
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino &&
    left.mode === right.mode
  )
}

class ReplayBuffer {
  entries = []
  overflow
  limit
  constructor(limit) {
    this.limit = limit
  }
  get overflowed() {
    return this.overflow !== undefined
  }
  push(value) {
    if (this.entries.length < this.limit && !this.overflowed) this.entries.push(value)
    else this.overflow = value
  }
  clear() {
    this.entries.length = 0
    this.overflow = undefined
  }
}

function consumeDirectoryStream(stream, onEntry) {
  const tasks = []
  stream.on('data', (entry) => {
    let result
    try {
      result = onEntry(entry)
    } catch (error) {
      result = Promise.reject(error)
    }
    if (!result) return
    tasks.push(Promise.resolve(result))
  })
  return new Promise((resolve) => {
    stream.once('end', () => resolve({ complete: true }))
    stream.once('close', () => resolve({ complete: false }))
    stream.once(EV.ERROR, (error) => resolve({ complete: false, error }))
  }).then(async ({ complete, error }) => {
    const settled = await Promise.allSettled(tasks)
    const failures = settled
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    return { complete: complete && failures.length === 0, error, failures }
  })
}

const binaryExtensions = new Set(
  `3dm 3ds 3g2 3gp 7z a aac adp afdesign afphoto afpub ai aif aiff alz ape apk appimage ar arj asf au avi bak baml bh bin bk bmp btif bz2 bzip2 cab caf cgm class cmx cpio cr2 cur dat dcm deb dex djvu dll dmg dng doc docm docx dot dotm dra ds_store dsk dts dtshd dvb dwg dxf ecelp4800 ecelp7470 ecelp9600 egg eol eot epub exe f4v fbs fh fla flac flatpak fli flv fpx fst fvt g3 gh gif graffle gz gzip h261 h263 h264 icns ico ief img ipa iso jar jpeg jpg jpgv jpm jxr key ktx lha lib lvp lz lzh lzma lzo m3u m4a m4v mar mdi mht mid midi mj2 mka mkv mmr mng mobi mov movie mp3 mp4 mp4a mpeg mpg mpga mxu nef npx numbers nupkg o odp ods odt oga ogg ogv otf ott pages pbm pcx pdb pdf pea pgm pic png pnm pot potm potx ppa ppam ppm pps ppsm ppsx ppt pptm pptx psd pya pyc pyo pyv qt rar ras raw resources rgb rip rlc rmf rmvb rpm rtf rz s3m s7z scpt sgi shar snap sil sketch slk smv snk so stl suo sub swf tar tbz tbz2 tga tgz thmx tif tiff tlz ttc ttf txz udf uvh uvi uvm uvp uvs uvu viv vob war wav wax wbmp wdp weba webm webp whl wim wm wma wmv wmx woff woff2 wrm wvx xbm xif xla xlam xls xlsb xlsm xlsx xlt xltm xltx xm xmind xpi xpm xwd xz z zip zipx`.split(
    ' '
  )
)
function isBinaryPath(filePath) {
  return binaryExtensions.has(sp.extname(filePath).slice(1).toLowerCase())
}

/** The only scanner, subscriber, and filesystem transition engine. */
class ObservationEngine {
  fsw
  reportError
  constructor(fsW) {
    this.fsw = fsW
    this.reportError = (error) => fsW.handleError(error)
  }

  /**
   * Watch a path with the owned polling scheduler or fs.watch.
   * @param path to file or dir
   * @param listener on fs change
   * @returns closer for the watcher instance
   */
  subscribePath(path, listener, initialStats, mapRelative = false, queueScope = path) {
    const opts = this.fsw.options
    const basename = sp.basename(path)
    const absolutePath = sp.resolve(path)
    const options = {
      persistent: opts.persistent
    }
    const generation = this.fsw.lifecycle.generation
    let active = true
    const trackedListener = (watchedPath, stats, trigger) => {
      if (!active || !this.fsw.lifecycle.isActive(generation)) return
      return listener(watchedPath, stats, trigger)
    }
    const publish = (trigger) => {
      void this.reconcileBackendTrigger(
        path,
        mapRelative,
        trigger,
        (candidate) =>
          trackedListener(
            candidate,
            trigger.kind === 'poll' && !isMissingObservation(trigger.current)
              ? trigger.current
              : undefined,
            trigger
          ),
        () => active && this.fsw.lifecycle.isActive(generation),
        true,
        queueScope
      )
    }

    let subscription
    if (opts.backendCapabilities.polling) {
      const enableBin = opts.pollingInterval !== opts.pollingBinaryInterval
      const pollingInterval =
        enableBin && isBinaryPath(basename) ? opts.pollingBinaryInterval : opts.pollingInterval
      subscription = setPollingListener(
        path,
        absolutePath,
        { interval: pollingInterval, persistent: opts.persistent },
        this.fsw.scheduler,
        {
          publish,
          errHandler: this.reportError,
          rawEmitter: this.fsw.emitRaw
        },
        initialStats,
        this.fsw.lifecycle.abortController.signal
      )
    } else {
      subscription = setFsWatchListener(
        path,
        absolutePath,
        options,
        {
          publish,
          errHandler: this.reportError,
          rawEmitter: this.fsw.emitRaw
        },
        this.fsw.lifecycle.abortController.signal
      )
    }
    if (!subscription) return
    return () => {
      if (!active) return
      active = false
      return subscription.close()
    }
  }

  /**
   * Watch a followed file symlink through the target's parent directory.
   * macOS also starts a one-shot exact-target fallback: FSEvents can omit the
   * first directory callback immediately after a subscription is established.
   */
  subscribeMappedFile(logicalPath, targetPath, helper, depth, useExactFallback = isMacos) {
    if (this.fsw.options.backendCapabilities.polling) return
    const targetDirectory = sp.dirname(targetPath)
    const targetKey = logicalPathKey(targetPath)
    const logicalParent = sp.dirname(logicalPath)
    const generation = this.fsw.lifecycle.generation
    let active = true
    let exactActive = useExactFallback
    let suppressDirectoryEcho = false
    let fallbackSnapshot
    let directorySubscription
    let exactSubscription
    const isActive = () =>
      active && this.fsw.lifecycle.isActive(generation) && this.isHelperActive(helper, logicalPath)
    const matchesTarget = (relativePath) => {
      if (relativePath === null) return true
      const candidate = sp.isAbsolute(relativePath)
        ? relativePath
        : sp.resolve(targetDirectory, relativePath)
      const candidateKey = logicalPathKey(candidate)
      return isWindows
        ? candidateKey.toLowerCase() === targetKey.toLowerCase()
        : candidateKey === targetKey
    }
    const retireExact = () => {
      if (!exactActive) return
      exactActive = false
      if (exactSubscription) void exactSubscription.close()
    }
    const publish = (source, trigger) => {
      if (trigger.kind !== 'native' || !matchesTarget(trigger.relativePath) || !isActive()) return
      const deduplicateAgainstFallback = source === 'directory' && suppressDirectoryEcho
      if (source === 'directory') {
        suppressDirectoryEcho = false
        retireExact()
      } else if (directorySubscription) {
        suppressDirectoryEcho = true
        retireExact()
      }
      void this.reconcileBackendTrigger(
        targetDirectory,
        true,
        trigger,
        async () => {
          if (deduplicateAgainstFallback && fallbackSnapshot !== undefined) {
            const current = await this.mappedFileSnapshot(targetPath)
            if (current !== undefined && sameMappedFileSnapshot(fallbackSnapshot, current)) return
          }
          await this.reconcileNativeTrigger(logicalParent, helper, trigger, logicalPath, depth - 1)
          if (source === 'exact') fallbackSnapshot = await this.mappedFileSnapshot(targetPath)
        },
        isActive,
        false,
        logicalPath
      )
    }
    const handlers = (source) => ({
      publish: (trigger) => publish(source, trigger),
      errHandler: (error) => {
        if (source === 'directory') directorySubscription = undefined
        else {
          exactSubscription = undefined
          exactActive = false
        }
        this.reportError(error)
      },
      rawEmitter: (event, relativePath) => {
        if ((source === 'directory' || exactActive) && matchesTarget(relativePath) && isActive()) {
          this.fsw.emitRaw(event, relativePath, { watchedPath: logicalPath })
        }
      }
    })
    directorySubscription = setFsWatchListener(
      targetDirectory,
      sp.resolve(targetDirectory),
      { persistent: this.fsw.options.persistent },
      handlers('directory'),
      this.fsw.lifecycle.abortController.signal
    )
    exactSubscription = useExactFallback
      ? setFsWatchListener(
          targetPath,
          sp.resolve(targetPath),
          { persistent: this.fsw.options.persistent },
          handlers('exact'),
          this.fsw.lifecycle.abortController.signal
        )
      : undefined
    if (!exactSubscription) exactActive = false
    const subscriptions = [directorySubscription, exactSubscription].filter(
      (subscription) => subscription !== undefined
    )
    if (subscriptions.length === 0) return
    return async () => {
      if (!active) return
      active = false
      await Promise.allSettled(subscriptions.map((subscription) => subscription.close()))
    }
  }

  async mappedFileSnapshot(path) {
    try {
      return await lstat(path)
    } catch (error) {
      if (isMissingError(error)) return false
      this.reportError(error)
      return
    }
  }

  /**
   * macOS can follow an exact symlink handle and miss the link's own removal.
   * Check only link existence so target-directory activity stays invisible when
   * followSymlinks is disabled.
   */
  watchSymlinkDeletion(path, force = false) {
    if ((!isMacos && !force) || this.fsw.options.backendCapabilities.polling) return
    const fsw = this.fsw
    const generation = fsw.lifecycle.generation
    const directory = sp.dirname(path)
    const basename = sp.basename(path)
    let active = true
    let timer

    const schedule = () => {
      timer = fsw.scheduler.setTimeout(() => {
        timer = undefined
        void (async () => {
          try {
            await lstat(path)
          } catch (error) {
            if (!active || !fsw.lifecycle.isActive(generation)) return
            if (isMissingError(error)) {
              active = false
              fsw.removePath(directory, basename)
              return
            }
            this.reportError(error)
          }
          if (active && fsw.lifecycle.isActive(generation)) schedule()
        })()
      }, fsw.options.pollingInterval)
      if (!fsw.options.persistent) timer.unref()
    }
    schedule()

    return () => {
      if (!active) return
      active = false
      fsw.scheduler.clearTimeout(timer)
      timer = undefined
    }
  }

  /**
   * Map one backend notification into a logical candidate and serialize its
   * filesystem reconciliation in the owning watcher instance.
   */
  reconcileBackendTrigger(
    scope,
    mapRelative,
    trigger,
    reconcile,
    isActive = () => true,
    coalesce = true,
    queueScope = scope
  ) {
    let candidate = scope
    if (mapRelative && trigger.kind === 'native' && trigger.relativePath !== null) {
      const resolved = resolveRecursiveCandidate(scope, trigger.relativePath)
      if (!resolved) {
        this.reportError(
          new Error(`Watcher reported a path outside its root: ${trigger.relativePath}`)
        )
        return Promise.resolve()
      }
      candidate = resolved
    }
    if (!isActive() || this.fsw.isUnwatched(candidate)) return Promise.resolve()
    const rootKey = logicalPathKey(queueScope)
    const candidateKey = logicalPathKey(candidate)
    return this.fsw.reconciliation.enqueue(
      rootKey,
      async () => {
        if (!isActive() || this.fsw.isUnwatched(candidateKey)) return
        await reconcile(candidate)
      },
      coalesce ? candidateKey : false
    )
  }

  /**
   * Watch a file and emit add event if warranted.
   * @returns closer for the watcher instance
   */
  handleFile(
    file,
    stats,
    initialAdd,
    watchResource = true,
    trigger,
    initialRecursive = false,
    retainObservation = false
  ) {
    if (this.fsw.closed) {
      return
    }
    const dirname = sp.dirname(file)
    const basename = sp.basename(file)
    const parent = this.fsw.tree.getDirectory(dirname)
    // stats is always present
    let prevStats = stats

    // if the file is already being watched, do nothing
    if (parent.has(basename)) return

    const listener = async (_path, newStats) => {
      if (!newStats || newStats.mtimeMs === 0) {
        try {
          const newStats =
            prevStats.isSymbolicLink() && !this.fsw.options.followSymlinks
              ? await lstat(file)
              : await stat(file)
          if (this.fsw.closed) return
          // Check that change event was not fired because of changed only accessTime.
          const at = newStats.atimeMs
          const mt = newStats.mtimeMs
          if (!at || at <= mt || mt !== prevStats.mtimeMs) {
            this.fsw.emitEvent(EV.CHANGE, file, newStats)
          }
          this.fsw.tree.recordObserved(file, newStats, 'change')
          prevStats = newStats
        } catch (error) {
          if (isMissingError(error)) {
            this.fsw.removePath(dirname, basename)
          } else {
            this.reportError(error)
          }
        }
        // add is about to be emitted if file not already tracked in parent
      } else if (parent.has(basename)) {
        // Check that change event was not fired because of changed only accessTime.
        const at = newStats.atimeMs
        const mt = newStats.mtimeMs
        if (!at || at <= mt || mt !== prevStats.mtimeMs) {
          this.fsw.emitEvent(EV.CHANGE, file, newStats)
        }
        this.fsw.tree.recordObserved(file, newStats, 'change')
        prevStats = newStats
      }
    }
    // kick off the watcher
    const watchesFile = watchResource && this.fsw.options.backendCapabilities.polling
    const closer = watchesFile ? this.subscribePath(file, listener, stats) : undefined
    parent.add(basename)
    this.fsw.tree.recordObserved(file, stats, 'add', trigger, initialRecursive, retainObservation)

    // emit an add event if we're supposed to
    if (!(initialAdd && this.fsw.options.ignoreInitial) && !this.fsw.isIgnored(file, stats)) {
      this.fsw.emitEvent(EV.ADD, file, stats)
    }

    return closer
  }

  /**
   * Handle symlinks encountered while reading a dir.
   * @param entry returned by readdirp
   * @param directory path of dir being read
   * @param path of this item
   * @param item basename of this item
   * @returns true if no more processing is needed for this entry.
   */
  async handleSymlink(entry, directory, path, item, initialAdd, wh) {
    if (this.fsw.closed || (wh && !this.isHelperActive(wh, path))) {
      return
    }
    const full = logicalPathKey(entry.fullPath)
    const dir = this.fsw.tree.getDirectory(directory)

    if (!this.fsw.options.followSymlinks) {
      // watch symlink directly (don't follow) and detect changes
      let linkPath
      try {
        linkPath = await readlink(path)
      } catch (error) {
        if (!isMissingError(error)) this.reportError(error)
        return true
      }

      if (this.fsw.closed || (wh && !this.isHelperActive(wh, path))) {
        return true
      }
      if (dir.has(item)) {
        if (this.fsw.tree.symlinkPaths.get(full) !== linkPath) {
          this.fsw.tree.symlinkPaths.set(full, linkPath)
          this.fsw.emitEvent(EV.CHANGE, path, entry.stats)
        }
      } else {
        dir.add(item)
        this.fsw.tree.symlinkPaths.set(full, linkPath)
        this.fsw.tree.recordObserved(
          path,
          entry.stats,
          'add',
          wh?.observationTrigger,
          initialAdd && Boolean(wh?.recursiveRoot)
        )
        if (!(initialAdd && this.fsw.options.ignoreInitial)) {
          this.fsw.emitEvent(EV.ADD, path, entry.stats)
        }
      }
      return true
    }

    // don't follow the same symlink more than once
    if (this.fsw.tree.symlinkPaths.has(full)) {
      return true
    }

    this.fsw.tree.symlinkPaths.set(full, true)
  }

  readDirectory(directory, initialAdd, wh, target, dir, depth) {
    if (!this.isHelperActive(wh, directory)) return
    // Normalize the directory name on Windows
    directory = sp.join(directory, '')

    const directoryKey = logicalPathKey(directory)
    const previous = this.fsw.tree.getDirectory(wh.watchPath)
    const current = new Set()

    const stream = this.fsw.createScanStream(directory, {
      fileFilter: (entry) => wh.filterPath(entry),
      directoryFilter: (entry) => wh.filterDir(entry)
    })
    if (!stream) return
    const scan = consumeDirectoryStream(stream, (entry) => {
      if (!this.isHelperActive(wh, directory)) return
      const stats = entry.stats
      if (!stats) return
      const item = entry.path
      let path = sp.join(directory, item)
      if (!this.isHelperActive(wh, path)) return
      current.add(item)

      const shouldAdd = item === target || (!target && !previous.has(item))
      if (target === undefined && !stats.isSymbolicLink() && !stats.isDirectory()) {
        if (!shouldAdd) return
        path = sp.join(dir, sp.relative(dir, path))
        const closer = this.handleFile(
          path,
          stats,
          initialAdd,
          !wh.recursiveRoot,
          wh.observationTrigger,
          initialAdd && Boolean(wh.recursiveRoot)
        )
        if (closer) this.fsw.addPathCloser(path, closer)
        return
      }

      return (async () => {
        if (
          stats.isSymbolicLink() &&
          (await this.handleSymlink(entry, directory, path, item, initialAdd, wh))
        ) {
          return
        }

        if (!this.isHelperActive(wh, path)) return
        // Files that present in current directory snapshot
        // but absent in previous are added to watch list and
        // emit `add` event.
        if (shouldAdd) {
          // ensure relativeness of path is preserved in case of watcher reuse
          path = sp.join(dir, sp.relative(dir, path))

          await this.addPathOnce(path, initialAdd, wh, depth + 1)
        }
      })()
    })

    return scan.then(async ({ complete, error, failures }) => {
      failures.forEach(this.reportError)

      if (error) {
        if (isMissingError(error) && this.isHelperActive(wh, directory)) {
          const affectedPath = target ? sp.join(directory, target) : directory
          let disappeared = false
          let becameNonDirectory = false
          try {
            const currentStats = target ? await lstat(affectedPath) : await stat(affectedPath)
            becameNonDirectory = !target && !currentStats.isDirectory()
          } catch (stateError) {
            if (isMissingError(stateError)) disappeared = true
            else this.reportError(stateError)
          }

          if (target) {
            if (disappeared && previous.has(target)) this.fsw.removePath(directory, target)
          } else if (
            (disappeared || becameNonDirectory) &&
            this.fsw.tree.watched.has(directoryKey)
          ) {
            this.fsw.removePath(sp.dirname(directory), sp.basename(directory), true)
            if (becameNonDirectory) {
              await this.addPathOnce(directory, false, wh, depth)
            }
          }
        } else {
          this.reportError(error)
        }
      }
      if (!complete || !this.isHelperActive(wh, directory)) {
        return
      }

      // Files that absent in current directory snapshot
      // but present in previous emit `remove` event
      // and are removed from @watched[directory].
      previous
        .getChildren()
        .filter((item) => !current.has(item))
        .forEach((item) => {
          const missingPath = sp.join(directory, item)
          if (this.isHelperActive(wh, missingPath)) this.fsw.removePath(directory, item)
        })
    })
  }

  /**
   * Populate the logical directory tree beneath one native recursive watcher.
   * Regular entries are consumed synchronously from readdirp's stat-bearing
   * stream; only symlinks need the full per-path add machinery.
   */
  scanRecursiveTree(dir, initialAdd, wh, baseDepth) {
    if (!this.isHelperActive(wh, dir)) return
    const fsw = this.fsw
    const maxDepth = fsw.options.depth
    const remainingDepth = maxDepth === undefined ? undefined : maxDepth - baseDepth
    const stream = fsw.createScanStream(dir, {
      fileFilter: (entry) => wh.filterPath(entry),
      directoryFilter: (entry) => !entry.stats?.isSymbolicLink() && wh.filterDir(entry),
      depth: remainingDepth
    })
    if (!stream) return

    return consumeDirectoryStream(stream, (entry) => {
      if (!this.isHelperActive(wh, dir)) return
      const stats = entry.stats
      if (!stats) return
      const path = sp.join(dir, entry.path)
      if (!this.isHelperActive(wh, path)) return
      const directory = sp.dirname(path)
      const item = sp.basename(path)

      if (stats.isSymbolicLink()) {
        return (async () => {
          if (await this.handleSymlink(entry, directory, path, item, initialAdd, wh)) return
          if (!this.isHelperActive(wh, path)) return
          const entryDepth = baseDepth + entry.path.split(/[/\\]/).length
          await this.addPathOnce(path, initialAdd, wh, entryDepth)
        })()
      }

      const parent = fsw.tree.getDirectory(directory)
      if (parent.has(item)) return
      parent.add(item)
      const isDirectory = stats.isDirectory()
      if (isDirectory) fsw.tree.getDirectory(path)
      fsw.tree.recordObserved(path, stats, 'add', wh.observationTrigger, initialAdd)
      if (!(initialAdd && fsw.options.ignoreInitial)) {
        fsw.emitEvent(isDirectory ? EV.ADD_DIR : EV.ADD, path, stats)
      }
    }).then((outcome) => {
      if (outcome.error) this.reportError(outcome.error)
      outcome.failures.forEach(this.reportError)
    })
  }

  isHelperActive(wh, path = wh.watchPath) {
    return this.fsw.isPathGenerationActive(path, wh.pathGeneration)
  }

  candidateDepth(root, candidate) {
    const relative = sp.relative(root, candidate)
    return relative ? relative.split(sp.sep).length : 0
  }

  candidateIgnored(root, candidate, stats) {
    const relative = sp.relative(root, candidate)
    let ancestor = root
    if (this.fsw.isIgnored(ancestor)) return true
    if (relative) {
      const parts = relative.split(sp.sep)
      for (let index = 0; index < parts.length - 1; index++) {
        ancestor = sp.join(ancestor, parts[index])
        if (this.fsw.isIgnored(ancestor)) return true
      }
    }
    return this.fsw.isIgnored(candidate, stats)
  }

  async highestMissingPath(root, candidate) {
    let missing = candidate
    let ancestor = sp.dirname(candidate)
    while (true) {
      try {
        await lstat(ancestor)
        return missing
      } catch (error) {
        if (!isMissingError(error)) {
          this.reportError(error)
          return missing
        }
      }
      missing = ancestor
      if (ancestor === root) return missing
      const parent = sp.dirname(ancestor)
      if (parent === ancestor) return missing
      ancestor = parent
    }
  }

  async reconcileNativeTrigger(root, rootHelper, trigger, candidateOverride, baseDepth = 0) {
    const fsw = this.fsw
    if (!this.isHelperActive(rootHelper, root)) return
    let localHelper
    const helper = () => (localHelper ??= rootHelper.withObservation(trigger))
    const candidate =
      candidateOverride ??
      (trigger.relativePath === null ? root : resolveRecursiveCandidate(root, trigger.relativePath))
    if (!candidate) {
      this.reportError(
        new Error(`Native watcher reported a path outside its root: ${trigger.relativePath}`)
      )
      return
    }

    const depth = baseDepth + this.candidateDepth(root, candidate)
    const maxDepth = fsw.options.depth
    if (maxDepth !== undefined && depth > maxDepth + 1) return
    if (this.candidateIgnored(root, candidate)) return

    let stats
    try {
      stats = await lstat(candidate)
    } catch (error) {
      if (!isMissingError(error)) {
        this.reportError(error)
        const ancestor = candidate === root ? root : sp.dirname(candidate)
        const ancestorDepth = Math.max(0, baseDepth + this.candidateDepth(root, ancestor))
        await this.readDirectory(
          ancestor,
          false,
          helper().fork(ancestor),
          undefined,
          ancestor,
          ancestorDepth
        )
        return
      }
      if (fsw.closed) return
      const missingPath = candidate === root ? root : await this.highestMissingPath(root, candidate)
      if (fsw.closed) return
      if (missingPath === root) {
        fsw.removePath(sp.dirname(root), sp.basename(root), true)
        return
      }
      const parentPath = sp.dirname(missingPath)
      const item = sp.basename(missingPath)
      if (fsw.tree.getDirectory(parentPath).has(item)) {
        fsw.removePath(parentPath, item)
      } else {
        await this.readDirectory(
          parentPath,
          false,
          helper().fork(parentPath),
          undefined,
          parentPath,
          Math.max(0, baseDepth + this.candidateDepth(root, parentPath))
        )
      }
      return
    }

    if (
      !this.isHelperActive(rootHelper, candidate) ||
      this.candidateIgnored(root, candidate, stats)
    ) {
      return
    }

    if (!stats.isDirectory() && !(stats.isSymbolicLink() && fsw.options.followSymlinks)) {
      const initialCreate = fsw.tree.consumeInitialCreate(
        candidate,
        stats,
        trigger,
        fsw.options.ignoreInitial
      )
      if (initialCreate !== undefined) {
        if (initialCreate) fsw.emitEvent(initialCreate, candidate, stats)
        return
      }
    }

    if (candidate === root) {
      if (stats.isDirectory()) {
        await this.readDirectory(root, false, helper(), undefined, root, baseDepth)
      }
      return
    }

    const parentPath = sp.dirname(candidate)
    const item = sp.basename(candidate)
    const parent = fsw.tree.getDirectory(parentPath)
    const tracked = parent.has(item)

    if (stats.isSymbolicLink()) {
      if (!fsw.options.followSymlinks) {
        let target = true
        try {
          target = await readlink(candidate)
        } catch {}
        if (!tracked) parent.add(item)
        fsw.tree.symlinkPaths.set(logicalPathKey(candidate), target)
        if (!tracked || !fsw.tree.isDuplicateObservation(candidate, stats, trigger)) {
          fsw.emitEvent(tracked ? EV.CHANGE : EV.ADD, candidate, stats)
        }
        if (!tracked) fsw.tree.recordObserved(candidate, stats, 'add', trigger)
        return
      }

      const logicalKey = logicalPathKey(candidate)
      const previousTarget = fsw.tree.symlinkPaths.get(logicalKey)
      let currentTarget
      try {
        currentTarget = await fsrealpath(candidate)
      } catch (error) {
        if (!isMissingError(error)) {
          this.reportError(error)
          return
        }
      }
      const targetChanged =
        tracked &&
        typeof previousTarget === 'string' &&
        (currentTarget === undefined ||
          logicalPathKey(previousTarget) !== logicalPathKey(currentTarget))
      if (targetChanged) {
        const previousKind = fsw.tree.observed.get(logicalKey)?.kind
        fsw.removePath(parentPath, item, previousKind === 'directory')
        if (!currentTarget || !this.isHelperActive(rootHelper, candidate)) return
        const linkHelper = helper().fork(candidate)
        linkHelper.recursiveRoot = undefined
        await this.addPathOnce(candidate, false, linkHelper, depth)
        return
      }
      const initialCreate = fsw.tree.consumeInitialCreate(
        candidate,
        stats,
        trigger,
        fsw.options.ignoreInitial
      )
      if (initialCreate !== undefined) {
        if (initialCreate) {
          fsw.closePath(candidate, true)
          const linkHelper = helper().fork(candidate)
          linkHelper.recursiveRoot = undefined
          await this.addPathOnce(candidate, false, linkHelper, depth)
        }
        return
      }
      if (!tracked) {
        const linkHelper = helper().fork(candidate)
        linkHelper.recursiveRoot = undefined
        await this.addPathOnce(candidate, false, linkHelper, depth)
      } else {
        fsw.emitEvent(EV.CHANGE, candidate, stats)
      }
      return
    }

    if (stats.isDirectory()) {
      const directoryHelper = helper().fork(candidate)
      const initialCreate = fsw.tree.consumeInitialCreate(
        candidate,
        stats,
        trigger,
        fsw.options.ignoreInitial
      )
      if (initialCreate !== undefined) {
        if (initialCreate) {
          fsw.closePath(candidate, true)
          await this.addPathOnce(candidate, false, directoryHelper, depth)
        }
        return
      }
      if (!tracked) {
        await this.addPathOnce(candidate, false, directoryHelper, depth)
      } else if (maxDepth === undefined || depth <= maxDepth) {
        await this.readDirectory(candidate, false, directoryHelper, undefined, candidate, depth)
      }
      return
    }

    if (!tracked) {
      await this.addPathOnce(candidate, false, helper(), depth)
    } else if (!fsw.tree.isDuplicateObservation(candidate, stats, trigger)) {
      fsw.emitEvent(EV.CHANGE, candidate, stats)
    }
  }

  /**
   * Keep a Windows parent handle for a directly watched directory. Windows can
   * silently retire the directory's own handle when an empty root is removed;
   * its parent still receives the namespace transition and can reconcile it.
   */
  watchRootParent(dir, wh) {
    if (!this.fsw.options.backendCapabilities.perDirectory || !isWindows) return
    const parentPath = sp.dirname(dir)
    if (sp.resolve(parentPath) === sp.resolve(dir)) return

    const canonicalParent = sp.normalize(sp.toNamespacedPath(sp.resolve(parentPath))).toLowerCase()
    const rootName = sp.basename(dir).toLowerCase()
    const generation = this.fsw.lifecycle.generation
    let active = true
    const matchesRoot = (relativePath) => {
      if (relativePath === null) return true
      const candidate = sp.isAbsolute(relativePath)
        ? sp.resolve(relativePath)
        : sp.resolve(parentPath, relativePath)
      return (
        sp.normalize(sp.toNamespacedPath(sp.dirname(candidate))).toLowerCase() ===
          canonicalParent && sp.basename(candidate).toLowerCase() === rootName
      )
    }
    const isActive = () =>
      active && this.fsw.lifecycle.isActive(generation) && this.isHelperActive(wh, dir)
    const publish = (trigger) => {
      if (trigger.kind !== 'native' || !matchesRoot(trigger.relativePath) || !isActive()) return
      void this.reconcileBackendTrigger(
        dir,
        false,
        trigger,
        async () => {
          let rootStats
          try {
            rootStats = await lstat(dir)
          } catch (error) {
            if (isMissingError(error)) {
              this.fsw.removePath(parentPath, sp.basename(dir), true)
            } else {
              this.reportError(error)
            }
            return
          }
          if (!isActive()) return
          if (!rootStats.isDirectory()) {
            this.fsw.removePath(parentPath, sp.basename(dir), true)
            await this.addPathOnce(dir, false, wh, 0)
            return
          }
          await this.readDirectory(dir, false, wh, undefined, dir, 0)
        },
        isActive
      )
    }
    const subscription = setFsWatchListener(
      parentPath,
      sp.resolve(parentPath),
      { persistent: this.fsw.options.persistent },
      {
        publish,
        errHandler: this.reportError,
        rawEmitter: (event, relativePath, details) => {
          if (matchesRoot(relativePath)) this.fsw.emitRaw(event, relativePath, details)
        }
      },
      this.fsw.lifecycle.abortController.signal
    )
    if (!subscription) return
    return () => {
      if (!active) return
      active = false
      return subscription.close()
    }
  }

  async watchRecursiveDirectory(dir, initialAdd, depth, wh) {
    const fsw = this.fsw
    const generation = fsw.lifecycle.generation
    const rootKey = logicalPathKey(dir)
    const buffered = new ReplayBuffer(RECURSIVE_TRIGGER_BUFFER_LIMIT)
    const fallbackClosers = []
    let phase = 'scanning'
    let pendingFailure
    let hasPendingFailure = false
    let recovery
    let subscription
    const scopeActive = (path = dir) =>
      fsw.lifecycle.isActive(generation) && fsw.isPathGenerationActive(path, wh.pathGeneration)
    const acceptsTrigger = (path = dir) =>
      phase !== 'recovering' && phase !== 'closed' && scopeActive(path)

    const establishFallback = async (error) => {
      if (!scopeActive()) return
      wh.recursiveRoot = undefined
      wh.recursiveDisabled = true
      let currentStats
      try {
        currentStats = await lstat(dir)
      } catch (statError) {
        if (isMissingError(statError)) fsw.removePath(sp.dirname(dir), sp.basename(dir), true)
        else this.reportError(statError)
        this.reportError(error)
        return
      }
      const closer = await this.handleDirectory(dir, currentStats, false, depth, undefined, wh)
      if (!scopeActive()) {
        if (closer) await closer()
        return
      }
      if (closer) fallbackClosers.push(closer)
      this.reportError(error)
    }

    const handleFailure = (error) => {
      if (!acceptsTrigger()) return
      const initializing = phase !== 'live'
      phase = 'recovering'
      fsw.tree.recursiveRoots.delete(rootKey)
      pendingFailure = error
      hasPendingFailure = true
      if (!initializing) {
        recovery = fsw.reconciliation.enqueue(dir, () => establishFallback(error), false)
      }
    }
    const processTrigger = (trigger) => {
      if (!acceptsTrigger()) return
      if (phase !== 'live') {
        buffered.push(trigger)
        return
      }
      const coalescePath =
        trigger.relativePath === null
          ? dir
          : (resolveRecursiveCandidate(dir, trigger.relativePath) ?? dir)
      void this.reconcileBackendTrigger(
        dir,
        true,
        trigger,
        () => (acceptsTrigger() ? this.reconcileNativeTrigger(dir, wh, trigger) : undefined),
        () => acceptsTrigger(coalescePath)
      )
    }

    const result = subscribeRecursiveNative(
      dir,
      fsw.options.persistent,
      { publish: processTrigger, failure: handleFailure, rawEmitter: fsw.emitRaw },
      fsw.lifecycle.abortController.signal
    )
    if (result.kind === 'unsupported') return false
    if (result.kind === 'failed') throw result.error
    subscription = result.subscription
    fsw.tree.recursiveRoots.add(rootKey)
    wh.recursiveRoot = dir

    const close = async () => {
      if (phase === 'closed') return
      phase = 'closed'
      fsw.tree.recursiveRoots.delete(rootKey)
      buffered.clear()
      await subscription?.close()
      if (recovery) await Promise.allSettled([recovery])
      await Promise.allSettled(fallbackClosers.map((closer) => closer()))
    }

    try {
      await this.scanRecursiveTree(dir, initialAdd, wh, depth)
      if (hasPendingFailure) {
        buffered.clear()
        await establishFallback(pendingFailure)
      } else {
        phase = 'replaying'
        let index = 0
        while (acceptsTrigger() && !buffered.overflowed && index < buffered.entries.length) {
          const trigger = buffered.entries[index++]
          if (trigger.rawEvent === 'rename' && trigger.relativePath !== null) {
            const candidate = resolveRecursiveCandidate(dir, trigger.relativePath)
            if (
              candidate &&
              candidate !== dir &&
              fsw.tree.getDirectory(sp.dirname(candidate)).has(sp.basename(candidate))
            ) {
              fsw.tree.markInitialCreate(candidate)
            }
          }
          await this.reconcileBackendTrigger(
            dir,
            true,
            trigger,
            () => this.reconcileNativeTrigger(dir, wh, trigger),
            () => acceptsTrigger(),
            false
          )
        }
        if (buffered.overflowed && acceptsTrigger()) {
          const overflowTrigger = {
            kind: 'native',
            resource: subscription.resource,
            rawEvent: EV.CHANGE,
            relativePath: null,
            sequence: Number.MAX_SAFE_INTEGER,
            observedAt: backendNow()
          }
          await this.reconcileBackendTrigger(
            dir,
            true,
            overflowTrigger,
            () => this.reconcileNativeTrigger(dir, wh, overflowTrigger),
            () => acceptsTrigger(),
            false
          )
        }
        if (phase !== 'recovering') phase = 'live'
      }
      buffered.clear()
      fsw.tree.clearInitialCreates(dir)
    } catch (error) {
      await close()
      throw error
    }
    if (!scopeActive()) {
      await close()
      return
    }
    return close
  }

  /**
   * Read directory to add / remove files from `@watched` list and re-read it on change.
   * @param dir fs path
   * @param stats
   * @param initialAdd
   * @param depth relative to user-supplied path
   * @param target child path targeted for watch
   * @param wh Common watch helpers for this path
   * @returns closer for the watcher instance.
   */
  async handleDirectory(dir, stats, initialAdd, depth, target, wh) {
    if (!this.isHelperActive(wh, dir)) return
    if (target) {
      this.fsw.tree.getDirectory(dir)
    } else {
      const parentDir = this.fsw.tree.getDirectory(sp.dirname(dir))
      const tracked = parentDir.has(sp.basename(dir))
      if (!(initialAdd && this.fsw.options.ignoreInitial) && !tracked) {
        this.fsw.emitEvent(EV.ADD_DIR, dir, stats)
      }

      // ensure dir is tracked (harmless if redundant)
      parentDir.add(sp.basename(dir))
      this.fsw.tree.getDirectory(dir)
      this.fsw.tree.recordObserved(
        dir,
        stats,
        tracked ? undefined : 'add',
        wh.observationTrigger,
        initialAdd && Boolean(wh.recursiveRoot)
      )
    }
    let closer

    const oDepth = this.fsw.options.depth
    // lunte-disable-next-line eqeqeq
    if (oDepth == null || depth <= oDepth) {
      if (
        this.fsw.options.backendCapabilities.recursive &&
        depth === 0 &&
        !target &&
        !wh.recursiveRoot &&
        !wh.recursiveDisabled
      ) {
        const recursiveCloser = await this.watchRecursiveDirectory(dir, initialAdd, depth, wh)
        if (recursiveCloser !== false) return recursiveCloser
      }
      if (wh.recursiveRoot) {
        if (!target) {
          await this.scanRecursiveTree(dir, initialAdd, wh, depth)
        }
        return
      }

      const buffered = new ReplayBuffer(RECURSIVE_TRIGGER_BUFFER_LIMIT)
      const replayCreates = new Set()
      let initializing = !target
      let active = true
      const removeObserved = (dirPath) => {
        if (target) {
          if (this.fsw.tree.getDirectory(dirPath).has(target)) this.fsw.removePath(dirPath, target)
          return
        }
        this.fsw.removePath(sp.dirname(dirPath), sp.basename(dirPath), true)
      }
      const observeDirectory = async (dirPath, currentStats, trigger) => {
        if (!active || !this.isHelperActive(wh, dirPath)) return
        if (this.fsw.options.backendCapabilities.polling && !currentStats) {
          removeObserved(dirPath)
          return
        }

        if (trigger.kind === 'native') {
          let observedStats
          try {
            const linkStats = await lstat(dirPath)
            observedStats =
              linkStats.isSymbolicLink() && this.fsw.options.followSymlinks
                ? await stat(dirPath)
                : linkStats
          } catch (error) {
            if (isMissingError(error)) {
              removeObserved(dirPath)
            } else {
              this.reportError(error)
            }
            return
          }

          if (!observedStats.isDirectory()) {
            removeObserved(dirPath)
            if (!target) await this.addPathOnce(dirPath, false, wh, depth)
            return
          }
        }

        await this.readDirectory(dirPath, false, wh, target, dir, depth)
      }
      const reconcile = (candidate, currentStats, trigger) => {
        if (!active || !this.isHelperActive(wh, candidate)) return
        if (initializing) {
          buffered.push({ path: candidate, stats: currentStats, trigger })
          return
        }
        if (trigger.kind === 'native' && !target) {
          return this.reconcileNativeTrigger(dir, wh, trigger, candidate, depth)
        }
        if (trigger.kind === 'native' && target) {
          const matchesTarget =
            candidate === dir ||
            (isWindows
              ? sp.basename(candidate).toLowerCase() === target.toLowerCase()
              : sp.basename(candidate) === target)
          if (matchesTarget) {
            return this.reconcileNativeTrigger(dir, wh, trigger, sp.join(dir, target), depth)
          }
        }
        return observeDirectory(dir, currentStats, trigger)
      }
      const rootParentCloser = depth === 0 && !target ? this.watchRootParent(dir, wh) : undefined
      closer = this.subscribePath(
        dir,
        reconcile,
        stats.isDirectory() ? stats : undefined,
        true,
        target ? sp.join(dir, target) : dir
      )

      if (!target) {
        await this.readDirectory(dir, initialAdd, wh, target, dir, depth)
        let index = 0
        while (!buffered.overflowed && index < buffered.entries.length && !this.fsw.closed) {
          const event = buffered.entries[index++]
          if (
            event.trigger.kind === 'native' &&
            event.trigger.rawEvent === 'rename' &&
            event.path !== dir &&
            this.fsw.tree.getDirectory(sp.dirname(event.path)).has(sp.basename(event.path))
          ) {
            this.fsw.tree.markInitialCreate(event.path)
            replayCreates.add(event.path)
          }
          await this.reconcileBackendTrigger(
            dir,
            true,
            event.trigger,
            () => {
              if (event.trigger.kind === 'native' && !target) {
                return this.reconcileNativeTrigger(dir, wh, event.trigger, event.path, depth)
              }
              return observeDirectory(dir, event.stats, event.trigger)
            },
            () => active && this.isHelperActive(wh, event.path),
            false
          )
        }
        if (buffered.overflow && !this.fsw.closed) {
          await observeDirectory(dir, buffered.overflow.stats, buffered.overflow.trigger)
        }
        buffered.clear()
        replayCreates.forEach((path) => this.fsw.tree.clearInitialCreate(path))
        initializing = false
      }
      if (!this.isHelperActive(wh, dir)) {
        active = false
        if (closer) await closer()
        if (rootParentCloser) await rootParentCloser()
        return
      }
      if (closer || rootParentCloser) {
        const backendClosers = [closer, rootParentCloser].filter(
          (candidate) => candidate !== undefined
        )
        closer = async () => {
          if (!active) return
          active = false
          buffered.clear()
          await Promise.allSettled(backendClosers.map((backendCloser) => backendCloser()))
        }
      }
    }
    return closer
  }

  /**
   * Handle added file, directory, or glob pattern.
   * Delegates call to handleFile / handleDirectory after checks.
   * @param path to file or ir
   * @param initialAdd was the file added at watch instantiation?
   * @param priorWh depth relative to user-supplied path
   * @param depth Child path actually targeted for watch
   * @param target Child path actually targeted for watch
   */
  async addRoot(path, initialAdd, pathGeneration, target) {
    let candidate = path
    let childTarget = target
    const generation = this.fsw.lifecycle.generation
    while (this.fsw.lifecycle.isActive(generation)) {
      const outcome = await this.addPathOnce(
        candidate,
        initialAdd,
        undefined,
        0,
        childTarget,
        pathGeneration
      )
      if (outcome === 'complete') return
      const parent = sp.dirname(candidate)
      if (parent === candidate) return
      childTarget = sp.basename(candidate)
      candidate = parent
    }
  }

  async addPathOnce(path, initialAdd, priorWh, depth, target, pathGeneration) {
    if (this.fsw.isIgnored(path) || this.fsw.closed) {
      return 'complete'
    }

    const wh = priorWh ? priorWh.fork(path) : this.fsw.createHelper(path)
    if (!priorWh && pathGeneration !== undefined) wh.pathGeneration = pathGeneration

    if (!this.isHelperActive(wh)) {
      return 'complete'
    }

    // evaluate what is at the path we're being asked to watch
    try {
      const linkStats = await lstat(wh.watchPath)
      if (!this.isHelperActive(wh)) {
        return 'complete'
      }
      if (this.fsw.isIgnored(wh.watchPath, linkStats)) {
        return 'complete'
      }

      const follow = this.fsw.options.followSymlinks
      const isSymbolicLink = linkStats.isSymbolicLink()
      const stats = isSymbolicLink && follow ? await stat(wh.watchPath) : linkStats
      const followedTarget = isSymbolicLink && follow ? await fsrealpath(path) : undefined
      let closer
      if (stats.isDirectory()) {
        const absPath = logicalPathKey(path)
        const ancestryPath = follow ? await fsrealpath(path) : path
        const targetPath = followedTarget ?? path
        const targetKey = logicalPathKey(ancestryPath)
        if (!this.isHelperActive(wh)) {
          return 'complete'
        }
        if (isSymbolicLink && wh.realpathAncestry.has(targetKey)) {
          const parent = this.fsw.tree.getDirectory(sp.dirname(wh.watchPath))
          parent.add(sp.basename(wh.watchPath))
          this.fsw.tree.getDirectory(wh.watchPath)
          this.fsw.tree.symlinkPaths.set(absPath, targetPath)
          this.fsw.tree.recordObserved(
            wh.watchPath,
            stats,
            'add',
            wh.observationTrigger,
            initialAdd && Boolean(wh.recursiveRoot)
          )
          if (!(initialAdd && this.fsw.options.ignoreInitial)) {
            this.fsw.emitEvent(EV.ADD_DIR, wh.watchPath, stats)
          }
          return 'complete'
        }
        wh.realpathAncestry.add(targetKey)
        if (wh.recursiveRoot && isSymbolicLink) {
          wh.recursiveRoot = undefined
        }
        if (isSymbolicLink) wh.recursiveDisabled = true
        closer = await this.handleDirectory(wh.watchPath, stats, initialAdd, depth, target, wh)
        if (!this.isHelperActive(wh)) {
          if (closer) await closer()
          return 'complete'
        }
        // preserve this symlink's target path
        if (isSymbolicLink) {
          this.fsw.tree.symlinkPaths.set(absPath, targetPath)
        }
      } else if (isSymbolicLink && !follow) {
        const linkTarget = await readlink(path)
        const retainsNativeFact =
          !this.fsw.options.backendCapabilities.polling && !wh.recursiveRoot && !priorWh
        const fileCloser = this.handleFile(
          wh.watchPath,
          stats,
          initialAdd,
          !wh.recursiveRoot,
          wh.observationTrigger,
          initialAdd && Boolean(wh.recursiveRoot),
          retainsNativeFact
        )
        if (wh.recursiveRoot) {
          this.fsw.tree.symlinkPaths.set(logicalPathKey(path), linkTarget)
          return 'complete'
        }
        const parent = sp.dirname(wh.watchPath)
        const parentStats = await stat(parent)
        const parentHelper = this.fsw.createHelper(parent)
        parentHelper.pathGeneration = wh.pathGeneration
        const parentCloser = await this.handleDirectory(
          parent,
          parentStats,
          initialAdd,
          depth,
          sp.basename(wh.watchPath),
          parentHelper
        )
        const deletionCloser = this.watchSymlinkDeletion(wh.watchPath)
        if (!this.isHelperActive(wh)) {
          if (fileCloser) await fileCloser()
          if (parentCloser) await parentCloser()
          if (deletionCloser) deletionCloser()
          return 'complete'
        }
        closer = async () => {
          await Promise.allSettled(
            [fileCloser, parentCloser, deletionCloser]
              .filter((candidate) => candidate !== undefined)
              .map((backendCloser) => backendCloser())
          )
        }
        this.fsw.tree.symlinkPaths.set(logicalPathKey(path), linkTarget)
      } else {
        if (followedTarget) {
          this.fsw.tree.symlinkPaths.set(logicalPathKey(path), followedTarget)
        }
        const retainsNativeFact =
          !this.fsw.options.backendCapabilities.polling && !wh.recursiveRoot && !priorWh
        const fileCloser = this.handleFile(
          wh.watchPath,
          stats,
          initialAdd,
          !wh.recursiveRoot,
          wh.observationTrigger,
          initialAdd && Boolean(wh.recursiveRoot),
          retainsNativeFact
        )
        const targetPath = followedTarget ?? (retainsNativeFact ? wh.watchPath : undefined)
        const targetCloser = targetPath
          ? this.subscribeMappedFile(wh.watchPath, targetPath, wh, depth)
          : undefined
        let parentCloser
        if (retainsNativeFact && followedTarget) {
          const parent = sp.dirname(wh.watchPath)
          const parentStats = await stat(parent)
          const parentHelper = this.fsw.createHelper(parent)
          parentHelper.pathGeneration = wh.pathGeneration
          parentCloser = await this.handleDirectory(
            parent,
            parentStats,
            initialAdd,
            depth,
            sp.basename(wh.watchPath),
            parentHelper
          )
        }
        const fileClosers = [fileCloser, targetCloser, parentCloser].filter(
          (candidate) => candidate !== undefined
        )
        closer =
          fileClosers.length === 0
            ? undefined
            : async () => {
                await Promise.allSettled(fileClosers.map((fileCloser) => fileCloser()))
              }
      }
      if (!this.isHelperActive(wh)) {
        if (closer) await closer()
        return 'complete'
      }
      if (closer) this.fsw.addPathCloser(path, closer)
      return 'complete'
    } catch (error) {
      if (!this.isHelperActive(wh)) {
        return 'complete'
      }
      this.fsw.handleError(error)
      return 'watch-parent'
    }
  }
}

module.exports = { ObservationEngine } // rt: S16
