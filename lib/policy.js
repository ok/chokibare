// Derived from chokidar src/policy.ts @ 74adf65 (https://github.com/paulmillr/chokidar, branch v6).
// MIT License. Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker.
'use strict'

const { stat } = require('fs/promises') // rt: S2
const sp = require('path') // rt: S3
const { EVENTS, isMissingError, isWindows, logicalPathKey } = require('./runtime')
const { LifecycleScope } = require('./tree') // lunte-disable-line no-unused-vars

function sameChangeStats(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ino === right.ino
  )
}

/** Converts truthful tree transitions into the public, timing-aware event API. */
class EventPolicy {
  pendingWrites = new Map()
  pendingUnlinks = new Map()
  pendingChanges = new Map()
  throttled = new Map()
  context

  constructor(context) {
    this.context = context
  }

  setTimeout(callback, delay) {
    const timer = this.context.scheduler.setTimeout(callback, delay)
    if (!this.context.options.persistent) timer.unref()
    return timer
  }

  async emit(event, path, stats) {
    if (this.context.isClosed()) return

    const { options, scheduler } = this.context
    const sourcePath = path
    const logicalKey = logicalPathKey(path)
    const generation = this.context.lifecycle.generation
    const pathGeneration = this.context.capturePathGeneration()
    if (isWindows) path = sp.normalize(path)
    if (options.cwd) path = sp.relative(options.cwd, path)
    const args = [path]
    if (stats != null) args.push(stats) // lunte-disable-line eqeqeq

    if (event === EVENTS.UNLINK || event === EVENTS.UNLINK_DIR) {
      this.pendingChanges.delete(logicalKey)
      this.throttled.get(EVENTS.CHANGE)?.get(logicalKey)?.clear(false)
    }

    const awf = options.awaitWriteFinish
    const pendingWrite = awf ? this.pendingWrites.get(logicalKey) : undefined
    if (pendingWrite) {
      pendingWrite.lastChange = scheduler.now()
      return
    }

    if (options.atomic) {
      if (event === EVENTS.UNLINK) {
        const existing = this.pendingUnlinks.get(logicalKey)
        if (existing) scheduler.clearTimeout(existing.timer)
        const entry = [event, ...args]
        const timer = this.setTimeout(
          () => {
            const pending = this.pendingUnlinks.get(logicalKey)
            if (!pending || pending.timer !== timer) return
            this.pendingUnlinks.delete(logicalKey)
            if (this.context.isClosed()) return
            const [pendingEvent, ...pendingArgs] = pending.event
            this.context.publish(pendingEvent, pendingArgs)
          },
          typeof options.atomic === 'number' ? options.atomic : 100
        )
        this.pendingUnlinks.set(logicalKey, { event: entry, timer })
        return
      }
      const pendingUnlink = this.pendingUnlinks.get(logicalKey)
      if (event === EVENTS.ADD && pendingUnlink) {
        event = EVENTS.CHANGE
        scheduler.clearTimeout(pendingUnlink.timer)
        this.pendingUnlinks.delete(logicalKey)
      }
    }

    if (awf && (event === EVENTS.ADD || event === EVENTS.CHANGE) && this.context.isReady()) {
      const awfEmit = (error, currentStats) => {
        if (this.context.isClosed()) return
        if (error) {
          event = EVENTS.ERROR
          args[0] = error
          this.context.publish(event, args)
        } else if (currentStats) {
          if (args.length > 1) args[1] = currentStats
          else args.push(currentStats)
          this.context.publish(event, args)
        }
      }
      this.awaitWriteFinish(path, awf.stabilityThreshold, event, awfEmit, logicalKey)
      return
    }

    if (event === EVENTS.CHANGE) {
      const throttler = this.throttle(EVENTS.CHANGE, sourcePath, 50, (suppressedCount) => {
        const pending = this.pendingChanges.get(logicalKey)
        this.pendingChanges.delete(logicalKey)
        if (
          suppressedCount > 0 &&
          pending?.replay &&
          this.context.lifecycle.isActive(generation) &&
          this.context.isPathGenerationActive(logicalKey, pathGeneration)
        ) {
          void this.emit(EVENTS.CHANGE, pending.path, pending.stats)
        }
      })
      if (!throttler) {
        const pending = this.pendingChanges.get(logicalKey)
        if (pending && !sameChangeStats(pending.stats, stats)) {
          pending.path = sourcePath
          pending.stats = stats
          pending.replay = true
        }
        return
      }
      this.pendingChanges.set(logicalKey, { path: sourcePath, stats, replay: false })
    }

    if (
      options.alwaysStat &&
      stats === undefined &&
      (event === EVENTS.ADD || event === EVENTS.ADD_DIR || event === EVENTS.CHANGE)
    ) {
      const fullPath = options.cwd ? sp.join(options.cwd, path) : path
      try {
        stats = await stat(fullPath)
      } catch (error) {
        this.context.handleError(error)
      }
      if (
        !stats ||
        !this.context.lifecycle.isActive(generation) ||
        !this.context.isPathGenerationActive(logicalKey, pathGeneration)
      ) {
        return
      }
      args.push(stats)
    }
    this.context.publish(event, args)
  }

  throttle(actionType, path, timeout, onRelease) {
    let action = this.throttled.get(actionType)
    if (!action) {
      action = new Map()
      this.throttled.set(actionType, action)
    }
    const key = actionType === 'readdir' ? path : logicalPathKey(path)
    const active = action.get(key)
    if (active) {
      active.count += 1
      return false
    }

    let timeoutObject
    const clear = (invokeRelease = true) => {
      const item = action.get(key)
      const count = item?.count ?? 0
      action.delete(key)
      this.context.scheduler.clearTimeout(timeoutObject)
      if (item) this.context.scheduler.clearTimeout(item.timeoutObject)
      if (invokeRelease && onRelease) onRelease(count)
      return count
    }
    timeoutObject = this.setTimeout(clear, timeout)
    const throttler = { timeoutObject, clear, count: 0 }
    action.set(key, throttler)
    return throttler
  }

  awaitWriteFinish(path, threshold, event, awfEmit, logicalKey) {
    const awf = this.context.options.awaitWriteFinish
    if (typeof awf !== 'object') return
    const pollInterval = awf.pollInterval
    let timeoutHandler
    let fullPath = path
    if (this.context.options.cwd && !sp.isAbsolute(path)) {
      fullPath = sp.join(this.context.options.cwd, path)
    }
    const writeKey = logicalKey ?? logicalPathKey(fullPath)
    const generation = this.context.lifecycle.generation

    const inspect = (previous) => {
      const task = (async () => {
        let current
        try {
          current = await stat(fullPath)
        } catch (error) {
          if (!this.context.lifecycle.isActive(generation) || !this.pendingWrites.has(writeKey)) {
            return
          }
          if (isMissingError(error)) {
            this.context.remove(sp.dirname(fullPath), sp.basename(fullPath))
          } else {
            this.pendingWrites.delete(writeKey)
            awfEmit(error)
          }
          return
        }

        if (!this.context.lifecycle.isActive(generation) || !this.pendingWrites.has(writeKey)) {
          return
        }
        const now = this.context.scheduler.now()
        const pending = this.pendingWrites.get(writeKey)
        if (!pending) return
        if (previous && current.size !== previous.size) pending.lastChange = now
        if (now - pending.lastChange >= threshold) {
          this.pendingWrites.delete(writeKey)
          awfEmit(undefined, current)
        } else {
          timeoutHandler = this.setTimeout(() => inspect(current), pollInterval)
        }
      })()
      this.context.lifecycle.track(task)
    }

    if (!this.pendingWrites.has(writeKey)) {
      this.pendingWrites.set(writeKey, {
        lastChange: this.context.scheduler.now(),
        cancelWait: () => {
          this.pendingWrites.delete(writeKey)
          this.context.scheduler.clearTimeout(timeoutHandler)
          return event
        }
      })
      timeoutHandler = this.setTimeout(inspect, pollInterval)
    }
  }

  cancelPath(path) {
    const logicalKey = logicalPathKey(path)
    const pendingUnlink = this.pendingUnlinks.get(logicalKey)
    if (pendingUnlink) {
      this.context.scheduler.clearTimeout(pendingUnlink.timer)
      this.pendingUnlinks.delete(logicalKey)
    }
    this.pendingWrites.get(logicalKey)?.cancelWait()
    this.pendingChanges.delete(logicalKey)
    ;['watch', 'add', 'remove', 'change'].forEach((actionType) => {
      this.throttled.get(actionType)?.get(logicalKey)?.clear(false)
    })
    const readdirEntries = this.throttled.get('readdir')
    readdirEntries?.get(logicalKey)?.clear(false)
    readdirEntries
      ?.get(`${logicalPathKey(sp.dirname(logicalKey))}\0${sp.basename(logicalKey)}`)
      ?.clear(false)
  }

  cancelWhere(contains) {
    const paths = new Set([
      ...this.pendingUnlinks.keys(),
      ...this.pendingWrites.keys(),
      ...this.pendingChanges.keys()
    ])
    ;[...paths].filter(contains).forEach((path) => this.cancelPath(path))
    this.throttled.forEach((entries, actionType) => {
      ;[...entries.keys()]
        .filter((key) => contains(actionType === 'readdir' ? key.split('\0', 1)[0] : key))
        .forEach((key) => entries.get(key)?.clear(false))
    })
  }

  close() {
    this.pendingWrites.forEach((pending) => pending.cancelWait())
    this.pendingUnlinks.forEach(({ timer }) => this.context.scheduler.clearTimeout(timer))
    this.pendingUnlinks.clear()
    this.pendingChanges.clear()
    this.throttled.forEach((entries) => {
      entries.forEach((throttler) => throttler.clear(false))
    })
    this.throttled.clear()
  }
}

module.exports = { EventPolicy } // rt: S16
