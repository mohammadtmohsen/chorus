import { z } from 'zod'
import { IPC_CONTRACT } from './ipc.js'
import { ProjectLayoutSlice, ReturnSlot } from './workspace-layout.js'

export type WindowRole = { kind: 'main' } | { kind: 'detached'; projectId: string }

const Ok = z.object({ ok: z.literal(true) })
const Refused = z.object({ refused: z.literal(true) })
const Empty = z.object({}).strict()
const ProjectId = z.string().min(1)

export const DETACHED_WINDOW_CONTRACT = {
  'project:focusWindow': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: Ok,
  },
  'project:prepareDetach': {
    request: z.object({ projectId: ProjectId, title: z.string() }).strict(),
    response: z.union([z.object({ ticket: z.string().min(1) }), Refused]),
  },
  'project:commitDetach': {
    request: z
      .object({ ticket: z.string().min(1), returnSlot: ReturnSlot, slice: ProjectLayoutSlice })
      .strict(),
    response: Ok,
  },
  'project:prepareRedock': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: z.union([
      z.object({
        ticket: z.string().min(1),
        paneId: z.string().min(1),
        slot: z.number().int().nonnegative(),
      }),
      Refused,
    ]),
  },
  'project:commitRedock': {
    request: z.object({ ticket: z.string().min(1), slice: ProjectLayoutSlice }).strict(),
    response: Ok,
  },
  'project:closeEmpty': {
    request: z.object({ projectId: ProjectId }).strict(),
    response: Ok,
  },
  'project:sliceChanged': {
    request: z.object({ projectId: ProjectId, slice: ProjectLayoutSlice }).strict(),
    response: Ok,
  },
  'project:visibility': {
    request: z
      .object({
        projectId: ProjectId,
        focused: z.boolean(),
        visibleConversationIds: z.array(z.string()),
      })
      .strict(),
    response: Ok,
  },
  'window:detachedState': {
    request: Empty,
    response: z.object({
      entries: z.array(
        z.object({ projectId: ProjectId, returnSlot: ReturnSlot, slice: ProjectLayoutSlice })
      ),
    }),
  },
  'window:detachedBootstrap': {
    request: Empty,
    response: z.object({
      projectId: ProjectId,
      slice: ProjectLayoutSlice,
      conversations: IPC_CONTRACT['conversation:restore'].response.shape.sessions,
    }),
  },
  'window:flushResult': {
    request: z.object({ requestId: z.string().min(1), slice: ProjectLayoutSlice }).strict(),
    response: Ok,
  },
  'window:hitTestResult': {
    request: z
      .object({
        requestId: z.string().min(1),
        paneId: z.string().min(1).nullable(),
        slot: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    response: Ok,
  },
}

export type DetachedWindowContract = typeof DETACHED_WINDOW_CONTRACT
export type DetachedWindowChannel = keyof DetachedWindowContract
export type DetachedWindowRequest<C extends DetachedWindowChannel> = z.infer<
  DetachedWindowContract[C]['request']
>
export type DetachedWindowResponse<C extends DetachedWindowChannel> = z.infer<
  DetachedWindowContract[C]['response']
>

export const DETACHED_WINDOW_CHANNELS = Object.keys(
  DETACHED_WINDOW_CONTRACT
) as DetachedWindowChannel[]

export const PROJECT_CLOSED_PUSH_CHANNEL = 'project:closed'
export const PROJECT_CLOSE_REQUEST_PUSH_CHANNEL = 'project:closeRequested'
export const ProjectClosedPush = z.object({ projectId: ProjectId })
export type ProjectClosedPush = z.infer<typeof ProjectClosedPush>

export const PROJECT_RETURNED_PUSH_CHANNEL = 'project:returned'
export const PROJECT_SLICE_PUSH_CHANNEL = 'project:slice'
export const PROJECT_VISIBILITY_PUSH_CHANNEL = 'project:visibilityChanged'
export const CONVERSATIONS_PUSH_CHANNEL = 'conversations:changed'
export const FLUSH_REQUEST_PUSH_CHANNEL = 'window:flushRequest'
export const HIT_TEST_REQUEST_PUSH_CHANNEL = 'window:hitTestRequest'

export const ProjectReturnedPush = z.object({
  projectId: ProjectId,
  returnSlot: ReturnSlot,
  slice: ProjectLayoutSlice,
})
export const ProjectSlicePush = z.object({ projectId: ProjectId, slice: ProjectLayoutSlice })
export const ProjectVisibilityPush = DETACHED_WINDOW_CONTRACT['project:visibility'].request
export const FlushRequestPush = z.object({ requestId: z.string().min(1) })
export const HitTestRequestPush = z.object({
  requestId: z.string().min(1),
  x: z.number(),
  y: z.number(),
})

export type ProjectReturnedPush = z.infer<typeof ProjectReturnedPush>
export type ProjectSlicePush = z.infer<typeof ProjectSlicePush>
export type ProjectVisibilityPush = z.infer<typeof ProjectVisibilityPush>
export type FlushRequestPush = z.infer<typeof FlushRequestPush>
export type HitTestRequestPush = z.infer<typeof HitTestRequestPush>

type DetachedCall<C extends DetachedWindowChannel> = (
  request: DetachedWindowRequest<C>
) => Promise<DetachedWindowResponse<C>>

export interface DetachedWindowApi {
  readonly focusProjectWindow: DetachedCall<'project:focusWindow'>
  readonly prepareDetach: DetachedCall<'project:prepareDetach'>
  readonly commitDetach: DetachedCall<'project:commitDetach'>
  readonly prepareRedock: DetachedCall<'project:prepareRedock'>
  readonly commitRedock: DetachedCall<'project:commitRedock'>
  readonly closeEmptyProject: DetachedCall<'project:closeEmpty'>
  readonly sendProjectSlice: DetachedCall<'project:sliceChanged'>
  readonly sendProjectVisibility: DetachedCall<'project:visibility'>
  readonly readDetachedState: () => Promise<DetachedWindowResponse<'window:detachedState'>>
  readonly readDetachedBootstrap: () => Promise<DetachedWindowResponse<'window:detachedBootstrap'>>
  readonly sendFlushResult: DetachedCall<'window:flushResult'>
  readonly sendHitTestResult: DetachedCall<'window:hitTestResult'>
  readonly onProjectClosed: (listener: (push: ProjectClosedPush) => void) => () => void
  readonly onProjectCloseRequested: (listener: (push: ProjectClosedPush) => void) => () => void
  readonly onProjectReturned: (listener: (push: ProjectReturnedPush) => void) => () => void
  readonly onProjectSlice: (listener: (push: ProjectSlicePush) => void) => () => void
  readonly onProjectVisibility: (listener: (push: ProjectVisibilityPush) => void) => () => void
  readonly onConversationsChanged: (listener: () => void) => () => void
  readonly onFlushRequest: (listener: (push: FlushRequestPush) => void) => () => void
  readonly onHitTestRequest: (listener: (push: HitTestRequestPush) => void) => () => void
}
