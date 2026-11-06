import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useBrowserScreencast } from './useBrowserScreencast.js'
import { placeEditor, WEBSITE_SURFACE_ATTRIBUTE } from './website-surface.js'

export function BrowserScreencast(props: {
  readonly browserId: string | null
  readonly selected: boolean
  readonly collapsed: boolean
  readonly row: RefObject<HTMLElement | null>
  readonly onToggleCollapsed: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const view = useBrowserScreencast(props.browserId, props.selected && !props.collapsed, props.row)
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
      </div>
    </div>
  )
}
