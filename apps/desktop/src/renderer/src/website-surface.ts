import type { BrowserInputEvent } from '../../shared/browser-ipc.js'

export const WEBSITE_SURFACE_ATTRIBUTE = 'data-website-surface'
type KeyInput = Extract<BrowserInputEvent, { kind: 'key' }>
type MouseButton = Extract<BrowserInputEvent, { kind: 'mouse' }>['button']
const mirrors = new WeakMap<HTMLTextAreaElement, number>()

export function insideWebsiteSurface(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${WEBSITE_SURFACE_ATTRIBUTE}]`) !== null
}

export function modifiersOf(event: {
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  )
}

export function buttonOf(button: number): MouseButton {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return 'none'
}

export function buttonsOf(buttons: number): number {
  return buttons & 31
}

export function wheelPixels(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>,
  pageHeight: number
): { deltaX: number; deltaY: number } {
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, pageHeight) : 1
  return { deltaX: event.deltaX * scale, deltaY: event.deltaY * scale }
}

export function printable(event: KeyboardEvent): boolean {
  return [...event.key].length === 1 && !event.ctrlKey && !event.metaKey
}

export function keyEventFor(event: KeyboardEvent, phase: 'down' | 'up'): KeyInput | null {
  if (event.isComposing || event.key === 'Process' || event.keyCode === 229) return null
  if ((event.metaKey || event.ctrlKey) && ['c', 'v', 'x'].includes(event.key.toLowerCase())) return null
  return {
    kind: 'key',
    type: phase === 'up' ? 'keyUp' : event.key === 'Enter' ? 'keyDown' : 'rawKeyDown',
    key: event.key.slice(0, 32),
    code: event.code.slice(0, 32),
    keyCode: Math.min(255, Math.max(0, event.keyCode)),
    autoRepeat: event.repeat,
    modifiers: modifiersOf(event),
    ...(phase === 'down' && event.key === 'Enter' ? { text: '\r' } : {}),
  }
}

export function placeEditor(
  editor: HTMLTextAreaElement | null,
  point: { readonly clientX: number; readonly clientY: number }
): void {
  const surface = editor?.parentElement
  if (editor === null || surface === null || surface === undefined) return
  const rect = surface.getBoundingClientRect()
  editor.style.left = `${String(Math.max(0, Math.min(rect.width - 1, point.clientX - rect.left)))}px`
  editor.style.top = `${String(Math.max(0, Math.min(rect.height - 1, point.clientY - rect.top)))}px`
}

export async function mirrorSelection(
  browserId: string | null,
  editor: HTMLTextAreaElement | null
): Promise<void> {
  if (browserId === null || editor === null) return
  const revision = (mirrors.get(editor) ?? 0) + 1
  mirrors.set(editor, revision)
  try {
    const { text } = await window.chorus.browserSelection({ browserId })
    if (
      mirrors.get(editor) !== revision ||
      !editor.isConnected ||
      editor.ownerDocument.activeElement !== editor ||
      editor.dataset['composing'] === 'true'
    )
      return
    editor.value = text
    editor.setSelectionRange(0, text.length)
  } catch {
    return
  }
}

export function nextEnabled(
  options: readonly { readonly disabled: boolean }[],
  current: number,
  direction: 1 | -1
): number {
  if (options.length === 0) return -1
  let index = current >= 0 && current < options.length ? current : direction === 1 ? -1 : 0
  for (let count = 0; count < options.length; count += 1) {
    index = (index + direction + options.length) % options.length
    if (options[index]?.disabled === false) return index
  }
  return -1
}
