# chokibare

**chokibare is a port of [chokidar](https://github.com/paulmillr/chokidar) to the
[Bare](https://github.com/holepunchto/bare) runtime. It copies chokidar as closely as we could.**

We love and trust chokidar. It has watched files for most of the JavaScript ecosystem since 2012,
and a great deal of hard-won knowledge is built into its code. chokidar needs Node.js, and we needed
the same thing on Bare. Rather than design a new watcher, we copied chokidar's code, its
architecture, its algorithms and its design patterns as faithfully as we could, and stayed as close
to the original as Bare allows.

**Most of the intellectual property in this package belongs to chokidar's authors and contributors**
(Copyright (c) 2012 Paul Miller, Elan Shanker, and contributors), not to us. The source files carry
chokidar's MIT copyright notice, and [UPSTREAM.md](UPSTREAM.md) maps every function back to its
chokidar original at the commit we ported from.

What is ours is limited to:

- the changes Bare forces (no `fs.watchFile`, no `process`, watch failures that `bare-fs` does not
  report, the inotify and open-file budgets);
- a short, numbered list of divergences, each one explained in UPSTREAM.md;
- a deliberately narrow scope: only the features one application needs today.

chokibare is an independent project. It is **not affiliated with or endorsed by chokidar or its
maintainers**. Please report problems with chokibare here, not to chokidar. If you run on Node.js,
**use chokidar**.

If chokidar has saved you time, please consider
[supporting its author](https://github.com/sponsors/paulmillr).

## Status

0.1.0 — the first release. The port of chokidar v6 (`74adf65`) is complete; its own test suites
pass against chokibare on macOS, Linux and Windows, under Bare and under Node (`docs/testing.md`
has the numbers). Two bare-fs defects limit what a watcher can do under Bare today, and chokibare
works around the one it can:

- [bare-fs#51](https://github.com/holepunchto/bare-fs/issues/51): a failed `fs.watch()` is a
  silent dead handle. On Linux chokibare verifies every arm against the kernel and reports the
  dead ones as `ENOSPC`.
- [bare-fs#52](https://github.com/holepunchto/bare-fs/issues/52): on Windows a burst of changes
  crashes the process. No workaround is possible in JavaScript; **do not use chokibare under Bare on
  Windows in production until that is fixed.**

See UPSTREAM.md for the pinned chokidar commit and every divergence from it.

## Development

```
npm install
npm test          # brittle under Bare, then under Node
npm run lint      # prettier, lunte, provenance headers
```

The ported test suite can also be run against the upstream chokidar build it was ported from,
which is how the port is verified:

```
CHOKIBARE_ORACLE=/path/to/chokidar-upstream npx brittle-node "test/*.js"
```

`docs/testing.md` explains the method, the recorded numbers per platform and runtime, and the
Docker scripts for Linux (`scripts/linux-run.sh`, `scripts/linux-enospc.sh`).
