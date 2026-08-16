import { describe, expect, it } from 'vitest'
import { joinInside, resolveDocument, type DocumentUri } from './document-identity.js'

/**
 * The URI strings here are the real shapes, taken from the two extensions'
 * bundles rather than from memory — `toGitUri` in VS Code's git extension and
 * `toReviewUri` in `gitlab.gitlab-workflow-6.86.0`. Guessing them is the
 * failure this whole module exists to avoid.
 */

/*
 * Every call below names `'darwin'`.
 *
 * The fixtures are POSIX — `/Users/me/repo`, `/src/app.ts` — and what counts as
 * an absolute path is a platform question, so without naming one these asserted
 * whichever host they ran on. On the Windows runner `hasRoot('/Users/me/repo')`
 * is false, because a rooted path with no drive letter cannot be located, and
 * seven tests went red for a reason that had nothing to do with what they test.
 */
const REPO = '/Users/me/repo'

const uri = (over: Partial<DocumentUri>): DocumentUri => ({
  scheme: 'file',
  path: `${REPO}/src/app.ts`,
  query: '',
  fsPath: `${REPO}/src/app.ts`,
  ...over,
})

/** `Uri.file(path).with({ scheme: 'gl-review', query })`, keys sorted. */
const review = (over: Record<string, unknown> = {}, path = '/src/app.ts'): DocumentUri =>
  uri({
    scheme: 'gl-review',
    path,
    // `fsPath` of such a URI is the relative path wearing a leading slash —
    // exactly the value that must never be used.
    fsPath: path,
    query: JSON.stringify({
      changeType: 'modified',
      commit: 'a1b2c3d4e5f6',
      exists: '1',
      mrId: 456,
      projectId: 123,
      repositoryRoot: REPO,
      ...over,
    }),
  })

const git = (ref: string, path = `${REPO}/src/app.ts`): DocumentUri =>
  uri({
    scheme: 'git',
    // The git extension appends `.git` to keep the language id neutral, which
    // is why the query is the only thing read.
    path: `${path}.git`,
    fsPath: `${path}.git`,
    query: JSON.stringify({ path, ref }),
  })

describe('joinInside', () => {
  it('joins a repo-relative path onto its root', () => {
    expect(joinInside(REPO, '/src/app.ts', 'darwin')).toBe(`${REPO}/src/app.ts`)
    expect(joinInside(`${REPO}/`, 'src/app.ts', 'darwin')).toBe(`${REPO}/src/app.ts`)
  })

  /* A path from a merge request never legitimately climbs out of the repo, so
     this refuses rather than normalising and being wrong quietly. */
  it('refuses to climb out of the root', () => {
    expect(joinInside(REPO, '/../../etc/passwd', 'darwin')).toBeNull()
    expect(joinInside(REPO, '/src/../../x', 'darwin')).toBeNull()
  })

  it('refuses a root that is not absolute, and an empty path', () => {
    expect(joinInside('repo', '/src/a.ts', 'darwin')).toBeNull()
    expect(joinInside(REPO, '/', 'darwin')).toBeNull()
  })
})

describe('resolveDocument — file', () => {
  it('is the working tree', () => {
    expect(resolveDocument(uri({}))).toEqual({
      filePath: `${REPO}/src/app.ts`,
      provenance: { kind: 'worktree' },
    })
  })
})

describe('resolveDocument — git', () => {
  it('reads the absolute path out of the query, not the path', () => {
    expect(resolveDocument(git('HEAD'))).toEqual({
      filePath: `${REPO}/src/app.ts`,
      provenance: { kind: 'ref', ref: 'HEAD' },
    })
  })

  it('keeps the index and a commit apart', () => {
    expect(resolveDocument(git('~'))?.provenance).toEqual({ kind: 'ref', ref: '~' })
    expect(resolveDocument(git('9f1c2ab'))?.provenance).toEqual({ kind: 'ref', ref: '9f1c2ab' })
  })

  /* An empty ref *is* the working tree, so qualifying it would invent a
     version that does not exist. */
  it('treats an empty ref as the working tree', () => {
    expect(resolveDocument(git(''))?.provenance).toEqual({ kind: 'worktree' })
  })

  it('refuses a query it cannot read', () => {
    expect(resolveDocument(uri({ scheme: 'git', query: 'not json' }))).toBeNull()
    expect(resolveDocument(uri({ scheme: 'git', query: '{"ref":"HEAD"}' }))).toBeNull()
    expect(resolveDocument(uri({ scheme: 'git', query: '{"path":"relative/x.ts"}' }))).toBeNull()
  })
})

describe('resolveDocument — gl-review', () => {
  /*
   * The reason this module exists. `fsPath` here is `/src/app.ts`: a
   * real-looking absolute path that is outside every project. Claude Code
   * sends exactly that.
   */
  it('rejoins the repo-relative path onto the repository root', () => {
    expect(resolveDocument(review())).toEqual({
      filePath: `${REPO}/src/app.ts`,
      provenance: { kind: 'review', commit: 'a1b2c3d4e5f6' },
    })
  })

  /* Base and head differ only by commit — the path is the same unless the file
     was renamed. Losing it makes the two panes indistinguishable. */
  it('keeps the two panes of one file apart by commit', () => {
    const base = resolveDocument(review({ commit: 'base111' }))
    const head = resolveDocument(review({ commit: 'head222' }))
    expect(base?.filePath).toBe(head?.filePath)
    expect(base?.provenance).not.toEqual(head?.provenance)
  })

  /*
   * GitLab's `isEmptyFileUri`: `!exists || !commit`. This is the blank pane
   * opposite an added or a deleted file, and there is nothing in it to refer
   * to.
   */
  it('refuses the empty pane opposite an added or deleted file', () => {
    expect(resolveDocument(review({ exists: '' }))).toBeNull()
    expect(resolveDocument(review({ commit: '' }))).toBeNull()
  })

  /*
   * Validated as a shape check and then dropped. An unexpected value means this
   * is not the URI shape we read out of the bundle, and refusing beats
   * misparsing — but nothing downstream reads it, because the commit already
   * covers the rename case: `git show <commit>:<old path>` works.
   */
  it('checks the change type against the closed set, and carries none of it', () => {
    expect(resolveDocument(review({ changeType: 'renamed' }))?.provenance).toEqual({
      kind: 'review',
      commit: 'a1b2c3d4e5f6',
    })
    expect(resolveDocument(review({ changeType: 'invented' }))).toBeNull()
  })

  it('refuses a query with no repository root to rejoin against', () => {
    expect(resolveDocument(review({ repositoryRoot: '' }))).toBeNull()
    expect(resolveDocument(uri({ scheme: 'gl-review', query: '' }))).toBeNull()
  })

  it('refuses a path that climbs out of the repository', () => {
    expect(resolveDocument(review({}, '/../../../etc/passwd'))).toBeNull()
  })
})

describe('resolveDocument — everything else', () => {
  /*
   * An allowlist: a scheme nobody has read yields nothing, rather than a path
   * that looks plausible and is wrong. `untitled:` has no path at all.
   */
  it.each(['untitled', 'output', 'vscode-notebook-cell', 'gitlab-remote', 'pr', 'vscode-userdata'])(
    'refuses %s',
    (scheme) => {
      expect(resolveDocument(uri({ scheme }))).toBeNull()
    }
  )
})
