import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { WEB_TABS_MAX } from '../../../shared/workspace-layout.js'
import { useWebTabs } from './hooks.js'
import { useShellOverlay } from './overlay.js'
import { useWorkspaceStore } from './store.js'
import { railSlotAt } from './useTabDrag.js'
import { runWebCommand, useWebPageStates } from './web-pages.js'

function nonEmpty(text: string | null | undefined): string | undefined {
  return text === null || text === undefined || text === '' ? undefined : text
}

function pageHost(url: string | null | undefined): string {
  if (url == null || url === 'about:blank') return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

interface WebTabGesture {
  readonly id: string
  readonly pointerId: number
  readonly element: HTMLButtonElement
  readonly startX: number
  readonly startY: number
  x: number
  y: number
  started: boolean
}

interface WebTabDrag {
  readonly id: string
  readonly offset: number
  readonly marker: number | null
}

function webTabTarget(strip: HTMLDivElement, id: string, x: number, y: number) {
  const bounds = strip.getBoundingClientRect()
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null
  const others = [...strip.querySelectorAll<HTMLElement>('[data-web-tab]')].filter(
    (tab) => tab.dataset['webTab'] !== id
  )
  const rects = others.map((tab) => tab.getBoundingClientRect())
  const index = railSlotAt(
    rects.map((rect) => rect.left + rect.width / 2),
    x
  )
  return {
    index,
    marker: (rects[index]?.left ?? rects.at(-1)?.right ?? bounds.left) - bounds.left,
  }
}

function useWebTabDrag(tabs: RefObject<HTMLDivElement | null>) {
  const gesture = useRef<WebTabGesture | null>(null)
  const frame = useRef<number | null>(null)
  const suppressClick = useRef(false)
  const [drag, setDrag] = useState<WebTabDrag | null>(null)
  useShellOverlay(drag !== null)

  const finish = useCallback(
    (commit: boolean): void => {
      const current = gesture.current
      gesture.current = null
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      if (current !== null) {
        if (current.started) suppressClick.current = true
        if (commit && current.started && tabs.current !== null) {
          const target = webTabTarget(tabs.current, current.id, current.x, current.y)
          if (target !== null) useWorkspaceStore.getState().moveWebTab(current.id, target.index)
        }
        if (current.element.hasPointerCapture(current.pointerId)) {
          current.element.releasePointerCapture(current.pointerId)
        }
      }
      setDrag(null)
    },
    [tabs]
  )

  const paint = useCallback(
    function paintDrag(): void {
      frame.current = null
      const current = gesture.current
      const strip = tabs.current
      if (current === null || !current.started || strip === null) return
      const target = webTabTarget(strip, current.id, current.x, current.y)
      setDrag({
        id: current.id,
        offset: current.x - current.startX,
        marker: target?.marker ?? null,
      })
    },
    [tabs]
  )

  useEffect(() => {
    if (drag === null) return
    const cancel = (): void => {
      finish(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', cancel)
    const unsubscribe = useWorkspaceStore.subscribe(
      (state) => state.webTabs.tabs,
      (roster) => {
        const id = gesture.current?.id
        if (id !== undefined && !roster.some((tab) => tab.id === id)) cancel()
      }
    )
    return () => {
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', cancel)
      unsubscribe()
    }
  }, [drag === null, finish])

  useEffect(
    () => () => {
      const current = gesture.current
      gesture.current = null
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      if (current?.element.hasPointerCapture(current.pointerId)) {
        current.element.releasePointerCapture(current.pointerId)
      }
    },
    []
  )

  const onPointerDown = (id: string, event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    finish(false)
    suppressClick.current = false
    if (useWorkspaceStore.getState().webTabs.tabs.length < 2) return
    event.stopPropagation()
    gesture.current = {
      id,
      pointerId: event.pointerId,
      element: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      started: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const current = gesture.current
    if (current?.pointerId !== event.pointerId) return
    current.x = event.clientX
    current.y = event.clientY
    if (!current.started) {
      if (Math.hypot(current.x - current.startX, current.y - current.startY) < 5) return
      current.started = true
      setDrag({ id: current.id, offset: 0, marker: null })
    }
    event.preventDefault()
    frame.current ??= requestAnimationFrame(paint)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const current = gesture.current
    if (current?.pointerId !== event.pointerId) return
    current.x = event.clientX
    current.y = event.clientY
    finish(true)
  }

  const onPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (gesture.current?.pointerId === event.pointerId) finish(false)
  }

  return {
    drag,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    consumeSuppressedClick: (): boolean => {
      if (!suppressClick.current) return false
      suppressClick.current = false
      return true
    },
  }
}

export function WebTabStrip(): React.JSX.Element {
  const { t } = useTranslation()
  const webTabs = useWebTabs()
  const pages = useWebPageStates()
  const tabs = useRef<HTMLDivElement>(null)
  const dragging = useWebTabDrag(tabs)
  const [compact, setCompact] = useState(false)
  useLayoutEffect(() => {
    const strip = tabs.current
    if (strip === null) return
    const update = (): void => {
      setCompact(webTabs.tabs.length > 0 && strip.clientWidth / webTabs.tabs.length < 72)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(strip)
    return () => {
      observer.disconnect()
    }
  }, [webTabs.tabs.length])
  const activePage = webTabs.activeId === null ? undefined : pages[webTabs.activeId]
  const activeTitle =
    nonEmpty(activePage?.title) ?? nonEmpty(pageHost(activePage?.url)) ?? t('webTabs.newTab')
  const close = (id: string): void => {
    useWorkspaceStore.getState().closeWebTab(id)
  }
  return (
    <div
      className="web-tab-group"
      style={{ '--web-tab-count': webTabs.tabs.length } as CSSProperties}
    >
      <span className="web-tab-divider" aria-hidden="true" />
      <div className="web-tabs" ref={tabs} data-compact={compact}>
        {webTabs.tabs.map((tab) => {
          const page = pages[tab.id]
          const selected = webTabs.showing && webTabs.activeId === tab.id
          const pageTitle = page?.title ?? ''
          const url = page?.url ?? ''
          const label = pageTitle === '' ? pageHost(url) : pageTitle
          const title = label === '' ? t('webTabs.newTab') : label
          return (
            <div
              className="web-tab"
              key={tab.id}
              data-web-tab={tab.id}
              data-active={selected}
              data-dragging={dragging.drag?.id === tab.id}
              style={
                dragging.drag?.id === tab.id
                  ? { transform: `translateX(${String(dragging.drag.offset)}px)` }
                  : undefined
              }
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  close(tab.id)
                }
              }}
            >
              <button
                type="button"
                className="web-tab-main"
                id={`web-tab-${tab.id}`}
                role="tab"
                aria-label={title}
                aria-selected={selected}
                aria-controls="web-tab-stage"
                title={url === '' ? title : url}
                onPointerDown={(event) => {
                  dragging.onPointerDown(tab.id, event)
                }}
                onPointerMove={dragging.onPointerMove}
                onPointerUp={dragging.onPointerUp}
                onPointerCancel={dragging.onPointerCancel}
                onLostPointerCapture={dragging.onPointerCancel}
                onClick={(event) => {
                  if (event.detail > 0 && dragging.consumeSuppressedClick()) {
                    event.preventDefault()
                    return
                  }
                  useWorkspaceStore.getState().activateWebTab(tab.id)
                }}
                onKeyDown={(event) => {
                  if (event.defaultPrevented) return
                  if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault()
                    const index = webTabs.tabs.findIndex((item) => item.id === tab.id)
                    const next = webTabs.tabs[index + 1] ?? webTabs.tabs[index - 1]
                    close(tab.id)
                    if (next !== undefined) {
                      document.getElementById(`web-tab-${next.id}`)?.focus({ preventScroll: true })
                    }
                    return
                  }
                  const buttons = tabs.current?.querySelectorAll<HTMLButtonElement>('.web-tab-main')
                  if (buttons === undefined) return
                  const index = webTabs.tabs.findIndex((item) => item.id === tab.id)
                  const next =
                    event.key === 'ArrowLeft'
                      ? (index - 1 + buttons.length) % buttons.length
                      : event.key === 'ArrowRight'
                        ? (index + 1) % buttons.length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? buttons.length - 1
                            : null
                  if (next === null) return
                  event.preventDefault()
                  buttons[next]?.focus({ preventScroll: true })
                }}
              >
                {page?.status === 'loading' ? (
                  <span className="web-tab-spinner" aria-label={t('webTabs.loading')} />
                ) : page?.icon != null ? (
                  <img className="web-tab-icon" src={page.icon} alt="" draggable={false} />
                ) : (
                  <svg className="web-tab-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <ellipse cx="12" cy="12" rx="4" ry="9" />
                    <path d="M3 12h18M5 7h14M5 17h14" />
                  </svg>
                )}
                <span className="web-tab-title">{title}</span>
              </button>
              <button
                type="button"
                className="web-tab-close"
                aria-label={t('webTabs.closeTab', { title })}
                title={t('webTabs.closeTab', { title })}
                onClick={() => {
                  close(tab.id)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
        {dragging.drag?.marker != null && (
          <span
            className="web-tab-insertion"
            style={{ left: dragging.drag.marker }}
            aria-hidden="true"
          />
        )}
      </div>
      {compact && webTabs.activeId !== null && (
        <button
          type="button"
          className="web-tab-close web-tab-active-close"
          aria-label={t('webTabs.closeTab', { title: activeTitle })}
          title={t('webTabs.closeTab', { title: activeTitle })}
          onClick={() => {
            if (webTabs.activeId !== null) close(webTabs.activeId)
          }}
        >
          ×
        </button>
      )}
      <button
        type="button"
        className="web-tab-add"
        aria-label={t('webTabs.addTab')}
        title={webTabs.tabs.length >= WEB_TABS_MAX ? t('webTabs.limit') : t('webTabs.addTab')}
        disabled={webTabs.tabs.length >= WEB_TABS_MAX}
        onClick={() => {
          runWebCommand('new-tab')
        }}
      >
        +
      </button>
    </div>
  )
}
