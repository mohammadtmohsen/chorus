import { Fragment, useId, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useBrowserScreencast } from './useBrowserScreencast.js'
import { nextEnabled, placeEditor, WEBSITE_SURFACE_ATTRIBUTE } from './website-surface.js'

export function BrowserScreencast(props: {
  readonly browserId: string | null
  readonly selected: boolean
  readonly collapsed: boolean
  readonly row: RefObject<HTMLElement | null>
  readonly onToggleCollapsed: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const view = useBrowserScreencast(props.browserId, props.selected && !props.collapsed, props.row)
  const menuId = useId()
  const menu = useRef<HTMLUListElement | null>(null)
  const promptInput = useRef<HTMLInputElement | null>(null)
  const dialogButton = useRef<HTMLButtonElement | null>(null)
  const selectToken = useRef<string | null>(null)
  const dialogToken = useRef<string | null>(null)
  const [highlight, setHighlight] = useState(-1)
  const [answer, setAnswer] = useState('')
  const [menuRect, setMenuRect] = useState({ left: 0, top: 0, minWidth: 1, maxHeight: 1 })

  useLayoutEffect(() => {
    const prompt = view.select
    selectToken.current = prompt?.token ?? null
    if (prompt === null) return
    setHighlight(prompt.selectedIndex >= 0 && prompt.selectedIndex < prompt.options.length
      ? prompt.selectedIndex : nextEnabled(prompt.options, -1, 1))
    if (props.selected && !props.collapsed) menu.current?.focus({ preventScroll: true })
  }, [view.select, props.selected, props.collapsed])

  useLayoutEffect(() => {
    const prompt = view.dialog
    dialogToken.current = prompt?.token ?? null
    if (prompt === null) return
    setAnswer(prompt.defaultPrompt)
    if (!props.selected || props.collapsed) return
    if (prompt.type === 'prompt') promptInput.current?.focus({ preventScroll: true })
    else dialogButton.current?.focus({ preventScroll: true })
  }, [view.dialog, props.selected, props.collapsed])

  useLayoutEffect(() => {
    const prompt = view.select
    const node = view.surface.current
    const list = menu.current
    if (prompt === null || node === null || list === null) return undefined
    const update = (): void => {
      const box = node.getBoundingClientRect()
      const scaleX = box.width / (view.frame?.width ?? (box.width || 1))
      const scaleY = box.height / (view.frame?.height ?? (box.height || 1))
      const next = {
        left: Math.max(0, Math.min(prompt.rect.x * scaleX, box.width - Math.max(list.offsetWidth, Math.min(box.width, prompt.rect.width * scaleX)))),
        top: Math.max(0, Math.min(prompt.rect.y * scaleY, box.height - Math.min(list.scrollHeight + 2, box.height))),
        minWidth: Math.max(1, Math.min(box.width, prompt.rect.width * scaleX)),
        maxHeight: Math.max(1, box.height),
      }
      setMenuRect((previous) => previous.left === next.left && previous.top === next.top && previous.minWidth === next.minWidth && previous.maxHeight === next.maxHeight ? previous : next)
    }
    const observer = new ResizeObserver(update)
    observer.observe(node)
    observer.observe(list)
    update()
    return () => observer.disconnect()
  }, [view.select, view.frame?.width, view.frame?.height, view.surface])

  useLayoutEffect(() => {
    const list = menu.current
    const option = list?.querySelector<HTMLElement>(`[data-option="${String(highlight)}"]`)
    if (list === null || option === undefined || option === null) return
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight
  }, [highlight, view.select])

  const restoreEditor = (): void => {
    if (selectToken.current === null && dialogToken.current === null && props.selected && !props.collapsed)
      view.editor.current?.focus({ preventScroll: true })
  }

  const choose = (index: number): void => {
    const prompt = view.select
    if (prompt === null || props.browserId === null || selectToken.current !== prompt.token) return
    if (index !== -1 && (prompt.options[index] === undefined || prompt.options[index]?.disabled)) return
    selectToken.current = null
    view.setSelect(null)
    void window.chorus.chooseBrowserSelect({ browserId: props.browserId, token: prompt.token, index }).catch(() => undefined)
    restoreEditor()
  }

  const reply = (accept: boolean): void => {
    const prompt = view.dialog
    if (prompt === null || props.browserId === null || dialogToken.current !== prompt.token) return
    dialogToken.current = null
    view.setDialog(null)
    void window.chorus.answerBrowserDialog({
      browserId: props.browserId,
      token: prompt.token,
      accept,
      ...(prompt.type === 'prompt' && accept ? { text: answer } : {}),
    }).catch(() => undefined)
    restoreEditor()
  }
  return (
    <div className="website-panel" hidden={!props.selected} data-collapsed={props.collapsed}>
      <header className="website-header">
        <span className="website-title">{t('website.title')}</span>
        <button
          type="button"
          className="website-collapse"
          aria-expanded={!props.collapsed}
          aria-label={props.collapsed ? t('website.expand') : t('website.collapse')}
          title={props.collapsed ? t('website.expand') : t('website.collapse')}
          onClick={props.onToggleCollapsed}
        >
          <span aria-hidden="true">{props.collapsed ? '▸' : '◂'}</span>
        </button>
      </header>
      <div className="website-stage" {...{ [WEBSITE_SURFACE_ATTRIBUTE]: '' }}>
        <div
          className="website-surface"
          ref={view.surface}
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            placeEditor(view.editor.current, event)
            view.editor.current?.focus({ preventScroll: true })
            view.pointerDown(event.nativeEvent)
          }}
          onPointerUp={(event) => view.pointerUp(event.nativeEvent)}
          onPointerMove={(event) => view.pointerMove(event.nativeEvent)}
          onPointerCancel={view.releaseButtons}
          onLostPointerCapture={view.releaseButtons}
          onContextMenu={(event) => event.preventDefault()}
        >
          <textarea
            ref={view.editor}
            className="website-editor"
            aria-label={t('website.surface')}
            spellCheck={false}
            autoCapitalize="off"
            onKeyDown={(event) => {
              view.keyDown(event.nativeEvent)
              if (event.nativeEvent.cancelBubble) event.stopPropagation()
            }}
            onKeyUp={(event) => {
              view.keyUp(event.nativeEvent)
              if (event.nativeEvent.cancelBubble) event.stopPropagation()
            }}
            onBlur={view.releaseHeld}
          />
          {view.frame === null ? (
            <p className="website-placeholder">{t('website.empty')}</p>
          ) : (
            <img className="website-frame" src={view.frame.url} alt="" draggable={false} />
          )}
        </div>
        {view.select !== null && (
          <ul
            className="website-select"
            role="listbox"
            aria-label={t('website.surface')}
            aria-activedescendant={highlight < 0 ? undefined : `${menuId}-${String(highlight)}`}
            tabIndex={-1}
            ref={menu}
            style={menuRect}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation()
              const options = view.select?.options ?? []
              if (event.key === 'Escape') choose(-1)
              else if (event.key === 'Enter') choose(highlight)
              else if (event.key === 'ArrowDown') setHighlight(nextEnabled(options, highlight, 1))
              else if (event.key === 'ArrowUp') setHighlight(nextEnabled(options, highlight, -1))
              else return
              event.preventDefault()
            }}
            onKeyUp={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) choose(-1)
            }}
          >
            {view.select.options.map((option, index) => (
              <Fragment key={index}>
                {option.group !== null && (index === 0 || view.select?.options[index - 1]?.group !== option.group) && (
                  <li className="website-select-group" role="presentation">{option.group}</li>
                )}
                <li
                  id={`${menuId}-${String(index)}`}
                  data-option={index}
                  role="option"
                  aria-selected={index === highlight}
                  aria-disabled={option.disabled}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    if (event.button === 0 && !option.disabled) choose(index)
                  }}
                >
                  {option.label}
                </li>
              </Fragment>
            ))}
          </ul>
        )}
        {view.dialog !== null && (
          <div
            className="website-dialog"
            role="alertdialog"
            aria-label={t(`website.dialog.${view.dialog.type}`)}
            aria-modal="true"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.nativeEvent.isComposing || event.key === 'Process' || event.keyCode === 229) return
              if (event.key === 'Tab') {
                const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input, button')]
                const current = controls.findIndex((node) => node === event.currentTarget.ownerDocument.activeElement)
                const next = current < 0
                  ? event.shiftKey ? controls.length - 1 : 0
                  : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
                controls[next]?.focus({ preventScroll: true })
                event.preventDefault()
                return
              }
              if (event.key === 'Escape') reply(view.dialog?.type === 'alert')
              else if (
                event.key === 'Enter' &&
                (event.target === event.currentTarget || event.target === promptInput.current)
              ) reply(true)
              else return
              event.preventDefault()
            }}
            onKeyUp={(event) => event.stopPropagation()}
          >
            <div className="website-dialog-body">
              <p>{view.dialog.message}</p>
              {view.dialog.type === 'prompt' && (
                <input
                  ref={promptInput}
                  aria-label={t('website.dialog.prompt')}
                  value={answer}
                  maxLength={10_000}
                  onChange={(event) => setAnswer(event.target.value)}
                />
              )}
              <div className="website-dialog-actions">
                {view.dialog.type !== 'alert' && (
                  <button type="button" onClick={() => reply(false)}>
                    {t('website.dialog.cancel')}
                  </button>
                )}
                <button type="button" ref={dialogButton} onClick={() => reply(true)}>
                  {t(view.dialog.type === 'beforeunload' ? 'website.dialog.leave' : 'website.dialog.ok')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
