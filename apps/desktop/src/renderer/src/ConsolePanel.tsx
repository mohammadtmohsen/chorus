import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CONSOLE_EXPRESSION_MAX,
  type ConsoleEntry,
  type ConsoleLevel,
} from '../../shared/console-ipc.js'
import { ConsoleValueView } from './ConsoleValueView.js'
import { onHostReconnected } from './host-actions.js'
import {
  EMPTY_CONSOLE,
  clockOf,
  openConsoleLink,
  pendingCommands,
  placeOf,
  recall,
  sourceState,
  visibleEntries,
  type ConsoleStream,
} from './console-stream.js'

const LEVELS: readonly ConsoleLevel[] = ['error', 'warning', 'info', 'log', 'debug']

export function ConsolePanel(props: {
  readonly projectId: string
  readonly browserId: string | null
  readonly active: boolean
}): React.JSX.Element {
  const { projectId, browserId, active } = props
  const { t } = useTranslation()
  const [stream, setStream] = useState<ConsoleStream>(EMPTY_CONSOLE)
  const [failure, setFailure] = useState(false)
  const [reconnect, setReconnect] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [levels, setLevels] = useState<ReadonlySet<ConsoleLevel>>(() => new Set(LEVELS))
  const [filter, setFilter] = useState('')
  const [input, setInput] = useState('')
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const draft = useRef('')
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    return onHostReconnected(() => {
      setReconnect((current) => current + 1)
    })
  }, [])

  useEffect(() => {
    if (!active) return undefined
    const link = openConsoleLink(window.chorus, projectId, {
      onStream: setStream,
      onFailure: setFailure,
    })
    return () => {
      link.close()
    }
  }, [active, projectId, reconnect])

  const shown = useMemo(
    () => visibleEntries(stream.entries, levels, filter),
    [stream.entries, levels, filter]
  )
  const pending = useMemo(() => pendingCommands(stream.entries), [stream.entries])
  const state = sourceState(stream, browserId)

  useLayoutEffect(() => {
    const element = list.current
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight
  }, [shown])

  const toggleLevel = (level: ConsoleLevel): void => {
    setLevels((current) => {
      const next = new Set(current)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  const clear = (): void => {
    window.chorus.clearConsole({ projectId }).catch(() => {
      setNotice(t('console.unreachable'))
    })
  }

  const submit = (): void => {
    const expression = input
    if (browserId === null || expression.trim() === '') return
    window.chorus
      .evaluateConsole({ projectId, browserId, expression })
      .then((reply) => {
        if (reply.status !== 'started') {
          setNotice(t(`console.start.${reply.status}`))
          return
        }
        setNotice(null)
        pinned.current = true
        setInput((currentInput) => (currentInput === expression ? '' : currentInput))
        setHistoryIndex(null)
        draft.current = ''
      })
      .catch(() => {
        setNotice(t('console.unreachable'))
      })
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    const field = event.currentTarget
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
      return
    }
    const before = field.value.slice(0, field.selectionStart)
    const after = field.value.slice(field.selectionEnd)
    const up = event.key === 'ArrowUp' && !before.includes('\n')
    const down = event.key === 'ArrowDown' && !after.includes('\n')
    if (!up && !down) return
    if (up && historyIndex === null) draft.current = field.value
    const next = recall(stream.history, historyIndex, up ? -1 : 1)
    if (next.text === null) return
    event.preventDefault()
    setHistoryIndex(next.index)
    setInput(next.index === null ? draft.current : next.text)
  }

  const actorOf = (entry: ConsoleEntry): string | null =>
    entry.actor === null ? null : t(`actor.${entry.actor}`)

  const message = (entry: ConsoleEntry): React.ReactNode => {
    switch (entry.kind) {
      case 'navigation':
        return t('console.navigated', { url: entry.url ?? entry.text })
      case 'crash':
        return t('console.crashed', { reason: entry.method ?? entry.text })
      case 'command':
        return <pre className="console-code">{entry.text}</pre>
      case 'result': {
        if (entry.status === 'ok') {
          const value = entry.values[0]
          return value === undefined ? (
            entry.text
          ) : (
            <ConsoleValueView projectId={projectId} value={value} />
          )
        }
        if (entry.status === 'threw') return entry.text
        if (entry.status === 'failed') {
          return t('console.status.failed', { reason: entry.text === '' ? '—' : entry.text })
        }
        return t(`console.status.${entry.status ?? 'interrupted'}`)
      }
      case 'console':
        if (entry.method === 'clear') return t('console.pageCleared')
        return entry.method === 'assert' ? t('console.assert', { text: entry.text }) : entry.text
      case 'exception':
      case 'browser':
        return entry.text
    }
  }

  const expandable = (entry: ConsoleEntry): readonly React.ReactNode[] => {
    const logged =
      entry.kind === 'console' || entry.kind === 'exception' || entry.kind === 'browser'
    const thrown = entry.kind === 'result' && entry.status === 'threw'
    if (!logged && !thrown) return []
    return entry.values
      .filter((value) => value.handle !== null)
      .map((value, index) => (
        <ConsoleValueView key={value.handle ?? String(index)} projectId={projectId} value={value} />
      ))
  }

  const stateText = state === 'ready' ? null : t(`console.state.${state}`)

  return (
    <section className="console-panel" aria-label={t('console.title')}>
      <div className="console-toolbar">
        <span className="console-title">{t('console.title')}</span>
        <div className="console-levels" role="group" aria-label={t('console.levels')}>
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className="console-level-toggle"
              aria-pressed={levels.has(level)}
              onClick={() => {
                toggleLevel(level)
              }}
            >
              {t(`console.level.${level}`)}
            </button>
          ))}
        </div>
        <input
          className="console-filter"
          type="search"
          value={filter}
          spellCheck={false}
          aria-label={t('console.filter')}
          placeholder={t('console.filter')}
          onChange={(event) => {
            setFilter(event.target.value)
          }}
        />
        <button
          type="button"
          className="browser-button browser-button--text"
          aria-label={t('console.clearLabel')}
          title={t('console.clearLabel')}
          disabled={stream.subscriptionId === ''}
          onClick={clear}
        >
          {t('console.clear')}
        </button>
      </div>
      {(stateText !== null || failure || notice !== null || stream.dropped > 0) && (
        <div className="console-status" role="status">
          {stateText !== null && <span>{stateText}</span>}
          {failure && <span>{t('console.unreachable')}</span>}
          {stream.dropped > 0 && <span>{t('console.dropped', { count: stream.dropped })}</span>}
          {notice !== null && (
            <>
              <span>{notice}</span>
              <button
                type="button"
                className="browser-button browser-button--text"
                onClick={() => {
                  setNotice(null)
                }}
              >
                {t('browser.dismissNotice')}
              </button>
            </>
          )}
        </div>
      )}
      <div
        className="console-entries"
        ref={list}
        role="log"
        onScroll={(event) => {
          const element = event.currentTarget
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
        }}
      >
        {shown.length === 0 && (
          <p className="console-empty">
            {stream.entries.length === 0 ? t('console.empty') : t('console.filteredEmpty')}
          </p>
        )}
        {shown.map((entry) => {
          const actor = actorOf(entry)
          const running =
            entry.kind === 'command' && entry.commandId !== null && pending.has(entry.commandId)
          return (
            <div
              key={entry.id}
              className={`console-entry console-entry--${entry.level} console-entry--${entry.kind}`}
            >
              <span className="console-time">{clockOf(entry.at)}</span>
              <span className="console-marker" aria-hidden="true">
                {entry.kind === 'command' ? '›' : entry.kind === 'result' ? '‹' : ''}
              </span>
              <div className="console-body">
                <div className="console-line">
                  {actor !== null && <span className="console-actor">{actor}</span>}
                  {entry.kind === 'browser' && entry.method !== null && (
                    <span className="console-source">{entry.method}</span>
                  )}
                  <span className="console-message">{message(entry)}</span>
                  {running && <span className="console-pending">{t('console.pending')}</span>}
                  {entry.cut && <span className="console-cut">{t('console.cut')}</span>}
                  {entry.location !== null && (
                    <span className="console-location" title={entry.location.url}>
                      {placeOf(entry.location.url, entry.location.line, entry.location.column)}
                    </span>
                  )}
                </div>
                {expandable(entry)}
                {entry.stack.length > 0 && (
                  <details className="console-stack">
                    <summary>{t('console.stack')}</summary>
                    {entry.stack.map((frame, index) => (
                      <span className="console-frame" key={`${frame.url}:${String(index)}`}>
                        <span className="console-frame-name">
                          {frame.functionName === '' ? t('console.anonymous') : frame.functionName}
                        </span>
                        <span className="console-location" title={frame.url}>
                          {placeOf(frame.url, frame.line, frame.column)}
                        </span>
                      </span>
                    ))}
                  </details>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="console-input-row">
        <span className="console-marker" aria-hidden="true">
          ›
        </span>
        <textarea
          className="console-input"
          rows={Math.min(6, Math.max(1, input.split('\n').length))}
          value={input}
          spellCheck={false}
          autoComplete="off"
          maxLength={CONSOLE_EXPRESSION_MAX}
          aria-label={t('console.input')}
          placeholder={t('console.inputPlaceholder')}
          disabled={browserId === null}
          onChange={(event) => {
            setInput(event.target.value)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
    </section>
  )
}
