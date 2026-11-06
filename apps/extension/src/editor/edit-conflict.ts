import type { WorkbenchEditRequest } from '../../../desktop/src/shared/workbench-ipc.js'

export interface EditDocument {
  readonly version: number
  readonly lineCount: number
  readonly lineText: (line: number) => string
  readonly rangeText: (range: WorkbenchEditRequest['range']) => string
}

export type EditConflict = 'version' | 'range' | 'text'

export function editConflict(
  document: EditDocument,
  request: WorkbenchEditRequest
): EditConflict | null {
  if (document.version !== request.baseVersion) return 'version'
  const { startLine, startColumn, endLine, endColumn } = request.range
  if (
    ![startLine, startColumn, endLine, endColumn].every(
      (value) => Number.isInteger(value) && value >= 1
    ) ||
    startLine > document.lineCount ||
    endLine > document.lineCount ||
    endLine < startLine ||
    (endLine === startLine && endColumn < startColumn)
  )
    return 'range'
  if (
    startColumn > document.lineText(startLine - 1).length + 1 ||
    endColumn > document.lineText(endLine - 1).length + 1
  )
    return 'range'
  return document.rangeText(request.range) === request.oldText ? null : 'text'
}
