import { useHostCapabilities } from './host-context.js'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { TOAST_WINDOW_NAME } from '../../shared/toast-window-ipc.js'
import type { WorkbenchRect } from '../../shared/workbench-ipc.js'

interface ToastLayer {
  host: HTMLDivElement | null
  anchor: RefObject<HTMLDivElement | null>
  stack: RefObject<HTMLDivElement | null>
}

function copyAttributes(source: HTMLElement, target: HTMLElement): void {
  for (const attribute of Array.from(target.attributes)) target.removeAttribute(attribute.name)
  for (const attribute of Array.from(source.attributes)) {
    target.setAttribute(attribute.name, attribute.value)
  }
}

function cardRegions(cards: HTMLElement, popup: Window): WorkbenchRect[] {
  const regions: WorkbenchRect[] = []
  const viewport = cards.getBoundingClientRect()
  const add = (x: number, y: number, width: number, height: number): void => {
    const left = Math.max(0, Math.floor(x))
    const top = Math.max(0, Math.floor(y))
    const right = Math.min(viewport.width, Math.ceil(x + width))
    const bottom = Math.min(viewport.height, Math.ceil(y + height))
    if (right > left && bottom > top) {
      regions.push({
        x: left,
        y: top,
        width: Math.floor(right - left),
        height: Math.floor(bottom - top),
      })
    }
  }
  for (const card of cards.querySelectorAll<HTMLElement>('.toast')) {
    const bounds = card.getBoundingClientRect()
    const left = bounds.left - viewport.left
    const top = bounds.top - viewport.top
    const radius = Math.min(
      Math.ceil(Number.parseFloat(popup.getComputedStyle(card).borderTopLeftRadius) || 0),
      Math.floor(bounds.width / 2),
      Math.floor(bounds.height / 2)
    )
    add(left, top + radius, bounds.width, bounds.height - 2 * radius)
    for (let row = 0; row < radius; row++) {
      const inset = Math.ceil(radius - Math.sqrt(radius * radius - (radius - row - 0.5) ** 2))
      add(left + inset, top + row, bounds.width - 2 * inset, 1)
      add(left + inset, top + bounds.height - row - 1, bounds.width - 2 * inset, 1)
    }
  }
  const scrollbar = cards.offsetWidth - cards.clientWidth
  if (cards.scrollHeight > cards.clientHeight && scrollbar > 0) {
    const left = popup.getComputedStyle(cards).direction === 'rtl' ? 0 : viewport.width - scrollbar
    add(left, 0, scrollbar, viewport.height)
  }
  return regions
}

export function useToastWindow(active: boolean, onClosed: () => void): ToastLayer {
  const capabilities = useHostCapabilities()
  const nativeViews = capabilities.embeddedEditor || capabilities.nativeBrowserViews
  const anchor = useRef<HTMLDivElement>(null)
  const stack = useRef<HTMLDivElement>(null)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [needed, setNeeded] = useState(active)
  const [generation, setGeneration] = useState(0)
  const visible = useRef(active)
  const placeWindow = useRef<(() => void) | null>(null)
  const rememberFocus = useRef<(() => void) | null>(null)
  const onWindowClosed = useRef(onClosed)

  useLayoutEffect(() => {
    onWindowClosed.current = onClosed
  }, [onClosed])

  useLayoutEffect(() => {
    if (visible.current && !active) rememberFocus.current?.()
    visible.current = active
    placeWindow.current?.()
  }, [active, host])

  useEffect(() => {
    if (active) setNeeded(true)
  }, [active])

  useEffect(() => {
    if (!needed || !nativeViews) return undefined
    const popup = window.open('about:blank', TOAST_WINDOW_NAME)
    if (popup === null) return undefined
    const childDocument = popup.document
    const target = childDocument.createElement('div')
    childDocument.body.replaceChildren(target)
    let lastPlacement: string | null = null
    let lastInteractive: boolean | null = null
    let stylesReady = false
    let styleRevision = 0
    let savedFocus: {
      element: HTMLElement
      start: number | null
      end: number | null
      direction: 'forward' | 'backward' | 'none' | null
    } | null = null

    rememberFocus.current = (): void => {
      const element = childDocument.activeElement as HTMLElement | null
      if (!element?.closest('.toast')) return
      const input = element.matches('input, textarea')
        ? (element as HTMLInputElement | HTMLTextAreaElement)
        : null
      savedFocus = {
        element,
        start: input?.selectionStart ?? null,
        end: input?.selectionEnd ?? null,
        direction: input?.selectionDirection ?? null,
      }
    }

    const setInteraction = (interactive: boolean): void => {
      if (lastInteractive === interactive || popup.closed) return
      lastInteractive = interactive
      void window.chorusToasts.setInteraction({ interactive }).catch(() => {
        lastInteractive = null
      })
    }

    const mouseDown = (): void => {
      setInteraction(true)
    }
    const mouseUp = (): void => {
      setInteraction(false)
    }
    childDocument.addEventListener('mousedown', mouseDown, true)
    childDocument.addEventListener('mouseup', mouseUp, true)
    popup.addEventListener('blur', mouseUp)

    const place = (): void => {
      const position = anchor.current
      const cards = stack.current
      if (popup.closed) return
      let rect: WorkbenchRect | null = null
      let regions: WorkbenchRect[] = []
      if (
        visible.current &&
        stylesReady &&
        position !== null &&
        cards !== null &&
        cards.ownerDocument === childDocument
      ) {
        const bounds = position.getBoundingClientRect()
        target.style.width = `${String(bounds.width)}px`
        target.style.maxHeight = window.getComputedStyle(position).maxHeight
        const height = cards.getBoundingClientRect().height
        if (bounds.width > 0 && height > 0) {
          rect = {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.ceil(bounds.width),
            height: Math.ceil(height),
          }
          regions = cardRegions(cards, popup)
        }
      }
      const shellFocus = document.activeElement
      const restoreFocus =
        rect !== null &&
        savedFocus !== null &&
        savedFocus.element.isConnected &&
        !shellFocus?.matches('input, textarea, [contenteditable="true"]')
      const request = { rect, regions, restoreFocus }
      const placement = JSON.stringify(request)
      if (lastPlacement === placement) return
      lastPlacement = placement
      const restoring = rect === null ? null : savedFocus
      void window.chorusToasts
        .setBounds(request)
        .then((answer) => {
          if (restoring === null || savedFocus !== restoring) return
          savedFocus = null
          if (!answer.focused || !visible.current || popup.closed) return
          const saved = restoring
          if (!saved.element.isConnected) return
          saved.element.focus({ preventScroll: true })
          if (
            saved.start !== null &&
            saved.end !== null &&
            saved.element.matches('input, textarea')
          ) {
            const input = saved.element as HTMLInputElement | HTMLTextAreaElement
            input.setSelectionRange(saved.start, saved.end, saved.direction ?? undefined)
          }
        })
        .catch(() => {
          lastPlacement = null
        })
    }
    placeWindow.current = place

    const mirrorTheme = (): void => {
      copyAttributes(document.documentElement, childDocument.documentElement)
      copyAttributes(document.body, childDocument.body)
      childDocument.documentElement.style.background = 'transparent'
      childDocument.body.style.background = 'transparent'
      childDocument.body.style.overflow = 'hidden'
      childDocument.body.style.margin = '0'
    }
    const mirrorStyles = (): void => {
      if (popup.closed) return
      const revision = ++styleRevision
      let pending = 0
      const loaded = (): void => {
        if (popup.closed || revision !== styleRevision) return
        pending -= 1
        if (pending !== 0) return
        stylesReady = true
        place()
      }
      const styles = Array.from(
        document.head.querySelectorAll('style, link[rel="stylesheet"]')
      ).map((source) => {
        const clone = source.cloneNode(true)
        if (source instanceof HTMLLinkElement && clone instanceof HTMLLinkElement) {
          clone.href = source.href
          clone.disabled = source.disabled
          if (!clone.disabled) {
            pending += 1
            clone.addEventListener('load', loaded, { once: true })
            clone.addEventListener('error', loaded, { once: true })
          }
        }
        return clone
      })
      stylesReady = pending === 0
      childDocument.head.replaceChildren(...styles)
      childDocument.title = document.title
      if (stylesReady) place()
    }
    mirrorTheme()
    mirrorStyles()
    const isStyle = (node: Node): boolean =>
      node instanceof HTMLStyleElement || node instanceof HTMLLinkElement
    const stylesChanged = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            isStyle(record.target) ||
            (record.target.parentElement !== null && isStyle(record.target.parentElement)) ||
            Array.from(record.addedNodes).some(isStyle) ||
            Array.from(record.removedNodes).some(isStyle)
        )
      ) {
        mirrorStyles()
      }
    })
    stylesChanged.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href', 'rel', 'media', 'disabled'],
    })
    const themeChanged = new MutationObserver(() => {
      mirrorTheme()
      place()
    })
    themeChanged.observe(document.documentElement, { attributes: true })
    themeChanged.observe(document.body, { attributes: true })
    const resized = new ResizeObserver(place)
    resized.observe(target)
    resized.observe(document.documentElement)
    if (anchor.current !== null) resized.observe(anchor.current)
    const cardSizes = new ResizeObserver(place)
    const watchCards = (): void => {
      cardSizes.disconnect()
      for (const card of target.querySelectorAll<HTMLElement>('.toast')) cardSizes.observe(card)
      place()
    }
    const cardsChanged = new MutationObserver(watchCards)
    cardsChanged.observe(target, { childList: true, subtree: true, characterData: true })
    watchCards()
    window.addEventListener('resize', place)
    childDocument.addEventListener('scroll', place, true)
    const closed = (): void => {
      setHost(null)
      onWindowClosed.current()
      setGeneration((value) => value + 1)
    }
    popup.addEventListener('beforeunload', closed)
    setHost(target)

    return () => {
      resized.disconnect()
      cardSizes.disconnect()
      cardsChanged.disconnect()
      stylesChanged.disconnect()
      themeChanged.disconnect()
      window.removeEventListener('resize', place)
      childDocument.removeEventListener('scroll', place, true)
      childDocument.removeEventListener('mousedown', mouseDown, true)
      childDocument.removeEventListener('mouseup', mouseUp, true)
      popup.removeEventListener('blur', mouseUp)
      popup.removeEventListener('beforeunload', closed)
      placeWindow.current = null
      rememberFocus.current = null
      popup.close()
    }
  }, [needed, generation, nativeViews])

  return { host, anchor, stack }
}
