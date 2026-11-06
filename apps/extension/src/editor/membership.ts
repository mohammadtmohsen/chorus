import { MAX_SELECTED_BYTES, toDisplayRange, utf8ByteLength } from '@chorus/ide-protocol/protocol'
import type { EditorLike } from '../../../vscode-extension/src/editor-context.js'
import type { WorkbenchPlace } from '../../../desktop/src/main/project-root.js'
import type {
  WorkbenchContext,
  WorkbenchSnapshot,
} from '../../../desktop/src/shared/workbench-ipc.js'
import { relativePath, type DocumentLocation } from './resources.js'

export interface LocatedEditor {
  readonly editor: EditorLike
  readonly location: DocumentLocation | null
  readonly preview?: true
}

export function contextFor(
  place: WorkbenchPlace,
  trusted: boolean,
  chosen: LocatedEditor | null
): WorkbenchContext {
  const editor = chosen?.editor
  const empty = (reason: WorkbenchContext['reason']): WorkbenchContext => ({
    relativePath: null,
    provenance: { kind: 'worktree' },
    scheme: trusted ? (editor?.uriScheme ?? '') : '',
    editorTypeId: trusted && editor !== undefined ? 'vscode.TextEditor' : '',
    reason,
    startLine: null,
    endLine: null,
    isEmpty: true,
    isDirty: false,
    languageId: '',
    selectedBytes: 0,
    version: null,
  })
  if (!trusted || chosen === null || editor === undefined) return empty('no-editor')
  if (chosen.location === null || editor.provenance === null) return empty('unresolved')
  const relative = relativePath(place, chosen.location)
  if (relative === null) return empty('outside-root')
  const range = toDisplayRange(editor.selection)
  return {
    relativePath: relative,
    provenance: editor.provenance,
    scheme: editor.uriScheme,
    editorTypeId: chosen.preview === true ? 'chorus.markdownPreview' : 'vscode.TextEditor',
    reason: 'ok',
    startLine: range.startLine,
    endLine: range.endLine,
    isEmpty: editor.selection.isEmpty,
    isDirty: editor.isDirty,
    languageId: editor.languageId,
    selectedBytes: utf8ByteLength(editor.selectedText),
    version: chosen.preview === true ? null : editor.documentVersion,
  }
}

export function snapshotFor(
  place: WorkbenchPlace,
  trusted: boolean,
  chosen: LocatedEditor | null
): WorkbenchSnapshot | null {
  const context = contextFor(place, trusted, chosen)
  if (chosen === null || context.reason !== 'ok' || context.selectedBytes > MAX_SELECTED_BYTES)
    return null
  return {
    ...context,
    text: chosen.editor.selectedText,
    ...(chosen.preview === true ? { preview: true as const } : {}),
  }
}

export function containingProjects<T extends WorkbenchPlace>(
  projects: readonly T[],
  location: DocumentLocation
): T[] {
  return projects.filter((project) => relativePath(project, location) !== null)
}

export function deepestProject<T extends WorkbenchPlace>(
  projects: readonly T[],
  location: DocumentLocation
): T | null {
  return containingProjects(projects, location).reduce<T | null>(
    (best, project) => (best === null || project.root.length > best.root.length ? project : best),
    null
  )
}
