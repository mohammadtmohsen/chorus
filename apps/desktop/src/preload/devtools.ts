import { ipcRenderer } from 'electron'
import type { BrowserPageRowWheel } from '../shared/browser-ipc.js'

interface DevtoolsWheel extends BrowserPageRowWheel {
  readonly isTrusted: boolean
  readonly cancelable: boolean
  preventDefault(): void
  stopImmediatePropagation(): void
}

declare const window: {
  addEventListener(
    type: 'wheel',
    listener: (event: DevtoolsWheel) => void,
    options: { readonly capture: boolean; readonly passive: boolean }
  ): void
}

const ROW_WHEEL_CHANNEL = 'browser:devtools:row-wheel'
const WHEEL_DELTA_MAX = 10_000

function rowWheel(event: DevtoolsWheel): BrowserPageRowWheel | null {
  const { deltaX, deltaY, deltaMode, shiftKey, ctrlKey, metaKey } = event
  if (!shiftKey && Math.abs(deltaX) <= Math.abs(deltaY)) return null
  if (deltaX === 0 && (!shiftKey || deltaY === 0)) return null
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null
  if (Math.abs(deltaX) > WHEEL_DELTA_MAX || Math.abs(deltaY) > WHEEL_DELTA_MAX) return null
  if (deltaMode !== 0 && deltaMode !== 1 && deltaMode !== 2) return null
  return { deltaX, deltaY, deltaMode, shiftKey, ctrlKey, metaKey }
}

window.addEventListener(
  'wheel',
  (event) => {
    if (!event.isTrusted || event.ctrlKey || event.metaKey) return
    const message = rowWheel(event)
    if (message === null) return
    if (event.cancelable) event.preventDefault()
    event.stopImmediatePropagation()
    ipcRenderer.send(ROW_WHEEL_CHANNEL, message)
  },
  { capture: true, passive: false }
)
