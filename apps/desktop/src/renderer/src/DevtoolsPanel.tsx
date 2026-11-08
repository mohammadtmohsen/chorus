import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserRect } from '../../shared/browser-ipc.js'
import { browserViewport } from './workspace/layout.js'
import { useWorkbenchStill } from './workspace/overlay.js'

interface Geometry {
  readonly rect: BrowserRect
  readonly active: boolean
}

const HIDDEN_RECT: BrowserRect = { x: 0, y: 0, width: 0, height: 0 }

function sameGeometry(left: Geometry | null, right: Geometry): boolean {
  return (
    left !== null &&
    left.active === right.active &&
    left.rect.x === right.rect.x &&
    left.rect.y === right.rect.y &&
    left.rect.width === right.rect.width &&
    left.rect.height === right.rect.height
  )
}

export function DevtoolsPanel(props: {
  readonly projectId: string
  readonly browserId: string | null
  readonly active: boolean
  readonly collapsed: boolean
  readonly scroller: React.RefObject<HTMLDivElement | null>
  readonly onCollapse: (collapsed: boolean) => void
}): React.JSX.Element {
  const { projectId, browserId, active, collapsed, scroller, onCollapse } = props
  const { t } = useTranslation()
  const root = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  const current = useRef({ collapsed, onCollapse })
  const revision = useRef({ browserId, value: 0 })
  const visible = active && !collapsed
  const still = useWorkbenchStill(browserId === null ? null : `${browserId}:devtools`)

  useLayoutEffect(() => {
    current.current = { collapsed, onCollapse }
  }, [collapsed, onCollapse])

  useEffect(() => {
    if (browserId === null) return undefined
    return window.chorus.onBrowser((push) => {
      if (push.kind !== 'devtools' || push.browserId !== browserId) return
      const target = current.current
      target.onCollapse(push.action === 'show' ? false : !target.collapsed)
    })
  }, [browserId])

  useLayoutEffect(() => {
    if (browserId === null) return undefined
    if (revision.current.browserId !== browserId) revision.current = { browserId, value: 0 }
    let lastSent: Geometry | null = null
    let lastRect = HIDDEN_RECT
    let frame: number | null = null
    const send = (next: Geometry): void => {
      if (sameGeometry(lastSent, next) || revision.current.browserId !== browserId) return
      lastSent = next
      revision.current.value += 1
      window.chorus
        .setBrowserDevtoolsGeometry({ browserId, revision: revision.current.value, ...next })
        .catch(() => {
          if (lastSent === next) lastSent = null
        })
    }
    if (!visible) {
      send({ rect: lastRect, active: false })
      return undefined
    }
    const panel = root.current
    const region = body.current
    const row = scroller.current
    if (panel === null || region === null || row === null) return undefined
    const measure = (): void => {
      frame = null
      const view = browserViewport(
        panel.getBoundingClientRect(),
        region.getBoundingClientRect(),
        row.getBoundingClientRect()
      )
      lastRect = view.rect
      send({ rect: view.rect, active: true })
    }
    const schedule = (): void => {
      frame ??= window.requestAnimationFrame(measure)
    }
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
      if (frame !== null) window.cancelAnimationFrame(frame)
      send({ rect: lastRect, active: false })
    }
  }, [browserId, visible, scroller])

  return (
    <div className="devtools-panel" data-project-id={projectId} ref={root} hidden={!active}>
      <div className="conversation-dock">
        <div className="conversation-dock-tabs">
          <div className="conversation-dock-tab" data-active="true">
            <span className="conversation-dock-tab-main">
              <span className="conversation-dock-tab-title">{t('devtools.title')}</span>
            </span>
          </div>
        </div>
        <button
          type="button"
          className="conversation-dock-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={collapsed ? t('devtools.expand') : t('devtools.collapse')}
          title={collapsed ? t('devtools.expand') : t('devtools.collapse')}
          onClick={() => {
            onCollapse(!collapsed)
          }}
        >
          <span aria-hidden="true">{collapsed ? '▸' : '◂'}</span>
        </button>
      </div>
      <div id={bodyId} className="conversation-body devtools-body" ref={body} hidden={collapsed}>
        {still !== null ? (
          <div className="browser-still">
            <img
              className="workbench-still"
              src={still}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
          </div>
        ) : (
          <div className="browser-placeholder">
            <p>{t('devtools.empty')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
