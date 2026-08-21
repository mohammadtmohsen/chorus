import { watch, type FSWatcher } from 'node:fs'
import { join, sep } from 'node:path'
import type { Logger } from '@chorus/shared'

/**
 * Noticing that a repository moved, so a Changes panel is not showing yesterday.
 *
 * The panel used to be a modal that read git once on mount, which is why it was
 * always slightly wrong: an agent finished a turn behind it and nothing said so.
 *
 * What this emits is a **nudge, not a diff**. Running `git diff` here would mean
 * running it for every conversation whether or not anything is looking, and
 * guessing which base each panel is showing. The renderer knows both, so it
 * re-asks.
 *
 * **One watch where the platform allows it, two where it does not.**
 *
 * - **The worktree**, recursive, for edits made outside Chorus — the editor, or
 *   a person. `recursive` is implemented on macOS and Windows only, so on Linux
 *   this degrades to noticing git operations alone. Degrading is the right
 *   failure: the panel keeps a refresh button, and the alternative is walking
 *   the tree ourselves to plant a watcher per directory, which on a repository
 *   with `node_modules` is thousands of file descriptors for a convenience.
 * - **`.git`**, non-recursive, only on the platforms without a recursive
 *   worktree watch. It used to be added unconditionally, which reported every
 *   git event twice on macOS — `.git` is inside the tree the recursive watch is
 *   already covering.
 *
 * **What this watches is a tree the app itself writes into**, and that is the
 * trap. `git status` takes `.git/index.lock` *and rewrites `.git/index`* — both
 * on a command that prints nothing and changes nothing a person did. So the
 * panel's own read was news to the watcher, which asked the panel to read
 * again: a loop at roughly 2Hz, measured from outside the app as 21 debounced
 * nudges in 12 seconds against an idle repository. It reads as a flickering
 * Refresh button (`disabled={loading}`), an editor that cannot hold focus
 * because its file is reloaded under it, and a main thread pinned in
 * synchronous git beside `better-sqlite3` — which is why dragging stuttered.
 *
 * The filter alone cannot fix it. `index` is exactly what `git add` changes and
 * *nothing else does*, so ignoring it would cost the panel the one signal that
 * a stage made outside Chorus exists — which Phase 2 verified on purpose. The
 * answer has to distinguish our write from theirs, so `suppress` marks the
 * window in which one is ours.
 *
 * **And that window is as narrow as the two files git actually writes.** The
 * first attempt quietened the whole of `.git` for the duration, which the e2e
 * driver rejected within one run: it configures an upstream with four
 * `git config` calls, those write `.git/config` and nothing else, they landed
 * inside a window, and the panel never learned the branch had an upstream at
 * all. `HEAD`, `refs`, `logs` and `config` all say something we did not do, so
 * only `index` and `index.lock` are ever treated as ours.
 */

/** Long enough to swallow a build's worth of writes, short enough to feel live. */
const DEBOUNCE_MS = 400

/**
 * How long after our own git command a `.git` write still counts as ours.
 *
 * FSEvents delivers after the fact, so the events a `git status` caused land
 * once it has already exited. Measured rather than picked: without a grace at
 * all the loop survived, because every cycle's tail arrived just outside its
 * own window. Short enough that a stage made a moment later is still noticed.
 */
const GRACE_MS = 250

/**
 * Paths whose churn says nothing about the change under review.
 *
 * `.git/objects` is the loudest thing in a repository during a commit — hundreds
 * of files — and every one of them is already implied by the `index` write that
 * follows. `node_modules` is the same argument at a larger scale.
 *
 * **`index.lock` is the one that mattered**, and leaving it out made the panel
 * feed itself. Every `git status` and every `git diff` takes that lock before
 * deciding whether the index needs refreshing, so the panel's *own* read
 * created a file inside the tree it was watching: read → lock appears and
 * vanishes → nudge → read. Measured from outside the app against an idle
 * repository with a panel open: 44 raw events and 21 debounced nudges in 12
 * seconds, every one of them `index.lock`, none of them anything else. It reads
 * as a flickering Refresh button — the button is `disabled={loading}` — and it
 * holds the main thread in synchronous git beside `better-sqlite3`, which is
 * what made dragging anything stutter.
 *
 * `index` itself is deliberately **not** here — see `suppress`. A stage rewrites
 * it and nothing else in the repository says so, so it has to keep arriving;
 * what changes is whether we were the one who caused it.
 */
const IGNORED = [
  'node_modules',
  `.git${sep}objects`,
  `.git${sep}lfs`,
  '.git/objects',
  '.git/lfs',
  'index.lock',
]

function isNoise(path: string | null): boolean {
  if (path === null) return false
  return IGNORED.some((fragment) => path.includes(fragment))
}

/**
 * The only two paths a read-only git command writes.
 *
 * `git status` and `git diff` take `.git/index.lock` and rewrite `.git/index`
 * to refresh the stat cache. Nothing else in the repository moves, so nothing
 * else may be attributed to us.
 */
const OWN_WRITES = new Set(['index', 'index.lock'])

function isOwnBookkeeping(path: string | null, inGitDir: boolean): boolean {
  if (path === null) return false
  // The two watches spell the same file differently: the recursive worktree
  // watch reports `.git/index`, the `.git`-rooted fallback reports `index`.
  const base = path.split(/[\\/]/).pop() ?? path
  if (!OWN_WRITES.has(base)) return false
  // A source file named `index` in the worktree is not git's bookkeeping, and
  // suppressing an edit to it would be the bug this whole file is about.
  return inGitDir || path.includes(`.git${sep}`) || path.includes('.git/')
}

export interface WorkspaceWatch {
  close: () => void
  /**
   * Run `fn` with git's own bookkeeping treated as ours rather than as news.
   *
   * Only `.git/index` and `.git/index.lock` are quietened, and only for the
   * length of the call plus a short grace — filesystem events arrive after the
   * process that caused them has exited, so a window that closed with the
   * command would miss its own tail and the loop would survive.
   *
   * Everything else keeps reporting throughout: the worktree, `HEAD`, `refs`,
   * `logs`, `config`. The one thing that can still be missed is somebody else's
   * `git add` landing inside our window, because a bare `index` write is
   * genuinely ambiguous — the panel's Refresh button is the answer to that, and
   * it is a far smaller hole than quietening `.git` wholesale.
   */
  suppress: <T>(fn: () => Promise<T>) => Promise<T>
}

/**
 * Watch one repository, calling `onChange` no more than once per debounce window.
 *
 * Returns a handle even when watching fails. A repository on a filesystem that
 * cannot be watched — a network mount, a container bind — must leave the panel
 * working rather than take the session down with it.
 */
export function watchWorkspace(cwd: string, onChange: () => void, log?: Logger): WorkspaceWatch {
  const watchers: FSWatcher[] = []
  let timer: NodeJS.Timeout | null = null
  let closed = false
  /** How many of our own git commands are in flight for this repository. */
  let reading = 0
  /** When the last of them stopped counting, plus the grace period. */
  let quietUntil = 0

  /*
   * Whether a `.git` write happening now is one of ours.
   *
   * A count rather than a boolean: two panels on the same repository read
   * concurrently, and a boolean cleared by the first to finish would un-quieten
   * the window the second is still inside.
   */
  const ours = (): boolean => reading > 0 || Date.now() < quietUntil

  const nudge =
    (inGitDir: boolean) =>
    (_kind: string, filename: string | Buffer | null): void => {
      if (closed) return
      const name = typeof filename === 'string' ? filename : null
      if (isNoise(name)) return
      if (ours() && isOwnBookkeeping(name, inGitDir)) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (!closed) onChange()
      }, DEBOUNCE_MS)
    }

  const add = (path: string, recursive: boolean, inGitDir: boolean): void => {
    try {
      watchers.push(watch(path, { recursive, persistent: false }, nudge(inGitDir)))
    } catch (error) {
      // Not fatal, and not silent: the panel still refreshes on demand, but
      // "why did it stop updating" should be answerable from the log.
      log?.warn('workspace watch failed', { path, recursive, error: String(error) })
    }
  }

  /*
   * `persistent: false` on both, so a watcher can never be the reason the
   * process refuses to exit.
   *
   * The `.git` watch is the **fallback**, not a companion. A recursive worktree
   * watch already covers `.git`, so adding it unconditionally reported every
   * git event twice — visible in the probe above as 22 `.git/index.lock` plus
   * 22 `index.lock`, the same 22 events named from two watches. Doubling the
   * events doubles the work behind a debounce that a burst can outrun, and buys
   * nothing where `recursive` is implemented. Where it is not — Linux — this is
   * the only thing that notices a commit at all.
   */
  const recursive = process.platform === 'darwin' || process.platform === 'win32'
  add(cwd, recursive, false)
  if (!recursive) add(join(cwd, '.git'), false, true)

  return {
    suppress: async (fn) => {
      reading += 1
      try {
        return await fn()
      } finally {
        reading -= 1
        // Extended on every release, not set once: the last command to finish
        // is the one whose events arrive last.
        quietUntil = Date.now() + GRACE_MS
      }
    },
    close: () => {
      closed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      for (const watcher of watchers) watcher.close()
      watchers.length = 0
    },
  }
}

/**
 * One watch per conversation anyone has actually looked at.
 *
 * Started lazily on the first `workspace:read` rather than when a conversation
 * opens, because most sessions never have a Changes panel opened in them and a
 * recursive watch on a repository with `node_modules` is not free. Stopped when
 * the conversation goes, so the map cannot grow for the life of the process.
 */
export class WorkspaceWatchers {
  private readonly watches = new Map<string, WorkspaceWatch>()

  constructor(
    private readonly onChange: (conversationId: string) => void,
    private readonly log?: Logger
  ) {}

  /** Idempotent: the second call for a conversation is a no-op, not a second watch. */
  ensure(conversationId: string, cwd: string): void {
    if (this.watches.has(conversationId)) return
    this.watches.set(
      conversationId,
      watchWorkspace(
        cwd,
        () => {
          this.onChange(conversationId)
        },
        this.log
      )
    )
  }

  /**
   * Run a git command as ours, so its own `.git` writes are not read as news.
   *
   * A no-op when nothing is watching this conversation — `ensure` is lazy, and
   * a read that arrives before the first one must still run.
   */
  async suppress<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const watch = this.watches.get(conversationId)
    return watch === undefined ? fn() : watch.suppress(fn)
  }

  release(conversationId: string): void {
    this.watches.get(conversationId)?.close()
    this.watches.delete(conversationId)
  }

  closeAll(): void {
    for (const watch of this.watches.values()) watch.close()
    this.watches.clear()
  }
}
