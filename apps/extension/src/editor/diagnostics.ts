import {
  MAX_DIAGNOSTIC_MESSAGE,
  MAX_DIAGNOSTIC_TEXT,
  type DiagnosticParams,
} from '@chorus/ide-protocol/protocol'
import { diagnosticAt, type DiagnosticDocument, type Refusal } from './diagnostic-pick.js'
import type { EditorProject } from './types.js'
import type { DocumentLocation } from './resources.js'
import { deepestProject } from './membership.js'

export function projectDiagnostic(
  projects: readonly EditorProject[],
  trusted: boolean,
  location: DocumentLocation | null,
  document: DiagnosticDocument
): { ok: true; projectId: string; params: DiagnosticParams } | { ok: false; reason: Refusal } {
  if (!trusted) return { ok: false, reason: 'untrusted' }
  if (location === null || document.provenance === null)
    return { ok: false, reason: 'unsupported-document' }
  const project = deepestProject(projects, location)
  if (project === null) return { ok: false, reason: 'outside-roots' }
  const found = diagnosticAt(document)
  if (found === null) return { ok: false, reason: 'no-diagnostic' }
  return {
    ok: true,
    projectId: project.id,
    params: {
      root: project.root,
      filePath: location.filePath,
      languageId: document.languageId,
      provenance: document.provenance,
      severity: found.severity,
      ...(found.source === undefined || found.source === '' ? {} : { source: found.source }),
      ...(found.code === undefined || found.code === '' ? {} : { code: found.code }),
      message: found.message.slice(0, MAX_DIAGNOSTIC_MESSAGE),
      range: {
        start: { line: found.range.start.line, character: found.range.start.character },
        end: { line: found.range.end.line, character: found.range.end.character },
      },
      text: document
        .linesOf(Math.max(0, found.range.start.line - 1), found.range.end.line + 2)
        .slice(0, MAX_DIAGNOSTIC_TEXT),
    },
  }
}
