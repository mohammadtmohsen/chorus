import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { SubmitEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BROWSER_RECT_MAX,
  BROWSER_PROPOSAL_MISSING_CODE,
  BROWSER_MISSING_CODE,
  BROWSER_STOPPED_CODE,
} from '../../shared/browser-ipc.js'
import { useHostCapabilities } from './host-context.js'
import { onHostReconnected, requestBrowserTools } from './host-actions.js'
import type {
  BrowserAction,
  BrowserFailure,
  BrowserFavorite,
  BrowserPasswordPrompt,
  BrowserPasswords,
  BrowserPoint,
  BrowserRect,
  BrowserSettingsStatus,
  BrowserState,
} from '../../shared/browser-ipc.js'
import { BrowserPasswords as PasswordControls } from './BrowserPasswords.js'
import { ConsolePanel } from './ConsolePanel.js'
import { browserViewport } from './workspace/layout.js'
import { useWorkbenchStill } from './workspace/overlay.js'
import { horizontalRowWheel } from './workspace/viewport.js'

interface Geometry {
  readonly rect: BrowserRect
  readonly bodyOrigin: BrowserPoint
  readonly active: boolean
  readonly fullyVisible: boolean
}

const HIDDEN_RECT: BrowserRect = { x: 0, y: 0, width: 0, height: 0 }
const HIDDEN_ORIGIN: BrowserPoint = { x: 0, y: 0 }

function clampCoordinate(value: number): number {
  return Math.min(BROWSER_RECT_MAX, Math.max(-BROWSER_RECT_MAX, value))
}

function sameGeometry(left: Geometry | null, right: Geometry): boolean {
  if (left === null) return false
  return (
    left.active === right.active &&
    left.rect.x === right.rect.x &&
    left.rect.y === right.rect.y &&
    left.rect.width === right.rect.width &&
    left.rect.height === right.rect.height &&
    left.bodyOrigin.x === right.bodyOrigin.x &&
    left.bodyOrigin.y === right.bodyOrigin.y
  )
}

function badgeLetter(favorite: BrowserFavorite): string {
  try {
    const host = new URL(favorite.url).hostname.replace(/^www\./, '')
    return (host[0] ?? '?').toUpperCase()
  } catch {
    return '?'
  }
}

function badgeName(favorite: BrowserFavorite): string {
  if (favorite.title !== '') return favorite.title
  try {
    return new URL(favorite.url).host
  } catch {
    return favorite.url
  }
}

function rowNeighbor(item: Element | null, direction: -1 | 1): Element | null {
  const step = (from: Element): Element | null =>
    direction < 0 ? from.previousElementSibling : from.nextElementSibling
  let next = item === null ? null : step(item)
  while (next?.classList.contains('conversation-sash')) next = step(next)
  return next
}

export function BrowserPanel(props: {
  readonly projectId: string
  readonly active: boolean
  readonly collapsed: boolean
  readonly scroller: React.RefObject<HTMLDivElement | null>
  readonly markTouched: (projectId: string) => void
  readonly onReveal: (box: Element | null) => void
  readonly onBrowserId?: (projectId: string, browserId: string | null) => void
  readonly onRevealWebsite?: (projectId: string) => void
  readonly onToggleCollapsed: () => void
}): React.JSX.Element {
  const {
    projectId,
    active,
    collapsed,
    scroller,
    markTouched,
    onReveal,
    onToggleCollapsed,
    onBrowserId,
    onRevealWebsite,
  } = props
  const visible = active && !collapsed
  const { t } = useTranslation()
  const capabilities = useHostCapabilities()
  const native = capabilities.nativeBrowserViews
  const root = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  const idRef = useRef<string | null>(null)
  const revision = useRef(0)
  const lastSent = useRef<Geometry | null>(null)
  const lastRect = useRef<BrowserRect>(HIDDEN_RECT)
  const lastOrigin = useRef<BrowserPoint>(HIDDEN_ORIGIN)
  const frame = useRef<number | null>(null)
  const revealAfterExpand = useRef(false)
  const rowTarget = useRef({ active: visible, scroller, projectId, markTouched, onRevealWebsite })
  const [attempt, setAttempt] = useState(0)
  const [browserId, setBrowserId] = useState<string | null>(null)
  const [attachFailed, setAttachFailed] = useState(false)
  const [state, admitState] = useState<BrowserState | null>(null)
  const [favorites, setFavorites] = useState<readonly BrowserFavorite[]>([])
  const [settings, setSettings] = useState<BrowserSettingsStatus>('ready')
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<BrowserPasswordPrompt | null>(null)
  const [passwords, setPasswords] = useState<BrowserPasswords | null>(null)
  const [passwordButtonHost, setPasswordButtonHost] = useState<HTMLSpanElement | null>(null)
  const [consoleOpen, setConsoleOpen] = useState(!native)
  const overlayStill = useWorkbenchStill(browserId)

  useLayoutEffect(() => {
    rowTarget.current = { active: visible, scroller, projectId, markTouched, onRevealWebsite }
  }, [visible, scroller, projectId, markTouched, onRevealWebsite])

  useEffect(() => {
    return onHostReconnected(() => {
      setAttempt((current) => current + 1)
    })
  }, [])

  useEffect(() => {
    let current = true
    let attached: string | null = null
    const unsubscribe = window.chorus.onBrowser((push) => {
      if (attached === null || push.browserId !== attached) return
      switch (push.kind) {
        case 'state':
          admitState(push.state)
          break
        case 'favorites':
          setFavorites(push.favorites)
          break
        case 'prompt':
          setPrompt(push.prompt)
          break
        case 'passwords':
          setPasswords(push.passwords)
          break
        case 'row-wheel': {
          const target = rowTarget.current
          const row = target.scroller.current
          if (!target.active || row === null) break
          const delta = horizontalRowWheel(push.wheel, row.clientWidth)
          if (delta === 0) break
          target.markTouched(target.projectId)
          row.scrollLeft += delta
          break
        }
        case 'command':
          if (push.command === 'reveal') rowTarget.current.onRevealWebsite?.(projectId)
          break
        case 'select':
        case 'dialog':
          break
        case 'found':
        case 'tab-open':
        case 'downloads':
          break
      }
    })
    window.chorus
      .attachBrowser({ projectId })
      .then((reply) => {
        if (!current) {
          window.chorus.detachBrowser({ browserId: reply.browserId }).catch(() => undefined)
          return
        }
        attached = reply.browserId
        idRef.current = reply.browserId
        revision.current = 0
        lastSent.current = null
        setBrowserId(reply.browserId)
        onBrowserId?.(projectId, reply.browserId)
        admitState(reply.state)
        setFavorites(reply.favorites)
        setSettings(reply.settings)
        setAttachFailed(false)
      })
      .catch(() => {
        if (current) setAttachFailed(true)
      })
    return () => {
      current = false
      unsubscribe()
      onBrowserId?.(projectId, null)
      if (attached === null) return
      if (idRef.current === attached) idRef.current = null
      window.chorus.detachBrowser({ browserId: attached }).catch(() => undefined)
    }
  }, [projectId, attempt, admitState, onBrowserId])

  const send = useCallback((geometry: Geometry) => {
    const id = idRef.current
    if (id === null || sameGeometry(lastSent.current, geometry)) return
    lastSent.current = geometry
    revision.current += 1
    const sent = revision.current
    window.chorus.setBrowserGeometry({ browserId: id, revision: sent, ...geometry }).catch(() => {
      if (lastSent.current === geometry) lastSent.current = null
    })
  }, [])

  const measure = useCallback(() => {
    frame.current = null
    if (!visible) return
    const panel = root.current
    const region = body.current
    const row = scroller.current
    if (panel === null || region === null || row === null) return
    const box = region.getBoundingClientRect()
    const view = browserViewport(panel.getBoundingClientRect(), box, row.getBoundingClientRect())
    const origin = { x: clampCoordinate(box.left), y: clampCoordinate(box.top) }
    lastRect.current = view.rect
    lastOrigin.current = origin
    send({ rect: view.rect, bodyOrigin: origin, active: true, fullyVisible: view.fullyVisible })
  }, [visible, scroller, send])

  const schedule = useCallback(() => {
    if (frame.current !== null) return
    frame.current = window.requestAnimationFrame(measure)
  }, [measure])

  useEffect(() => {
    if (!native || !visible || browserId === null) return undefined
    const row = scroller.current
    const panel = root.current
    const region = body.current
    if (row === null || panel === null || region === null) return undefined
    const sizes = new ResizeObserver(schedule)
    const watchRow = (): void => {
      sizes.disconnect()
      sizes.observe(panel)
      sizes.observe(region)
      sizes.observe(row)
      for (const item of Array.from(row.children)) sizes.observe(item)
    }
    watchRow()
    const items = new MutationObserver(() => {
      watchRow()
      schedule()
    })
    items.observe(row, { childList: true })
    row.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      sizes.disconnect()
      items.disconnect()
      row.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current)
        frame.current = null
      }
      send({
        rect: lastRect.current,
        bodyOrigin: lastOrigin.current,
        active: false,
        fullyVisible: false,
      })
    }
  }, [native, visible, browserId, scroller, schedule, send])

  useLayoutEffect(() => {
    if (!native) return
    if (!visible) {
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current)
        frame.current = null
      }
      send({
        rect: lastRect.current,
        bodyOrigin: lastOrigin.current,
        active: false,
        fullyVisible: false,
      })
      return
    }
    if (revealAfterExpand.current) {
      revealAfterExpand.current = false
      onReveal(root.current?.parentElement ?? null)
    }
    if (browserId !== null) schedule()
  })

  const report = (failure: BrowserFailure | null): void => {
    setNotice(failure === null ? null : t(`browser.failure.${failure}`))
  }

  const reveal = (): void => {
    if (capabilities.streamedBrowser && onRevealWebsite !== undefined) onRevealWebsite(projectId)
    else onReveal(root.current?.parentElement ?? null)
    schedule()
  }

  const showBrowser = (): void => {
    const id = idRef.current
    const pending = state !== null && !state.live && state.url !== null
    if (id === null || !pending) {
      reveal()
      return
    }
    window.chorus
      .restoreBrowser({ browserId: id })
      .then((reply) => {
        if (idRef.current !== id) return
        admitState(reply.state)
        report(reply.failure)
        if (reply.failure === null) reveal()
      })
      .catch(() => {
        if (idRef.current === id) report('failed')
      })
  }

  const showNeighbor = (direction: -1 | 1): void => {
    onReveal(rowNeighbor(root.current?.parentElement ?? null, direction))
  }

  const act = (action: BrowserAction): void => {
    const id = idRef.current
    if (id === null) return
    window.chorus
      .actOnBrowser({ browserId: id, action })
      .then((reply) => {
        if (idRef.current !== id) return
        admitState(reply.state)
        report(reply.failure)
      })
      .catch(() => {
        if (idRef.current === id) report('failed')
      })
  }

  const navigate = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const id = idRef.current
    const target = (editing ? address : (state?.url ?? '')).trim()
    if (id === null || target === '') return
    window.chorus
      .navigateBrowser({ browserId: id, address: target })
      .then((reply) => {
        if (idRef.current !== id) return
        admitState(reply.state)
        report(reply.failure)
        if (reply.failure !== null) return
        setEditing(false)
        reveal()
      })
      .catch(() => {
        if (idRef.current === id) report('failed')
      })
  }

  const escapeAddress = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return
    setEditing(false)
    event.currentTarget.blur()
  }

  const addFavorite = (): void => {
    const id = idRef.current
    if (id === null) return
    window.chorus
      .addBrowserFavorite({ browserId: id })
      .then((reply) => {
        if (idRef.current !== id) return
        setFavorites(reply.favorites)
        if (reply.failure === 'limit') setNotice(t('browser.favoriteLimit'))
        else report(reply.failure)
      })
      .catch(() => {
        if (idRef.current === id) report('failed')
      })
  }

  const openFavorite = (favoriteId: string): void => {
    const id = idRef.current
    if (id === null) return
    window.chorus
      .openBrowserFavorite({ browserId: id, favoriteId })
      .then((reply) => {
        if (idRef.current !== id) return
        admitState(reply.state)
        report(reply.failure)
        if (reply.failure === null) reveal()
      })
      .catch(() => {
        if (idRef.current === id) report('failed')
      })
  }

  const removeFavorite = (favoriteId: string): void => {
    const id = idRef.current
    if (id === null) return
    window.chorus
      .removeBrowserFavorite({ browserId: id, favoriteId })
      .then((reply) => {
        if (idRef.current !== id) return
        setFavorites(reply.favorites)
        report(reply.failure)
      })
      .catch(() => {
        if (idRef.current === id) report('failed')
      })
  }

  const live = state?.live === true
  const canReload =
    live ||
    (!native &&
      (state?.error?.code === BROWSER_MISSING_CODE || state?.error?.code === BROWSER_STOPPED_CODE))
  const loading = state?.status === 'loading'
  const still = live ? overlayStill : null
  const url = state?.url ?? null
  const loadError = state?.error ?? null
  const ready = browserId !== null && state !== null

  const placeholder = ((): React.ReactNode => {
    if (!native)
      return (
        <>
          <p>
            {state?.error?.code === BROWSER_PROPOSAL_MISSING_CODE
              ? t('extension.browserProposalMissing')
              : (state?.error?.description ?? t('extension.browserWebsiteHelp'))}
          </p>
          {state?.error?.code === BROWSER_PROPOSAL_MISSING_CODE && (
            <button type="button" className="browser-button" onClick={requestBrowserTools}>
              {t('extension.enableBrowser')}
            </button>
          )}
        </>
      )
    if (attachFailed) {
      return (
        <>
          <p>{t('browser.attachFailed')}</p>
          <button
            type="button"
            className="browser-button"
            onClick={() => {
              setAttachFailed(false)
              setAttempt((count) => count + 1)
            }}
          >
            {t('browser.retry')}
          </button>
        </>
      )
    }
    if (!ready) return <p role="status">{t('browser.attaching')}</p>
    if (url === null) {
      return (
        <>
          <p className="browser-placeholder-title">{t('browser.emptyTitle')}</p>
          <p>{t('browser.emptyHint')}</p>
          <p className="browser-help">{t('browser.profileHelp')}</p>
          <p className="browser-help">{t('browser.googleHelp')}</p>
        </>
      )
    }
    if (!live) {
      return (
        <>
          <p>{t('browser.pending', { url })}</p>
          <button type="button" className="browser-button" onClick={showBrowser}>
            {t('browser.revealShort')}
          </button>
        </>
      )
    }
    return (
      <button type="button" className="browser-button" onClick={reveal}>
        {t('browser.reveal')}
      </button>
    )
  })()

  return (
    <div className="browser-panel" data-native-browser={native} ref={root} hidden={!active}>
      <div className="conversation-dock">
        <div className="conversation-dock-tabs">
          <div className="conversation-dock-tab" data-active="true">
            <span
              className="conversation-dock-tab-main"
              style={{ paddingRight: collapsed ? 0 : undefined }}
            >
              <span className="conversation-dock-tab-title">
                {state !== null && state.title !== '' ? state.title : t('browser.tabTitle')}
              </span>
            </span>
          </div>
        </div>
        <button
          type="button"
          className="conversation-dock-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={collapsed ? t('browser.expand') : t('browser.collapse')}
          title={collapsed ? t('browser.expand') : t('browser.collapse')}
          onClick={() => {
            revealAfterExpand.current = collapsed
            markTouched(projectId)
            onToggleCollapsed()
          }}
        >
          <span aria-hidden="true">{collapsed ? '▸' : '◂'}</span>
        </button>
      </div>
      <div
        id={bodyId}
        className="conversation-body"
        hidden={collapsed}
        style={{ display: collapsed ? 'none' : undefined }}
      >
        <div className="browser-toolbar">
          <button
            type="button"
            className="browser-button"
            aria-label={t('browser.previousPane')}
            title={t('browser.previousPane')}
            onClick={() => {
              showNeighbor(-1)
            }}
          >
            ‹
          </button>
          <button
            type="button"
            className="browser-button"
            aria-label={t('browser.back')}
            title={t('browser.back')}
            disabled={state?.canGoBack !== true}
            onClick={() => {
              act('back')
            }}
          >
            ←
          </button>
          <button
            type="button"
            className="browser-button"
            aria-label={t('browser.forward')}
            title={t('browser.forward')}
            disabled={state?.canGoForward !== true}
            onClick={() => {
              act('forward')
            }}
          >
            →
          </button>
          <button
            type="button"
            className="browser-button"
            aria-label={loading ? t('browser.stop') : t('browser.reload')}
            title={loading ? t('browser.stop') : t('browser.reload')}
            disabled={!canReload}
            onClick={() => {
              act(loading ? 'stop' : 'reload')
            }}
          >
            {loading ? '×' : '↻'}
          </button>
          <form className="browser-address" onSubmit={navigate}>
            <input
              className="browser-address-input"
              type="text"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              maxLength={8192}
              aria-label={t('browser.address')}
              placeholder={t('browser.addressPlaceholder')}
              disabled={!ready}
              value={editing ? address : (url ?? '')}
              onFocus={() => {
                setAddress(url ?? '')
                setEditing(true)
              }}
              onBlur={() => {
                setEditing(false)
              }}
              onChange={(event) => {
                setAddress(event.target.value)
                setEditing(true)
              }}
              onKeyDown={escapeAddress}
            />
          </form>
          <button
            type="button"
            className="browser-button"
            aria-label={t('browser.addFavorite')}
            title={t('browser.addFavorite')}
            disabled={!ready || url === null}
            onClick={addFavorite}
          >
            ☆
          </button>
          {native && <span className="browser-password-button" ref={setPasswordButtonHost} />}
          <button
            type="button"
            className="browser-button"
            aria-label={t('browser.external')}
            title={t('browser.external')}
            disabled={url === null}
            onClick={() => {
              act('external')
            }}
          >
            ↗
          </button>
          {native && (
            <button
              type="button"
              className="browser-button browser-button--text"
              aria-label={t('browser.devtools')}
              title={t('browser.devtools')}
              disabled={!live}
              onClick={() => {
                act('devtools')
              }}
            >
              {t('browser.devtoolsShort')}
            </button>
          )}
          <button
            type="button"
            className="browser-button browser-button--text"
            aria-label={t('console.toggleLabel')}
            title={t('console.toggleLabel')}
            aria-pressed={consoleOpen}
            disabled={!ready}
            onClick={() => {
              setConsoleOpen((open) => !open)
            }}
          >
            {t('console.toggle')}
          </button>
          {(native || capabilities.streamedBrowser) && (
            <button
              type="button"
              className="browser-button browser-button--text"
              aria-label={t('browser.reveal')}
              title={t('browser.reveal')}
              onClick={showBrowser}
            >
              {t('browser.revealShort')}
            </button>
          )}
          <button
            type="button"
            className="browser-button"
            aria-label={t('browser.nextPane')}
            title={t('browser.nextPane')}
            onClick={() => {
              showNeighbor(1)
            }}
          >
            ›
          </button>
        </div>
        {favorites.length > 0 && (
          <div className="browser-favorites" role="group" aria-label={t('browser.favorites')}>
            {favorites.map((favorite) => {
              const name = badgeName(favorite)
              return (
                <span className="browser-favorite" key={favorite.id}>
                  <button
                    type="button"
                    className="browser-favorite-open"
                    title={favorite.url}
                    aria-label={t('browser.openFavorite', { name })}
                    onClick={() => {
                      openFavorite(favorite.id)
                    }}
                  >
                    {favorite.icon !== null ? (
                      <img className="browser-favorite-icon" src={favorite.icon} alt="" />
                    ) : (
                      <span className="browser-favorite-letter" aria-hidden="true">
                        {badgeLetter(favorite)}
                      </span>
                    )}
                    <span className="browser-favorite-label">{name}</span>
                  </button>
                  <button
                    type="button"
                    className="browser-favorite-remove"
                    aria-label={t('browser.removeFavorite', { name })}
                    title={t('browser.removeFavorite', { name })}
                    onClick={() => {
                      removeFavorite(favorite.id)
                    }}
                  >
                    ×
                  </button>
                </span>
              )
            })}
          </div>
        )}
        {(notice !== null || settings !== 'ready' || loadError !== null) && (
          <div className="browser-notice" role="status">
            {settings === 'corrupt' && <span>{t('browser.settingsCorrupt')}</span>}
            {settings === 'unreadable' && <span>{t('browser.settingsUnreadable')}</span>}
            {loadError !== null && (
              <span>
                {t('browser.loadFailed', {
                  description: loadError.description,
                  code: loadError.code,
                })}
              </span>
            )}
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
        {native && (
          <PasswordControls
            browserId={browserId}
            state={state}
            prompt={prompt}
            passwords={passwords}
            buttonHost={passwordButtonHost}
            onPrompt={(candidateId) => {
              setPrompt((current) => (current?.candidateId === candidateId ? null : current))
            }}
          />
        )}
        <div
          className="browser-body"
          ref={body}
          style={
            !native && consoleOpen && loadError === null
              ? { flex: 'none', minHeight: 0, height: 0, overflow: 'hidden' }
              : undefined
          }
        >
          {still !== null ? (
            <button
              type="button"
              className="browser-still"
              aria-label={t('browser.reveal')}
              title={t('browser.reveal')}
              onClick={reveal}
            >
              <img
                className="workbench-still"
                src={still}
                alt=""
                aria-hidden="true"
                draggable={false}
              />
            </button>
          ) : (
            <div className="browser-placeholder">{placeholder}</div>
          )}
        </div>
        {consoleOpen && (
          <ConsolePanel projectId={projectId} browserId={browserId} active={visible} />
        )}
      </div>
    </div>
  )
}
