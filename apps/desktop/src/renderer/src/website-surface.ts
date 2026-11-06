import type { BrowserInputEvent } from '../../shared/browser-ipc.js'

export const WEBSITE_SURFACE_ATTRIBUTE = 'data-website-surface'
type KeyInput = Extract<BrowserInputEvent, { kind: 'key' }>
type MouseButton = Extract<BrowserInputEvent, { kind: 'mouse' }>['button']
const mirrors = new WeakMap<HTMLTextAreaElement, number>()
const NAMED_KEY_CODES: Readonly<Record<string, number | undefined>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  NumpadEnter: 13,
  Shift: 16,
  ShiftLeft: 16,
  ShiftRight: 16,
  Control: 17,
  ControlLeft: 17,
  ControlRight: 17,
  Alt: 18,
  AltLeft: 18,
  AltRight: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  MetaLeft: 91,
  MetaRight: 92,
  ContextMenu: 93,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumLock: 144,
  ScrollLock: 145,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
}

export function virtualKeyCode(event: Pick<KeyboardEvent, 'code' | 'key'>): number {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.charCodeAt(3)
  if (/^Digit[0-9]$/.test(event.code)) return event.code.charCodeAt(5)
  if (/^Numpad[0-9]$/.test(event.code)) return 96 + Number(event.code.slice(6))
  if (/^F(?:[1-9]|1[0-2])$/.test(event.code)) return 111 + Number(event.code.slice(1))
  const named = Object.hasOwn(NAMED_KEY_CODES, event.code)
    ? NAMED_KEY_CODES[event.code]
    : Object.hasOwn(NAMED_KEY_CODES, event.key)
      ? NAMED_KEY_CODES[event.key]
      : undefined
  if (named !== undefined) return named
  return /^[a-z0-9]$/i.test(event.key) ? event.key.toUpperCase().charCodeAt(0) : 0
}

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
  return /^.$/su.test(event.key) && !event.ctrlKey && !event.metaKey
}

export function keyEventFor(event: KeyboardEvent, phase: 'down' | 'up'): KeyInput | null {
  if (event.isComposing || event.key === 'Process') return null
  if ((event.metaKey || event.ctrlKey) && ['c', 'v', 'x'].includes(event.key.toLowerCase()))
    return null
  return {
    kind: 'key',
    type: phase === 'up' ? 'keyUp' : event.key === 'Enter' ? 'keyDown' : 'rawKeyDown',
    key: event.key.slice(0, 32),
    code: event.code.slice(0, 32),
    keyCode: virtualKeyCode(event),
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
  const start = current >= 0 && current < options.length ? current : direction === 1 ? -1 : 0
  for (const offset of options.keys()) {
    const index = (start + direction * (offset + 1) + options.length) % options.length
    if (options[index]?.disabled === false) return index
  }
  return -1
}
