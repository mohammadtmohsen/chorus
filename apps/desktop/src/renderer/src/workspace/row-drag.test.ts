/** @vitest-environment jsdom */
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { configureHostResources } from '../host-resources.js'
import {
  registeredRow,
  routeRowWheel,
  scrollRegisteredRow,
  startEditorResize,
  startRowPush,
  stepEditorResize,
  stepRow,
  type RowWidths,
} from './row-drag.js'

function item(className: string, width: number): HTMLDivElement {
  const node = document.createElement('div')
  node.className = className
  Object.defineProperty(node, 'getBoundingClientRect', {
    value: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: 0,
      width,
      height: 0,
      toJSON: () => ({}),
    }),
    configurable: true,
  })
  return node
}

function sash(): HTMLDivElement {
  const node = document.createElement('div')
  node.className = 'conversation-sash'
  node.setPointerCapture = (): void => undefined
  node.releasePointerCapture = (): void => undefined
  return node
}

function row(...children: HTMLElement[]): HTMLDivElement {
  const scroller = document.createElement('div')
  scroller.append(...children)
  return scroller
}

function press(target: HTMLDivElement, clientX: number): ReactPointerEvent<HTMLDivElement> {
  return {
    button: 0,
    clientX,
    pointerId: 1,
    currentTarget: target,
  } as unknown as ReactPointerEvent<HTMLDivElement>
}

function moveTo(target: HTMLElement, clientX: number): void {
  target.dispatchEvent(new MouseEvent('pointermove', { clientX }))
}

function release(target: HTMLElement): void {
  target.dispatchEvent(new MouseEvent('pointerup'))
}

describe('resizing the editor divider', () => {
  function editorSash(): HTMLDivElement {
    const divider = sash()
    let captured = false
    divider.setPointerCapture = (): void => {
      captured = true
    }
    divider.hasPointerCapture = (): boolean => captured
    divider.releasePointerCapture = (): void => {
      captured = false
    }
    return divider
  }

  function pointer(target: HTMLElement, type: string, clientX = 800, pointerId = 1): void {
    const event = new MouseEvent(type, { clientX })
    Object.defineProperty(event, 'pointerId', { value: pointerId })
    target.dispatchEvent(event)
  }

  it('clamps a drag to the window and minimum, restores the origin and commits once', () => {
    const divider = editorSash()
    const applied: number[] = []
    let commits = 0
    startEditorResize(
      press(divider, 800),
      780,
      1_280,
      (width) => applied.push(width),
      () => {
        commits += 1
      }
    )
    pointer(divider, 'pointermove', 1_700)
    pointer(divider, 'pointermove', 400)
    pointer(divider, 'pointermove', 800)
    pointer(divider, 'pointerup')
    pointer(divider, 'pointerup')
    expect(applied).toEqual([1_280, 500, 780])
    expect(commits).toBe(1)
    expect(divider.hasPointerCapture(1)).toBe(false)
  })

  it('ignores another pointer and cleans up after losing capture', () => {
    const divider = editorSash()
    const applied: number[] = []
    let commits = 0
    startEditorResize(
      press(divider, 800),
      800,
      1_000,
      (width) => applied.push(width),
      () => {
        commits += 1
      }
    )
    pointer(divider, 'pointermove', 1_200, 2)
    pointer(divider, 'pointermove', 1_200)
    divider.releasePointerCapture(1)
    pointer(divider, 'lostpointercapture')
    pointer(divider, 'pointermove', 400)
    pointer(divider, 'pointerup')
    expect(applied).toEqual([1_000])
    expect(commits).toBe(1)
  })

  it('supports keyboard steps, Home and End without exceeding the bounds', () => {
    const divider = editorSash()
    let width = 800
    const applied: number[] = []
    let prevented = 0
    const keys = [
      { key: 'ArrowRight', shiftKey: false },
      { key: 'ArrowRight', shiftKey: true },
      { key: 'End', shiftKey: false },
      { key: 'ArrowRight', shiftKey: false },
      { key: 'Home', shiftKey: false },
      { key: 'ArrowLeft', shiftKey: true },
      { key: 'Tab', shiftKey: false },
    ]
    for (const key of keys) {
      stepEditorResize(
        {
          ...key,
          currentTarget: divider,
          preventDefault: () => {
            prevented += 1
          },
        } as unknown as ReactKeyboardEvent<HTMLDivElement>,
        width,
        1_000,
        (next) => {
          width = next
          applied.push(next)
        }
      )
    }
    expect(applied).toEqual([808, 848, 1_000, 1_000, 500, 500])
    expect(prevented).toBe(6)
  })
})

describe('dragging a row divider', () => {
  it('resizes chats and restores them at the origin without writing an editor width', () => {
    const divider = sash()
    row(
      item('workspace-pane-workbench', 749),
      sash(),
      item('conversation-slot', 500),
      divider,
      item('conversation-slot', 500)
    )
    const applied: RowWidths[] = []
    let commits = 0

    startRowPush(
      press(divider, 300),
      (widths) => {
        applied.push(widths)
      },
      () => {
        commits += 1
      }
    )
    moveTo(divider, 360)
    moveTo(divider, 300)
    release(divider)

    expect(applied).toEqual([
      { boxes: [560, 500], traffic: null, terminal: null, console: null, devtools: null },
      { boxes: [500, 500], traffic: null, terminal: null, console: null, devtools: null },
    ])
    expect(commits).toBe(1)
  })

  it('keeps Traffic at its own floor when the box before it is pushed past its floor', () => {
    const divider = sash()
    row(
      item('workspace-pane-workbench', 749),
      sash(),
      item('conversation-slot', 500),
      divider,
      item('traffic-box', 500)
    )
    const applied: RowWidths[] = []

    startRowPush(
      press(divider, 300),
      (widths) => {
        applied.push(widths)
      },
      (): void => undefined
    )
    moveTo(divider, 260)
    release(divider)

    expect(applied).toEqual([
      { boxes: [500], traffic: 540, terminal: null, console: null, devtools: null },
    ])
  })
})

describe('the run terminal pane in the row', () => {
  it('widens the terminal pane when Traffic beside it is already at its floor', () => {
    const divider = sash()
    row(
      item('workspace-pane-workbench', 749),
      sash(),
      item('conversation-slot', 500),
      sash(),
      item('traffic-box', 500),
      divider,
      item('project-terminal-box', 640)
    )
    const applied: RowWidths[] = []

    startRowPush(
      press(divider, 300),
      (widths) => {
        applied.push(widths)
      },
      (): void => undefined
    )
    moveTo(divider, 260)
    release(divider)

    expect(applied).toEqual([
      { boxes: [500], traffic: 500, terminal: 680, console: null, devtools: null },
    ])
  })

  it('reports the terminal width it left alone while Traffic grows', () => {
    const divider = sash()
    row(
      item('workspace-pane-workbench', 749),
      sash(),
      item('traffic-box', 800),
      divider,
      item('project-terminal-box', 640)
    )
    const applied: RowWidths[] = []

    stepRow(
      {
        key: 'ArrowRight',
        shiftKey: true,
        currentTarget: divider,
        preventDefault: (): void => undefined,
      } as unknown as ReactKeyboardEvent<HTMLDivElement>,
      (widths) => {
        applied.push(widths)
      }
    )

    expect(applied).toEqual([
      { boxes: [], traffic: 840, terminal: 640, console: null, devtools: null },
    ])
  })

  it.each([
    ['the floor its slots need', '1280', 1_280, 680],
    ['the pane’s own floor when the value is unreadable', 'wide', 1_100, 500],
    ['the pane’s own floor when the value is below it', '100', 1_100, 500],
  ])('stops shrinking the terminal pane at %s', (_, declared, terminal, box) => {
    const terminalBox = item('project-terminal-box', 1_600)
    terminalBox.setAttribute('data-min-width', declared)
    const divider = sash()
    row(item('traffic-box', 800), sash(), terminalBox, divider, item('conversation-slot', 500))
    const applied: RowWidths[] = []

    startRowPush(
      press(divider, 1_000),
      (widths) => {
        applied.push(widths)
      },
      (): void => undefined
    )
    moveTo(divider, 500)
    release(divider)

    expect(applied).toEqual([
      { boxes: [box], traffic: 800, terminal, console: null, devtools: null },
    ])
  })
})

describe('nudging a row divider from the keyboard', () => {
  function key(
    target: HTMLDivElement,
    name: string,
    shiftKey: boolean
  ): { readonly event: ReactKeyboardEvent<HTMLDivElement>; readonly prevented: () => boolean } {
    let prevented = false
    const event = {
      key: name,
      shiftKey,
      currentTarget: target,
      preventDefault: () => {
        prevented = true
      },
    } as unknown as ReactKeyboardEvent<HTMLDivElement>
    return { event, prevented: () => prevented }
  }

  it('moves 8px, or 40px with Shift, and claims the key', () => {
    const divider = sash()
    row(
      item('workspace-pane-workbench', 749),
      sash(),
      item('conversation-slot', 700),
      divider,
      item('traffic-box', 800)
    )
    const applied: RowWidths[] = []
    const apply = (widths: RowWidths): void => {
      applied.push(widths)
    }

    const right = key(divider, 'ArrowRight', false)
    stepRow(right.event, apply)
    const left = key(divider, 'ArrowLeft', true)
    stepRow(left.event, apply)

    expect(applied).toEqual([
      { boxes: [708], traffic: 800, terminal: null, console: null, devtools: null },
      { boxes: [660], traffic: 800, terminal: null, console: null, devtools: null },
    ])
    expect(right.prevented()).toBe(true)
    expect(left.prevented()).toBe(true)
  })

  it('widens Traffic instead once the chat is at its minimum', () => {
    const divider = sash()
    row(
      item('workspace-pane-workbench', 749),
      sash(),
      item('conversation-slot', 500),
      divider,
      item('traffic-box', 500)
    )
    const applied: RowWidths[] = []

    stepRow(key(divider, 'ArrowLeft', true).event, (widths) => {
      applied.push(widths)
    })

    expect(applied).toEqual([
      { boxes: [500], traffic: 540, terminal: null, console: null, devtools: null },
    ])
  })

  it('leaves every other key to the page', () => {
    const divider = sash()
    row(item('workspace-pane-workbench', 749), divider, item('conversation-slot', 500))
    const applied: RowWidths[] = []
    const tab = key(divider, 'Tab', false)

    stepRow(tab.event, (widths) => {
      applied.push(widths)
    })

    expect(applied).toEqual([])
    expect(tab.prevented()).toBe(false)
  })
})

describe('swiping along the row', () => {
  function swipe(target: Element, init: WheelEventInit): WheelEvent {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }

  function sideways(clientWidth: number, scrollWidth: number): HTMLDivElement {
    const node = document.createElement('div')
    node.style.overflowX = 'auto'
    Object.defineProperty(node, 'clientWidth', { value: clientWidth, configurable: true })
    Object.defineProperty(node, 'scrollWidth', { value: scrollWidth, configurable: true })
    return node
  }

  it('moves the row for a sideways swipe or Shift-wheel over a chat, and leaves the rest local', () => {
    const transcript = document.createElement('div')
    const scroller = row(transcript)
    const stop = routeRowWheel(scroller, 'pane-1', () => undefined)

    expect(swipe(transcript, { deltaX: 60, deltaY: 4 }).defaultPrevented).toBe(true)
    expect(swipe(transcript, { deltaY: 30, shiftKey: true }).defaultPrevented).toBe(true)
    expect(scroller.scrollLeft).toBe(90)

    expect(swipe(transcript, { deltaY: 80 }).defaultPrevented).toBe(false)
    expect(swipe(transcript, { deltaX: 60, ctrlKey: true }).defaultPrevented).toBe(false)
    expect(scroller.scrollLeft).toBe(90)
    stop()
  })

  it('moves the row even over a traffic pane or code block that could still scroll sideways', () => {
    const request = document.createElement('div')
    const panes = sideways(400, 1_000)
    panes.append(request)
    const code = sideways(300, 900)
    const scroller = row(panes, code)
    let reachedInside = 0
    panes.addEventListener('wheel', () => {
      reachedInside += 1
    })
    const stop = routeRowWheel(scroller, 'pane-1', () => undefined)

    swipe(request, { deltaX: 50 })
    swipe(code, { deltaX: 70 })

    expect(scroller.scrollLeft).toBe(120)
    expect(panes.scrollLeft).toBe(0)
    expect(code.scrollLeft).toBe(0)
    expect(reachedInside).toBe(0)
    stop()
  })

  describe.each(['conversation-dock-tabs', 'terminal-tabs'])('over a .%s strip', (className) => {
    function strip(visible: number, full: number, scrolled: number): HTMLDivElement {
      const node = sideways(visible, full)
      node.className = className
      node.scrollLeft = scrolled
      return node
    }

    it('scrolls the strip toward hidden tabs and keeps the row still', () => {
      const tab = document.createElement('button')
      const tabs = strip(300, 900, 200)
      tabs.append(tab)
      const scroller = row(tabs)
      let reachedInside = 0
      tabs.addEventListener('wheel', () => {
        reachedInside += 1
      })
      const stop = routeRowWheel(scroller, 'pane-1', () => undefined)

      expect(swipe(tab, { deltaX: 40 }).defaultPrevented).toBe(true)
      expect(swipe(tab, { deltaY: 30, shiftKey: true }).defaultPrevented).toBe(true)
      expect(swipe(tab, { deltaX: -50 }).defaultPrevented).toBe(true)

      expect(tabs.scrollLeft).toBe(220)
      expect(scroller.scrollLeft).toBe(0)
      expect(reachedInside).toBe(0)
      stop()
    })

    it('hands the swipe to the row once the strip is at that edge', () => {
      const atEnd = strip(300, 900, 600)
      const atStart = strip(300, 900, 0)
      const scroller = row(atEnd, atStart)
      scroller.scrollLeft = 500
      const stop = routeRowWheel(scroller, 'pane-1', () => undefined)

      expect(swipe(atEnd, { deltaX: 40 }).defaultPrevented).toBe(true)
      expect(swipe(atStart, { deltaX: -70 }).defaultPrevented).toBe(true)

      expect(atEnd.scrollLeft).toBe(600)
      expect(atStart.scrollLeft).toBe(0)
      expect(scroller.scrollLeft).toBe(470)
      stop()
    })

    it('moves the row when every tab already fits', () => {
      const tabs = strip(400, 400, 0)
      const scroller = row(tabs)
      const stop = routeRowWheel(scroller, 'pane-1', () => undefined)

      swipe(tabs, { deltaX: 50 })
      swipe(tabs, { deltaY: 20, shiftKey: true })

      expect(tabs.scrollLeft).toBe(0)
      expect(scroller.scrollLeft).toBe(70)
      stop()
    })

    it('keeps vertical, Ctrl and Meta gestures local', () => {
      const tabs = strip(300, 900, 200)
      const scroller = row(tabs)
      const stop = routeRowWheel(scroller, 'pane-1', () => undefined)

      expect(swipe(tabs, { deltaY: 80 }).defaultPrevented).toBe(false)
      expect(swipe(tabs, { deltaX: 60, ctrlKey: true }).defaultPrevented).toBe(false)
      expect(swipe(tabs, { deltaX: 60, metaKey: true }).defaultPrevented).toBe(false)

      expect(tabs.scrollLeft).toBe(200)
      expect(scroller.scrollLeft).toBe(0)
      stop()
    })
  })

  it('stops routing once it is cleaned up', () => {
    const transcript = document.createElement('div')
    const scroller = row(transcript)
    routeRowWheel(scroller, 'pane-1', () => undefined)()

    expect(swipe(transcript, { deltaX: 60 }).defaultPrevented).toBe(false)
    expect(scroller.scrollLeft).toBe(0)
  })

  describe('the continuous row bridge', () => {
    afterEach(() => {
      configureHostResources()
    })

    it('hands a row swipe to the bridge when it takes it, and scrolls the row when it does not', () => {
      const taken: number[] = []
      let accept = true
      configureHostResources({
        noteImageUrl: (url) => url,
        continuousRow: {
          wheel: (_paneId, delta) => {
            taken.push(delta)
            return accept
          },
          rowMoved: () => undefined,
        },
      })
      const transcript = document.createElement('div')
      const scroller = row(transcript)
      const stop = routeRowWheel(scroller, 'pane-1', () => undefined)

      expect(swipe(transcript, { deltaX: 80 }).defaultPrevented).toBe(true)
      expect(taken).toEqual([80])
      expect(scroller.scrollLeft).toBe(0)

      accept = false
      swipe(transcript, { deltaX: 80 })
      expect(scroller.scrollLeft).toBe(80)
      stop()
    })

    it('marks the project touched before a scroll that arrives from the page', () => {
      const scroller = row(document.createElement('div'))
      let touched = 0
      const stop = routeRowWheel(scroller, 'pane-1', () => {
        touched += 1
      })

      scrollRegisteredRow('pane-1', 120)
      expect(touched).toBe(1)
      expect(scroller.scrollLeft).toBe(120)
      expect(registeredRow('pane-1')?.row).toBe(120)

      stop()
      expect(registeredRow('pane-1')).toBeNull()
    })

    it('gives every registration a new number, so a target for an old row can be told apart', () => {
      const first = routeRowWheel(row(), 'pane-1', () => undefined)
      const before = registeredRow('pane-1')?.registration
      first()
      const second = routeRowWheel(row(), 'pane-1', () => undefined)
      expect(registeredRow('pane-1')?.registration).not.toBe(before)
      second()
    })
  })
})
