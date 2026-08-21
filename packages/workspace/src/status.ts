/**
 * Parsing `git status --porcelain=v2 --branch`.
 *
 * Porcelain v2 rather than v1 because it is the only format git promises not to
 * change, and it carries the branch and ahead/behind counts in the same call —
 * which matters when the point is to answer "what did the agent just do to my
 * repo" in one round trip.
 *
 * Pure, so the parsing is tested against recorded output rather than against a
 * repository whose state has to be constructed first.
 */

/**
 * The states porcelain v2 can report, minus the one deliberately not asked for.
 *
 * `copied` and `typechanged` were folded into `renamed` and `modified` until
 * 2026-08-20 — not because git does not report them, but because nothing read
 * them. VS Code distinguishes both (`C` and `T`), so matching its vocabulary
 * meant widening this first; the letters cannot be added at the end of a pipe
 * that already threw the distinction away.
 *
 * **`ignored` is absent on purpose.** git only reports it with `--ignored`,
 * which `readStatus` does not pass and VS Code's own status command does not
 * either — it runs `-uall`/`-uno`. Asking for it would mean enumerating
 * `node_modules` to populate a letter no upstream UI shows.
 */
export type FileState =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechanged'
  | 'untracked'
  | 'conflicted'

export interface ChangedFile {
  readonly path: string
  /** Set only for a rename. */
  readonly from?: string
  readonly state: FileState
  readonly staged: boolean
  readonly unstaged: boolean
}

export interface WorkspaceStatus {
  readonly branch: string | null
  /** Null when the branch has no upstream. */
  readonly upstream: string | null
  readonly ahead: number
  readonly behind: number
  readonly files: readonly ChangedFile[]
  readonly clean: boolean
}

export const EMPTY_STATUS: WorkspaceStatus = {
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  clean: true,
}

export function parseStatus(output: string): WorkspaceStatus {
  let branch: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: ChangedFile[] = []

  for (const line of output.split('\n')) {
    if (line === '') continue

    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      // A repo with no commits yet reports "(detached)" or a literal head name.
      branch = head === '(detached)' ? null : head
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim()
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line)
      ahead = Number(match?.[1] ?? 0)
      behind = Number(match?.[2] ?? 0)
      continue
    }
    if (line.startsWith('#')) continue

    const entry = parseEntry(line)
    if (entry !== null) files.push(entry)
  }

  return { branch, upstream, ahead, behind, files, clean: files.length === 0 }
}

function parseEntry(line: string): ChangedFile | null {
  const kind = line[0]

  if (kind === '?') {
    return { path: line.slice(2), state: 'untracked', staged: false, unstaged: true }
  }
  // Ignored entries only appear with --ignored, and are never interesting here.
  if (kind === '!') return null

  if (kind === 'u') {
    const path = line.split(' ').slice(10).join(' ')
    return { path, state: 'conflicted', staged: false, unstaged: true }
  }

  if (kind === '1' || kind === '2') {
    const fields = line.split(' ')
    const xy = fields[1] ?? '..'
    // XY is git's two-column code: staged state, then working-tree state.
    const [x = '.', y = '.'] = xy
    const staged = x !== '.'
    const unstaged = y !== '.'

    if (kind === '2') {
      /*
       * A rename packs both paths into the tail, tab-separated.
       *
       * Kind `2` is "renamed **or copied**", and which one is in the XY code:
       * `R` for a rename, `C` for a copy. Every kind-`2` line was read as a
       * rename until 2026-08-20, so a copied file reported its source as if the
       * original had moved — the one place where the old collapse was not just
       * a missing letter but a false statement about the tree.
       */
      const tail = fields.slice(9).join(' ')
      const [path = '', from = ''] = tail.split('\t')
      return { path, from, state: xy.includes('C') ? 'copied' : 'renamed', staged, unstaged }
    }

    return {
      path: fields.slice(8).join(' '),
      state: stateFromXy(xy),
      staged,
      unstaged,
    }
  }

  return null
}

function stateFromXy(xy: string): FileState {
  // Whichever side has a code wins; a file staged as added and then modified in
  // the working tree is still, to a reader, an added file.
  const codes = `${xy[0] ?? '.'}${xy[1] ?? '.'}`
  if (codes.includes('A')) return 'added'
  if (codes.includes('D')) return 'deleted'
  if (codes.includes('R')) return 'renamed'
  // A regular file becoming a symlink, or the reverse. Rare, and it used to
  // fall through to `modified` — which is what it looks like in a diff and not
  // what happened to the file.
  if (codes.includes('T')) return 'typechanged'
  return 'modified'
}
