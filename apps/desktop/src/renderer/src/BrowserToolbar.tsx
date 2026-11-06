import { memo, useState } from 'react'
import type { RefObject, SubmitEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BROWSER_MISSING_CODE,
  BROWSER_STOPPED_CODE,
  type BrowserAction,
  type BrowserFailure,
  type BrowserFavorite,
  type BrowserSettingsStatus,
  type BrowserState,
} from '../../shared/browser-ipc.js'

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

export const BrowserToolbar = memo(function BrowserToolbar(props: {
  readonly browserId: string | null
  readonly currentBrowserId: RefObject<string | null>
  readonly state: BrowserState | null
  readonly favorites: readonly BrowserFavorite[]
  readonly settings: BrowserSettingsStatus
  readonly notice: string | null
  readonly native: boolean
  readonly consoleOpen?: boolean
  readonly showLoadError?: boolean
  readonly onState: (state: BrowserState) => void
  readonly onFavorites: (favorites: readonly BrowserFavorite[]) => void
  readonly onNotice: (notice: string | null) => void
  readonly onReveal: () => void
  readonly onNeighbor?: (direction: -1 | 1) => void
  readonly onShowBrowser?: () => void
  readonly onToggleConsole?: () => void
  readonly onPasswordButtonHost?: (node: HTMLSpanElement | null) => void
}): React.JSX.Element {
  const { browserId, state, favorites, settings, notice, native, onState, onFavorites, onNotice } =
    props
  const { t } = useTranslation()
  const idRef = props.currentBrowserId
  const consoleOpen = props.consoleOpen ?? false
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const reveal = props.onReveal
  const report = (failure: BrowserFailure | null): void => {
    onNotice(failure === null ? null : t(`browser.failure.${failure}`))
  }

  const act = (action: BrowserAction): void => {
    const id = idRef.current
    if (id === null) return
    window.chorus
      .actOnBrowser({ browserId: id, action })
      .then((reply) => {
        if (idRef.current !== id) return
        onState(reply.state)
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
        onState(reply.state)
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
        onFavorites(reply.favorites)
        if (reply.failure === 'limit') onNotice(t('browser.favoriteLimit'))
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
        onState(reply.state)
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
        onFavorites(reply.favorites)
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
  const url = state?.url ?? null
  const loadError = props.showLoadError === false ? null : (state?.error ?? null)
  const ready = browserId !== null && state !== null

  return (
    <>
      <div className="browser-toolbar">
        {props.onNeighbor !== undefined && (
          <button
            type="button"
            className="browser-button"
            aria-label={t('browser.previousPane')}
            title={t('browser.previousPane')}
            onClick={() => {
              props.onNeighbor?.(-1)
            }}
          >
            ‹
          </button>
        )}
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
        {native && <span className="browser-password-button" ref={props.onPasswordButtonHost} />}
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
        {props.onToggleConsole !== undefined && (
          <button
            type="button"
            className="browser-button browser-button--text"
            aria-label={t('console.toggleLabel')}
            title={t('console.toggleLabel')}
            aria-pressed={consoleOpen}
            disabled={!ready}
            onClick={() => {
              props.onToggleConsole?.()
            }}
          >
            {t('console.toggle')}
          </button>
        )}
        {props.onShowBrowser !== undefined && (
          <button
            type="button"
            className="browser-button browser-button--text"
            aria-label={t('browser.reveal')}
            title={t('browser.reveal')}
            onClick={props.onShowBrowser}
          >
            {t('browser.revealShort')}
          </button>
        )}
        {props.onNeighbor !== undefined && (
          <button
            type="button"
            className="browser-button"
            aria-label={t('browser.nextPane')}
            title={t('browser.nextPane')}
            onClick={() => {
              props.onNeighbor?.(1)
            }}
          >
            ›
          </button>
        )}
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
                  onNotice(null)
                }}
              >
                {t('browser.dismissNotice')}
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
})
