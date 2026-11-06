import { z } from 'zod'

export const BrowserHostState = z.object({
  tabId: z.string().min(1),
  projectId: z.string().nullable(),
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  generation: z.number().int().nonnegative(),
  closed: z.boolean().optional(),
  error: z.string().optional(),
})
export type BrowserHostState = z.infer<typeof BrowserHostState>

const Target = z.object({
  tabId: z.string().min(1),
  projectId: z.string().nullable(),
  generation: z.number().int().nonnegative(),
})

export const BrowserHostEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), state: BrowserHostState }),
  Target.extend({ kind: z.literal('cdp'), method: z.string(), params: z.unknown().optional() }),
  Target.extend({ kind: z.literal('navigated'), url: z.string() }),
  Target.extend({ kind: z.literal('crashed'), reason: z.string() }),
  Target.extend({ kind: z.literal('gone') }),
])
export type BrowserHostEvent = z.infer<typeof BrowserHostEvent>
