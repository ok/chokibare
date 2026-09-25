// Port of chokidar src/architecture.test.ts @ 74adf65 (130 lines). Pure unit tests on the internal
// modules (backend.js, runtime.js, tree.js) — no filesystem, no watcher instances — so they gain
// nothing from a suite() case's fixture directory beyond the shared runner shape used everywhere
// else in this port.
//
// backend.js/runtime.js/tree.js are chokidar's own internal modules: never re-exported through the
// public API or through lib/testing.js's inspectWatcher/backendTesting seam, so this file loads them
// directly, the same way test/helpers/index.js loads index.js/runtime.js/testing.js: from the
// upstream oracle build under CHOKIDAR4BARE_ORACLE (Node only), or from chokidar4bare's own lib/ otherwise.
'use strict'

const path = require('path')
const { suite, isBare } = require('./helpers')
const rt = require('../lib/bare-runtime')

const s = suite()

const ORACLE = rt.env('CHOKIDAR4BARE_ORACLE')
let internalsPromise = null

function loadInternals() {
  if (!internalsPromise) {
    internalsPromise = ORACLE ? loadOracleInternals() : loadChokidar4bareInternals()
  }
  return internalsPromise
}

function loadOracleInternals() {
  if (isBare) throw new Error('CHOKIDAR4BARE_ORACLE: upstream chokidar runs on Node only')
  const { pathToFileURL } = require('url')
  const mod = (file) => import(pathToFileURL(path.join(ORACLE, file)).href)
  return Promise.all([mod('backend.js'), mod('runtime.js'), mod('tree.js')]).then(
    ([backend, runtime, tree]) => ({ backend, runtime, tree })
  )
}

function loadChokidar4bareInternals() {
  return Promise.resolve({
    backend: require('../lib/backend'),
    runtime: require('../lib/runtime'),
    tree: require('../lib/tree')
  })
}

// Upstream's `reportTestFailure` (index.test.ts:2396-2403) surfaces an unexpected task error via
// process/CI annotations; here it just fails the assertion that owns the LifecycleScope under test.
function onTaskError(t) {
  return (error) => {
    t.fail(error instanceof Error ? error.message : String(error))
  }
}

s.test(
  'architecture boundaries › owns tasks and subscriptions in one lifecycle scope',
  async (t) => {
    const { tree } = await loadInternals()
    const { LifecycleScope } = tree

    let settled = 0
    let closed = 0
    let release
    const barrier = new Promise((resolve) => {
      release = resolve
    })
    const scope = new LifecycleScope(() => {
      settled += 1
    }, onTaskError(t))
    scope.track(barrier)
    scope.addCloser('/owned', () => {
      closed += 1
    })

    t.is(scope.tasks.size, 1)
    t.is(scope.closers.size, 1)
    await Promise.allSettled(scope.beginClose())
    t.is(scope.state, 'CLOSING')
    t.is(scope.abortController.signal.aborted, true)
    t.is(closed, 1)
    t.is(scope.closers.size, 0)

    release()
    await scope.drain()
    scope.finishClose()
    t.is(settled, 1)
    t.is(scope.state, 'CLOSED')
  }
)

s.test(
  'architecture boundaries › rejects reconciliation candidates that escape their root',
  async (t) => {
    const { tree } = await loadInternals()
    const { resolveRecursiveCandidate } = tree

    const root = path.resolve('/watch-root')
    const candidate = path.join(root, 'child.txt')
    t.is(resolveRecursiveCandidate(root, '../escape.txt'), undefined)
    t.is(resolveRecursiveCandidate(root, 'child.txt'), candidate)
  }
)

s.test('architecture boundaries › keeps containment checks segment-aware', async (t) => {
  const { runtime } = await loadInternals()
  const { isSameOrInside, isStrictlyInside } = runtime

  const root = path.resolve('/watch-root')
  t.is(isSameOrInside(root, root), true)
  t.is(isStrictlyInside(root, root), false)
  t.is(isStrictlyInside(root, path.join(root, 'child')), true)
  t.is(isSameOrInside(root, path.resolve('/watch-root-sibling')), false)
})

s.test('architecture boundaries › normalizes separators while preserving UNC roots', async (t) => {
  const { runtime } = await loadInternals()
  const { normalizePath } = runtime

  t.is(normalizePath('folder\\child\\..\\file.txt'), 'folder/file.txt')
  t.is(normalizePath('//server/share/folder'), '//server/share/folder')
})

s.test(
  'architecture boundaries › keeps native observations local while preserving traversal state',
  async (t) => {
    const { runtime } = await loadInternals()
    const { WatchHelper } = runtime

    const helper = new WatchHelper('/watch-root', true, {
      capturePathGeneration: () => 7,
      isntIgnored: () => true
    })
    helper.realpathAncestry.add('/real-root')
    const trigger = {
      kind: 'native',
      resource: path.resolve('/watch-root'),
      rawEvent: 'rename',
      relativePath: 'child.txt',
      sequence: 1,
      observedAt: 10
    }

    const observation = helper.withObservation(trigger)
    const child = observation.fork('/watch-root/child')
    t.is(helper.observationTrigger, undefined)
    t.is(observation.observationTrigger, trigger)
    t.is(observation.realpathAncestry, helper.realpathAncestry)
    t.is(child.observationTrigger, trigger)
    t.is(child.realpathAncestry === helper.realpathAncestry, false)
    t.is(child.realpathAncestry.has('/real-root'), true)
    t.is(child.pathGeneration, 7)
  }
)

s.test('architecture boundaries › selects one immutable backend capability set', async (t) => {
  const { backend } = await loadInternals()
  const { selectBackend } = backend

  t.alike(selectBackend({ backend: 'polling' }), {
    kind: 'polling',
    polling: true,
    recursive: false,
    perDirectory: false
  })
  t.alike(selectBackend({ backend: 'native-recursive', depth: 1 }), {
    kind: 'native-per-directory',
    polling: false,
    recursive: false,
    perDirectory: true
  })
  t.is(Object.isFrozen(selectBackend({ backend: 'native-recursive' })), true)
})

s.test(
  'architecture boundaries › owns shared resource generations and subscriber teardown once',
  async (t) => {
    const { backend } = await loadInternals()
    const {
      attachSharedSubscriber,
      createSharedResourceState,
      detachSharedSubscriber,
      invalidateSharedResource
    } = backend

    const key = path.resolve('/resource')
    const resource = createSharedResourceState(key, ['first'])
    const successor = createSharedResourceState(key)
    t.ok(successor.generation > resource.generation)
    let reconfigured = 0
    let closed = 0

    t.is(attachSharedSubscriber(resource, 'second'), true)
    reconfigured += 1
    t.is(detachSharedSubscriber(resource, 'first'), 'remaining')
    reconfigured += 1
    t.is(reconfigured, 2)
    t.is(closed, 0)
    t.alike(invalidateSharedResource(resource), ['second'])
    closed += 1
    t.is(invalidateSharedResource(resource), undefined)
    t.is(closed, 1)
  }
)

s.run()
