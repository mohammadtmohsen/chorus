import {
  MAX_SELECTED_BYTES,
  utf8ByteLength,
  type EditorMetadata,
  type IdeStatus,
  type Provenance,
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
  /** Kept for diagnostics: which scheme was refused is the useful half. */
  readonly uriScheme: string
  /**
   * The absolute working-tree path `document-identity.ts` resolved, which for a
   * `gl-review:` document is nothing like the document's own `fsPath`.
   *
   * Meaningless when `provenance` is null, and unreachable in that case: every
   * path that reads this asks `isSupported` first.
   */
  readonly filePath: string
  /**
   * Which version of the file the lines are, or null when this is not a
   * document that can be referenced at all.
   */
  readonly provenance: Provenance | null
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

/** An editor whose document has a name and a version. */
export interface ReferenceableEditor extends EditorLike {
  readonly provenance: Provenance
}

/**
 * Whether a document is something Chorus can hand an agent a path to.
 *
 * This asked `uriScheme === 'file'` until 2026-08-13, which refused the two
 * panes of every diff. The question is now whether `resolveDocument` could say
 * what the document is — a path *and* which version of it — because a path
 * without a version is what makes a merge request selection a lie.
 */
export function isSupported(editor: EditorLike | null): editor is ReferenceableEditor {
  return editor !== null && editor.provenance !== null
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

export function metadataFor(
  editor: ReferenceableEditor,
  source: 'current' | 'cached'
): EditorMetadata {
  return {
    source,
    filePath: editor.filePath,
    fileUrl: editor.fileUrl,
    languageId: editor.languageId,
    documentVersion: editor.documentVersion,
    isDirty: editor.isDirty,
    provenance: editor.provenance,
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
 * **Forgetting is only correct for another project's file.** Until 2026-08-13
 * one rule served two situations: "the user is now looking at a file from
 * somewhere else" and "the user is now looking at something that is not a file
 * at all" both threw the selection away. The second is wrong, and it is the
 * common one — the left pane of a git diff is `git:`, a scratch buffer is
 * `untitled:`, and clicking either wiped the pill. Claude Code's extension
 * keeps its cached selection until the last visible editor closes; this is the
 * same idea with the project rule left intact.
 *
 * What it costs is staleness: a remembered selection can be minutes old. It is
 * marked `cached` for exactly that reason, and Send re-asks the editor rather
 * than trusting it.
 */
export class SelectionCache {
  #last: ReferenceableEditor | null = null

  /** Record the current editor, if it says anything about what to remember. */
  observe(editor: EditorLike | null, roots: readonly string[]): void {
    if (editor === null) return
    /*
     * Not referenceable at all — an output channel, the `git:` side of a diff,
     * a notebook cell. The user has not moved to another project; they have
     * looked at something this extension has no name for, and what they had
     * selected before is still the best answer.
     */
    if (!isSupported(editor)) return
    this.#last = roots.some((r) => isInside(r, editor.filePath)) ? editor : null
  }

  /**
   * The editor to report, and whether it is live or remembered.
   *
   * The current editor wins only when it is one that can be referenced.
   * Preferring it unconditionally — which this did until 2026-08-13 — meant
   * `observe` could keep a perfectly good selection that `resolve` then refused
   * to use, because `activeTextEditor` survives the window losing focus to
   * Chorus. Both halves have to agree or neither is visible.
   */
  resolve(editor: EditorLike | null): { editor: EditorLike | null; source: 'current' | 'cached' } {
    if (editor !== null && isSupported(editor)) return { editor, source: 'current' }
    if (this.#last !== null) return { editor: this.#last, source: 'cached' }
    // Null and unsupported both report `unsupported`, so there is nothing to
    // choose between them here.
    return { editor: null, source: 'current' }
  }

  /**
   * Drop the cache if the document it holds is the one that just closed.
   *
   * Keyed on the URL rather than the path, because that is what identifies a
   * document across schemes. Without this, "keep what we had" can outlive the
   * buffer it describes — a tab closed an hour ago still offering its lines.
   */
  forget(fileUrl: string): void {
    if (this.#last?.fileUrl === fileUrl) this.#last = null
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
