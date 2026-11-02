import { CONVERSATION_NOTE_MAX_LENGTH, type ConversationNote as SavedNote } from '@chorus/shared'
import { useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  gestureRect,
  noteFractions,
  placeNote,
  type ConversationNoteHandle,
  type NoteBounds,
  type NoteGestureKind,
  type NoteRect,
  type NoteStatus,
} from './useConversationNote.js'

interface Gesture {
  readonly kind: NoteGestureKind
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly origin: NoteRect
}

interface LiveGesture {
  readonly kind: NoteGestureKind
  readonly origin: NoteRect
  readonly dx: number
  readonly dy: number
}

const RETRYABLE: ReadonlySet<NoteStatus> = new Set([
  'failed',
  'saveFailed',
  'journalReadFailed',
  'journalFailed',
])

export function ConversationNote(props: {
  readonly note: ConversationNoteHandle
}): React.JSX.Element {
  const { t } = useTranslation()
  const { note } = props
  const root = useRef<HTMLDivElement | null>(null)
  const body = useRef<HTMLTextAreaElement | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const latestBounds = useRef<NoteBounds | null>(null)
  const [bounds, setBounds] = useState<NoteBounds | null>(null)
  const [live, setLive] = useState<LiveGesture | null>(null)

  useLayoutEffect(() => {
    const pane = root.current?.parentElement
    if (pane === null || pane === undefined) return
    const measure = (): void => {
      const width = pane.clientWidth
      const height = pane.clientHeight
      const current = latestBounds.current
      if (current !== null && current.width === width && current.height === height) return
      const next = { width, height }
      latestBounds.current = next
      setBounds(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(pane)
    return () => {
      observer.disconnect()
    }
  }, [])

  const placed = bounds === null ? null : placeNote(note.view, bounds)
  const rect =
    live === null
      ? placed
      : bounds === null
        ? null
        : gestureRect(live.kind, live.origin, live.dx, live.dy, bounds)

  const canFocus = rect !== null && note.state.load === 'ready'

  useLayoutEffect(() => {
    const textarea = body.current
    if (!canFocus || textarea === null) return
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(0, 0)
    textarea.scrollTop = 0
    textarea.scrollLeft = 0
  }, [canFocus])

  const begin =
    (kind: NoteGestureKind) =>
    (event: ReactPointerEvent<HTMLElement>): void => {
      if (event.button !== 0 || placed === null || gesture.current !== null) return
      if (event.target instanceof Element && event.target.closest('button') !== null) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      gesture.current = {
        kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: placed,
      }
      setLive({ kind, origin: placed, dx: 0, dy: 0 })
    }

  const move = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = gesture.current
    if (active?.pointerId !== event.pointerId) return
    setLive({
      kind: active.kind,
      origin: active.origin,
      dx: event.clientX - active.startX,
      dy: event.clientY - active.startY,
    })
  }

  const finish = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = gesture.current
    if (active?.pointerId !== event.pointerId) return
    gesture.current = null
    setLive(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const dx = event.clientX - active.startX
    const dy = event.clientY - active.startY
    const current = latestBounds.current
    if ((dx === 0 && dy === 0) || current === null) return
    const ended = gestureRect(active.kind, active.origin, dx, dy, current)
    note.changeView(noteFractions(ended, current))
  }

  const abandon = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = gesture.current
    if (active?.pointerId !== event.pointerId) return
    gesture.current = null
    setLive(null)
  }

  const handlers = (kind: NoteGestureKind) => ({
    onPointerDown: begin(kind),
    onPointerMove: move,
    onPointerUp: finish,
    onPointerCancel: abandon,
    onLostPointerCapture: abandon,
  })

  const editor = (saved: SavedNote | null): string | null => {
    const editor = saved?.updatedBy ?? null
    if (editor === null) return null
    return editor === 'user'
      ? t('conversationNote.editedByYou')
      : t('conversationNote.editedBy', { who: editor })
  }

  const status =
    note.status === 'waiting' || note.status === 'loading'
      ? t('conversationNote.loading')
      : note.status === 'failed'
        ? t('conversationNote.loadFailed')
        : note.status === 'conflict'
          ? null
          : note.status === 'saveFailed'
            ? t('conversationNote.saveFailed')
            : note.status === 'journalReadFailed'
              ? t('conversationNote.journalReadFailed')
              : note.status === 'journalFailed'
                ? t('conversationNote.journalFailed')
                : note.status === 'saving'
                  ? t('conversationNote.saving')
                  : editor(note.state.saved)

  const conflict = note.conflict

  return (
    <div
      ref={root}
      className="conversation-note"
      role="region"
      aria-label={t('conversationNote.label')}
      hidden={rect === null}
      data-moving={live !== null}
      data-status={note.status}
      style={
        rect === null
          ? undefined
          : { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }
    >
      <div
        className="conversation-note-head"
        title={t('conversationNote.move')}
        {...handlers('move')}
      >
        <span className="conversation-note-title">{t('conversationNote.title')}</span>
        <span className="conversation-note-status" role="status">
          {status}
        </span>
        <button
          type="button"
          className="conversation-note-hide"
          aria-label={t('conversationNote.hide')}
          title={t('conversationNote.hide')}
          onClick={() => {
            note.changeView({ visible: false })
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="conversation-note-content">
        {conflict === null ? null : (
          <div className="conversation-note-conflict" role="alert">
            <p>
              {conflict.updatedBy === 'user' || conflict.updatedBy === null
                ? t('conversationNote.conflictYou')
                : t('conversationNote.conflict', { who: conflict.updatedBy })}
            </p>
            <div className="conversation-note-actions">
              <button type="button" onClick={note.keepMine}>
                {t('conversationNote.keepMine')}
              </button>
              <button type="button" onClick={note.useSaved}>
                {t('conversationNote.useSaved')}
              </button>
            </div>
          </div>
        )}
        {RETRYABLE.has(note.status) ? (
          <div className="conversation-note-actions">
            <button type="button" onClick={note.retry}>
              {t('conversationNote.retry')}
            </button>
          </div>
        ) : null}
        {note.state.load === 'failed' ? null : (
          <textarea
            ref={body}
            className="conversation-note-body"
            aria-label={t('conversationNote.label')}
            placeholder={t('conversationNote.placeholder')}
            value={note.text}
            maxLength={CONVERSATION_NOTE_MAX_LENGTH}
            readOnly={note.state.load !== 'ready'}
            spellCheck
            onChange={(event) => {
              note.edit(event.target.value)
            }}
          />
        )}
      </div>
      <div
        className="conversation-note-grip"
        role="presentation"
        title={t('conversationNote.resize')}
        {...handlers('resize')}
      />
    </div>
  )
}
