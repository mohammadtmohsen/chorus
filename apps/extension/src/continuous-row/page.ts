import { horizontalRowWheel } from '../../../desktop/src/renderer/src/workspace/viewport.js'
import {
  BROWSER_VIEW_WHEEL,
  CHORUS_COMPOSITE,
  CHORUS_EXTENSION_ID,
  CONTINUOUS_ROW,
  editorEdge,
  readRowMessage,
  rowBounds,
  slideStrip,
  stripOf,
  type PageMessage,
  type RowBounds,
} from './protocol.js'

const DRAG_IDLE_MS = 140
const SASH_SLACK_PX = 4
const ADJOIN_PX = 6
const NO_ROW = { generation: 0, row: 0, rowMax: 0 }
const WEBVIEW_READY = 'webview-ready'
const WEBVIEW_WHEEL = 'did-scroll-wheel'
const ACTIVE = 'chorus-row-active'
const COVERING = 'chorus-row-cover'
const VSCODE_OVERLAY = 'spotlight-overlay'
const VEIL_WIDTH_PX = 2
const BROWSER_CONTAINER = '.browser-container'
const CONTENT_MARK = 'data-chorus-row-content'
const ROOT_MARK = 'data-chorus-row-root'

const PAGE_CSS = `
html.${ACTIVE} [${ROOT_MARK}] { clip-path: none !important; }
html.${ACTIVE} [${CONTENT_MARK}] {
  left: var(--chorus-row-frame-left) !important;
  width: var(--chorus-row-frame-width) !important;
  clip-path: inset(0 0 0 var(--chorus-row-inset)) !important;
  z-index: 36 !important;
}
#chorus-row-cover { display: none; }
html.${COVERING} #chorus-row-cover {
  display: block;
  position: fixed;
  z-index: 36;
  left: var(--chorus-row-left);
  top: var(--chorus-row-cover-top);
  width: var(--chorus-row-cover-width);
  height: var(--chorus-row-cover-height);
  background: var(--vscode-sideBar-background);
}
#chorus-row-veil {
  position: fixed;
  inset: auto;
  left: var(--chorus-row-left);
  top: var(--chorus-row-veil-top);
  width: ${String(VEIL_WIDTH_PX)}px;
  height: var(--chorus-row-veil-height);
  z-index: 37;
  pointer-events: auto;
}
`

interface Drag {
  readonly start: number
  readonly startEdge: number
  readonly y: number
  x: number
}

let chorusFrame: Window | null = null
let chorusIframe: HTMLIFrameElement | null = null
let marked: HTMLElement | null = null
let session = -1
let mirror = NO_ROW
let sentRowSeq = 0
let appliedPageSeq = 0
let active = false
let held = false
let manual = false
let left = 0
let drag: Drag | null = null
let dragIdle: ReturnType<typeof setTimeout> | undefined
let applying = false
let measuring = false
let placing = false
let veilAt = Number.NaN

const root = document.documentElement
const style = document.createElement('style')
style.textContent = PAGE_CSS
document.head.append(style)
const cover = document.createElement('div')
cover.id = 'chorus-row-cover'
const veil = document.createElement('div')
veil.id = 'chorus-row-veil'
veil.className = VSCODE_OVERLAY
veil.style.display = 'none'

function part(name: string): HTMLElement | null {
  return document.getElementById(`workbench.parts.${name}`)
}

function box(name: string): DOMRect | null {
  const element = part(name)
  return element === null || element.offsetWidth === 0 ? null : element.getBoundingClientRect()
}

function editorRight(): number {
  return box('editor')?.right ?? 0
}

function sidebarRight(): number {
  return box('sidebar')?.right ?? 0
}

function bounds(): RowBounds {
  const barRight = box('activitybar')?.right ?? 0
  return rowBounds(window.innerWidth, barRight, Math.max(barRight, sidebarRight()))
}

function covering(): boolean {
  return root.classList.contains(COVERING)
}

function setPixels(element: HTMLElement, name: string, value: number): void {
  element.style.setProperty(name, `${String(Math.round(value))}px`)
}

function inset(limits: RowBounds): number {
  return Math.max(0, Math.round(left - limits.barRight))
}

function send(message: PageMessage): void {
  chorusFrame?.postMessage(message, '*')
}

function publish(): void {
  if (!active) {
    const idle = { page: 0, extra: 0, inset: 0 }
    send({ source: CONTINUOUS_ROW, kind: 'page', ...idle, applied: appliedPageSeq })
    return
  }
  const limits = bounds()
  send({
    source: CONTINUOUS_ROW,
    kind: 'page',
    ...stripOf(left, limits),
    inset: held ? inset(limits) : 0,
    applied: appliedPageSeq,
  })
}

interface ChorusFrame {
  readonly iframe: HTMLIFrameElement
  readonly window: Window
}

function chorusFrameOf(source: MessageEventSource | null): ChorusFrame | null {
  if (source === null || source instanceof MessagePort) return null
  for (const iframe of document.querySelectorAll<HTMLIFrameElement>('iframe.webview')) {
    if (!iframe.src.includes(`extensionId=${CHORUS_EXTENSION_ID}`)) continue
    const host = iframe.contentWindow
    if (host === null) continue
    const children = Array.from({ length: host.length }, (_, index) => host[index])
    const child = children.find((candidate) => candidate === source)
    if (child !== undefined) return { iframe, window: child }
  }
  return null
}

function chorusContent(): HTMLElement | null {
  let node = chorusIframe?.parentElement ?? null
  while (node !== null && getComputedStyle(node).position !== 'fixed') node = node.parentElement
  return node
}

function mark(content: HTMLElement | null): void {
  if (content === marked) return
  marked?.removeAttribute(CONTENT_MARK)
  marked?.parentElement?.removeAttribute(ROOT_MARK)
  marked = content
  content?.setAttribute(CONTENT_MARK, '')
  content?.parentElement?.setAttribute(ROOT_MARK, '')
}

function mouse(type: string, target: EventTarget, x: number, y: number): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
    })
  )
}

function dividerSash(): HTMLElement | null {
  const chorus = box('auxiliarybar')
  if (chorus === null) return null
  for (const sash of document.querySelectorAll<HTMLElement>('.monaco-sash.vertical')) {
    const area = sash.getBoundingClientRect()
    if (area.height === 0) continue
    const center = area.left + area.width / 2
    const besideChorus = area.top < chorus.bottom && area.bottom > chorus.top
    if (besideChorus && Math.abs(center - chorus.left) <= SASH_SLACK_PX) return sash
  }
  return null
}

function endDrag(): void {
  clearTimeout(dragIdle)
  if (drag === null) return
  const ending = drag
  drag = null
  mouse('mouseup', window, ending.x, ending.y)
}

function dragTo(edge: number): void {
  if (drag === null) {
    const sash = dividerSash()
    if (sash === null) return
    const area = sash.getBoundingClientRect()
    const center = area.left + area.width / 2
    drag = {
      start: center,
      startEdge: editorRight(),
      y: area.top + Math.min(area.height / 2, 120),
      x: center,
    }
    mouse('mousedown', sash, drag.x, drag.y)
  }
  drag.x = drag.start + (edge - drag.startEdge)
  mouse('mousemove', window, drag.x, drag.y)
  clearTimeout(dragIdle)
  dragIdle = setTimeout(endDrag, DRAG_IDLE_MS)
}

function driveDivider(target: number): number {
  if (Math.abs(target - editorRight()) < 1) return editorRight()
  const explorer = sidebarRight()
  dragTo(target)
  const squeezed = explorer - sidebarRight()
  if (squeezed >= 1) dragTo(target + squeezed)
  return editorRight()
}

function holdFrame(limits: RowBounds): void {
  const content = chorusContent()
  mark(content)
  held = content !== null
  if (content === null) {
    root.classList.remove(ACTIVE)
    return
  }
  setPixels(content, '--chorus-row-frame-left', limits.barRight)
  setPixels(content, '--chorus-row-frame-width', window.innerWidth - limits.barRight)
  setPixels(content, '--chorus-row-inset', inset(limits))
  root.classList.add(ACTIVE)
}

function moveVeil(edge: number): void {
  const at = Math.round(edge)
  if (at === veilAt) return
  veilAt = at
  setPixels(veil, '--chorus-row-left', at)
}

function placeVeil(): void {
  placing = false
  if (covering()) moveVeil(veilEdge(editorRight()))
}

function schedulePlaceVeil(): void {
  if (placing || !covering()) return
  placing = true
  requestAnimationFrame(placeVeil)
}

function setCovering(on: boolean): void {
  root.classList.toggle(COVERING, on)
  const display = on ? 'block' : 'none'
  if (veil.style.display !== display) veil.style.display = display
}

function veilEdge(divider: number): number {
  const edge = Math.max(left, box('editor')?.left ?? left)
  for (const browser of document.querySelectorAll<HTMLElement>(BROWSER_CONTAINER)) {
    const area = browser.getBoundingClientRect()
    const start = Math.max(edge, area.left) + 1
    if (area.width > 0 && start < Math.min(area.right, divider)) return start
  }
  return edge
}

function showCover(on: boolean, divider: number): void {
  setCovering(on)
  if (!on) return
  const chorus = box('auxiliarybar')
  const top = chorus?.top ?? 0
  const bodyTop = marked?.getBoundingClientRect().top ?? top
  setPixels(cover, '--chorus-row-left', left)
  setPixels(cover, '--chorus-row-cover-top', top)
  setPixels(cover, '--chorus-row-cover-width', Math.max(0, divider - left))
  setPixels(cover, '--chorus-row-cover-height', Math.max(0, bodyTop - top))
  moveVeil(veilEdge(divider))
  setPixels(veil, '--chorus-row-veil-top', top)
  setPixels(veil, '--chorus-row-veil-height', Math.max(0, (chorus?.bottom ?? top) - top))
}

function release(): void {
  endDrag()
  held = false
  setCovering(false)
  root.classList.remove(ACTIVE)
}

function apply(): void {
  applying = false
  if (!active) return
  const limits = bounds()
  left = Math.max(limits.barRight, Math.min(limits.widest, left))
  let divider = editorRight()
  if (!manual) {
    divider = driveDivider(editorEdge(left, limits))
    if (left > divider) left = divider
  }
  holdFrame(limits)
  showCover(!manual && left < divider - 0.5, divider)
  publish()
}

function scheduleApply(): void {
  if (applying) return
  applying = true
  requestAnimationFrame(apply)
}

function measure(): void {
  measuring = false
  const limits = bounds()
  const chorus = box('auxiliarybar')
  const editor = box('editor')
  const next =
    chorusIframe !== null &&
    part('auxiliarybar')?.getAttribute('data-active-composite') === CHORUS_COMPOSITE &&
    chorus !== null &&
    editor !== null &&
    Math.abs(chorus.left - editor.right) <= ADJOIN_PX &&
    limits.floor < limits.widest
  if (!next) release()
  if (next && drag === null && !applying && (manual || !covering())) {
    left = editorRight()
    setCovering(false)
    if (manual) holdFrame(limits)
  }
  active = next
  if (active) scheduleApply()
  else publish()
}

function scheduleMeasure(): void {
  if (measuring) return
  measuring = true
  requestAnimationFrame(measure)
}

function slide(delta: number): void {
  const limits = bounds()
  const strip = { ...stripOf(left, limits), row: mirror.row, rowMax: mirror.rowMax }
  const next = slideStrip(strip, delta)
  left = limits.widest - next.page
  scheduleApply()
  if (next.row === strip.row) return
  sentRowSeq += 1
  mirror = { ...mirror, row: next.row }
  send({
    source: CONTINUOUS_ROW,
    kind: 'row-target',
    seq: sentRowSeq,
    generation: mirror.generation,
    row: next.row,
  })
}

window.addEventListener(
  'wheel',
  (event) => {
    if (!active || manual || event.altKey || event.shiftKey) return
    const delta = horizontalRowWheel(event, window.innerWidth)
    if (delta === 0) return
    event.preventDefault()
    event.stopPropagation()
    slide(delta)
  },
  { capture: true, passive: false }
)

window.addEventListener(
  'mousedown',
  (event) => {
    if (!event.isTrusted) return
    endDrag()
    if (event.target instanceof Element && event.target.closest('.monaco-sash') !== null) {
      manual = true
    }
  },
  true
)
window.addEventListener(
  'mousemove',
  (event) => {
    if (event.isTrusted) endDrag()
  },
  true
)
window.addEventListener(
  'mouseup',
  (event) => {
    if (!event.isTrusted || !manual) return
    manual = false
    scheduleMeasure()
  },
  true
)

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!event.origin.startsWith('vscode-webview://')) return
  const message = readRowMessage(event.data)
  if (message === null) return
  if (message.kind === 'hello') {
    const found = chorusFrameOf(event.source)
    if (found === null) return
    if (message.session !== session || found.window !== chorusFrame) {
      session = message.session
      mirror = NO_ROW
      sentRowSeq = 0
      appliedPageSeq = 0
      mark(null)
    }
    chorusFrame = found.window
    chorusIframe = found.iframe
    scheduleMeasure()
    return
  }
  if (event.source !== chorusFrame) return
  if (message.kind === 'row') {
    if (message.session !== session) return
    if (message.generation !== mirror.generation || message.applied >= sentRowSeq) {
      mirror = { generation: message.generation, row: message.row, rowMax: message.rowMax }
    }
    return
  }
  appliedPageSeq = message.seq
  if (!active) {
    publish()
    return
  }
  left = bounds().widest - message.page
  scheduleApply()
})

function channelOf(data: unknown): unknown {
  return typeof data === 'object' && data !== null ? Reflect.get(data, 'channel') : null
}

function reportedWheel(report: unknown): number {
  if (typeof report !== 'object' || report === null) return 0
  if (Reflect.get(report, 'channel') !== WEBVIEW_WHEEL) return 0
  return wheelDelta(Reflect.get(report, 'data'))
}

function wheelDelta(wheel: unknown): number {
  if (typeof wheel !== 'object' || wheel === null) return 0
  const deltaX: unknown = Reflect.get(wheel, 'deltaX')
  const deltaY: unknown = Reflect.get(wheel, 'deltaY')
  const deltaMode: unknown = Reflect.get(wheel, 'deltaMode')
  if (typeof deltaX !== 'number' || typeof deltaY !== 'number' || typeof deltaMode !== 'number') {
    return 0
  }
  const modifiers = { ctrlKey: false, metaKey: false, shiftKey: false }
  return horizontalRowWheel({ deltaX, deltaY, deltaMode, ...modifiers }, window.innerWidth)
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!event.origin.startsWith('vscode-webview://')) return
  if (channelOf(event.data) !== WEBVIEW_READY) return
  const port = event.ports[0]
  const host = event.source
  if (port === undefined || host === null) return
  port.addEventListener('message', (report: MessageEvent<unknown>) => {
    if (!active || manual || host === chorusIframe?.contentWindow) return
    const delta = reportedWheel(report.data)
    if (delta !== 0) slide(delta)
  })
})

function listenToBrowserViews(): void {
  const globals: unknown = Reflect.get(window, 'vscode')
  if (typeof globals !== 'object' || globals === null) return
  const ipc: unknown = Reflect.get(globals, 'ipcRenderer')
  if (typeof ipc !== 'object' || ipc === null) return
  const on: unknown = Reflect.get(ipc, 'on')
  if (typeof on !== 'function') return
  Reflect.apply(on, ipc, [
    BROWSER_VIEW_WHEEL,
    (_event: unknown, wheel: unknown) => {
      if (!active || manual) return
      const delta = wheelDelta(wheel)
      if (delta !== 0) slide(delta)
    },
  ])
}

listenToBrowserViews()

window.addEventListener('resize', scheduleMeasure)

const waitForParts = new MutationObserver(() => {
  const chorus = part('auxiliarybar')
  const editor = part('editor')
  const workbench = document.querySelector('.monaco-workbench')
  if (chorus === null || editor === null || workbench === null) return
  waitForParts.disconnect()
  workbench.append(cover, veil)
  const sized = new ResizeObserver(() => {
    if (drag === null) measure()
  })
  sized.observe(chorus)
  sized.observe(editor)
  new MutationObserver(scheduleMeasure).observe(chorus, {
    attributes: true,
    attributeFilter: ['data-active-composite'],
  })
  new MutationObserver(schedulePlaceVeil).observe(editor, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style'],
  })
  scheduleMeasure()
})
waitForParts.observe(document, { childList: true, subtree: true })
