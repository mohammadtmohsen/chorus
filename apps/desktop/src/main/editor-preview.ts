import type { EditorEditApproval } from '@chorus/agent-protocol'
import { parseDiff } from '@chorus/workspace'
import type { WorkbenchEditRequest } from '../shared/workbench-ipc.js'

export function editorApprovalRequest(
  request: Pick<EditorEditApproval, 'path' | 'version' | 'range' | 'patch'>
): Omit<WorkbenchEditRequest, 'requestId'> {
  const lines = parseDiff(
    `diff --git a/${request.path} b/${request.path}\n${request.patch}`
  ).flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines))
  return {
    path: request.path,
    baseVersion: request.version,
    range: request.range,
    oldText: lines
      .filter((line) => line.kind === 'removed' || line.kind === 'context')
      .map((line) => line.text)
      .join('\n'),
    newText: lines
      .filter((line) => line.kind === 'added' || line.kind === 'context')
      .map((line) => line.text)
      .join('\n'),
  }
}
