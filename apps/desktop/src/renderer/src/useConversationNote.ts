import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  CONVERSATION_NOTE_MAX_LENGTH,
  type ConversationNote,
  type ConversationNoteView,
  type ConversationNoteWrite,
} from '@chorus/shared'
import type { ConversationNoteJournalResponse } from '../../shared/ipc.js'

export const NOTE_MIN_WIDTH = 160
export const NOTE_MIN_HEIGHT = 96
export const NOTE_DEFAULT_WIDTH = 280
export const NOTE_DEFAULT_HEIGHT = 96
export const NOTE_INSET = 12
const TEXT_SAVE_DELAY_MS = 400

export interface NoteDraft {
  readonly text: string
  readonly base: number
}

export interface NoteViewFields {
  readonly visible: boolean
  readonly x: number | null
  readonly y: number | null
  readonly width: number | null
  readonly height: number | null
}

export interface NoteJournal {
  readonly text: NoteDraft | null
  readonly view: ConversationNoteView | null
}

export type NoteLoad = 'waiting' | 'loading' | 'ready' | 'failed'

export type JournalHealth = 'ok' | 'readFailed' | 'writeFailed'

export interface NoteState {
  readonly load: NoteLoad
  readonly saved: ConversationNote | null
  readonly pending: NoteDraft | null
  readonly sending: NoteDraft | null
  readonly pendingView: ConversationNoteView | null
  readonly sendingView: ConversationNoteView | null
  readonly saveFailed: boolean
  readonly viewFailed: boolean
  readonly journal: JournalHealth
}

export type NoteEvent =
  | { readonly type: 'loading' }
  | { readonly type: 'loaded'; readonly note: ConversationNote }
  | { readonly type: 'loadFailed' }
  | { readonly type: 'pushed'; readonly note: ConversationNote }
  | { readonly type: 'edited'; readonly text: string }
  | { readonly type: 'textSending' }
  | {
      readonly type: 'textSent'
      readonly request: NoteDraft
      readonly result: ConversationNoteWrite
    }
  | { readonly type: 'textFailed' }
  | { readonly type: 'keptMine' }
  | { readonly type: 'usedSaved' }
  | { readonly type: 'viewChanged'; readonly view: ConversationNoteView }
  | { readonly type: 'viewSending' }
  | { readonly type: 'viewSent'; readonly note: ConversationNote }
  | { readonly type: 'viewFailed' }
  | { readonly type: 'retried' }
  | { readonly type: 'journaled'; readonly health: JournalHealth }
  | { readonly type: 'journalRead'; readonly journal: NoteJournal | null }

export type NoteStatus =
  | 'waiting'
  | 'loading'
  | 'failed'
  | 'conflict'
  | 'saveFailed'
  | 'journalReadFailed'
  | 'journalFailed'
  | 'saving'
  | 'saved'

const VIEW_KEYS = ['visible', 'x', 'y', 'width', 'height'] as const

function isFraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function newer(current: ConversationNote | null, next: ConversationNote): ConversationNote {
  return current === null || next.version > current.version ? next : current
}

function definedView(view: ConversationNoteView): ConversationNoteView {
  return {
    ...(view.visible === undefined ? {} : { visible: view.visible }),
    ...(view.x === undefined ? {} : { x: view.x }),
    ...(view.y === undefined ? {} : { y: view.y }),
    ...(view.width === undefined ? {} : { width: view.width }),
    ...(view.height === undefined ? {} : { height: view.height }),
  }
}

function mergeView(
  first: ConversationNoteView | null,
  second: ConversationNoteView | null
): ConversationNoteView | null {
  if (first === null) return second === null ? null : definedView(second)
  if (second === null) return definedView(first)
  return { ...definedView(first), ...definedView(second) }
}

function settle(state: NoteState): NoteState {
  const { pending, saved } = state
  if (pending === null || saved === null || state.sending !== null) return state
  return pending.text === saved.body ? { ...state, pending: null } : state
}

export function initialNoteState(
  journal: NoteJournal | null,
  health: JournalHealth = 'ok'
): NoteState {
  return {
    load: 'waiting',
    saved: null,
    pending: journal?.text ?? null,
    sending: null,
    pendingView: journal?.view ?? null,
    sendingView: null,
    saveFailed: false,
    viewFailed: false,
    journal: health,
  }
}

export function adoptsJournal(state: NoteState, journal: NoteJournal | null): boolean {
  if (journal === null) return true
  const text =
    journal.text === null || state.pending === null || state.pending.text === journal.text.text
  return text && (journal.view === null || state.pendingView === null)
}

export function reduceNote(state: NoteState, event: NoteEvent): NoteState {
  switch (event.type) {
    case 'loading':
      return state.load === 'ready' || state.load === 'loading'
        ? state
        : { ...state, load: 'loading' }
    case 'loaded':
      return settle({ ...state, load: 'ready', saved: newer(state.saved, event.note) })
    case 'loadFailed':
      return state.load === 'ready' ? state : { ...state, load: 'failed' }
    case 'pushed': {
      if (state.saved !== null && event.note.version <= state.saved.version) return state
      const saved = event.note
      const { pending, sending } = state
      const echoed = pending !== null && sending !== null && saved.body === sending.text
      return settle({
        ...state,
        saved,
        pending: !echoed
          ? pending
          : pending.text === sending.text
            ? null
            : { text: pending.text, base: saved.revision },
      })
    }
    case 'edited': {
      if (state.load !== 'ready' || state.saved === null) return state
      const base = state.pending?.base ?? state.saved.revision
      return settle({ ...state, pending: { text: event.text, base }, saveFailed: false })
    }
    case 'textSending':
      return state.pending === null || state.sending !== null
        ? state
        : { ...state, sending: state.pending }
    case 'textSent': {
      const saved = newer(state.saved, event.result.note)
      const { pending } = state
      const next =
        event.result.status !== 'saved' || pending === null
          ? pending
          : pending.text === event.request.text
            ? null
            : { text: pending.text, base: event.result.note.revision }
      return settle({ ...state, saved, pending: next, sending: null, saveFailed: false })
    }
    case 'textFailed':
      return { ...state, sending: null, saveFailed: true }
    case 'keptMine':
      return state.pending === null || state.saved === null || state.sending !== null
        ? state
        : {
            ...state,
            pending: { text: state.pending.text, base: state.saved.revision },
            saveFailed: false,
          }
    case 'usedSaved':
      return state.sending !== null ? state : { ...state, pending: null, saveFailed: false }
    case 'viewChanged':
      return state.load !== 'ready'
        ? state
        : { ...state, pendingView: mergeView(state.pendingView, event.view), viewFailed: false }
    case 'viewSending':
      return state.pendingView === null || state.sendingView !== null
        ? state
        : { ...state, sendingView: state.pendingView, pendingView: null }
    case 'viewSent':
      return {
        ...state,
        saved: newer(state.saved, event.note),
        sendingView: null,
        viewFailed: false,
      }
    case 'viewFailed':
      return {
        ...state,
        pendingView: mergeView(state.sendingView, state.pendingView),
        sendingView: null,
        viewFailed: true,
      }
    case 'retried':
      return state.saveFailed || state.viewFailed
        ? { ...state, saveFailed: false, viewFailed: false }
        : state
    case 'journaled':
      return state.journal === event.health ? state : { ...state, journal: event.health }
    case 'journalRead':
      return event.journal === null
        ? state
        : settle({
            ...state,
            pending: state.pending ?? event.journal.text,
            pendingView: state.pendingView ?? event.journal.view,
          })
  }
}

export function noteText(state: NoteState): string {
  return state.pending?.text ?? state.saved?.body ?? ''
}

export function noteConflict(state: NoteState): ConversationNote | null {
  const { pending, saved } = state
  if (pending === null || saved === null || state.sending !== null) return null
  return saved.revision !== pending.base && saved.body !== pending.text ? saved : null
}

export function noteView(state: NoteState): NoteViewFields {
  const local = mergeView(state.sendingView, state.pendingView) ?? {}
  const saved = state.saved
  return {
    visible: local.visible ?? saved?.visible ?? false,
    x: local.x ?? saved?.x ?? null,
    y: local.y ?? saved?.y ?? null,
    width: local.width ?? saved?.width ?? null,
    height: local.height ?? saved?.height ?? null,
  }
}

export function needsTextSend(state: NoteState): boolean {
  return (
    state.load === 'ready' &&
    state.pending !== null &&
    state.sending === null &&
    !state.saveFailed &&
    noteConflict(state) === null
  )
}

export function needsViewSend(state: NoteState): boolean {
  return (
    state.load === 'ready' &&
    state.pendingView !== null &&
    state.sendingView === null &&
    !state.viewFailed
  )
}

export function noteStatus(state: NoteState): NoteStatus {
  if (state.load === 'waiting') return 'waiting'
  if (state.load === 'failed') return 'failed'
  if (state.load === 'loading' && state.saved === null) return 'loading'
  if (noteConflict(state) !== null) return 'conflict'
  if (state.saveFailed || state.viewFailed) return 'saveFailed'
  if (state.journal === 'readFailed') return 'journalReadFailed'
  if (state.journal === 'writeFailed') return 'journalFailed'
  const unsaved =
    state.pending !== null ||
    state.sending !== null ||
    state.pendingView !== null ||
    state.sendingView !== null
  return unsaved ? 'saving' : 'saved'
}

export function noteNeedsAttention(state: NoteState): boolean {
  const status = noteStatus(state)
  return (
    status === 'failed' ||
    status === 'conflict' ||
    status === 'saveFailed' ||
    status === 'journalReadFailed' ||
    status === 'journalFailed'
  )
}

export function journalOf(state: NoteState): NoteJournal | null {
  const view = mergeView(state.sendingView, state.pendingView)
  if (state.pending === null && view === null) return null
  return { text: state.pending, view }
}

function parseDraft(value: unknown): NoteDraft | null {
  if (typeof value !== 'object' || value === null) return null
  const { text, base } = value as { text?: unknown; base?: unknown }
  if (typeof text !== 'string' || text.length > CONVERSATION_NOTE_MAX_LENGTH) return null
  if (typeof base !== 'number' || !Number.isSafeInteger(base) || base < 0) return null
  return { text, base }
}

function parseView(value: unknown): ConversationNoteView | null {
  if (typeof value !== 'object' || value === null) return null
  const { visible, x, y, width, height } = value as Record<string, unknown>
  const view: ConversationNoteView = {
    ...(typeof visible === 'boolean' ? { visible } : {}),
    ...(isFraction(x) ? { x } : {}),
    ...(isFraction(y) ? { y } : {}),
    ...(isFraction(width) ? { width } : {}),
    ...(isFraction(height) ? { height } : {}),
  }
  return VIEW_KEYS.some((key) => view[key] !== undefined) ? view : null
}

export function parseJournal(raw: string | null): NoteJournal | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { text, view } = parsed as { text?: unknown; view?: unknown }
  const journal = { text: parseDraft(text), view: parseView(view) }
  return journal.text === null && journal.view === null ? null : journal
}

function journalOwner(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { owner } = parsed as { owner?: unknown }
    return typeof owner === 'string' ? owner : null
  } catch {
    return null
  }
}

export type JournalAnswer =
  | { readonly ok: true; readonly matched: boolean; readonly current: string | null }
  | { readonly ok: false }

export interface JournalBackend {
  read(): JournalAnswer
  compare(expected: string | null, next: string | null): JournalAnswer
}

export type JournalRead =
  | { readonly ok: true; readonly raw: string | null; readonly journal: NoteJournal | null }
  | { readonly ok: false }

export class NoteJournalSlot {
  private seen: string | null = null
  private readable = false
  private settled = false

  constructor(
    private readonly backend: JournalBackend,
    private readonly owner: string
  ) {}

  read(): JournalRead {
    const answer = this.backend.read()
    if (!answer.ok) return { ok: false }
    this.readable = true
    return { ok: true, raw: answer.current, journal: parseJournal(answer.current) }
  }

  adopt(raw: string | null): void {
    this.seen = raw
    this.settled = true
  }

  sync(desired: NoteJournal | null): JournalHealth {
    if (!this.readable) return 'readFailed'
    const next =
      desired === null
        ? null
        : JSON.stringify({ owner: this.owner, text: desired.text, view: desired.view })
    if (next === null && this.seen === null && this.settled) return 'ok'
    let expected = this.seen
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = this.backend.compare(expected, next)
      if (!answer.ok) {
        this.settled = false
        return 'writeFailed'
      }
      if (answer.matched || answer.current === next) {
        this.seen = answer.current
        this.settled = true
        return 'ok'
      }
      const { current } = answer
      if (current !== null && journalOwner(current) !== this.owner) {
        if (next !== null) {
          this.settled = false
          return 'writeFailed'
        }
        this.seen = null
        this.settled = true
        return 'ok'
      }
      expected = current
    }
    this.settled = false
    return 'writeFailed'
  }
}

export interface NoteBounds {
  readonly width: number
  readonly height: number
}

export interface NoteRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(high, low))
}

export function clampNoteRect(rect: NoteRect, bounds: NoteBounds): NoteRect {
  const width = clamp(rect.width, Math.min(NOTE_MIN_WIDTH, bounds.width), bounds.width)
  const height = clamp(rect.height, Math.min(NOTE_MIN_HEIGHT, bounds.height), bounds.height)
  return {
    left: clamp(rect.left, 0, bounds.width - width),
    top: clamp(rect.top, 0, bounds.height - height),
    width,
    height,
  }
}

export function placeNote(view: NoteViewFields, bounds: NoteBounds): NoteRect {
  const width = view.width === null ? NOTE_DEFAULT_WIDTH : view.width * bounds.width
  const height = view.height === null ? NOTE_DEFAULT_HEIGHT : view.height * bounds.height
  return clampNoteRect(
    {
      left: view.x === null ? bounds.width - width - NOTE_INSET : view.x * bounds.width,
      top: view.y === null ? NOTE_INSET : view.y * bounds.height,
      width,
      height,
    },
    bounds
  )
}

function fraction(value: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round(clamp(value / whole, 0, 1) * 10_000) / 10_000
}

export function noteFractions(rect: NoteRect, bounds: NoteBounds): ConversationNoteView {
  return {
    x: fraction(rect.left, bounds.width),
    y: fraction(rect.top, bounds.height),
    width: fraction(rect.width, bounds.width),
    height: fraction(rect.height, bounds.height),
  }
}

export type NoteGestureKind = 'move' | 'resize'

export function gestureRect(
  kind: NoteGestureKind,
  origin: NoteRect,
  dx: number,
  dy: number,
  bounds: NoteBounds
): NoteRect {
  return clampNoteRect(
    kind === 'move'
      ? { ...origin, left: origin.left + dx, top: origin.top + dy }
      : { ...origin, width: origin.width + dx, height: origin.height + dy },
    bounds
  )
}

function journalAnswer(call: () => ConversationNoteJournalResponse): JournalAnswer {
  try {
    const reply = call()
    return reply.ok ? { ok: true, matched: reply.matched, current: reply.current } : { ok: false }
  } catch {
    return { ok: false }
  }
}

export interface NoteApi {
  readonly load: (conversationId: string) => Promise<ConversationNote>
  readonly saveText: (
    conversationId: string,
    text: string,
    baseRevision: number
  ) => Promise<ConversationNoteWrite>
  readonly saveView: (
    conversationId: string,
    view: ConversationNoteView
  ) => Promise<ConversationNote>
  readonly journal: (conversationId: string) => JournalBackend
}

const WINDOW_NOTE_API: NoteApi = {
  load: (conversationId) => window.chorus.getConversationNote({ conversationId }),
  saveText: (conversationId, text, baseRevision) =>
    window.chorus.setConversationNoteText({ conversationId, text, baseRevision }),
  saveView: (conversationId, view) =>
    window.chorus.setConversationNoteView({ conversationId, ...definedView(view) }),
  journal: (conversationId) => ({
    read: () => journalAnswer(() => window.chorus.readConversationNoteJournal({ conversationId })),
    compare: (expected, next) =>
      journalAnswer(() =>
        window.chorus.compareConversationNoteJournal({ conversationId, expected, next })
      ),
  }),
}

let rendererOwner: string | null = null

function journalOwnerId(): string {
  rendererOwner ??= crypto.randomUUID()
  return rendererOwner
}

export class NoteSync {
  private state: NoteState
  private readonly listeners = new Set<() => void>()
  private readonly slot: NoteJournalSlot
  private textTimer: ReturnType<typeof setTimeout> | null = null
  private loading = false
  private disposed = false

  constructor(
    private readonly conversationId: string,
    private readonly api: NoteApi = WINDOW_NOTE_API,
    owner: string = journalOwnerId()
  ) {
    this.slot = new NoteJournalSlot(api.journal(conversationId), owner)
    const read = this.slot.read()
    if (read.ok) {
      this.slot.adopt(read.raw)
      this.state = initialNoteState(read.journal)
    } else {
      this.state = initialNoteState(null, 'readFailed')
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly snapshot = (): NoteState => this.state

  readonly isDisposed = (): boolean => this.disposed

  readonly load = (): void => {
    if (this.disposed || this.loading) return
    this.loading = true
    this.dispatch({ type: 'loading' })
    this.api.load(this.conversationId).then(
      (note) => {
        this.loading = false
        this.dispatch({ type: 'loaded', note })
      },
      () => {
        this.loading = false
        this.dispatch({ type: 'loadFailed' })
      }
    )
  }

  readonly pushed = (note: ConversationNote): void => {
    this.dispatch({ type: 'pushed', note })
  }

  readonly edit = (text: string): void => {
    this.dispatch({ type: 'edited', text })
  }

  readonly changeView = (view: ConversationNoteView): void => {
    this.dispatch({ type: 'viewChanged', view })
  }

  readonly toggle = (): void => {
    if (this.disposed) return
    if (this.state.load === 'failed') {
      this.load()
      return
    }
    this.changeView({ visible: !noteView(this.state).visible })
  }

  readonly keepMine = (): void => {
    this.dispatch({ type: 'keptMine' })
  }

  readonly useSaved = (): void => {
    this.dispatch({ type: 'usedSaved' })
  }

  readonly retry = (): void => {
    if (this.disposed) return
    if (this.state.load === 'failed') this.load()
    if (this.state.journal === 'readFailed') {
      const read = this.slot.read()
      if (read.ok) {
        if (adoptsJournal(this.state, read.journal)) this.slot.adopt(read.raw)
        this.state = reduceNote(this.state, { type: 'journalRead', journal: read.journal })
      }
    }
    this.state = reduceNote(this.state, { type: 'retried' })
    this.commit()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    if (this.textTimer !== null) {
      clearTimeout(this.textTimer)
      this.textTimer = null
    }
    this.state = initialNoteState(null)
    for (const listener of this.listeners) listener()
    this.listeners.clear()
  }

  private dispatch(event: NoteEvent): void {
    if (this.disposed) return
    const next = reduceNote(this.state, event)
    if (next === this.state) return
    this.state = next
    this.commit()
  }

  private commit(): void {
    if (this.disposed) return
    const health = this.slot.sync(journalOf(this.state))
    this.state = reduceNote(this.state, { type: 'journaled', health })
    for (const listener of this.listeners) listener()
    this.schedule()
  }

  private schedule(): void {
    if (this.disposed) return
    if (needsTextSend(this.state) && this.textTimer === null) {
      this.textTimer = setTimeout(() => {
        this.textTimer = null
        this.sendText()
      }, TEXT_SAVE_DELAY_MS)
    }
    if (needsViewSend(this.state)) this.sendView()
  }

  private sendText(): void {
    if (this.disposed || !needsTextSend(this.state)) return
    this.dispatch({ type: 'textSending' })
    const request = this.state.sending
    if (request === null) return
    this.api.saveText(this.conversationId, request.text, request.base).then(
      (result) => {
        this.dispatch({ type: 'textSent', request, result })
      },
      () => {
        this.dispatch({ type: 'textFailed' })
      }
    )
  }

  private sendView(): void {
    this.dispatch({ type: 'viewSending' })
    const view = this.state.sendingView
    if (view === null) return
    this.api.saveView(this.conversationId, view).then(
      (note) => {
        this.dispatch({ type: 'viewSent', note })
      },
      () => {
        this.dispatch({ type: 'viewFailed' })
      }
    )
  }
}

const syncs = new Map<string, NoteSync>()
let listening = false

function forgetSync(conversationId: string): void {
  const sync = syncs.get(conversationId)
  if (sync === undefined) return
  syncs.delete(conversationId)
  sync.dispose()
}

function noteSync(conversationId: string): NoteSync {
  const known = syncs.get(conversationId)
  if (known !== undefined) return known
  const created = new NoteSync(conversationId)
  syncs.set(conversationId, created)
  if (!listening) {
    listening = true
    window.chorus.onConversationNote((push) => {
      if (push.note === null) forgetSync(push.conversationId)
      else syncs.get(push.conversationId)?.pushed(push.note)
    })
  }
  return created
}

export interface ConversationNoteHandle {
  readonly state: NoteState
  readonly status: NoteStatus
  readonly text: string
  readonly view: NoteViewFields
  readonly conflict: ConversationNote | null
  readonly attention: boolean
  readonly edit: (text: string) => void
  readonly changeView: (view: ConversationNoteView) => void
  readonly toggle: () => void
  readonly keepMine: () => void
  readonly useSaved: () => void
  readonly retry: () => void
}

export function useConversationNote(
  conversationId: string,
  starting: boolean
): ConversationNoteHandle {
  const [sync] = useState(() => noteSync(conversationId))
  const state = useSyncExternalStore(sync.subscribe, sync.snapshot)
  useEffect(() => {
    if (!starting) sync.load()
  }, [sync, starting])
  return {
    state,
    status: noteStatus(state),
    text: noteText(state),
    view: noteView(state),
    conflict: noteConflict(state),
    attention: noteNeedsAttention(state),
    edit: sync.edit,
    changeView: sync.changeView,
    toggle: sync.toggle,
    keepMine: sync.keepMine,
    useSaved: sync.useSaved,
    retry: sync.retry,
  }
}
