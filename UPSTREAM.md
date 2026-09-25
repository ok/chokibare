# Upstream

chokibare is a translation of chokidar. This file is the map back to the original and the record of
every place we differ.

## Pin

|            |                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| Repository | https://github.com/paulmillr/chokidar                                                                   |
| Branch     | `v6`                                                                                                    |
| Commit     | `74adf65` (2026-08-16, "Remove linter"; the v6 rewrite is `b62d140`)                                    |
| Spec       | `docs/architecture.md` at that commit; `src/v6.test.ts` and `src/index.test.ts` are the executable spec |
| License    | MIT, Copyright (c) 2012 Paul Miller, Elan Shanker                                                       |

Prior art also read, not copied: [localwatch](https://github.com/holepunchto/localwatch)
(Apache-2.0) — arm-then-walk ordering and per-file delete recursion.

## Function map

One row per exported symbol and per class. `upstream file:line → chokibare file:line`.
Rows marked `split from` are helpers extracted to meet function-size guardrails.

| Upstream                                          | chokibare | Note |
| ------------------------------------------------- | --------- | ---- |
| _(filled in per module as the translation lands)_ |           |      |

## Divergences

Each is tagged in code as `// DVn` or `// Vn`. Relative to the pinned v6 commit only the rows
marked "ours" are divergences; the others exist so the same table reads against chokidar 5.x.

| ID   | Upstream behaviour                                      | chokibare                                                                                                                                                    | Why                                                      | Test |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ---- |
| DV2  | (5.x) per-file `fs.watch`                               | directory-only handles on every platform; per-file kqueue on macOS only as an opt-in (`fileWatchLimit`)                                                      | v6 already does directory-only; the opt-in is ours       |      |
| DV3  | every directory event re-reads the directory            | Linux: an inotify `change` (IN_MODIFY / IN_ATTRIB) does not re-read — membership cannot change on it                                                         | one large write is 10–21 k `change` events under bare-fs |      |
| DV7  | readdirp                                                | `lib/read-dir.js`: async walk over `opendir`, lstat only when the dirent type is unknown or stats are required                                               | bare-fs has no Node streams                              |      |
| DV10 | `process.nextTick`                                      | `queueMicrotask`                                                                                                                                             | no `process` under Bare                                  |      |
| DV11 | a failed `fs.watch` throws                              | stat before arm; Linux verifies each arm through `/proc/self/fdinfo`; a failed arm is an `error` with `code: 'ENOSPC'`; recursive is never selected on Linux | bare-fs discards the `uv_fs_event_start()` result        |      |
| DV12 | `followSymlinks` defaults to true                       | only `false` is supported                                                                                                                                    | scope                                                    |      |
| DV14 | `raw` carries Node's watcher data                       | `raw(kind, path, {watchedPath})`; `path` may be `null`                                                                                                       | NULL filename on overflow                                |      |
| DV15 | a null-name or directory-level event re-reads one level | the whole subtree is re-read and every known file re-stat'ed                                                                                                 | the only loss signals that reach JS                      |      |
| DV16 | —                                                       | macOS opt-in per-file watch cap with a `warning` event                                                                                                       | silent EMFILE under bare-fs                              |      |
| —    | path length                                             | paths over 4096 bytes are refused with `ENAMETOOLONG`                                                                                                        | bare-fs truncates silently                               |      |

Kept from v6 unchanged (listed so nobody "fixes" them): scan-time callback buffering (1024),
native-name validation, ancestor ignore checks, the Windows parent handle for a watched root, the
macOS one-shot exact-target handle, recursive-root runtime fallback, the injected Scheduler, echo
suppression windows (25 ms / 10 ms), the 50 ms change window with replay, atomic, awaitWriteFinish.

## Sync log

| Date       | Event                                  |
| ---------- | -------------------------------------- |
| 2026-09-25 | Pinned `74adf65`. Translation started. |
