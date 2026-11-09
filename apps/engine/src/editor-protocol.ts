import { z } from 'zod'

export const EditorPlace = z.object({ host: z.string(), root: z.string().min(1) })
export const EditorEditRequest = z.object({
  requestId: z.string(),
  path: z.string(),
  baseVersion: z.number().int(),
  range: z.object({
    startLine: z.number().int(),
    startColumn: z.number().int(),
    endLine: z.number().int(),
    endColumn: z.number().int(),
  }),
  oldText: z.string(),
  newText: z.string(),
})
export const EditorAskDiffRequest = z.object({
  requestId: z.string(),
  approvalId: z.string(),
  path: z.string(),
  before: z.string().nullable(),
  proposed: z.string(),
  close: z.boolean().optional(),
  revealPath: z.string().optional(),
})
const EditorReviewDiffVersion = z.object({
  requestId: z.string(),
  iid: z.number().int().positive(),
  versionId: z.number().int().positive(),
})
export const EditorReviewDiffRequest = z.union([
  EditorReviewDiffVersion.extend({
    path: z.string().min(1),
    oldPath: z.string().min(1),
    before: z.string(),
    after: z.string(),
    workspace: z.boolean(),
  }),
  EditorReviewDiffVersion.extend({
    title: z.string().min(1),
    files: z
      .array(
        z.object({
          path: z.string().min(1),
          oldPath: z.string().min(1),
          before: z.string(),
          after: z.string(),
          workspace: z.boolean(),
        })
      )
      .min(1),
  }),
])
export const EditorReviewDiffResult = z.object({
  requestId: z.string(),
  ok: z.boolean(),
  failure: z.enum(['no-editor', 'open-failed']).optional(),
  message: z.string().optional(),
})
