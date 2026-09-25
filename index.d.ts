// Derived from chokidar src/index.ts @ 74adf65 (https://github.com/paulmillr/chokidar, branch v6).
// MIT License. Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker.

/*! chokidar - MIT License (c) 2012 Paul Miller (paulmillr.com) */
import { EventEmitter } from 'events'
import type { Stats } from 'fs'
import {
  type ChokidarOptions,
  type EmitArgs,
  EVENTS as EV,
  type EventName,
  type FSWInstanceOptions,
  type Matcher,
  type Path,
  type Scheduler,
  type WatchHandlers,
  type WatchHelper
} from './lib/runtime'

export type {
  AWF,
  BackendStrategy,
  ChokidarOptions,
  EmitArgs,
  EmitArgsWithName,
  EmitErrorArgs,
  FSWInstanceOptions,
  Matcher,
  MatcherObject,
  MatchFunction,
  Scheduler,
  SchedulerTimer,
  Throttler,
  ThrottleType,
  WatchBackend
} from './lib/runtime'

export interface FSWatcherEventMap {
  [EV.READY]: []
  [EV.RAW]: Parameters<WatchHandlers['rawEmitter']>
  [EV.ERROR]: Parameters<WatchHandlers['errHandler']>
  [EV.ALL]: [event: EventName, ...EmitArgs]
  [EV.ADD]: EmitArgs
  [EV.CHANGE]: EmitArgs
  [EV.ADD_DIR]: EmitArgs
  [EV.UNLINK]: EmitArgs
  [EV.UNLINK_DIR]: EmitArgs
}

/**
 * Watches files & directories for changes. Emitted events:
 * `add`, `addDir`, `change`, `unlink`, `unlinkDir`, `all`, `error`
 *
 *     new FSWatcher()
 *       .add(directories)
 *       .on('add', path => log('File', path, 'was added'))
 */
export declare class FSWatcher extends EventEmitter<FSWatcherEventMap> {
  options: FSWInstanceOptions
  private lifecycle
  private tree
  private reconciliation
  private events
  get closed(): boolean
  private ignoredPaths
  private streams
  private pendingAdds
  private pathMutation
  private pathBarriers
  private closePromise?
  private userIgnored?
  private unwatchIgnored?
  private readyEmitted
  private readyPending
  private readyScheduled
  private emitRaw
  private handler
  private scheduler
  constructor(_opts?: ChokidarOptions, scheduler?: Scheduler)
  private addIgnoredPath(matcher: Matcher): void
  private removeIgnoredPath(matcher: Matcher): void
  private ignoredMatcher(matcher: Matcher): Matcher
  private capturePathGeneration(): number
  private invalidatePath(path: Path): void
  private isPathGenerationActive(path: Path, generation: number): boolean
  private queueReady(): void
  /**
   * Adds paths to be watched on an existing FSWatcher instance.
   * @param paths_ file or file list
   */
  add(paths_: Path | Path[]): FSWatcher
  /**
   * Close watchers or start ignoring events from specified paths.
   */
  unwatch(paths_: Path | Path[]): FSWatcher
  /**
   * Close watchers and remove all listeners from watched paths.
   */
  close(): Promise<void>
  /**
   * Expose list of watched paths
   * @returns for chaining
   */
  getWatched(): Record<string, string[]>
  private emitWithAll(event: EventName, args: EmitArgs): void
  /**
   * Normalize and emit events.
   * Calling emitEvent DOES NOT MEAN emit() would be called!
   * @param event Type of event
   * @param path File or directory path
   * @param stats arguments to be passed with event
   */
  private emitEvent(event: EventName, path: Path, stats?: Stats): Promise<void>
  /** Common handler for backend and reconciliation failures. */
  private handleError(error: unknown): void
  /**
   * Determines whether user has asked to ignore this path.
   */
  private isIgnored(path: Path, stats?: Stats): boolean
  private isUnwatched(path: Path): boolean
  /**
   * Provides a set of common helpers and properties relating to symlink handling.
   * @param path file or directory pattern being watched
   */
  private createHelper(path: Path): WatchHelper
  private removeTreeItem(directory: string, item: string): void
  /**
   * Handles emitting unlink events for
   * files and directories, and via recursion, for
   * files and directories within directories that are unlinked
   * @param directory within which the following item is located
   * @param item      base path of item/directory
   */
  private removePath(directory: string, item: string, isDirectory?: boolean): void
  /**
   * Closes all watchers for a path
   */
  private closePath(path: Path, recursive?: boolean): void
  /**
   * Closes only file-specific watchers
   */
  private closeFile(path: Path): void
  private addPathCloser(path: Path, closer: () => void | Promise<void>): void
  private createScanStream
}

/**
 * Instantiates watcher with paths to be tracked.
 * @param paths file / directory paths
 * @param options opts, such as `atomic`, `awaitWriteFinish`, `ignored`, and others
 * @returns an instance of FSWatcher for chaining.
 * @example
 * const watcher = watch('.').on('all', (event, path) => { console.log(event, path); });
 * watch('.', { atomic: true, awaitWriteFinish: true, ignored: (f, stats) => stats?.isFile() && !f.endsWith('.js') })
 */
export declare function watch(paths: string | string[], options?: ChokidarOptions): FSWatcher

/**
 * chokibare only: process-wide counters for logging and tests. `nativeWatches` is the number of
 * shared native directory handles; `inotify` reports the Linux watch budget and how many arms the
 * kernel confirmed.
 */
export declare function facts(): {
  nativeWatches: number
  inotify: { armed: number; limit: number; reserve: number; verified: number }
}
