import { z } from 'zod'
import { diagnosticParams } from '@chorus/ide-protocol/protocol'
import { WorkbenchContext } from '../../desktop/src/shared/workbench-ipc.js'
import { WindowRole } from '../../desktop/src/shared/detached-window-ipc.js'

export const PROTOCOL_VERSION = 3
export const MAX_FRAME_BYTES = 64 * 1024 * 1024
export const PERSON_PACED_CHANNELS: ReadonlySet<string> = new Set([
  'project:adopt',
  'project:adoptRemote',
  'project:relocate',
  'files:chooseDirectory',
  'app:pickNoteImage',
])
export const PERSON_PACED_HOST_METHODS: ReadonlySet<string> = new Set([
  'pickDirectory',
  'pickFiles',
  'browser.pickFiles',
])
export const SecretId = z.enum([
  'claude',
  'codex',
  'deepseek',
  'gitlab',
  'typesafe',
  'completion-deepseek',
  'completion-codestral',
])
export type SecretId = z.infer<typeof SecretId>
export const ATTENTION_ROOMS_CHANNEL = 'host:attentionRooms'
export const AttentionRoom = z.object({
  conversationId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  approvals: z.number().int().nonnegative(),
  questions: z.number().int().nonnegative(),
})
export type AttentionRoom = z.infer<typeof AttentionRoom>
export const EngineActivity = z.object({
  conversations: z.array(z.string()),
  approvals: z.number().int().nonnegative(),
  questions: z.number().int().nonnegative(),
  runs: z.array(z.string()),
  starting: z.number().int().nonnegative(),
  busy: z.boolean(),
})
export type EngineActivity = z.infer<typeof EngineActivity>
export const EngineClientKind = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vscode') }),
  z.object({
    kind: z.literal('desktop'),
    electronVersion: z.string(),
    chromeVersion: z.string(),
  }),
])
export type EngineClientKind = z.infer<typeof EngineClientKind>
export const OfferedSecret = z.object({
  value: z.string().max(65536).nullable(),
  revision: z.number().int().nonnegative(),
})
export type OfferedSecret = z.infer<typeof OfferedSecret>
export const EngineDescriptor = z.object({
  protocol: z.number().int(),
  build: z.string(),
  appVersion: z.string(),
  generation: z.string(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  socketPath: z.string(),
  pid: z.number().int().positive(),
})
export type EngineDescriptor = z.infer<typeof EngineDescriptor>
export const Hello = z.object({
  kind: z.literal('hello'),
  token: z.string(),
  protocol: z.number().int(),
  build: z.string(),
  appVersion: z.string(),
  client: EngineClientKind,
  role: WindowRole,
  clientId: z.string().min(1).max(200),
  workspaceKey: z.string().min(1).max(1000),
  workspaceFolders: z.array(z.string().max(8192)).max(100),
  trusted: z.boolean(),
  secrets: z.record(SecretId, OfferedSecret),
  lastSeq: z.number().int().nonnegative().default(0),
  cold: z.boolean().default(false),
})
export type Hello = z.infer<typeof Hello>
export const ClientMessage = z.discriminatedUnion('kind', [
  Hello,
  z.object({
    kind: z.literal('invoke'),
    id: z.string(),
    channel: z.string(),
    request: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('hostAnswer'),
    id: z.string(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({ kind: z.literal('adoptFolder'), id: z.string(), path: z.string() }),
  z.object({ kind: z.literal('journal'), id: z.string(), request: z.unknown().optional() }),
  z.object({
    kind: z.literal('storage'),
    id: z.string(),
    key: z.string().max(1000),
    value: z.string().max(65536).nullable().optional(),
  }),
  z.object({
    kind: z.literal('focus'),
    viewVisible: z.boolean().default(true),
    focused: z.boolean(),
    attentive: z.boolean().default(false),
    projectIds: z.array(z.string()),
    focusedProjectId: z.string().nullable().default(null),
    lastSeq: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('secret'),
    secretId: SecretId,
    value: z.string().max(65536).nullable(),
    revision: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('status'), id: z.string() }),
  z.object({ kind: z.literal('replay'), id: z.string(), afterSeq: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('shutdown'), id: z.string() }),
  z.object({
    kind: z.literal('editorContext'),
    report: z.object({ host: z.string(), projectRoot: z.string(), context: WorkbenchContext }),
  }),
  z.object({
    kind: z.literal('diagnostic'),
    id: z.string(),
    projectId: z.string(),
    params: diagnosticParams,
  }),
  z.object({
    kind: z.literal('completion'),
    id: z.string(),
    requestId: z.string(),
    payload: z.unknown().optional(),
  }),
  z.object({ kind: z.literal('completionConfigured'), id: z.string() }),
  z.object({ kind: z.literal('completionCancel'), requestId: z.string() }),
])
export type ClientMessage = z.infer<typeof ClientMessage>
export const ServerMessage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('welcome'),
    generation: z.string(),
    throughSeq: z.number().int(),
    activity: EngineActivity,
    storage: z.record(z.string(), z.string()),
  }),
  z.object({
    kind: z.literal('restartRequired'),
    descriptor: EngineDescriptor.omit({ token: true }),
    activity: EngineActivity,
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
    kind: z.literal('hostCall'),
    id: z.string(),
    method: z.string(),
    params: z.unknown().optional(),
  }),
])
export type ServerMessage = z.infer<typeof ServerMessage>
export const WebviewMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('restart') }),
  z.object({
    kind: z.literal('dropFiles'),
    id: z.string(),
    uris: z.array(z.string().max(8192)).max(64),
  }),
  z.object({
    kind: z.literal('invoke'),
    id: z.string(),
    channel: z.string(),
    request: z.unknown().optional(),
  }),
  z.object({ kind: z.literal('journal'), id: z.string(), request: z.unknown().optional() }),
  z.object({
    kind: z.literal('storage'),
    id: z.string(),
    key: z.string().startsWith('chorus:message-mode:'),
    value: z.string().max(65536),
  }),
  z.object({
    kind: z.literal('focus'),
    projectIds: z.array(z.string()),
    focusedProjectId: z.string().nullable().default(null),
    lastSeq: z.number().int().nonnegative(),
  }),
])
