import { AgentIdSchema } from '@chorus/shared'
import { z } from 'zod'
import { BrowserId, BrowserProjectId } from './browser-ipc.js'

export const CONSOLE_ENTRIES_MAX = 1_000
export const CONSOLE_PUSH_ENTRIES_MAX = 200
export const CONSOLE_TEXT_MAX = 8_192
export const CONSOLE_EXPRESSION_MAX = 65_536
export const CONSOLE_VALUE_TEXT_MAX = 2_048
export const CONSOLE_VALUES_MAX = 20
export const CONSOLE_FRAMES_MAX = 10
export const CONSOLE_URL_MAX = 2_048
export const CONSOLE_NAME_MAX = 512
export const CONSOLE_METHOD_MAX = 32
export const CONSOLE_HISTORY_MAX = 100
export const CONSOLE_PROPERTIES_MAX = 200
export const CONSOLE_SOURCES_MAX = 8
export const CONSOLE_DROPPED_MAX = Number.MAX_SAFE_INTEGER

export const ConsoleToken = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)
export const ConsoleSubscriptionId = z.string().min(1).max(128)

export const ConsoleState = z.enum(['no-page', 'connecting', 'ready', 'paused', 'unavailable'])
export type ConsoleState = z.infer<typeof ConsoleState>

export const ConsoleLevel = z.enum(['error', 'warning', 'info', 'log', 'debug'])
export type ConsoleLevel = z.infer<typeof ConsoleLevel>

export const ConsoleActor = z.union([z.literal('user'), AgentIdSchema])
export type ConsoleActor = z.infer<typeof ConsoleActor>

export const ConsoleEntryKind = z.enum([
  'console',
  'exception',
  'browser',
  'command',
  'result',
  'navigation',
  'crash',
])
export type ConsoleEntryKind = z.infer<typeof ConsoleEntryKind>

export const ConsoleRunStatus = z.enum(['ok', 'threw', 'timeout', 'interrupted', 'failed'])
export type ConsoleRunStatus = z.infer<typeof ConsoleRunStatus>

export const ConsoleStartStatus = z.enum([
  'started',
  'no-page',
  'connecting',
  'paused',
  'unavailable',
  'busy',
  'invalid',
])
export type ConsoleStartStatus = z.infer<typeof ConsoleStartStatus>

export const ConsoleValueType = z.enum([
  'string',
  'number',
  'boolean',
  'undefined',
  'symbol',
  'bigint',
  'object',
  'function',
  'accessor',
])
export type ConsoleValueType = z.infer<typeof ConsoleValueType>

const ConsoleUrl = z.string().max(CONSOLE_URL_MAX)
const ConsolePosition = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

export const ConsoleLocation = z
  .object({ url: ConsoleUrl, line: ConsolePosition, column: ConsolePosition })
  .strict()
export type ConsoleLocation = z.infer<typeof ConsoleLocation>

export const ConsoleFrame = z
  .object({
    functionName: z.string().max(CONSOLE_NAME_MAX),
    url: ConsoleUrl,
    line: ConsolePosition,
    column: ConsolePosition,
  })
  .strict()
export type ConsoleFrame = z.infer<typeof ConsoleFrame>

export const ConsoleValue = z
  .object({
    type: ConsoleValueType,
    subtype: z.string().max(CONSOLE_METHOD_MAX).nullable(),
    text: z.string().max(CONSOLE_VALUE_TEXT_MAX),
    handle: ConsoleToken.nullable(),
  })
  .strict()
export type ConsoleValue = z.infer<typeof ConsoleValue>

export const ConsoleEntry = z
  .object({
    id: ConsoleToken,
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    at: z.number(),
    kind: ConsoleEntryKind,
    level: ConsoleLevel,
    method: z.string().max(CONSOLE_METHOD_MAX).nullable(),
    actor: ConsoleActor.nullable(),
    commandId: ConsoleToken.nullable(),
    status: ConsoleRunStatus.nullable(),
    text: z.string().max(CONSOLE_EXPRESSION_MAX),
    values: z.array(ConsoleValue).max(CONSOLE_VALUES_MAX),
    location: ConsoleLocation.nullable(),
    stack: z.array(ConsoleFrame).max(CONSOLE_FRAMES_MAX),
    url: ConsoleUrl.nullable(),
    cut: z.boolean(),
  })
  .strict()
export type ConsoleEntry = z.infer<typeof ConsoleEntry>

export const ConsoleSource = z
  .object({ browserId: BrowserId, state: ConsoleState, url: ConsoleUrl.nullable() })
  .strict()
export type ConsoleSource = z.infer<typeof ConsoleSource>

const ConsoleDropped = z.number().int().nonnegative().max(CONSOLE_DROPPED_MAX)
const ConsoleEpoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const ConsoleSnapshot = z
  .object({
    projectId: BrowserProjectId,
    epoch: ConsoleEpoch,
    entries: z.array(ConsoleEntry).max(CONSOLE_ENTRIES_MAX),
    dropped: ConsoleDropped,
    history: z.array(z.string().min(1).max(CONSOLE_EXPRESSION_MAX)).max(CONSOLE_HISTORY_MAX),
    sources: z.array(ConsoleSource).max(CONSOLE_SOURCES_MAX),
  })
  .strict()
export type ConsoleSnapshot = z.infer<typeof ConsoleSnapshot>

export const ConsolePropertyKind = z.enum(['own', 'internal', 'private'])
export type ConsolePropertyKind = z.infer<typeof ConsolePropertyKind>

export const ConsoleProperty = z
  .object({
    name: z.string().max(CONSOLE_NAME_MAX),
    kind: ConsolePropertyKind,
    enumerable: z.boolean(),
    value: ConsoleValue,
  })
  .strict()
export type ConsoleProperty = z.infer<typeof ConsoleProperty>

export const ConsoleExpansion = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      properties: z.array(ConsoleProperty).max(CONSOLE_PROPERTIES_MAX),
      total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      omittedIndexed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ status: z.literal('gone') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
])
export type ConsoleExpansion = z.infer<typeof ConsoleExpansion>

const ConsoleProjectRequest = z.object({ projectId: BrowserProjectId }).strict()
const ConsoleSubscriptionRequest = z.object({ subscriptionId: ConsoleSubscriptionId }).strict()
const ConsoleOk = z.object({ ok: z.literal(true) }).strict()

export const CONSOLE_CONTRACT = {
  'console:subscribe': {
    request: ConsoleProjectRequest,
    response: z
      .object({ subscriptionId: ConsoleSubscriptionId, snapshot: ConsoleSnapshot })
      .strict(),
  },
  'console:unsubscribe': {
    request: ConsoleSubscriptionRequest,
    response: ConsoleOk,
  },
  'console:ack': {
    request: ConsoleSubscriptionRequest,
    response: ConsoleOk,
  },
  'console:snapshot': {
    request: ConsoleSubscriptionRequest,
    response: z.object({ snapshot: ConsoleSnapshot }).strict(),
  },
  'console:evaluate': {
    request: z
      .object({
        projectId: BrowserProjectId,
        browserId: BrowserId,
        expression: z.string().min(1).max(CONSOLE_EXPRESSION_MAX),
      })
      .strict(),
    response: z.object({ commandId: ConsoleToken.nullable(), status: ConsoleStartStatus }).strict(),
  },
  'console:expand': {
    request: z.object({ projectId: BrowserProjectId, handle: ConsoleToken }).strict(),
    response: ConsoleExpansion,
  },
  'console:clear': {
    request: ConsoleProjectRequest,
    response: ConsoleOk,
  },
} as const

export type ConsoleContract = typeof CONSOLE_CONTRACT
export type ConsoleChannel = keyof ConsoleContract
export type ConsoleRequest<C extends ConsoleChannel> = z.infer<ConsoleContract[C]['request']>
export type ConsoleResponse<C extends ConsoleChannel> = z.infer<ConsoleContract[C]['response']>

export const CONSOLE_CHANNELS = Object.keys(CONSOLE_CONTRACT) as ConsoleChannel[]

export const CONSOLE_PUSH_CHANNEL = 'console:push'

export const ConsolePush = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('entries'),
      subscriptionId: ConsoleSubscriptionId,
      projectId: BrowserProjectId,
      epoch: ConsoleEpoch,
      entries: z.array(ConsoleEntry).max(CONSOLE_PUSH_ENTRIES_MAX),
      dropped: ConsoleDropped,
    })
    .strict(),
  z
    .object({
      kind: z.literal('state'),
      subscriptionId: ConsoleSubscriptionId,
      projectId: BrowserProjectId,
      sources: z.array(ConsoleSource).max(CONSOLE_SOURCES_MAX),
      dropped: ConsoleDropped,
    })
    .strict(),
  z
    .object({
      kind: z.literal('cleared'),
      subscriptionId: ConsoleSubscriptionId,
      projectId: BrowserProjectId,
      epoch: ConsoleEpoch,
    })
    .strict(),
  z
    .object({
      kind: z.literal('resync'),
      subscriptionId: ConsoleSubscriptionId,
      projectId: BrowserProjectId,
    })
    .strict(),
])
export type ConsolePush = z.infer<typeof ConsolePush>

export interface ConsoleApi {
  readonly subscribeConsole: (
    request: ConsoleRequest<'console:subscribe'>
  ) => Promise<ConsoleResponse<'console:subscribe'>>
  readonly unsubscribeConsole: (
    request: ConsoleRequest<'console:unsubscribe'>
  ) => Promise<ConsoleResponse<'console:unsubscribe'>>
  readonly ackConsole: (
    request: ConsoleRequest<'console:ack'>
  ) => Promise<ConsoleResponse<'console:ack'>>
  readonly snapshotConsole: (
    request: ConsoleRequest<'console:snapshot'>
  ) => Promise<ConsoleResponse<'console:snapshot'>>
  readonly evaluateConsole: (
    request: ConsoleRequest<'console:evaluate'>
  ) => Promise<ConsoleResponse<'console:evaluate'>>
  readonly expandConsole: (
    request: ConsoleRequest<'console:expand'>
  ) => Promise<ConsoleResponse<'console:expand'>>
  readonly clearConsole: (
    request: ConsoleRequest<'console:clear'>
  ) => Promise<ConsoleResponse<'console:clear'>>
  readonly onConsole: (listener: (push: ConsolePush) => void) => () => void
}
