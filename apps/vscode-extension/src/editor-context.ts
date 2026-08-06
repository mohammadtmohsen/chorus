import {
  MAX_SELECTED_BYTES,
  utf8ByteLength,
  type EditorMetadata,
  type IdeStatus,
} from '@chorus/ide-protocol'

/**
 * Deciding what this window may say about each of Chorus's roots.
 *
 * Deliberately free of any `vscode` import: the module is structural, so the
 * rules that govern disclosure can be tested directly instead of through a
 * mock of the editor. `extension.ts` is the only file that knows what a
 * `TextEditor` is, and its job is to fill in the shapes below.
 */

/** The parts of an active editor this extension is allowed to look at. */
export interface EditorLike {
  /** `file` for a real document on disk; anything else is out of scope for v1. */
  readonly uriScheme: string
  readonly filePath: string
  readonly fileUrl: string
  readonly languageId: string
  readonly documentVersion: number
  readonly isDirty: boolean
  readonly selection: {
    readonly start: { readonly line: number; readonly character: number }
    readonly end: { readonly line: number; readonly character: number }
    readonly isEmpty: boolean
  }
  /** The selected text, used for its size only until Send asks for it. */
  readonly selectedText: string
}

export interface RootReport {
  readonly root: string
  readonly status: IdeStatus
  readonly editor: EditorMetadata | null
}

export interface WindowFacts {
  /** Canonical workspace folders, already resolved by the caller. */
  readonly workspaceFolders: readonly string[]
  readonly isTrusted: boolean
}

/** Whether a document is something Chorus can hand an agent a path to. */
export function isSupported(editor: EditorLike | null): editor is EditorLike {
  return editor !== null && editor.uriScheme === 'file'
}

/**
 * Path containment, on segments.
 *
 * The extension gets the cheap version of this check and Electron main gets
 * the authoritative one. Here it exists to avoid disclosing a path at all;
 * there it exists because a client cannot be trusted. Both must agree that
 * `/a/project-old` is not inside `/a/project`.
 */
export function isInside(root: string, filePath: string): boolean {
  if (filePath === root) return true
  return filePath.startsWith(root.endsWith('/') ? root : `${root}/`)
}

export function metadataFor(editor: EditorLike, source: 'current' | 'cached'): EditorMetadata {
  return {
    source,
    filePath: editor.filePath,
    fileUrl: editor.fileUrl,
    languageId: editor.languageId,
    documentVersion: editor.documentVersion,
    isDirty: editor.isDirty,
    selection: {
      start: { line: editor.selection.start.line, character: editor.selection.start.character },
      end: { line: editor.selection.end.line, character: editor.selection.end.character },
      isEmpty: editor.selection.isEmpty,
      // Travels on the live frame so an oversized selection is visible before
      // Send, without the text itself ever leaving the editor.
      selectedBytes: utf8ByteLength(editor.selectedText),
    },
  }
}

/**
 * What this window can say about one root.
 *
 * The order of these checks is the disclosure policy. A path is only ever
 * attached once the root is open here, the workspace is trusted, and the file
 * is inside that root — so a document from another project cannot reach Chorus
 * even as a name.
 */
export function reportFor(
  root: string,
  facts: WindowFacts,
  editor: EditorLike | null,
  source: 'current' | 'cached'
): RootReport {
  const bare = (status: IdeStatus): RootReport => ({ root, status, editor: null })

  // Equality, not containment: opening the parent of a project would silently
  // widen the scope of everything reported from here.
  if (!facts.workspaceFolders.includes(root)) return bare('unmatched')
  if (!facts.isTrusted) return bare('untrusted')
  if (editor === null) return bare('unsupported')
  if (!isSupported(editor)) return bare('unsupported')

  /*
   * The root is open, but the user is looking at a file from somewhere else —
   * a sibling folder of a multi-root window, or a file opened from outside any
   * project. There is no context to give for *this* root, and saying so as
   * `unmatched` is the truth: nothing here matches that project right now.
   */
  if (!isInside(root, editor.filePath)) return bare('unmatched')

  const metadata = metadataFor(editor, source)
  if (metadata.selection.selectedBytes > MAX_SELECTED_BYTES) {
    // Still names the file: the pill has to say which selection is too large.
    return { root, status: 'tooLarge', editor: metadata }
  }
  return { root, status: 'ready', editor: metadata }
}

/**
 * The last editor that was eligible, kept so the context survives focus moving
 * away (plan §2).
 *
 * VS Code has no active text editor while focus is in its terminal, its
 * sidebar, or another application — which is every moment the user is actually
 * reaching for the Chorus composer. Without this the pill would empty exactly
 * when it is about to be used.
 *
 * The cache is cleared whenever there *is* a current editor that is not
 * eligible, so an unrelated file never falls back to an older in-project
 * selection. Absence of an editor is remembered; the wrong editor is not.
 */
export class SelectionCache {
  #last: EditorLike | null = null

  /** Record the current editor, and report what should be used in its place. */
  observe(editor: EditorLike | null, roots: readonly string[]): void {
    if (editor === null) return
    const eligible = isSupported(editor) && roots.some((r) => isInside(r, editor.filePath))
    this.#last = eligible ? editor : null
  }

  /** The editor to report, and whether it is live or remembered. */
  resolve(editor: EditorLike | null): { editor: EditorLike | null; source: 'current' | 'cached' } {
    if (editor !== null) return { editor, source: 'current' }
    if (this.#last !== null) return { editor: this.#last, source: 'cached' }
    return { editor: null, source: 'current' }
  }

  clear(): void {
    this.#last = null
  }
}

/** Every root's report for this window, in one frame. */
export function reportAll(
  roots: readonly string[],
  facts: WindowFacts,
  editor: EditorLike | null,
  cache: SelectionCache
): RootReport[] {
  cache.observe(editor, facts.workspaceFolders)
  const resolved = cache.resolve(editor)
  return roots.map((root) => reportFor(root, facts, resolved.editor, resolved.source))
}
