import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type {
  BrowserInputEvent,
  BrowserRequest,
  BrowserSelectPrompt,
  BrowserDialogPrompt,
} from '../../shared/browser-ipc.js'
import {
  buttonOf,
  buttonsOf,
  keyEventFor,
  mirrorSelection,
  modifiersOf,
  printable,
  wheelPixels,
} from './website-surface.js'

interface Frame {
  readonly url: string
  readonly width: number
  readonly height: number
  readonly receipt: BrowserRequest<'browser:frameAck'>
}
type KeyInput = Extract<BrowserInputEvent, { kind: 'key' }>
type MouseButton = Extract<BrowserInputEvent, { kind: 'mouse' }>['button']
type ContinuousInput =
  | (Extract<BrowserInputEvent, { kind: 'mouse' }> & { readonly type: 'mouseMoved' })
  | Extract<BrowserInputEvent, { kind: 'wheel' }>
interface QueuedInput {
  event: BrowserInputEvent
  readonly browserId: string
  readonly settle: ((sent: boolean) => void) | null
}

export function useBrowserScreencast(
  browserId: string | null,
  selected: boolean,
  row: RefObject<HTMLElement | null>
) {
  const surface = useRef<HTMLDivElement | null>(null)
  const editor = useRef<HTMLTextAreaElement | null>(null)
  const [instance] = useState(() => crypto.randomUUID())
  const generation = useRef(0)
  const epoch = useRef(0)
  const live = useRef(false)
  const composing = useRef(false)
  const committed = useRef<string | null>(null)
  const decoding = useRef<HTMLImageElement | null>(null)
  const heldKeys = useRef(new Map<string, KeyInput>())
  const heldButtons = useRef(new Map<MouseButton, number>())
  const mouseButtons = useRef(0)
  const lastPoint = useRef({ x: 0, y: 0 })
  const inputQueue = useRef<QueuedInput[]>([])
  const inputRunning = useRef(false)
  const pendingMove = useRef<QueuedInput | null>(null)
  const pendingWheel = useRef<QueuedInput | null>(null)
  const shownFrame = useRef<Frame | null>(null)
  const [frame, setFrame] = useState<Frame | null>(null)
  const [select, setSelect] = useState<BrowserSelectPrompt | null>(null)
  const [dialog, setDialog] = useState<BrowserDialogPrompt | null>(null)
  const [intersecting, setIntersecting] = useState(false)
  const visible = selected && intersecting

  useLayoutEffect(() => {
    shownFrame.current = frame
    if (frame !== null) void window.chorus.ackBrowserFrame(frame.receipt).catch(() => undefined)
  }, [frame])

  const cancelDecode = useCallback((): void => {
    if (decoding.current !== null) decoding.current.src = ''
    decoding.current = null
  }, [])

  useEffect(() => {
    cancelDecode()
    epoch.current = 0
    live.current = false
    shownFrame.current = null
    setFrame(null)
    setSelect(null)
    setDialog(null)
  }, [browserId, cancelDecode])

  useEffect(() => {
    const node = surface.current
    if (node === null) return undefined
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIntersecting(
          entry?.isIntersecting === true &&
            entry.intersectionRect.width > 0 &&
            entry.intersectionRect.height > 0
        )
      },
      { root: row.current }
    )
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [row])

  useEffect(() => {
    if (browserId === null) return undefined
    const stop = window.chorus.onBrowserFrame((pushed) => {
      if (
        pushed.browserId !== browserId ||
        pushed.instance !== instance ||
        pushed.generation !== generation.current ||
        pushed.epoch < epoch.current
      )
        return
      cancelDecode()
      epoch.current = pushed.epoch
      live.current = true
      const receipt = {
        browserId,
        instance: pushed.instance,
        generation: pushed.generation,
        serial: pushed.serial,
      }
      let scheduled = false
      const image = new Image()
      decoding.current = image
      image.src = `data:image/jpeg;base64,${pushed.data}`
      void image
        .decode()
        .then(() => {
          if (
            decoding.current !== image ||
            pushed.generation !== generation.current ||
            pushed.epoch !== epoch.current ||
            !live.current
          )
            return
          scheduled = true
          setFrame({ url: image.src, width: pushed.width, height: pushed.height, receipt })
        })
        .catch(() => undefined)
        .finally(() => {
          if (decoding.current === image) decoding.current = null
          if (!scheduled) void window.chorus.ackBrowserFrame(receipt).catch(() => undefined)
        })
    })
    return () => {
      stop()
      cancelDecode()
    }
  }, [browserId, instance, cancelDecode])

  useEffect(() => {
    if (browserId === null) return undefined
    return window.chorus.onBrowser((pushed) => {
      if (pushed.browserId !== browserId) return
      if (pushed.kind === 'select')
        setSelect((previous) =>
          previous?.token === pushed.select?.token ? previous : pushed.select
        )
      else if (pushed.kind === 'dialog')
        setDialog((previous) =>
          previous?.token === pushed.dialog?.token ? previous : pushed.dialog
        )
      else if (pushed.kind === 'state' && !pushed.state.live) {
        cancelDecode()
        live.current = false
        shownFrame.current = null
        setFrame(null)
        setSelect(null)
        setDialog(null)
      }
    })
  }, [browserId, cancelDecode])

  useEffect(() => {
    const node = surface.current
    if (browserId === null || node === null) return undefined
    const report = (): void => {
      const { width, height } = node.getBoundingClientRect()
      generation.current += 1
      cancelDecode()
      void window.chorus
        .streamBrowser({
          browserId,
          instance,
          generation: generation.current,
          visible: visible && width >= 1 && height >= 1,
          width: Math.min(8192, Math.max(1, Math.round(width))),
          height: Math.min(8192, Math.max(1, Math.round(height))),
          scale: Math.min(4, Math.max(1, window.devicePixelRatio)),
        })
        .catch(() => undefined)
    }
    const observer = new ResizeObserver(report)
    observer.observe(node)
    window.addEventListener('resize', report)
    report()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      generation.current += 1
      cancelDecode()
      void window.chorus
        .streamBrowser({
          browserId,
          instance,
          generation: generation.current,
          visible: false,
          width: 1,
          height: 1,
          scale: 1,
        })
        .catch(() => undefined)
    }
  }, [browserId, instance, visible, cancelDecode])

  const point = useCallback((clientX: number, clientY: number) => {
    const node = surface.current
    const current = shownFrame.current
    if (node === null || current === null) return { x: 0, y: 0 }
    const box = node.getBoundingClientRect()
    return {
      x: box.width > 0 ? ((clientX - box.left) * current.width) / box.width : 0,
      y: box.height > 0 ? ((clientY - box.top) * current.height) / box.height : 0,
    }
  }, [])

  const inputTarget = useCallback((): string | null => {
    if (browserId === null || shownFrame.current?.receipt.browserId !== browserId || !live.current)
      return null
    return browserId
  }, [browserId])

  const drainInput = useCallback(async (): Promise<void> => {
    if (inputRunning.current) return
    inputRunning.current = true
    try {
      let queued = inputQueue.current.shift()
      while (queued !== undefined) {
        if (pendingMove.current === queued) pendingMove.current = null
        if (pendingWheel.current === queued) pendingWheel.current = null
        let sent = false
        try {
          await window.chorus.browserInput({ browserId: queued.browserId, event: queued.event })
          sent = true
        } catch {
          sent = false
        }
        queued.settle?.(sent)
        queued = inputQueue.current.shift()
      }
    } finally {
      inputRunning.current = false
    }
  }, [])

  const send = useCallback(
    (event: BrowserInputEvent): Promise<boolean> => {
      const target = inputTarget()
      if (target === null) return Promise.resolve(false)
      pendingMove.current = null
      pendingWheel.current = null
      return new Promise<boolean>((settle) => {
        inputQueue.current.push({ browserId: target, event, settle })
        void drainInput()
      })
    },
    [inputTarget, drainInput]
  )

  const sendContinuous = useCallback(
    (event: ContinuousInput): void => {
      const target = inputTarget()
      if (target === null) return
      const pending = event.kind === 'wheel' ? pendingWheel : pendingMove
      const queued = pending.current
      if (queued !== null && queued.browserId === target) {
        queued.event =
          event.kind === 'wheel' && queued.event.kind === 'wheel'
            ? {
                ...event,
                deltaX: queued.event.deltaX + event.deltaX,
                deltaY: queued.event.deltaY + event.deltaY,
              }
            : event
      } else {
        const next: QueuedInput = { browserId: target, event, settle: null }
        pending.current = next
        inputQueue.current.push(next)
      }
      void drainInput()
    },
    [inputTarget, drainInput]
  )

  const clearContinuous = useCallback((): void => {
    pendingMove.current = null
    pendingWheel.current = null
    inputQueue.current = inputQueue.current.filter((queued) => queued.settle !== null)
  }, [])

  const releaseButtons = useCallback((): void => {
    for (const [button, clickCount] of heldButtons.current) {
      const bit = button === 'left' ? 1 : button === 'right' ? 2 : 4
      mouseButtons.current &= ~bit
      void send({
        kind: 'mouse',
        type: 'mouseReleased',
        ...lastPoint.current,
        button,
        buttons: mouseButtons.current,
        clickCount,
        modifiers: 0,
      })
    }
    heldButtons.current.clear()
    mouseButtons.current = 0
  }, [send])

  const releaseHeld = useCallback((): void => {
    clearContinuous()
    releaseButtons()
    for (const pressed of heldKeys.current.values()) {
      const { text: _text, ...key } = pressed
      void send({ ...key, type: 'keyUp', modifiers: 0, autoRepeat: false })
    }
    heldKeys.current.clear()
  }, [send, clearContinuous, releaseButtons])

  useEffect(() => {
    if (!selected) releaseHeld()
    window.addEventListener('blur', releaseHeld)
    return () => {
      window.removeEventListener('blur', releaseHeld)
      releaseHeld()
    }
  }, [selected, releaseHeld])

  useEffect(() => {
    return () => {
      live.current = false
      shownFrame.current = null
    }
  }, [browserId])

  useEffect(() => {
    const area = editor.current
    const stage = surface.current
    if (area === null || stage === null) return undefined
    const text = async (value: string): Promise<void> => {
      let start = 0
      while (start < value.length) {
        let end = Math.min(value.length, start + 10_000)
        const last = value.charCodeAt(end - 1)
        if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1
        if (!(await send({ kind: 'text', text: value.slice(start, end) }))) return
        start = end
      }
      await mirrorSelection(browserId, area)
    }
    const onBeforeInput = (event: InputEvent): void => {
      if (event.isComposing || composing.current) return
      if (event.inputType !== 'insertText' && event.inputType !== 'insertReplacementText') return
      event.preventDefault()
      const value = event.data ?? event.dataTransfer?.getData('text/plain') ?? ''
      if (committed.current === value) {
        committed.current = null
        return
      }
      committed.current = null
      if (value !== '') void text(value)
    }
    const onPaste = (event: ClipboardEvent): void => {
      event.preventDefault()
      committed.current = null
      const value = event.clipboardData?.getData('text/plain') ?? ''
      if (value !== '') void text(value)
    }
    const onCut = (): void => {
      if (area.selectionStart === area.selectionEnd) return
      const key: KeyInput = {
        kind: 'key',
        type: 'rawKeyDown',
        key: 'Delete',
        code: 'Delete',
        keyCode: 46,
        autoRepeat: false,
        modifiers: 0,
      }
      void send(key)
        .then(() => send({ ...key, type: 'keyUp' }))
        .then(() => mirrorSelection(browserId, area))
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.isComposing && event.key !== 'Process' && !composing.current)
        committed.current = null
    }
    const onCompositionStart = (): void => {
      composing.current = true
      committed.current = null
      area.dataset['composing'] = 'true'
    }
    const onCompositionEnd = (event: CompositionEvent): void => {
      composing.current = false
      delete area.dataset['composing']
      committed.current = event.data === '' ? null : event.data
      area.value = ''
      if (event.data !== '') void text(event.data)
      else void mirrorSelection(browserId, area)
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      sendContinuous({
        kind: 'wheel',
        ...point(event.clientX, event.clientY),
        ...wheelPixels(event, stage.clientHeight),
        modifiers: modifiersOf(event),
      })
    }
    area.addEventListener('beforeinput', onBeforeInput)
    area.addEventListener('paste', onPaste)
    area.addEventListener('cut', onCut)
    area.addEventListener('keydown', onKeyDown)
    area.addEventListener('compositionstart', onCompositionStart)
    area.addEventListener('compositionend', onCompositionEnd)
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      area.removeEventListener('beforeinput', onBeforeInput)
      area.removeEventListener('paste', onPaste)
      area.removeEventListener('cut', onCut)
      area.removeEventListener('keydown', onKeyDown)
      area.removeEventListener('compositionstart', onCompositionStart)
      area.removeEventListener('compositionend', onCompositionEnd)
      stage.removeEventListener('wheel', onWheel)
      composing.current = false
      delete area.dataset['composing']
    }
  }, [browserId, send, sendContinuous, point])

  const pointerDown = (event: PointerEvent): void => {
    const button = buttonOf(event.button)
    if (button === 'none') return
    const position = point(event.clientX, event.clientY)
    lastPoint.current = position
    const clickCount = Math.min(3, Math.max(1, event.detail))
    heldButtons.current.set(button, clickCount)
    mouseButtons.current = buttonsOf(event.buttons)
    void send({
      kind: 'mouse',
      type: 'mousePressed',
      ...position,
      button,
      buttons: mouseButtons.current,
      clickCount,
      modifiers: modifiersOf(event),
    })
  }

  const pointerUp = (event: PointerEvent): void => {
    const button = buttonOf(event.button)
    const clickCount = heldButtons.current.get(button)
    if (clickCount === undefined) return
    heldButtons.current.delete(button)
    mouseButtons.current = buttonsOf(event.buttons)
    lastPoint.current = point(event.clientX, event.clientY)
    void send({
      kind: 'mouse',
      type: 'mouseReleased',
      ...lastPoint.current,
      button,
      buttons: mouseButtons.current,
      clickCount,
      modifiers: modifiersOf(event),
    }).then(() => mirrorSelection(browserId, editor.current))
  }

  const pointerMove = (event: PointerEvent): void => {
    lastPoint.current = point(event.clientX, event.clientY)
    sendContinuous({
      kind: 'mouse',
      type: 'mouseMoved',
      ...lastPoint.current,
      button: 'none',
      buttons: buttonsOf(event.buttons),
      clickCount: 0,
      modifiers: modifiersOf(event),
    })
  }

  const keyDown = (event: KeyboardEvent): boolean => {
    if (composing.current || event.isComposing || event.key === 'Process') return true
    const key = keyEventFor(event, 'down')
    if (key === null) return false
    if (!printable(event)) event.preventDefault()
    heldKeys.current.set(key.code || key.key, key)
    void send(key)
    return true
  }

  const keyUp = (event: KeyboardEvent): boolean => {
    if (composing.current || event.isComposing || event.key === 'Process') return true
    const key = keyEventFor(event, 'up')
    if (key === null) return false
    const id = key.code || key.key
    if (!heldKeys.current.has(id)) return true
    heldKeys.current.delete(id)
    void send(key).then(() => mirrorSelection(browserId, editor.current))
    return true
  }

  return {
    surface,
    editor,
    frame,
    select,
    setSelect,
    dialog,
    setDialog,
    visible,
    pointerDown,
    pointerUp,
    pointerMove,
    keyDown,
    keyUp,
    releaseButtons,
    releaseHeld,
  }
}
