import { describe, expect, it } from 'vitest'
import { mergeChanges, type DiffLike, type StatusLike } from './changed-files.js'

const d = (path: string, extra: Partial<DiffLike> = {}): DiffLike => ({
  path,
  status: 'modified',
  added: 1,
  removed: 0,
  ...extra,
})

const s = (path: string, extra: Partial<StatusLike> = {}): StatusLike => ({
  path,
  state: 'modified',
  staged: false,
  unstaged: true,
  ...extra,
})

describe('mergeChanges', () => {
  it('carries the diff through with its counts', () => {
    expect(mergeChanges([d('src/a.ts', { added: 4, removed: 2 })], [s('src/a.ts')])).toEqual([
      {
        path: 'src/a.ts',
        status: 'modified',
        added: 4,
        removed: 2,
        staged: false,
        untracked: false,
      },
    ])
  })

  it('marks a file that has content in the index', () => {
    // Staged-ness is not in the diff at all, so a checkbox driven from the diff
    // alone would never tick.
    const [file] = mergeChanges([d('src/a.ts')], [s('src/a.ts', { staged: true })])
    expect(file?.staged).toBe(true)
  })

  it('includes an untracked file the diff cannot describe', () => {
    // `git diff` never lists untracked files. Without this, a brand new file
    // could not be staged from the panel — which is most of what staging is for.
    const merged = mergeChanges([], [s('src/new.ts', { state: 'untracked' })])
    // `status` was `'added'` here until 2026-08-20, which made an untracked file
    // indistinguishable from a staged addition — one row, two meanings, and no
    // way to draw VS Code's `U` and `A` as different letters.
    expect(merged).toEqual([
      {
        path: 'src/new.ts',
        status: 'untracked',
        added: 0,
        removed: 0,
        staged: false,
        untracked: true,
      },
    ])
  })

  it('does not list a file twice when it is both diffed and in status', () => {
    const merged = mergeChanges([d('src/a.ts')], [s('src/a.ts', { state: 'untracked' })])
    expect(merged.map((f) => f.path)).toEqual(['src/a.ts'])
    // The diff won, so it keeps the diff's counts rather than an untracked zero.
    expect(merged[0]?.untracked).toBe(false)
  })

  it('can stage an untracked file that is already staged', () => {
    // A newly added file that has been `git add`ed is still reported by status,
    // and must show as staged rather than as a fresh untracked one.
    const merged = mergeChanges([], [s('src/new.ts', { state: 'untracked', staged: true })])
    expect(merged[0]?.staged).toBe(true)
  })

  it('leaves tracked-but-unchanged files out', () => {
    expect(mergeChanges([], [])).toEqual([])
  })

  it('keeps a conflicted file that has no diff entry', () => {
    // The regression this phase exists for. A path can be conflicted and absent
    // from `git diff` entirely — both sides deleted it, say — and those used to
    // be dropped here, so the panel hid exactly the files a merge needs shown.
    const merged = mergeChanges([], [s('src/clash.ts', { state: 'conflicted' })])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ path: 'src/clash.ts', status: 'conflicted' })
  })

  it('lets a conflict outrank the diff that also describes it', () => {
    // A conflicted file usually DOES have a patch. Showing it as an ordinary
    // modification is how a conflict gets committed by accident.
    const merged = mergeChanges(
      [{ path: 'src/clash.ts', status: 'modified', added: 3, removed: 1 }],
      [s('src/clash.ts', { state: 'conflicted' })]
    )
    expect(merged[0]?.status).toBe('conflicted')
    // The counts still come from the diff — only the state is overridden.
    expect(merged[0]).toMatchObject({ added: 3, removed: 1 })
  })

  it('distinguishes untracked from added', () => {
    // `U` and `A` are different letters in VS Code. Untracked used to report
    // `status: 'added'`, which made them the same row.
    const merged = mergeChanges([], [s('src/new.ts', { state: 'untracked' })])
    expect(merged[0]).toMatchObject({ status: 'untracked', untracked: true })
  })

  it('carries copied and type-changed through from the status', () => {
    // Neither can be expressed by a patch, so the diff calls them something
    // else; the status is the only place the distinction exists.
    const copied = mergeChanges(
      [{ path: 'src/copy.ts', status: 'added', added: 9, removed: 0 }],
      [s('src/copy.ts', { state: 'copied' })]
    )
    expect(copied[0]?.status).toBe('copied')
    const typed = mergeChanges(
      [{ path: 'src/link', status: 'modified', added: 1, removed: 1 }],
      [s('src/link', { state: 'typechanged' })]
    )
    expect(typed[0]?.status).toBe('typechanged')
  })

  it('leaves an ordinary modification to the diff', () => {
    // The override is narrow on purpose: only states the patch cannot express.
    const merged = mergeChanges(
      [{ path: 'src/a.ts', status: 'renamed', added: 2, removed: 2 }],
      [s('src/a.ts', { state: 'modified' })]
    )
    expect(merged[0]?.status).toBe('renamed')
  })
})
