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
