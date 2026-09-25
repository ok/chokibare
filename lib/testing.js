// Derived from chokidar src/testing.ts @ 74adf65 (https://github.com/paulmillr/chokidar, branch v6).
// MIT License. Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker.
'use strict'

const {
  failNativeWatch,
  failRecursiveWatch,
  nativeResourceCountForTests,
  setNativeWatchFactoryForTests,
  setRecursiveWatchFactoryForTests
} = require('./backend')
const { logicalPathKey } = require('./runtime')

/** Process-global backend fault injection, kept outside the packaged API. */
const backendTesting = {
  nativeResourceCount() {
    return nativeResourceCountForTests()
  },
  setNativeWatchFactory(factory) {
    setNativeWatchFactoryForTests(factory)
  },
  setRecursiveWatchFactory(factory) {
    setRecursiveWatchFactoryForTests(factory)
  },
  failRecursiveWatch(path, error) {
    return failRecursiveWatch(path, error)
  },
  failNativeWatch(path, error) {
    return failNativeWatch(path, error)
  }
}

/** Deliberately unpackaged test seam for race injection and state assertions. */
function inspectWatcher(watcher) {
  const internal = watcher // rt: S17 (type cast erased)
  const { lifecycle, tree, reconciliation, events } = internal
  return {
    lifecycle,
    state: lifecycle.state, // rt: S17 (type cast erased)
    generation: lifecycle.generation,
    abortController: lifecycle.abortController,
    tasks: lifecycle.tasks,
    closers: lifecycle.closers,
    tree,
    watched: tree.watched,
    observed: tree.observed,
    recursiveRoots: tree.recursiveRoots,
    symlinkPaths: tree.symlinkPaths,
    reconciliation,
    pendingReconciliations: reconciliation.pending,
    events,
    pendingWrites: events.pendingWrites,
    pendingUnlinks: events.pendingUnlinks,
    pendingChangeEmissions: events.pendingChanges,
    throttled: events.throttled, // rt: S17 (type cast erased)
    handler: internal.handler,
    scheduler: internal.scheduler,
    streams: internal.streams,
    emitRaw: internal.emitRaw,
    get readyEmitted() {
      return internal.readyEmitted
    },
    set readyEmitted(value) {
      internal.readyEmitted = value
    },
    drainTasks: () => lifecycle.drain(),
    createHelper: (path) => internal.createHelper(path),
    emitEvent: (event, path, stats) => internal.emitEvent(event, path, stats),
    logicalKey: logicalPathKey,
    capturePathGeneration: () => internal.capturePathGeneration(),
    isIgnored: (path, stats) => internal.isIgnored(path, stats),
    awaitWriteFinish: (path, threshold, event, emit, logicalKey) =>
      events.awaitWriteFinish(path, threshold, event, emit, logicalKey),
    addPathCloser: (path, closer) => internal.addPathCloser(path, closer),
    removePath: (directory, item, isDirectory) => internal.removePath(directory, item, isDirectory),
    createScanStream: (root, options) => internal.createScanStream(root, options),
    walkMissingRoot: async (path) => {
      const host = internal.handler // rt: S17 (type cast erased)
      const original = host.addPathOnce
      let calls = 0
      host.addPathOnce = async () => {
        calls += 1
        return 'watch-parent'
      }
      try {
        await internal.handler.addRoot(path, true, internal.capturePathGeneration())
        return calls
      } finally {
        host.addPathOnce = original
      }
    },
    recordObserved: (path, stats, transition, trigger, initialRecursive) =>
      tree.recordObserved(path, stats, transition, trigger, initialRecursive),
    directoryEntry: (directory) => tree.getDirectory(directory),
    throttle: (actionType, path, timeout, onRelease) =>
      events.throttle(actionType, path, timeout, onRelease),
    trackTask: (task) => lifecycle.track(task),
    enqueueReconciliation: (scope, work, coalescePath = scope) =>
      reconciliation.enqueue(scope, work, coalescePath),
    isDuplicateObservation: (path, stats, trigger) =>
      tree.isDuplicateObservation(path, stats, trigger)
  }
}

module.exports = { backendTesting, inspectWatcher } // rt: S16
