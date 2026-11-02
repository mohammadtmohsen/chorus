import { randomUUID } from 'node:crypto'
import type { AgentId } from '@chorus/shared'
import type { WebContents } from 'electron'
import { z } from 'zod'
import {
  CONSOLE_ENTRIES_MAX,
  CONSOLE_EXPRESSION_MAX,
  CONSOLE_FRAMES_MAX,
  CONSOLE_HISTORY_MAX,
  CONSOLE_METHOD_MAX,
  CONSOLE_NAME_MAX,
  CONSOLE_PROPERTIES_MAX,
  CONSOLE_PUSH_ENTRIES_MAX,
  CONSOLE_SOURCES_MAX,
  CONSOLE_TEXT_MAX,
  CONSOLE_URL_MAX,
  CONSOLE_VALUE_TEXT_MAX,
  CONSOLE_VALUES_MAX,
  ConsoleValueType,
  type ConsoleActor,
  type ConsoleEntry,
  type ConsoleEntryKind,
  type ConsoleExpansion,
  type ConsoleFrame,
  type ConsoleLevel,
  type ConsoleLocation,
  type ConsoleProperty,
  type ConsolePropertyKind,
  type ConsoleRunStatus,
  type ConsoleSnapshot,
  type ConsoleSource,
  type ConsoleStartStatus,
  type ConsoleState,
  type ConsoleValue,
} from '../shared/console-ipc.js'

export const CONSOLE_STORE_BYTES = 2 * 1_024 * 1_024
export const CONSOLE_HISTORY_BYTES = 256 * 1_024
export const CONSOLE_HANDLES_MAX = 4_000
export const CONSOLE_PENDING_MAX = 16
export const CONSOLE_PAGE_RATE = 500
export const CONSOLE_FLUSH_MS = 50
export const CONSOLE_HUMAN_TIMEOUT_MS = 30_000
export const CONSOLE_EXPAND_DEPTH_MAX = 24
export const CONSOLE_NAMED_MAX = 100
export const CONSOLE_RELEASE_MAX = 1_000
export const CONSOLE_AGENT_BYTES = 65_536
export const CONSOLE_AGENT_VALUE_MAX = 8_192
export const CONSOLE_AGENT_ROW_MAX = 4_096
export const CONSOLE_AGENT_FRAMES_MAX = 5
export const CONSOLE_AGENT_COUNT = { min: 1, max: 200, fallback: 50 } as const
export const CONSOLE_AGENT_SKIP = { min: 0, max: 1_000, fallback: 0 } as const
export const CONSOLE_AGENT_TIMEOUT_MS = { min: 100, max: 30_000, fallback: 5_000 } as const

const PROTOCOL_VERSION = '1.3'
const GROUP_PREFIX = 'chorus-'
const CONSOLE_GROUP = 'console'
const RATE_WINDOW_MS = 1_000
const FUNCTION_LINE_MAX = 200
const ELLIPSIS = '…'
const INDEX = /^\d+$/
const SPECIFIER = /%([sidfoOc%])/g
const LENGTH = /\((\d+)\)$/
const ATOMIC_SUBTYPES: ReadonlySet<string> = new Set([
  'error',
  'regexp',
  'date',
  'node',
  'trustedtype',
  'wasmvalue',
])

const CdpCallFrame = z.object({
  functionName: z.string(),
  url: z.string(),
  lineNumber: z.number(),
  columnNumber: z.number(),
})

const CdpStackTrace = z.object({ callFrames: z.array(CdpCallFrame) })
type CdpStackTrace = z.infer<typeof CdpStackTrace>

const CdpPropertyPreview = z.object({
  name: z.string(),
  type: z.string(),
  value: z.string().optional(),
  subtype: z.string().optional(),
})
type CdpPropertyPreview = z.infer<typeof CdpPropertyPreview>

const CdpLeafPreview = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  description: z.string().optional(),
  overflow: z.boolean(),
  properties: z.array(CdpPropertyPreview),
})
type CdpLeafPreview = z.infer<typeof CdpLeafPreview>

const CdpObjectPreview = CdpLeafPreview.extend({
  entries: z.array(z.object({ key: CdpLeafPreview.optional(), value: CdpLeafPreview })).optional(),
})
type CdpObjectPreview = z.infer<typeof CdpObjectPreview>

const CdpRemoteObject = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  className: z.string().optional(),
  value: z.unknown().optional(),
  unserializableValue: z.string().optional(),
  description: z.string().optional(),
  objectId: z.string().optional(),
  preview: CdpObjectPreview.optional(),
})
type CdpRemoteObject = z.infer<typeof CdpRemoteObject>

const CdpExceptionDetails = z.object({
  text: z.string(),
  lineNumber: z.number(),
  columnNumber: z.number(),
  url: z.string().optional(),
  stackTrace: CdpStackTrace.optional(),
  exception: CdpRemoteObject.optional(),
  executionContextId: z.number().optional(),
})
type CdpExceptionDetails = z.infer<typeof CdpExceptionDetails>

const CdpConsoleCalled = z.object({
  type: z.string(),
  args: z.array(CdpRemoteObject),
  executionContextId: z.number().optional(),
  timestamp: z.number(),
  stackTrace: CdpStackTrace.optional(),
})

const CdpExceptionThrown = z.object({
  timestamp: z.number(),
  exceptionDetails: CdpExceptionDetails,
})

const CdpLogEntryAdded = z.object({
  entry: z.object({
    source: z.string(),
    level: z.string(),
    text: z.string(),
    timestamp: z.number(),
    url: z.string().optional(),
    lineNumber: z.number().optional(),
    stackTrace: CdpStackTrace.optional(),
    args: z.array(CdpRemoteObject).optional(),
  }),
})

const CdpContextCreated = z.object({
  context: z.object({
    id: z.number(),
    uniqueId: z.string(),
    auxData: z
      .object({ isDefault: z.boolean().optional(), frameId: z.string().optional() })
      .optional(),
  }),
})

const CdpContextDestroyed = z.object({ executionContextId: z.number() })

const CdpFrameTree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) })

const CdpEvaluated = z.object({
  result: CdpRemoteObject,
  exceptionDetails: CdpExceptionDetails.optional(),
})

const CdpPropertyList = z.object({
  result: z.array(z.unknown()),
  internalProperties: z.array(z.unknown()).optional(),
  privateProperties: z.array(z.unknown()).optional(),
})

const CdpSlot = z.object({
  name: z.string(),
  value: CdpRemoteObject.optional(),
  get: CdpRemoteObject.optional(),
  set: CdpRemoteObject.optional(),
  enumerable: z.boolean().optional(),
  symbol: CdpRemoteObject.optional(),
})
type CdpSlot = z.infer<typeof CdpSlot>

const CdpInternalSlot = CdpSlot.pick({ name: true, value: true })

const CdpReference = z.object({ objectId: z.string().optional() })

const CdpReferences = z.object({
  value: CdpReference.optional(),
  get: CdpReference.optional(),
  set: CdpReference.optional(),
  symbol: CdpReference.optional(),
})

export interface ConsoleSourceInput {
  readonly browserId: string
  readonly projectId: string
  readonly owner: WebContents
  readonly contents: WebContents
}

export interface BrowserConsolesDeps {
  readonly preferredOwner: (projectId: string) => WebContents | null
  readonly now?: () => number
}

export type ConsoleServiceEvent =
  | {
      readonly kind: 'entries'
      readonly projectId: string
      readonly epoch: number
      readonly entries: readonly ConsoleEntry[]
      readonly dropped: number
    }
  | {
      readonly kind: 'state'
      readonly projectId: string
      readonly sources: readonly ConsoleSource[]
      readonly dropped: number
    }
  | { readonly kind: 'cleared'; readonly projectId: string; readonly epoch: number }

export interface ConsoleClip {
  readonly text: string
  readonly cut: boolean
}

export interface ConsoleException {
  readonly text: ConsoleClip
  readonly location: ConsoleLocation | null
  readonly stack: readonly ConsoleFrame[]
}

export interface ConsoleOutcome {
  readonly status: ConsoleRunStatus | 'cleared'
  readonly url: string | null
  readonly result: {
    readonly type: ConsoleValueType
    readonly subtype: string | null
    readonly text: ConsoleClip
  } | null
  readonly exception: ConsoleException | null
  readonly failure: string | null
}

export interface ConsoleLaunch {
  readonly commandId: string | null
  readonly status: ConsoleStartStatus
  readonly done: Promise<ConsoleOutcome> | null
}

export interface ConsoleEvaluation {
  readonly projectId: string
  readonly expression: string
  readonly actor: ConsoleActor
  readonly timeoutMs: number
  readonly browserId?: string
  readonly owner?: WebContents
}

export interface ConsoleReadRequest {
  readonly count: number
  readonly skip: number
  readonly levels?: readonly string[]
}

export interface ConsoleRunRequest {
  readonly expression: string
  readonly timeoutMs: number
  readonly actor: AgentId
}

type Settlement =
  | { readonly kind: 'reply'; readonly raw: unknown }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'cleared' }

interface Launched {
  readonly commandId: string
  readonly actor: ConsoleActor
  readonly group: string
  readonly generation: number
  readonly epoch: number
  readonly session: number
  readonly contextId: number
}

interface Handle {
  readonly id: string
  readonly projectId: string
  readonly sourceId: string
  readonly generation: number
  readonly epoch: number
  readonly objectId: string
  readonly entryId: string
  readonly depth: number
  readonly grouped: boolean
  readonly contextId: number | null
}

interface StoredEntry {
  readonly entry: ConsoleEntry
  readonly bytes: number
  readonly handles: string[]
  readonly group: { readonly sourceId: string; readonly name: string } | null
}

interface Store {
  readonly projectId: string
  readonly byId: Map<string, StoredEntry>
  epoch: number
  entries: StoredEntry[]
  bytes: number
  handleCount: number
  dropped: number
  history: string[]
  outbox: ConsoleEntry[]
  stateDirty: boolean
  timer: ReturnType<typeof setTimeout> | null
  windowStart: number
  windowCount: number
  clearedAt: number
}

interface ExecutionContext {
  readonly id: number
  readonly uniqueId: string
}

interface Source {
  readonly id: string
  readonly browserId: string
  readonly projectId: string
  readonly owner: WebContents
  readonly contents: WebContents
  readonly order: number
  readonly contexts: Map<string, ExecutionContext>
  readonly groups: Set<string>
  readonly pending: Map<string, (settlement: Settlement) => void>
  readonly inflight: Set<string>
  readonly cleanup: (() => void)[]
  state: ConsoleState
  attached: boolean
  attachment: number
  session: number
  generation: number
  replaying: boolean
  replayFloor: number
  lastTimestamp: number
  rootFrameId: string | null
  rootFailed: boolean
  rooting: boolean
  released: boolean
}

interface Draft {
  readonly kind: ConsoleEntryKind
  readonly level: ConsoleLevel
  readonly at: number
  readonly text: string
  readonly method?: string | null
  readonly actor?: ConsoleActor
  readonly commandId?: string
  readonly status?: ConsoleRunStatus
  readonly objects?: readonly CdpRemoteObject[]
  readonly quote?: boolean
  readonly location?: ConsoleLocation | null
  readonly stack?: readonly ConsoleFrame[]
  readonly url?: string | null
  readonly source?: Source
  readonly group?: string
  readonly contextId?: number
  readonly cut?: boolean
}

interface Place {
  readonly entryId: string
  readonly depth: number
  readonly handles: string[]
  readonly grouped: boolean
  readonly quote: boolean
  readonly contextId: number | null
  readonly clipped: { cut: boolean }
}

interface ListedProperty {
  readonly kind: ConsolePropertyKind
  readonly raw: unknown
}

const GONE: ConsoleExpansion = { status: 'gone' }
const UNAVAILABLE: ConsoleExpansion = { status: 'unavailable' }
const ACCESSOR: ConsoleValue = { type: 'accessor', subtype: null, text: '(...)', handle: null }
const UNDEFINED: ConsoleValue = {
  type: 'undefined',
  subtype: null,
  text: 'undefined',
  handle: null,
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let end = Math.max(0, max - ELLIPSIS.length)
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}${ELLIPSIS}`
}

function clip(text: string, max: number): ConsoleClip {
  return { text: cut(text, max), cut: text.length > max }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function within(value: number, bounds: { readonly min: number; readonly max: number }): number {
  return Number.isFinite(value)
    ? Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)))
    : bounds.min
}

function position(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(value) + 1))
}

function isoOf(at: number): string | null {
  return Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? new Date(at).toISOString() : null
}

function valueType(type: string): ConsoleValueType {
  const parsed = ConsoleValueType.safeParse(type)
  return parsed.success ? parsed.data : 'object'
}

function primitiveText(value: unknown): string | null {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return typeof value === 'string' ? value : null
}

function lengthOf(description: string | undefined): number | null {
  const match = LENGTH.exec(description ?? '')
  const digits = match?.[1]
  if (digits === undefined) return null
  const length = Number(digits)
  return Number.isSafeInteger(length) ? length : null
}

function indexedName(item: unknown): boolean {
  return (
    typeof item === 'object' &&
    item !== null &&
    'name' in item &&
    typeof item.name === 'string' &&
    INDEX.test(item.name)
  )
}

function functionText(description: string): string {
  const line = description.split('\n', 1)[0] ?? ''
  return `ƒ ${cut(line.replace(/^function\s*/, ''), FUNCTION_LINE_MAX)}`
}

function propertyText(property: CdpPropertyPreview): string {
  switch (property.type) {
    case 'string':
      return `'${property.value ?? ''}'`
    case 'function':
      return 'ƒ'
    case 'accessor':
      return '(...)'
    case 'object':
      if (property.subtype === 'null') return 'null'
      return property.value === undefined || property.value === 'Object' ? '{…}' : property.value
    default:
      return property.value ?? property.type
  }
}

function leafText(preview: CdpLeafPreview): string {
  const description = preview.description ?? ''
  switch (preview.type) {
    case 'string':
      return `'${description}'`
    case 'function':
      return 'ƒ'
    case 'object':
      if (preview.subtype === 'null') return 'null'
      return description === 'Object' ? '{…}' : description
    default:
      return description
  }
}

function previewText(preview: CdpObjectPreview): string {
  if (preview.type !== 'object') return leafText(preview)
  const more = preview.overflow ? `, ${ELLIPSIS}` : ''
  switch (preview.subtype) {
    case 'null':
      return 'null'
    case 'array':
    case 'typedarray': {
      const length = lengthOf(preview.description)
      const items = preview.properties.map((property) =>
        INDEX.test(property.name)
          ? propertyText(property)
          : `${property.name}: ${propertyText(property)}`
      )
      const counted = length === null ? '' : `(${String(length)}) `
      return `${counted}[${items.join(', ')}${more}]`
    }
    case 'map':
    case 'set':
    case 'weakmap':
    case 'weakset': {
      const items = (preview.entries ?? []).map((entry) =>
        entry.key === undefined
          ? leafText(entry.value)
          : `${leafText(entry.key)} => ${leafText(entry.value)}`
      )
      return `${preview.description ?? ''} {${items.join(', ')}${more}}`
    }
    case 'promise': {
      const state =
        preview.properties.find((property) => property.name === '[[PromiseState]]')?.value ??
        'pending'
      const result = preview.properties.find((property) => property.name === '[[PromiseResult]]')
      return state === 'pending' || result === undefined
        ? `Promise {<${state}>}`
        : `Promise {<${state}>: ${propertyText(result)}}`
    }
    case undefined:
    default: {
      const body = preview.properties.map(
        (property) => `${property.name}: ${propertyText(property)}`
      )
      const description = preview.description ?? 'Object'
      const named = description === 'Object' ? '' : `${description} `
      return `${named}{${body.join(', ')}${more}}`
    }
  }
}

function objectText(object: CdpRemoteObject): string {
  const described = object.description ?? object.className ?? 'Object'
  if (object.subtype === 'null') return 'null'
  if (object.subtype !== undefined && ATOMIC_SUBTYPES.has(object.subtype)) return described
  return object.preview === undefined ? described : previewText(object.preview)
}

function remoteText(object: CdpRemoteObject, quote: boolean): string {
  switch (object.type) {
    case 'string': {
      const text = typeof object.value === 'string' ? object.value : (object.description ?? '')
      return quote ? `'${text}'` : text
    }
    case 'undefined':
      return 'undefined'
    case 'number':
    case 'boolean':
    case 'bigint':
      return object.unserializableValue ?? primitiveText(object.value) ?? object.description ?? ''
    case 'symbol':
      return object.description ?? 'Symbol()'
    case 'function':
      return functionText(object.description ?? '')
    default:
      return objectText(object)
  }
}

function specified(code: string, object: CdpRemoteObject): string {
  switch (code) {
    case 'c':
      return ''
    case 'd':
    case 'i':
      return typeof object.value === 'number' ? String(Math.trunc(object.value)) : 'NaN'
    case 'f':
      return typeof object.value === 'number' ? String(object.value) : 'NaN'
    case 'o':
    case 'O':
      return remoteText(object, true)
    default:
      return remoteText(object, false)
  }
}

export function formatConsoleArguments(args: readonly CdpRemoteObject[]): string {
  const [first, ...rest] = args
  if (first === undefined) return ''
  const format = first.type === 'string' && typeof first.value === 'string' ? first.value : null
  if (!format?.includes('%')) {
    return args.map((arg) => remoteText(arg, false)).join(' ')
  }
  let next = 0
  const head = format.replace(SPECIFIER, (match: string, code: string) => {
    if (code === '%') return '%'
    const object = rest[next]
    if (object === undefined) return match
    next += 1
    return specified(code, object)
  })
  return [head, ...rest.slice(next).map((arg) => remoteText(arg, false))].join(' ')
}

function consoleLevel(type: string): ConsoleLevel {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error'
    case 'warning':
      return 'warning'
    case 'info':
      return 'info'
    case 'debug':
      return 'debug'
    default:
      return 'log'
  }
}

function logLevel(level: string): ConsoleLevel {
  switch (level) {
    case 'error':
      return 'error'
    case 'warning':
      return 'warning'
    case 'verbose':
      return 'debug'
    default:
      return 'info'
  }
}

function startOf(state: ConsoleState): ConsoleStartStatus {
  switch (state) {
    case 'paused':
      return 'paused'
    case 'connecting':
      return 'connecting'
    case 'no-page':
      return 'no-page'
    case 'ready':
    case 'unavailable':
      return 'unavailable'
  }
}

function framesOf(stack: CdpStackTrace | undefined): ConsoleFrame[] {
  return (stack?.callFrames ?? []).slice(0, CONSOLE_FRAMES_MAX).map((frame) => ({
    functionName: cut(frame.functionName, CONSOLE_NAME_MAX),
    url: cut(frame.url, CONSOLE_URL_MAX),
    line: position(frame.lineNumber),
    column: position(frame.columnNumber),
  }))
}

function framesCut(stack: CdpStackTrace | undefined): boolean {
  return (stack?.callFrames.length ?? 0) > CONSOLE_FRAMES_MAX
}

function locationOf(frame: ConsoleFrame | undefined): ConsoleLocation | null {
  return frame === undefined ? null : { url: frame.url, line: frame.line, column: frame.column }
}

function exceptionOf(details: CdpExceptionDetails): {
  readonly text: string
  readonly location: ConsoleLocation | null
  readonly stack: ConsoleFrame[]
} {
  const stack = framesOf(details.stackTrace)
  const location =
    details.url !== undefined && details.url !== ''
      ? {
          url: cut(details.url, CONSOLE_URL_MAX),
          line: position(details.lineNumber),
          column: position(details.columnNumber),
        }
      : locationOf(stack[0])
  const description = details.exception?.description
  const text = description === undefined ? details.text : `${details.text} ${description}`
  return { text, location, stack }
}

function where(location: ConsoleLocation): string {
  return `${location.url}:${String(location.line)}:${String(location.column)}`
}

function frameText(frame: ConsoleFrame): string {
  return `${frame.functionName === '' ? '(anonymous)' : frame.functionName} ${where(frame)}`
}

function referencesOf(raw: unknown): string[] {
  const parsed = CdpReferences.safeParse(raw)
  if (!parsed.success) return []
  const { value, get, set, symbol } = parsed.data
  return [value, get, set, symbol].flatMap((reference) =>
    reference?.objectId === undefined ? [] : [reference.objectId]
  )
}

function agentRow(entry: ConsoleEntry): Record<string, unknown> {
  const rowCut =
    entry.cut ||
    entry.text.length > CONSOLE_AGENT_ROW_MAX ||
    entry.stack.length > CONSOLE_AGENT_FRAMES_MAX
  return {
    id: entry.id,
    at: isoOf(entry.at),
    kind: entry.kind,
    level: entry.level,
    method: entry.method,
    actor: entry.actor,
    commandId: entry.commandId,
    status: entry.status,
    text: cut(entry.text, CONSOLE_AGENT_ROW_MAX),
    location: entry.location === null ? null : where(entry.location),
    stack: entry.stack.slice(0, CONSOLE_AGENT_FRAMES_MAX).map(frameText),
    url: entry.url,
    cut: rowCut,
  }
}

function agentOutcome(commandId: string, outcome: ConsoleOutcome): string {
  const { exception, result } = outcome
  const doc = {
    status: outcome.status,
    commandId,
    url: outcome.url,
    result:
      result === null
        ? null
        : {
            type: result.type,
            subtype: result.subtype,
            text: result.text.text,
            cut: result.text.cut,
          },
    exception:
      exception === null
        ? null
        : {
            text: exception.text.text,
            cut: exception.text.cut,
            location: exception.location === null ? null : where(exception.location),
            stack: exception.stack.slice(0, CONSOLE_AGENT_FRAMES_MAX).map(frameText),
          },
    failure: outcome.failure,
  }
  if (jsonBytes(doc) <= CONSOLE_AGENT_BYTES) return JSON.stringify(doc)
  const brief = {
    ...doc,
    result:
      doc.result === null ? null : { ...doc.result, text: cut(doc.result.text, 1_024), cut: true },
    exception:
      doc.exception === null
        ? null
        : { ...doc.exception, text: cut(doc.exception.text, 1_024), cut: true, stack: [] },
  }
  return JSON.stringify(brief)
}

export class BrowserConsoles {
  private readonly deps: BrowserConsolesDeps
  private readonly now: () => number
  private readonly stores = new Map<string, Store>()
  private readonly sources = new Map<string, Source>()
  private readonly byContents = new Map<WebContents, Source>()
  private readonly byBrowser = new Map<string, Source>()
  private readonly handles = new Map<string, Handle>()
  private readonly listeners = new Set<(event: ConsoleServiceEvent) => void>()
  private order = 0
  private sequence = 0
  private epochs = 0
  private closed = false

  constructor(deps: BrowserConsolesDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
  }

  subscribe(listener: (event: ConsoleServiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  mount(input: ConsoleSourceInput): void {
    if (this.closed || input.contents.isDestroyed() || this.byContents.has(input.contents)) return
    const previous = this.byBrowser.get(input.browserId)
    if (previous !== undefined) this.release(previous.contents)
    this.order += 1
    const source: Source = {
      id: randomUUID(),
      browserId: input.browserId,
      projectId: input.projectId,
      owner: input.owner,
      contents: input.contents,
      order: this.order,
      contexts: new Map(),
      groups: new Set(),
      pending: new Map(),
      inflight: new Set(),
      cleanup: [],
      state: 'connecting',
      attached: false,
      attachment: 0,
      session: 0,
      generation: 0,
      replaying: false,
      replayFloor: 0,
      lastTimestamp: 0,
      rootFrameId: null,
      rootFailed: false,
      rooting: false,
      released: false,
    }
    this.sources.set(source.id, source)
    this.byContents.set(source.contents, source)
    this.byBrowser.set(source.browserId, source)
    this.listen(source)
    this.connect(source)
    this.touch(this.storeOf(source.projectId))
  }

  release(contents: WebContents): void {
    const source = this.byContents.get(contents)
    if (source === undefined) return
    source.released = true
    this.byContents.delete(contents)
    this.sources.delete(source.id)
    if (this.byBrowser.get(source.browserId) === source) this.byBrowser.delete(source.browserId)
    for (const stop of source.cleanup.splice(0)) stop()
    this.invalidate(source)
    const attached = source.attached
    source.attached = false
    this.cancelRequests(source)
    if (attached && !contents.isDestroyed()) this.detachQuietly(contents)
    const store = this.stores.get(source.projectId)
    if (store !== undefined) this.touch(store)
  }

  snapshot(projectId: string): ConsoleSnapshot {
    this.flush(projectId)
    const store = this.storeOf(projectId)
    return {
      projectId,
      epoch: store.epoch,
      entries: store.entries.map((stored) => stored.entry),
      dropped: store.dropped,
      history: [...store.history],
      sources: this.sourcesOf(projectId),
    }
  }

  flush(projectId: string): void {
    const store = this.stores.get(projectId)
    if (store === undefined) return
    if (store.timer !== null) {
      clearTimeout(store.timer)
      store.timer = null
    }
    this.deliver(store)
  }

  page(projectId: string): { readonly url: string | null; readonly state: ConsoleState } | null {
    const source = this.preferred(projectId)
    return source === undefined ? null : { url: this.urlOf(source), state: this.stateOf(source) }
  }

  evaluate(request: ConsoleEvaluation): ConsoleLaunch {
    const refused = (status: ConsoleStartStatus): ConsoleLaunch => ({
      commandId: null,
      status,
      done: null,
    })
    if (this.closed) return refused('unavailable')
    if (request.expression.length === 0 || request.expression.length > CONSOLE_EXPRESSION_MAX) {
      return refused('invalid')
    }
    const source =
      request.browserId === undefined
        ? this.preferred(request.projectId)
        : this.byBrowser.get(request.browserId)
    if (
      source?.projectId !== request.projectId ||
      (request.owner !== undefined && source.owner !== request.owner) ||
      source.contents.isDestroyed()
    ) {
      return refused('no-page')
    }
    if (!source.attached && !source.contents.isDevToolsOpened()) this.connect(source)
    const context = this.mainContext(source)
    if (this.stateOf(source) !== 'ready' || context === undefined) {
      return refused(startOf(this.stateOf(source)))
    }
    const store = this.storeOf(request.projectId)
    if (this.outstanding(request.projectId) >= CONSOLE_PENDING_MAX) return refused('busy')
    const commandId = randomUUID()
    this.append(store, {
      kind: 'command',
      level: 'log',
      at: this.now(),
      actor: request.actor,
      commandId,
      text: request.expression,
      url: this.urlOf(source),
    })
    if (request.actor === 'user') this.remember(store, request.expression)
    const timeoutMs = within(request.timeoutMs, {
      min: CONSOLE_AGENT_TIMEOUT_MS.min,
      max: CONSOLE_HUMAN_TIMEOUT_MS,
    })
    const done = this.launch(store, source, context, {
      commandId,
      actor: request.actor,
      expression: request.expression,
      timeoutMs,
    })
    return { commandId, status: 'started', done }
  }

  async expand(projectId: string, handleId: string): Promise<ConsoleExpansion> {
    const handle = this.handles.get(handleId)
    const store = this.stores.get(projectId)
    if (handle?.projectId !== projectId || handle.epoch !== store?.epoch) {
      return GONE
    }
    const source = this.sources.get(handle.sourceId)
    if (source?.generation !== handle.generation) return GONE
    if (!source.attached || source.state !== 'ready') return UNAVAILABLE
    const session = source.session
    let raw: unknown
    try {
      raw = await this.send(source, 'Runtime.getProperties', {
        objectId: handle.objectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
        generatePreview: true,
      })
    } catch {
      return this.alive(handle, source, session) ? UNAVAILABLE : GONE
    }
    const listed = CdpPropertyList.safeParse(raw)
    const own = listed.success ? listed.data.result : []
    const indexed = own.filter(indexedName)
    const others: ListedProperty[] = [
      ...own
        .filter((item) => !indexedName(item))
        .map((item) => ({ kind: 'own' as const, raw: item })),
      ...(listed.success ? (listed.data.privateProperties ?? []) : []).map((item) => ({
        kind: 'private' as const,
        raw: item,
      })),
      ...(listed.success ? (listed.data.internalProperties ?? []) : []).map((item) => ({
        kind: 'internal' as const,
        raw: item,
      })),
    ]
    const shownOthers = others.slice(0, CONSOLE_NAMED_MAX)
    const shownIndexed = indexed
      .slice(0, CONSOLE_PROPERTIES_MAX - shownOthers.length)
      .map((item) => ({ kind: 'own' as const, raw: item }))
    const shown = [...shownIndexed, ...shownOthers]
    const hidden: ListedProperty[] = [
      ...indexed.slice(shownIndexed.length).map((item) => ({ kind: 'own' as const, raw: item })),
      ...others.slice(shownOthers.length),
    ]
    const owner = store.byId.get(handle.entryId)
    if (
      owner === undefined ||
      this.stores.get(projectId) !== store ||
      store.epoch !== handle.epoch ||
      !this.alive(handle, source, session)
    ) {
      if (!handle.grouped) this.releaseReferences(source, [...shown, ...hidden])
      return GONE
    }
    if (!listed.success) return UNAVAILABLE
    if (!handle.grouped) this.releaseReferences(source, hidden)
    const place: Place = {
      entryId: handle.entryId,
      depth: handle.depth + 1,
      handles: owner.handles,
      grouped: handle.grouped,
      quote: true,
      contextId: handle.contextId,
      clipped: { cut: false },
    }
    const properties = shown.flatMap((item) => this.propertyOf(store, source, item, place))
    return {
      status: 'ok',
      properties,
      total: indexed.length + others.length,
      omittedIndexed: indexed.length - shownIndexed.length,
    }
  }

  clear(projectId: string): void {
    const store = this.stores.get(projectId)
    if (store === undefined) return
    store.epoch = this.nextEpoch()
    store.clearedAt = this.now()
    for (const stored of store.entries) {
      for (const id of stored.handles) this.dropHandle(store, id, false)
    }
    store.entries = []
    store.byId.clear()
    store.bytes = 0
    store.outbox = []
    store.dropped = 0
    store.windowCount = 0
    for (const source of [...this.sources.values()]) {
      if (source.projectId !== projectId) continue
      for (const finish of [...source.pending.values()]) finish({ kind: 'cleared' })
      for (const group of source.groups) {
        this.fire(source, 'Runtime.releaseObjectGroup', { objectGroup: group })
      }
      source.groups.clear()
      this.fire(source, 'Runtime.releaseObjectGroup', { objectGroup: CONSOLE_GROUP })
      this.fire(source, 'Runtime.discardConsoleEntries')
      this.fire(source, 'Log.clear')
    }
    if (store.timer !== null) {
      clearTimeout(store.timer)
      store.timer = null
    }
    this.emit({ kind: 'cleared', projectId, epoch: store.epoch })
    store.stateDirty = true
    this.deliver(store)
  }

  read(projectId: string, request: ConsoleReadRequest): string {
    const store = this.stores.get(projectId)
    const count = within(request.count, CONSOLE_AGENT_COUNT)
    const skip = within(request.skip, CONSOLE_AGENT_SKIP)
    const levels = new Set(request.levels ?? [])
    const all = store?.entries ?? []
    const matching =
      levels.size === 0 ? all : all.filter((stored) => levels.has(stored.entry.level))
    const newest = [...matching].reverse().slice(skip, skip + count)
    const rows: Record<string, unknown>[] = []
    const page = this.page(projectId)
    const head = {
      page,
      total: matching.length,
      skip,
      dropped: store?.dropped ?? 0,
      omitted: newest.length,
      cut: false,
    }
    let room = CONSOLE_AGENT_BYTES - jsonBytes({ ...head, rows })
    let rowsCut = false
    for (const stored of newest) {
      const row = agentRow(stored.entry)
      const cost = jsonBytes(row) + (rows.length === 0 ? 0 : 1)
      if (cost > room) break
      rows.push(row)
      room -= cost
      if (row['cut'] === true) rowsCut = true
    }
    const omitted = newest.length - rows.length
    return JSON.stringify({ ...head, rows, omitted, cut: rowsCut || omitted > 0 })
  }

  async run(projectId: string, request: ConsoleRunRequest): Promise<string> {
    const launch = this.evaluate({
      projectId,
      expression: request.expression,
      actor: request.actor,
      timeoutMs: within(request.timeoutMs, CONSOLE_AGENT_TIMEOUT_MS),
    })
    if (launch.commandId === null || launch.done === null) {
      return JSON.stringify({
        status: launch.status,
        commandId: null,
        url: this.page(projectId)?.url ?? null,
      })
    }
    return agentOutcome(launch.commandId, await launch.done)
  }

  dispose(projectId: string): void {
    const store = this.stores.get(projectId)
    if (store !== undefined) {
      this.stores.delete(projectId)
      if (store.timer !== null) clearTimeout(store.timer)
    }
    for (const source of [...this.sources.values()]) {
      if (source.projectId !== projectId) continue
      for (const finish of [...source.pending.values()]) finish({ kind: 'cleared' })
      for (const group of source.groups) {
        this.fire(source, 'Runtime.releaseObjectGroup', { objectGroup: group })
      }
      source.groups.clear()
      this.fire(source, 'Runtime.releaseObjectGroup', { objectGroup: CONSOLE_GROUP })
      this.release(source.contents)
    }
    for (const [id, handle] of this.handles) {
      if (handle.projectId === projectId) this.handles.delete(id)
    }
    if (store === undefined || this.closed) return
    this.emit({ kind: 'cleared', projectId, epoch: this.nextEpoch() })
    this.emit({ kind: 'state', projectId, sources: [], dropped: 0 })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const source of [...this.sources.values()]) this.release(source.contents)
    for (const store of this.stores.values()) {
      if (store.timer !== null) clearTimeout(store.timer)
    }
    this.stores.clear()
    this.handles.clear()
    this.listeners.clear()
  }

  private nextEpoch(): number {
    this.epochs += 1
    return this.epochs
  }

  private mainContext(source: Source): ExecutionContext | undefined {
    return source.rootFrameId === null ? undefined : source.contexts.get(source.rootFrameId)
  }

  private listen(source: Source): void {
    const { contents } = source
    const debuggee = contents.debugger
    const onMessage = (
      _event: unknown,
      method: string,
      params: unknown,
      sessionId?: string
    ): void => {
      if (sessionId !== undefined && sessionId !== '') return
      this.receive(source, method, params)
    }
    const onDetach = (): void => {
      this.detached(source)
    }
    const onNavigate = (_event: unknown, url: string): void => {
      this.navigated(source, url)
    }
    const onGone = (_event: unknown, details: { readonly reason: string }): void => {
      this.crashed(source, details.reason)
    }
    const onOpened = (): void => {
      if (source.attached) return
      source.state = 'paused'
      this.touch(this.storeOf(source.projectId))
    }
    const onClosed = (): void => {
      if (!source.attached || source.state !== 'ready') this.connect(source)
    }
    const onDestroyed = (): void => {
      this.release(contents)
    }
    debuggee.on('message', onMessage)
    debuggee.on('detach', onDetach)
    contents.on('did-navigate', onNavigate)
    contents.on('render-process-gone', onGone)
    contents.on('devtools-opened', onOpened)
    contents.on('devtools-closed', onClosed)
    contents.once('destroyed', onDestroyed)
    source.cleanup.push(() => {
      debuggee.removeListener('message', onMessage)
      debuggee.removeListener('detach', onDetach)
      contents.removeListener('did-navigate', onNavigate)
      contents.removeListener('render-process-gone', onGone)
      contents.removeListener('devtools-opened', onOpened)
      contents.removeListener('devtools-closed', onClosed)
      contents.removeListener('destroyed', onDestroyed)
    })
  }

  private connect(source: Source): void {
    if (source.released || this.closed || source.contents.isDestroyed()) return
    const store = this.storeOf(source.projectId)
    const debuggee = source.contents.debugger
    if (!debuggee.isAttached()) {
      try {
        debuggee.attach(PROTOCOL_VERSION)
      } catch {
        source.attached = false
        source.state = source.contents.isDevToolsOpened() ? 'paused' : 'unavailable'
        this.touch(store)
        return
      }
      this.cancelRequests(source)
    }
    source.attached = true
    source.session += 1
    const session = source.session
    source.state = 'connecting'
    source.replaying = true
    source.replayFloor = Math.max(source.lastTimestamp, store.clearedAt)
    this.touch(store)
    Promise.all([this.send(source, 'Runtime.enable'), this.send(source, 'Log.enable')]).then(
      () => {
        if (!this.current(source, session)) return
        source.replaying = false
        source.state = 'ready'
        this.touch(this.storeOf(source.projectId))
        this.root(source, session)
      },
      () => {
        if (!this.current(source, session)) return
        source.replaying = false
        source.state = 'unavailable'
        this.touch(this.storeOf(source.projectId))
      }
    )
  }

  private current(source: Source, session: number): boolean {
    return !this.closed && !source.released && source.attached && source.session === session
  }

  private alive(handle: Handle, source: Source, session: number): boolean {
    return (
      this.handles.has(handle.id) &&
      !source.released &&
      source.attached &&
      source.session === session &&
      source.generation === handle.generation
    )
  }

  private detachQuietly(contents: WebContents): boolean {
    try {
      contents.debugger.detach()
      return true
    } catch {
      return false
    }
  }

  private async send(
    source: Source,
    method: string,
    params: Readonly<Record<string, unknown>> = {}
  ): Promise<unknown> {
    if (source.released || !source.attached || source.contents.isDestroyed()) {
      throw new Error('The page is not connected')
    }
    const reply: unknown = await source.contents.debugger.sendCommand(method, params)
    return reply
  }

  private fire(
    source: Source,
    method: string,
    params: Readonly<Record<string, unknown>> = {}
  ): void {
    this.send(source, method, params).catch(() => undefined)
  }

  private root(source: Source, session: number): void {
    if (source.rooting || !this.current(source, session)) return
    source.rooting = true
    this.send(source, 'Page.getFrameTree').then(
      (raw) => {
        source.rooting = false
        if (!this.current(source, session)) return
        const parsed = CdpFrameTree.safeParse(raw)
        source.rootFailed = !parsed.success
        if (parsed.success) source.rootFrameId = parsed.data.frameTree.frame.id
        this.touch(this.storeOf(source.projectId))
      },
      () => {
        source.rooting = false
        if (!this.current(source, session)) return
        source.rootFailed = true
        this.touch(this.storeOf(source.projectId))
      }
    )
  }

  private receive(source: Source, method: string, params: unknown): void {
    if (source.released) return
    switch (method) {
      case 'Runtime.consoleAPICalled':
        this.consoleCalled(source, params)
        return
      case 'Runtime.exceptionThrown':
        this.exceptionThrown(source, params)
        return
      case 'Log.entryAdded':
        this.logged(source, params)
        return
      case 'Runtime.executionContextCreated':
        this.contextCreated(source, params)
        return
      case 'Runtime.executionContextDestroyed':
        this.contextDestroyed(source, params)
        return
      case 'Runtime.executionContextsCleared':
        source.contexts.clear()
        this.invalidate(source)
        this.touch(this.storeOf(source.projectId))
        return
      default:
        return
    }
  }

  private consoleCalled(source: Source, params: unknown): void {
    const parsed = CdpConsoleCalled.safeParse(params)
    if (!parsed.success) return
    const call = parsed.data
    const store = this.storeOf(source.projectId)
    if (!this.admit(source, store, call.timestamp)) {
      this.releaseObjects(source, call.args)
      return
    }
    const level = consoleLevel(call.type)
    const stack = framesOf(call.stackTrace)
    const traced =
      level === 'error' || level === 'warning' || call.type === 'trace' || call.type === 'assert'
    this.append(store, {
      kind: 'console',
      level,
      at: call.timestamp,
      method: call.type,
      text: formatConsoleArguments(call.args),
      objects: call.args,
      location: locationOf(stack[0]),
      stack: traced ? stack : [],
      source,
      ...(call.executionContextId === undefined ? {} : { contextId: call.executionContextId }),
      cut: traced && framesCut(call.stackTrace),
    })
  }

  private exceptionThrown(source: Source, params: unknown): void {
    const parsed = CdpExceptionThrown.safeParse(params)
    if (!parsed.success) return
    const { timestamp, exceptionDetails } = parsed.data
    const objects = exceptionDetails.exception === undefined ? [] : [exceptionDetails.exception]
    const store = this.storeOf(source.projectId)
    if (!this.admit(source, store, timestamp)) {
      this.releaseObjects(source, objects)
      return
    }
    const exception = exceptionOf(exceptionDetails)
    this.append(store, {
      kind: 'exception',
      level: 'error',
      at: timestamp,
      text: exception.text,
      objects,
      location: exception.location,
      stack: exception.stack,
      source,
      ...(exceptionDetails.executionContextId === undefined
        ? {}
        : { contextId: exceptionDetails.executionContextId }),
      cut: framesCut(exceptionDetails.stackTrace),
    })
  }

  private logged(source: Source, params: unknown): void {
    const parsed = CdpLogEntryAdded.safeParse(params)
    if (!parsed.success) return
    const { entry } = parsed.data
    const objects = entry.args ?? []
    const store = this.storeOf(source.projectId)
    if (!this.admit(source, store, entry.timestamp)) {
      this.releaseObjects(source, objects)
      return
    }
    const level = logLevel(entry.level)
    const stack = framesOf(entry.stackTrace)
    const location =
      entry.url !== undefined && entry.url !== ''
        ? { url: cut(entry.url, CONSOLE_URL_MAX), line: position(entry.lineNumber), column: 1 }
        : locationOf(stack[0])
    this.append(store, {
      kind: 'browser',
      level,
      at: entry.timestamp,
      method: entry.source,
      text: entry.text,
      objects,
      location,
      stack: level === 'error' || level === 'warning' ? stack : [],
      source,
      cut: (level === 'error' || level === 'warning') && framesCut(entry.stackTrace),
    })
  }

  private contextCreated(source: Source, params: unknown): void {
    const parsed = CdpContextCreated.safeParse(params)
    if (!parsed.success) return
    const { context } = parsed.data
    const frameId = context.auxData?.frameId
    if (context.auxData?.isDefault !== true || frameId === undefined) return
    source.contexts.set(frameId, { id: context.id, uniqueId: context.uniqueId })
    if (frameId === source.rootFrameId) {
      this.touch(this.storeOf(source.projectId))
      return
    }
    if (source.rootFrameId === null || !source.contexts.has(source.rootFrameId)) {
      this.root(source, source.session)
    }
  }

  private contextDestroyed(source: Source, params: unknown): void {
    const parsed = CdpContextDestroyed.safeParse(params)
    if (!parsed.success) return
    const contextId = parsed.data.executionContextId
    let root = false
    for (const [frameId, context] of source.contexts) {
      if (context.id !== contextId) continue
      source.contexts.delete(frameId)
      if (frameId === source.rootFrameId) root = true
    }
    if (!root) {
      this.forgetContext(source, contextId)
      return
    }
    this.invalidate(source)
    this.touch(this.storeOf(source.projectId))
  }

  private forgetContext(source: Source, contextId: number): void {
    const store = this.stores.get(source.projectId)
    for (const [id, handle] of this.handles) {
      if (handle.sourceId !== source.id || handle.contextId !== contextId) continue
      this.handles.delete(id)
      if (store !== undefined) store.handleCount = Math.max(0, store.handleCount - 1)
    }
  }

  private detached(source: Source): void {
    if (source.released) return
    source.attached = false
    source.replaying = false
    source.session += 1
    source.contexts.clear()
    source.rootFrameId = null
    source.rootFailed = false
    this.cancelRequests(source)
    this.invalidate(source)
    const paused = !source.contents.isDestroyed() && source.contents.isDevToolsOpened()
    source.state = paused ? 'paused' : 'unavailable'
    this.touch(this.storeOf(source.projectId))
  }

  private navigated(source: Source, url: string): void {
    if (source.released) return
    this.append(this.storeOf(source.projectId), {
      kind: 'navigation',
      level: 'info',
      at: this.now(),
      text: cut(url, CONSOLE_URL_MAX),
      url: url === '' ? null : cut(url, CONSOLE_URL_MAX),
    })
    if (source.attached ? source.state === 'unavailable' : !source.contents.isDevToolsOpened()) {
      this.connect(source)
    }
  }

  private crashed(source: Source, reason: string): void {
    if (source.released) return
    const store = this.storeOf(source.projectId)
    this.append(store, {
      kind: 'crash',
      level: 'error',
      at: this.now(),
      method: reason,
      text: cut(reason, CONSOLE_TEXT_MAX),
      url: this.urlOf(source),
    })
    source.contexts.clear()
    this.invalidate(source)
    source.state = 'unavailable'
    this.touch(store)
  }

  private invalidate(source: Source): void {
    source.generation += 1
    source.groups.clear()
    const store = this.stores.get(source.projectId)
    for (const [id, handle] of this.handles) {
      if (handle.sourceId !== source.id) continue
      this.handles.delete(id)
      if (handle.projectId === store?.projectId) store.handleCount -= 1
    }
    for (const finish of [...source.pending.values()]) finish({ kind: 'interrupted' })
  }

  private admit(source: Source, store: Store, timestamp: number): boolean {
    if (source.replaying && timestamp <= source.replayFloor) return false
    if (timestamp < store.clearedAt) return false
    source.lastTimestamp = Math.max(source.lastTimestamp, timestamp)
    const now = this.now()
    if (now - store.windowStart >= RATE_WINDOW_MS) {
      store.windowStart = now
      store.windowCount = 0
    }
    if (store.windowCount >= CONSOLE_PAGE_RATE) {
      store.dropped = Math.min(Number.MAX_SAFE_INTEGER, store.dropped + 1)
      this.touch(store)
      return false
    }
    store.windowCount += 1
    return true
  }

  private releaseObjects(source: Source, objects: readonly CdpRemoteObject[]): void {
    for (const object of objects) {
      if (object.objectId !== undefined) {
        this.fire(source, 'Runtime.releaseObject', { objectId: object.objectId })
      }
    }
  }

  private releaseReferences(source: Source, items: readonly ListedProperty[]): void {
    for (const item of items.slice(0, CONSOLE_RELEASE_MAX)) {
      for (const objectId of referencesOf(item.raw)) {
        this.fire(source, 'Runtime.releaseObject', { objectId })
      }
    }
  }

  private releaseGroup(source: Source, launched: Launched): void {
    source.groups.delete(launched.group)
    if (source.session !== launched.session || source.generation !== launched.generation) return
    this.fire(source, 'Runtime.releaseObjectGroup', { objectGroup: launched.group })
  }

  private launch(
    store: Store,
    source: Source,
    context: ExecutionContext,
    run: {
      readonly commandId: string
      readonly actor: ConsoleActor
      readonly expression: string
      readonly timeoutMs: number
    }
  ): Promise<ConsoleOutcome> {
    const human = run.actor === 'user'
    const launched: Launched = {
      commandId: run.commandId,
      actor: run.actor,
      group: `${GROUP_PREFIX}${run.commandId}`,
      generation: source.generation,
      epoch: store.epoch,
      session: source.session,
      contextId: context.id,
    }
    const attachment = source.attachment
    source.groups.add(launched.group)
    source.inflight.add(run.commandId)
    const answered = (): void => {
      if (source.attachment === attachment) source.inflight.delete(run.commandId)
    }
    return new Promise<ConsoleOutcome>((resolve) => {
      let open = true
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (settlement: Settlement): void => {
        if (!open) return
        open = false
        if (timer !== null) clearTimeout(timer)
        source.pending.delete(run.commandId)
        resolve(this.settle(store, source, launched, settlement))
      }
      source.pending.set(run.commandId, finish)
      timer = setTimeout(() => {
        finish({ kind: 'timeout' })
      }, run.timeoutMs)
      this.send(source, 'Runtime.evaluate', {
        expression: run.expression,
        objectGroup: launched.group,
        includeCommandLineAPI: human,
        silent: false,
        generatePreview: true,
        userGesture: human,
        awaitPromise: true,
        replMode: true,
        timeout: run.timeoutMs,
        uniqueContextId: context.uniqueId,
      }).then(
        (raw) => {
          answered()
          if (open) {
            finish({ kind: 'reply', raw })
            return
          }
          this.releaseGroup(source, launched)
        },
        (error: unknown) => {
          answered()
          finish({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      )
    })
  }

  private cancelRequests(source: Source): void {
    source.attachment += 1
    source.inflight.clear()
  }

  private outstanding(projectId: string): number {
    let total = 0
    for (const source of this.sources.values()) {
      if (source.projectId === projectId) total += source.inflight.size
    }
    return total
  }

  private settle(
    store: Store,
    source: Source,
    launched: Launched,
    settlement: Settlement
  ): ConsoleOutcome {
    const url = this.urlOf(source)
    const blank = (status: ConsoleOutcome['status']): ConsoleOutcome => ({
      status,
      url,
      result: null,
      exception: null,
      failure: null,
    })
    if (
      settlement.kind === 'cleared' ||
      this.closed ||
      this.stores.get(store.projectId) !== store ||
      store.epoch !== launched.epoch
    ) {
      this.releaseGroup(source, launched)
      return blank('cleared')
    }
    if (
      settlement.kind === 'interrupted' ||
      source.released ||
      source.generation !== launched.generation ||
      this.mainContext(source)?.id !== launched.contextId
    ) {
      this.releaseGroup(source, launched)
      this.result(store, launched, 'interrupted', url, '')
      return blank('interrupted')
    }
    switch (settlement.kind) {
      case 'timeout':
        this.releaseGroup(source, launched)
        this.result(store, launched, 'timeout', url, '')
        return blank('timeout')
      case 'error': {
        this.releaseGroup(source, launched)
        const failure = cut(settlement.message, CONSOLE_VALUE_TEXT_MAX)
        this.result(store, launched, 'failed', url, failure)
        return { ...blank('failed'), failure }
      }
      case 'reply':
        return this.replied(store, source, launched, settlement.raw, url)
    }
  }

  private result(
    store: Store,
    launched: Launched,
    status: ConsoleRunStatus,
    url: string | null,
    text: string
  ): void {
    this.append(store, {
      kind: 'result',
      level: status === 'failed' ? 'error' : 'warning',
      at: this.now(),
      actor: launched.actor,
      commandId: launched.commandId,
      status,
      text,
      url,
    })
  }

  private replied(
    store: Store,
    source: Source,
    launched: Launched,
    raw: unknown,
    url: string | null
  ): ConsoleOutcome {
    const parsed = CdpEvaluated.safeParse(raw)
    if (!parsed.success) {
      this.releaseGroup(source, launched)
      this.result(store, launched, 'failed', url, '')
      return { status: 'failed', url, result: null, exception: null, failure: null }
    }
    const { result, exceptionDetails } = parsed.data
    const retained = (exceptionDetails?.exception ?? result).objectId !== undefined
    if (!retained) this.releaseGroup(source, launched)
    const group = retained ? launched.group : undefined
    const base = {
      kind: 'result' as const,
      at: this.now(),
      actor: launched.actor,
      commandId: launched.commandId,
      url,
      source,
      contextId: launched.contextId,
      ...(group === undefined ? {} : { group }),
    }
    if (exceptionDetails !== undefined) {
      const exception = exceptionOf(exceptionDetails)
      this.append(store, {
        ...base,
        level: 'error',
        status: 'threw',
        text: exception.text,
        objects: exceptionDetails.exception === undefined ? [] : [exceptionDetails.exception],
        location: exception.location,
        stack: exception.stack,
        cut: framesCut(exceptionDetails.stackTrace),
      })
      return {
        status: 'threw',
        url,
        result: null,
        exception: {
          text: clip(exception.text, CONSOLE_AGENT_VALUE_MAX),
          location: exception.location,
          stack: exception.stack,
        },
        failure: null,
      }
    }
    const text = remoteText(result, true)
    this.append(store, {
      ...base,
      level: 'log',
      status: 'ok',
      text,
      objects: [result],
      quote: true,
    })
    return {
      status: 'ok',
      url,
      result: {
        type: valueType(result.type),
        subtype: result.subtype === undefined ? null : cut(result.subtype, CONSOLE_METHOD_MAX),
        text: clip(text, CONSOLE_AGENT_VALUE_MAX),
      },
      exception: null,
      failure: null,
    }
  }

  private propertyOf(
    store: Store,
    source: Source,
    item: ListedProperty,
    place: Place
  ): ConsoleProperty[] {
    if (item.kind === 'internal') {
      const parsed = CdpInternalSlot.safeParse(item.raw)
      if (!parsed.success) return []
      return [
        {
          name: cut(parsed.data.name, CONSOLE_NAME_MAX),
          kind: 'internal',
          enumerable: false,
          value: this.slotOf(store, source, parsed.data, place),
        },
      ]
    }
    const parsed = CdpSlot.safeParse(item.raw)
    if (!parsed.success) return []
    const slot = parsed.data
    if (!place.grouped && slot.symbol?.objectId !== undefined) {
      this.fire(source, 'Runtime.releaseObject', { objectId: slot.symbol.objectId })
    }
    return [
      {
        name: cut(slot.symbol?.description ?? slot.name, CONSOLE_NAME_MAX),
        kind: item.kind,
        enumerable: item.kind === 'own' && slot.enumerable === true,
        value: this.slotOf(store, source, slot, place),
      },
    ]
  }

  private slotOf(
    store: Store,
    source: Source,
    slot: Pick<CdpSlot, 'value'> & Partial<Pick<CdpSlot, 'get' | 'set'>>,
    place: Place
  ): ConsoleValue {
    if (slot.value !== undefined) return this.valueOf(store, source, slot.value, place)
    const accessors = [slot.get, slot.set].filter(
      (accessor): accessor is CdpRemoteObject => accessor !== undefined
    )
    if (!place.grouped) this.releaseObjects(source, accessors)
    return accessors.length === 0 ? UNDEFINED : ACCESSOR
  }

  private valueOf(
    store: Store,
    source: Source | undefined,
    object: CdpRemoteObject,
    place: Place
  ): ConsoleValue {
    const full = remoteText(object, place.quote)
    if (full.length > CONSOLE_VALUE_TEXT_MAX) place.clipped.cut = true
    const value = {
      type: valueType(object.type),
      subtype: object.subtype === undefined ? null : cut(object.subtype, CONSOLE_METHOD_MAX),
      text: cut(full, CONSOLE_VALUE_TEXT_MAX),
    }
    const objectId = object.objectId
    if (objectId === undefined || source === undefined) return { ...value, handle: null }
    if (
      place.depth >= CONSOLE_EXPAND_DEPTH_MAX ||
      store.handleCount >= CONSOLE_HANDLES_MAX ||
      !source.attached ||
      source.released
    ) {
      if (!place.grouped) this.fire(source, 'Runtime.releaseObject', { objectId })
      return { ...value, handle: null }
    }
    const id = randomUUID()
    this.handles.set(id, {
      id,
      projectId: store.projectId,
      sourceId: source.id,
      generation: source.generation,
      epoch: store.epoch,
      objectId,
      entryId: place.entryId,
      depth: place.depth,
      grouped: place.grouped,
      contextId: place.contextId,
    })
    store.handleCount += 1
    place.handles.push(id)
    return { ...value, handle: id }
  }

  private append(store: Store, draft: Draft): ConsoleEntry {
    const id = randomUUID()
    const handles: string[] = []
    const source = draft.source
    const grouped = draft.group !== undefined
    const objects = draft.objects ?? []
    const shown = objects.slice(0, CONSOLE_VALUES_MAX)
    if (source !== undefined && !grouped) {
      this.releaseObjects(source, objects.slice(CONSOLE_VALUES_MAX))
    }
    const wanted = shown.filter((object) => object.objectId !== undefined).length
    while (store.handleCount + wanted > CONSOLE_HANDLES_MAX && store.entries.length > 0) {
      this.evict(store)
    }
    const place: Place = {
      entryId: id,
      depth: 0,
      handles,
      grouped,
      quote: draft.quote === true,
      contextId: draft.contextId ?? null,
      clipped: { cut: false },
    }
    const values = shown.map((object) => this.valueOf(store, source, object, place))
    const limit = draft.kind === 'command' ? CONSOLE_EXPRESSION_MAX : CONSOLE_TEXT_MAX
    this.sequence += 1
    const entry: ConsoleEntry = {
      id,
      seq: this.sequence,
      at: Number.isFinite(draft.at) ? draft.at : this.now(),
      kind: draft.kind,
      level: draft.level,
      method:
        draft.method === undefined || draft.method === null
          ? null
          : cut(draft.method, CONSOLE_METHOD_MAX),
      actor: draft.actor ?? null,
      commandId: draft.commandId ?? null,
      status: draft.status ?? null,
      text: cut(draft.text, limit),
      values,
      location: draft.location ?? null,
      stack: (draft.stack ?? []).slice(0, CONSOLE_FRAMES_MAX),
      url: draft.url ?? null,
      cut:
        draft.cut === true ||
        place.clipped.cut ||
        draft.text.length > limit ||
        objects.length > CONSOLE_VALUES_MAX ||
        (draft.stack ?? []).length > CONSOLE_FRAMES_MAX,
    }
    const stored: StoredEntry = {
      entry,
      bytes: jsonBytes(entry),
      handles,
      group:
        source !== undefined && draft.group !== undefined
          ? { sourceId: source.id, name: draft.group }
          : null,
    }
    store.entries.push(stored)
    store.byId.set(id, stored)
    store.bytes += stored.bytes
    while (
      store.entries.length > 1 &&
      (store.entries.length > CONSOLE_ENTRIES_MAX || store.bytes > CONSOLE_STORE_BYTES)
    ) {
      this.evict(store)
    }
    store.outbox.push(entry)
    this.schedule(store)
    return entry
  }

  private evict(store: Store): void {
    const oldest = store.entries.shift()
    if (oldest === undefined) return
    store.byId.delete(oldest.entry.id)
    store.bytes -= oldest.bytes
    for (const id of oldest.handles) this.dropHandle(store, id, true)
    const group = oldest.group
    if (group === null) return
    const source = this.sources.get(group.sourceId)
    if (!source?.groups.delete(group.name)) return
    this.fire(source, 'Runtime.releaseObjectGroup', { objectGroup: group.name })
  }

  private dropHandle(store: Store, id: string, release: boolean): void {
    const handle = this.handles.get(id)
    if (handle === undefined) return
    this.handles.delete(id)
    store.handleCount = Math.max(0, store.handleCount - 1)
    if (!release || handle.grouped) return
    const source = this.sources.get(handle.sourceId)
    if (source?.generation !== handle.generation) return
    this.fire(source, 'Runtime.releaseObject', { objectId: handle.objectId })
  }

  private remember(store: Store, expression: string): void {
    if (store.history.at(-1) === expression) return
    store.history.push(expression)
    let bytes = store.history.reduce((total, line) => total + Buffer.byteLength(line, 'utf8'), 0)
    while (
      store.history.length > 1 &&
      (store.history.length > CONSOLE_HISTORY_MAX || bytes > CONSOLE_HISTORY_BYTES)
    ) {
      const dropped = store.history.shift()
      bytes -= dropped === undefined ? 0 : Buffer.byteLength(dropped, 'utf8')
    }
  }

  private storeOf(projectId: string): Store {
    const existing = this.stores.get(projectId)
    if (existing !== undefined) return existing
    const store: Store = {
      projectId,
      byId: new Map(),
      epoch: this.nextEpoch(),
      entries: [],
      bytes: 0,
      handleCount: 0,
      dropped: 0,
      history: [],
      outbox: [],
      stateDirty: false,
      timer: null,
      windowStart: 0,
      windowCount: 0,
      clearedAt: 0,
    }
    this.stores.set(projectId, store)
    return store
  }

  private preferred(projectId: string): Source | undefined {
    const owner = this.deps.preferredOwner(projectId)
    let chosen: Source | undefined
    let newest: Source | undefined
    for (const source of this.sources.values()) {
      if (source.projectId !== projectId || source.contents.isDestroyed()) continue
      if (newest === undefined || source.order > newest.order) newest = source
      if (owner === null || source.owner !== owner) continue
      if (chosen === undefined || source.order > chosen.order) chosen = source
    }
    return chosen ?? newest
  }

  private stateOf(source: Source): ConsoleState {
    if (source.contents.isDestroyed()) return 'unavailable'
    if (source.state !== 'ready' || this.mainContext(source) !== undefined) return source.state
    return source.rootFailed ? 'unavailable' : 'connecting'
  }

  private urlOf(source: Source): string | null {
    if (source.contents.isDestroyed()) return null
    const url = source.contents.getURL()
    return url === '' ? null : cut(url, CONSOLE_URL_MAX)
  }

  private sourcesOf(projectId: string): ConsoleSource[] {
    return [...this.sources.values()]
      .filter((source) => source.projectId === projectId)
      .sort((left, right) => left.order - right.order)
      .slice(-CONSOLE_SOURCES_MAX)
      .map((source) => ({
        browserId: source.browserId,
        state: this.stateOf(source),
        url: this.urlOf(source),
      }))
  }

  private touch(store: Store): void {
    store.stateDirty = true
    this.schedule(store)
  }

  private schedule(store: Store): void {
    if (store.timer !== null || this.closed) return
    store.timer = setTimeout(() => {
      store.timer = null
      this.deliver(store)
    }, CONSOLE_FLUSH_MS)
  }

  private deliver(store: Store): void {
    if (this.closed || this.stores.get(store.projectId) !== store) return
    const entries = store.outbox
    store.outbox = []
    for (let start = 0; start < entries.length; start += CONSOLE_PUSH_ENTRIES_MAX) {
      this.emit({
        kind: 'entries',
        projectId: store.projectId,
        epoch: store.epoch,
        entries: entries.slice(start, start + CONSOLE_PUSH_ENTRIES_MAX),
        dropped: store.dropped,
      })
    }
    if (!store.stateDirty) return
    store.stateDirty = false
    this.emit({
      kind: 'state',
      projectId: store.projectId,
      sources: this.sourcesOf(store.projectId),
      dropped: store.dropped,
    })
  }

  private emit(event: ConsoleServiceEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}
