/**
 * One list of what changed, from the two things git reports separately.
 *
 * `git diff` gives content — hunks, and how many lines moved. `git status`
 * gives *state* — whether a path is staged, and whether git has ever seen it.
 * A review panel only needed the first. A source-control panel needs both, and
 * needs them reconciled:
 *
 * - **`git diff` never lists untracked files.** That is git's behaviour, not an
 *   omission, and it is recorded with a test in `git.test.ts`. Left alone it
 *   means a brand new file cannot be staged from the panel, which is most of
 *   what staging is for.
 * - **Staged-ness is not in the diff at all**, so a checkbox driven from it
 *   would never tick.
 *
 * Pure and exported, so the reconciliation is testable without a repository.
 */

export interface DiffLike {
  readonly path: string
  readonly status: 'added' | 'removed' | 'modified' | 'renamed'
  readonly added: number
  readonly removed: number
}

export interface StatusLike {
  readonly path: string
  readonly state:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'typechanged'
    | 'untracked'
    | 'conflicted'
  readonly staged: boolean
  readonly unstaged: boolean
}

/**
 * What the list draws, per file.
 *
 * `status` is deliberately wider than `DiffLike['status']`. The diff can only
 * say what happened to the *content* — added, removed, modified, renamed — while
 * `git status` knows things a patch cannot express: that a path is untracked,
 * that it is a copy rather than a move, that its type changed, that it is
 * conflicted. This union is the two vocabularies merged, and the status side
 * wins wherever it knows more.
 *
 * Until 2026-08-20 it was the narrow four, so **a conflicted path with no diff
 * entry vanished from the list entirely** — the file you most need to see during
 * a merge was the one the panel could not show.
 */
export interface ChangedFile {
  readonly path: string
  readonly status:
    | 'added'
    | 'removed'
    | 'modified'
    | 'renamed'
    | 'copied'
    | 'typechanged'
    | 'untracked'
    | 'conflicted'
  readonly added: number
  readonly removed: number
  /** Has content in the index. Drives the checkbox and the two groups. */
  readonly staged: boolean
  /** git has never seen this path — it can be staged, but not diffed. */
  readonly untracked: boolean
}

/**
 * States `git status` knows better than the diff does.
 *
 * For these the status wins even when the path also appears in the diff: a
 * conflicted file still has a patch, and showing it as an ordinary
 * modification is how a merge conflict gets committed by accident.
 */
const STATUS_WINS = ['conflicted', 'copied', 'typechanged'] as const

/*
 * A guard rather than a `Set<string>`, so the narrowing is real.
 *
 * With a plain set the ternary below kept the whole `StatusLike['state']` union
 * — including `deleted`, which is the status's word for what the diff calls
 * `removed`. Typecheck caught it; a cast would have shipped a row whose letter
 * lookup misses.
 */
function statusWins(state: StatusLike['state'] | undefined): state is (typeof STATUS_WINS)[number] {
  return state !== undefined && (STATUS_WINS as readonly string[]).includes(state)
}

export function mergeChanges(
  diff: readonly DiffLike[],
  status: readonly StatusLike[]
): ChangedFile[] {
  const stagedPaths = new Set(status.filter((f) => f.staged).map((f) => f.path))
  const byPath = new Map(status.map((f) => [f.path, f]))
  const seen = new Set<string>()

  const merged: ChangedFile[] = diff.map((file) => {
    seen.add(file.path)
    // The diff describes the content; the status may know something the patch
    // cannot express. Where it does, it wins — see `STATUS_WINS`.
    const state = byPath.get(file.path)?.state
    return {
      path: file.path,
      status: statusWins(state) ? state : file.status,
      added: file.added,
      removed: file.removed,
      staged: stagedPaths.has(file.path),
      untracked: false,
    }
  })

  /*
   * Everything the diff cannot describe: untracked files, and conflicts.
   *
   * **Untracked** — counts of zero rather than a guess. The file's whole content
   * is "added" in one sense, but reading it to say so would mean reading every
   * untracked file in the project to draw a list. The status letter carries the
   * meaning. It reports `status: 'untracked'` rather than `'added'`, so `U` and
   * `A` stay distinguishable the way VS Code distinguishes them.
   *
   * **Conflicted** — a path can be conflicted and absent from `git diff`
   * entirely (both sides deleted it, say). Those used to be dropped here, which
   * meant the panel hid the files a merge most needs to show.
   */
  for (const file of status) {
    if (seen.has(file.path)) continue
    if (file.state !== 'untracked' && file.state !== 'conflicted') continue
    seen.add(file.path)
    merged.push({
      path: file.path,
      status: file.state,
      added: 0,
      removed: 0,
      staged: stagedPaths.has(file.path),
      untracked: file.state === 'untracked',
    })
  }

  return merged
}
