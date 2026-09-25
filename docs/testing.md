# Testing

chokidar4bare's suites are chokidar v6's own suites, ported to brittle. They are the executable
specification of the port: `test/v6.js` (74 cases), `test/index.js` (the 119-case shared suite run
under the native, recursive-preferred and owned-polling backends), `test/architecture.js` (7
cases), plus chokidar4bare's own `test/read-dir.js`, `test/inotify.js`, `test/enospc.js` and
`test/smoke.js`.

## The oracle

Under Node the `imports` map resolves `fs` to Node's own `fs`, so the translated engine runs on
the same `fs.watch` upstream runs on. That makes upstream's suite a differential oracle:

```
# 1. the ported tests against the upstream chokidar build they were ported from
git clone https://github.com/paulmillr/chokidar ../chokidar-upstream
git -C ../chokidar-upstream checkout --detach 74adf65 && (cd ../chokidar-upstream && npm ci && npm run build)
CHOKIDAR4BARE_ORACLE=$PWD/../chokidar-upstream npx brittle-node "test/*.js"

# 2. the same tests against chokidar4bare on Node — the numbers must match step 1
npx brittle-node "test/*.js"

# 3. and under Bare
npx brittle-bare "test/*.js"
```

Any difference between steps 1 and 2 is a translation bug: fix the translation, never the test.
Differences between 2 and 3 are confined to `lib/backend.js`, `lib/read-dir.js` and the Bare
defences, and to cases marked `{ skip: isBare }` (they need `process.env`, `process.chdir`,
`child_process` or `fs.watchFile`).

Recorded numbers (2026-09-25, macOS arm64, Node 24.19, Bare 1.33.4):

| Suite                  | oracle (Node)      | chokidar4bare (Node) | chokidar4bare (Bare, macOS) | chokidar4bare (Bare, Linux) |
| ---------------------- | ------------------ | -------------------- | --------------------------- | --------------------------- |
| `test/v6.js`           | 75/75, 268 asserts | 75/75, 268           | 75/75, 253                  | 75/75, 246                  |
| `test/index.js`        | 359/359, 988       | 359/359, 988         | 359/359, 952                | 240/240, 641                |
| `test/architecture.js` | 8/8, 35            | 8/8, 35              | 8/8, 35                     | 8/8, 35                     |

On Linux under Bare the recursive-preferred label does not register (240 = 2 × 119 + 2): libuv
ignores the recursive flag there and bare-fs cannot report it, so chokidar4bare pre-latches recursive
as unsupported (DV11) and the harness's `canUseRecursiveWatch` says no.

## CI (2026-09-25, `ok/chokidar4bare`, `.github/workflows/integrate.yml`)

| Job                                                                    | Result (run 36181023033, `4076026`, bare-fs 4.8.2)                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Test / linux (Node + Bare)                                             | green                                                                       |
| Test / linux inotify limits (`test/enospc.js` with the limits lowered) | green                                                                       |
| Test / win32 (Node + Bare)                                             | green: Bare 478/478 (1,163 asserts), Node 478/478 — burst test and F15 live |
| Test / darwin (Node + Bare)                                            | green: Bare 478/478 (1,316), Node 478/478                                   |
| Lint, Security                                                         | green                                                                       |

Windows needed two things the local runs could not show: bare-fs 4.8.2 (before it, a burst
overflowed libuv's 4 KB ReadDirectoryChangesW buffer, libuv passed a NULL filename and bare-fs
crashed on it: [holepunchto/bare-fs#52](https://github.com/holepunchto/bare-fs/issues/52), fixed
the day it was filed), and watch paths are resolved with
`realpathSync.native` on Node (the runner's temp directory is an 8.3 short name; libuv's fs-event
assertion fires when the callback's long name does not share the watched spelling — the same
assertion that has kept chokidar's own CI red).

**Known runner flakes on darwin under Bare** (each once, on different runs; all pass locally ×3;
both are verbatim upstream assertions with no macOS guard upstream either):

- `fs.watch (non-polling) › watch individual files › should detect unlink and re-add`
- `fs.watch (recursive preferred) › watch individual files › should detect safe-edit` (exact count
  of three `change` events for three rename-over saves 300 ms apart)

They are tracked here by name. A case that fails twice gets investigated, not re-run.

## Linux locally

Docker is enough. `scripts/linux-run.sh` copies the checkout into a `node:22-slim` container with a
cached `node_modules` volume and runs the given files under Node, Bare or both:

```
scripts/linux-run.sh both test/v6.js test/index.js
```

`scripts/linux-enospc.sh` runs `test/enospc.js` in a privileged container after lowering
`fs.inotify.max_user_watches` to 1024 and `max_queued_events` to 16, the way the CI job does, and
restores them afterwards. Those limits are kernel-global inside Docker Desktop's VM: never run it
alongside another Linux test run.

## Timing

Tests wait on conditions, never on fixed sleeps; `CHOKIDAR4BARE_TEST_TIMEOUT_SCALE=2` stretches every
timeout on a slow machine. macOS FSEvents coalesces and duplicates events, so counts there are
asserted only where upstream asserts them. brittle never bails: one flake fails one test, not the
run.
