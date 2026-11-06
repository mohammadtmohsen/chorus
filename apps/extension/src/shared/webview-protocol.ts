import { z } from 'zod'
import { EngineActivity } from '../../../engine/src/protocol.js'
import { IPC_CONTRACT } from '../../../desktop/src/shared/ipc.js'
import { TRAFFIC_CONTRACT } from '../../../desktop/src/shared/traffic-ipc.js'
import { RUN_CONTRACT } from '../../../desktop/src/shared/run-ipc.js'
import { CONSOLE_CONTRACT } from '../../../desktop/src/shared/console-ipc.js'
import { BROWSER_CONTRACT } from '../../../desktop/src/shared/browser-ipc.js'

export const SHELL_CHANNELS = new Set([
  ...Object.keys(IPC_CONTRACT),
  ...Object.keys(TRAFFIC_CONTRACT),
  ...Object.keys(RUN_CONTRACT),
  ...Object.keys(CONSOLE_CONTRACT),
  ...Object.keys(BROWSER_CONTRACT),
])

export const ShellViewFocusMessage = z.object({
  kind: z.literal('viewFocus'),
  focused: z.boolean(),
})

export const ShellHostMessage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('boot'),
    storage: z.record(z.string(), z.string()),
    imageBase: z.string(),
  }),
  z.object({
    kind: z.literal('answer'),
    id: z.string(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({ kind: z.literal('push'), channel: z.string(), payload: z.unknown().optional() }),
  z.object({
    kind: z.literal('state'),
    state: z.enum(['connecting', 'connected', 'reconnecting', 'stopped', 'restart-required']),
    activity: EngineActivity.optional(),
  }),
  z.object({ kind: z.literal('showProject'), projectId: z.string() }),
  z.object({
    kind: z.literal('projectAdopted'),
    project: z.object({ id: z.string(), created: z.boolean() }),
  }),
])
export type ShellHostMessage = z.infer<typeof ShellHostMessage>
