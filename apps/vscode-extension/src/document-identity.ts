/**
 * What a document *is*, when it is not simply a file on disk.
 *
 * The extension used to ask `uriScheme === 'file'` and refuse everything else,
 * which is why a merge request diff and the left pane of a git diff both
 * reported nothing. They are ordinary `TextEditor`s — `vscode.diff` opens two
 * of them — so the selection was always there to read. What was missing is a
 * way to say *which version of the file* the lines belong to.
 *
 * Pure, and free of any `vscode` import, so the parsing can be tested against
 * real captured URI strings rather than through a mock of the editor.
 *
 * **An allowlist of shapes we have actually read, deliberately not Claude
 * Code's blocklist.** Its extension accepts every scheme it has not explicitly
 * excluded and sends `uri.fsPath`, which for a `gl-review:` document is
 * `/src/app.ts` — repo-relative, pointing nowhere. That is invisible there
 * because nothing downstream checks it; here Electron main re-validates every
 * path, so a guessed shape becomes a silent `unmatched` two processes away.
 * A scheme we have not parsed yields nothing, which the pill can explain.
 */

/** Which version of the file the selected lines come from. */
export type Provenance =
  | { readonly kind: 'worktree' }
  /** A git ref: `HEAD`, `~` for the index, or a commit sha. */
  | { readonly kind: 'ref'; readonly ref: string }
  /** A merge request diff pane, identified by the commit it was read at. */
  | {
      readonly kind: 'review'
      readonly commit: string
      readonly changeType: ChangeType
    }

/**
 * The four values GitLab writes, read out of its bundle rather than guessed:
 * `BQe="added", zQe="deleted", VQe="renamed", uhe="modified"`.
 */
export const CHANGE_TYPES = ['added', 'deleted', 'renamed', 'modified'] as const
export type ChangeType = (typeof CHANGE_TYPES)[number]

/** The parts of a `vscode.Uri` this needs. `query` is already decoded there. */
export interface DocumentUri {
  readonly scheme: string
  readonly path: string
  readonly query: string
  readonly fsPath: string
}

export interface ResolvedDocument {
  /** An absolute path in the working tree — where the file lives, or would. */
  readonly filePath: string
  readonly provenance: Provenance
}

/** `JSON.parse` that answers with a value instead of throwing. */
function parseQuery(query: string): Record<string, unknown> | null {
  if (query === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(query)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Join a repo-relative path onto its root, refusing anything that could climb
 * out of it.
 *
 * A `..` segment is rejected rather than resolved: GitLab's `new_path` is a
 * path inside the repository and never legitimately contains one, so the only
 * thing normalising would buy is a way to be wrong quietly. Main re-checks the
 * result regardless — this is disclosure minimisation, not the security
 * boundary.
 */
export function joinInside(root: string, relative: string): string | null {
  if (root === '' || !root.startsWith('/')) return null
  const segments = relative.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) return null
  if (segments.includes('..')) return null
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return `${base}/${segments.join('/')}`
}

function isChangeType(value: unknown): value is ChangeType {
  return typeof value === 'string' && CHANGE_TYPES.includes(value as ChangeType)
}

/**
 * The built-in Git extension's `git:` URIs.
 *
 * `toGitUri` puts the **absolute** path in `query.path` and the ref beside it;
 * `uri.path` itself may have `.git` appended to keep the language id neutral,
 * which is why the query is the only thing read here.
 *
 * An empty ref means the working tree — the same bytes as the file — so it
 * reports `worktree` rather than inventing a version that would need
 * qualifying.
 */
function resolveGit(uri: DocumentUri): ResolvedDocument | null {
  const query = parseQuery(uri.query)
  if (query === null) return null
  const filePath = stringField(query, 'path')
  if (!filePath?.startsWith('/')) return null

  const ref = query['ref']
  if (typeof ref !== 'string') return null
  if (ref === '') return { filePath, provenance: { kind: 'worktree' } }
  return { filePath, provenance: { kind: 'ref', ref } }
}

/**
 * GitLab's merge request diff panes.
 *
 * `toReviewUri` builds `gl-review:<repo-relative path>?<sorted json>`, so the
 * path has to be rejoined to the `repositoryRoot` the query carries — its
 * `fsPath` is the relative path wearing a leading slash and is never a real
 * location.
 *
 * `commit` is the only thing that tells the two panes apart: base and head
 * carry `base_commit_sha` and `head_commit_sha` for the same file, and the
 * paths differ only for a rename. It is also what makes the selection
 * reproducible — `git show <commit>:<path>` is what the GitLab extension reads
 * itself, from the local object store, before falling back to the API.
 *
 * `exists` is about *this side of the diff* having content, not about the file
 * being on disk: it is `!new_file` for base and `!deleted_file` for head. With
 * no content and no commit this is the blank pane opposite an added or deleted
 * file — GitLab's own `isEmptyFileUri` — and there is nothing there to
 * reference.
 */
function resolveReview(uri: DocumentUri): ResolvedDocument | null {
  const query = parseQuery(uri.query)
  if (query === null) return null

  const commit = stringField(query, 'commit')
  const exists = stringField(query, 'exists')
  if (commit === null || exists === null) return null

  const root = stringField(query, 'repositoryRoot')
  if (root === null) return null
  const filePath = joinInside(root, uri.path)
  if (filePath === null) return null

  const changeType = query['changeType']
  if (!isChangeType(changeType)) return null
  return { filePath, provenance: { kind: 'review', commit, changeType } }
}

/**
 * Everything a document can be, or `null` when it is not one this extension
 * can name.
 *
 * `untitled:` is deliberately absent: it has no path at all, so there is
 * nothing an agent could open and nothing to check against a project root.
 * Notebook cells are absent because a cell needs an index carried through the
 * reference to mean anything, which is its own decision.
 */
export function resolveDocument(uri: DocumentUri): ResolvedDocument | null {
  switch (uri.scheme) {
    case 'file':
      return uri.fsPath === '' ? null : { filePath: uri.fsPath, provenance: { kind: 'worktree' } }
    case 'git':
      return resolveGit(uri)
    case 'gl-review':
      return resolveReview(uri)
    default:
      return null
  }
}
