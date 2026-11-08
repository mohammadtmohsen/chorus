import { useShellOverlay } from './overlay.js'
import { useToastWindow } from '../useToastWindow.js'
import { HostContext } from '../host-context.js'
import { DESKTOP_CAPABILITIES } from '../../../shared/host-capabilities.js'
/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationArrangement } from '../../../shared/workspace-layout.js'
import type { SessionInfo } from '../Session.js'
import { EditorPane } from './EditorPane.js'
import { useWorkspaceStore } from './store.js'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('./PaneTabStrip.js', () => ({ PaneTabStrip: () => null }))
vi.mock('./PaneWorkbench.js', () => ({ PaneWorkbench: () => null }))
vi.mock('../BrowserPanel.js', () => ({ BrowserPanel: () => null }))
vi.mock('./ProjectNotes.js', () => ({ ProjectNotes: () => null }))
vi.mock('../TrafficPanel.js', () => ({ TrafficPanel: () => null }))
vi.mock('../GitPanel.js', () => ({ GitPanel: () => null }))
vi.mock('../ProjectTerminalPane.js', () => ({ ProjectTerminalPane: () => null }))
vi.mock('./hooks.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTrafficLive: () => false,
  useProjectRun: () => null,
}))

class FakeObserver {
  observe(): void {
    return undefined
  }

  disconnect(): void {
    return undefined
  }
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', FakeObserver)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  cleanup()
})

const session = (conversationId: string): SessionInfo => ({
  conversationId,
  participants: ['claude'],
  projectId: 'p1',
  cwd: '/tmp/p1',
  profileId: 'read-only',
  title: conversationId,
})

const twoColumns: ConversationArrangement = {
  layout: {
    kind: 'branch',
    orientation: 'row',
    children: [
      { kind: 'leaf', paneId: 'g1' },
      { kind: 'leaf', paneId: 'g2' },
    ],
    sizes: [1, 1],
  },
  panes: {
    g1: { id: 'g1', tabs: ['source'], activeTabId: 'source' },
    g2: { id: 'g2', tabs: ['replacement'], activeTabId: 'replacement' },
  },
  focusedPaneId: 'g2',
}

function Chat(props: { readonly conversationId: string }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  return (
    <textarea
      data-chat={props.conversationId}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
      }}
    />
  )
}

const props = (sessions: readonly SessionInfo[]): ComponentProps<typeof EditorPane> => ({
  paneId: 'pane-1',
  node: { kind: 'leaf', paneId: 'pane-1' },
  path: [],
  sessions: new Map(sessions.map((each) => [each.conversationId, each])),
  focusedPaneId: 'pane-1',
  drag: null,
  onTabPointerDown: () => undefined,
  consumeSuppressedClick: () => false,
  onStartInProject: () => undefined,
  onEndConversation: () => undefined,
  onActivate: () => undefined,
  onFocus: () => undefined,
  onClose: () => undefined,
  onReorder: () => undefined,
  onRename: () => undefined,
  projects: [],
  onRenameProject: () => undefined,
  onSetProjectNotes: () => undefined,
  onSetProjectNoteSize: () => undefined,
  onSendProjectNoteSelection: () => undefined,
  onCommitLayout: () => undefined,
  renderSession: (each) => <Chat key={each.conversationId} conversationId={each.conversationId} />,
  trafficTerminals: [],
})

const chat = (container: HTMLElement, conversationId: string): HTMLTextAreaElement | null =>
  container.querySelector<HTMLTextAreaElement>(`textarea[data-chat="${conversationId}"]`)

beforeEach(() => {
  useWorkspaceStore.setState({
    panes: { 'pane-1': { id: 'pane-1', tabs: ['p1'], activeTabId: 'p1' } },
    focusedPaneId: 'pane-1',
    conversationGroups: { p1: twoColumns },
    editorWidthFractions: {},
    rowScroll: {},
  })
})

describe('the editor resize control', () => {
  it('resizes through the saved project width and resets to the default width', () => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_000 })
    try {
      const settings = props([session('source'), session('replacement')])
      const commit = vi.fn()
      const view = render(<EditorPane {...settings} onCommitLayout={commit} />)
      const divider = view.container.querySelector<HTMLElement>('[data-editor-resize]')
      const editor = view.container.querySelector<HTMLElement>('.workspace-pane-workbench')
      const row = view.container.querySelector<HTMLElement>('.conversation-scroller')
      if (divider === null || editor === null || row === null) {
        throw new Error('the editor is not drawn')
      }
      const groups = useWorkspaceStore.getState().conversationGroups

      expect(divider.getAttribute('aria-valuenow')).toBe('500')
      expect(divider.getAttribute('aria-valuemax')).toBe('1000')
      expect(row.scrollLeft).toBe(500)
      expect(editor.style.flexBasis).toBe('997px')
      fireEvent.keyDown(divider, { key: 'End' })
      fireEvent.keyUp(divider, { key: 'End' })
      expect(useWorkspaceStore.getState().editorWidthFractions['p1']).toBe(1)
      expect(useWorkspaceStore.getState().conversationGroups).toBe(groups)
      expect(divider.getAttribute('aria-valuenow')).toBe('1000')
      expect(editor.style.flexBasis).toBe('997px')
      expect(row.scrollLeft).toBe(0)
      expect(commit).toHaveBeenCalledTimes(1)

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
      fireEvent(window, new Event('resize'))
      expect(divider.getAttribute('aria-valuemax')).toBe('800')
      expect(divider.getAttribute('aria-valuenow')).toBe('800')
      expect(editor.style.flexBasis).toBe('797px')

      fireEvent.doubleClick(divider)
      expect(useWorkspaceStore.getState().editorWidthFractions['p1']).toBeUndefined()
      expect(divider.getAttribute('aria-valuenow')).toBe('500')
      expect(editor.style.flexBasis).toBe('797px')
      expect(row.scrollLeft).toBe(300)
      expect(commit).toHaveBeenCalledTimes(2)
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
  })

  it('keeps the first chat fully visible at the default and after resetting a narrower pane', () => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2_000 })
    let paneWidth = 1_880
    const measuredWidth = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('workspace-pane-content')) return paneWidth
        if (this.classList.contains('conversation-scroller')) return paneWidth - 3
        return 0
      })
    try {
      const commit = vi.fn()
      const view = render(
        <EditorPane
          {...props([session('source'), session('replacement')])}
          onCommitLayout={commit}
        />
      )
      const divider = view.container.querySelector<HTMLElement>('[data-editor-resize]')
      const editor = view.container.querySelector<HTMLElement>('.workspace-pane-workbench')
      const row = view.container.querySelector<HTMLElement>('.conversation-scroller')
      const firstChat = view.container.querySelector<HTMLElement>('.conversation-slot')
      const typed = chat(view.container, 'source')
      if (
        divider === null ||
        editor === null ||
        row === null ||
        firstChat === null ||
        typed === null
      ) {
        throw new Error('the editor and first chat are not drawn')
      }
      const firstChatRight = (): number =>
        Number.parseFloat(editor.style.flexBasis) +
        Number.parseFloat(divider.style.flexBasis) +
        Number.parseFloat(firstChat.style.flexBasis) -
        row.scrollLeft

      expect(divider.getAttribute('aria-valuenow')).toBe('1371')
      expect(firstChatRight()).toBe(row.clientWidth)
      fireEvent.change(typed, { target: { value: 'draft preserved after reset' } })
      fireEvent.keyDown(divider, { key: 'End' })
      fireEvent.keyUp(divider, { key: 'End' })
      expect(divider.getAttribute('aria-valuenow')).toBe('2000')
      expect(row.scrollLeft).toBe(0)

      fireEvent.doubleClick(divider)
      expect(divider.getAttribute('aria-valuenow')).toBe('1371')
      expect(row.scrollLeft).toBe(629)
      expect(firstChatRight()).toBe(row.clientWidth)
      expect(useWorkspaceStore.getState().editorWidthFractions['p1']).toBeUndefined()
      expect(useWorkspaceStore.getState().rowScroll['p1']).toBe(0)
      expect(chat(view.container, 'source')).toBe(typed)
      expect(typed.value).toBe('draft preserved after reset')
      expect(commit).toHaveBeenCalledTimes(2)

      paneWidth = 1_480
      fireEvent(window, new Event('resize'))
      expect(divider.getAttribute('aria-valuenow')).toBe('971')
      expect(firstChatRight()).toBe(row.clientWidth)
    } finally {
      measuredWidth.mockRestore()
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
  })

  it('scrolls back to the full editor and resizes from that position without remounting chats', () => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_000 })
    try {
      const commit = vi.fn()
      const view = render(
        <EditorPane
          {...props([session('source'), session('replacement')])}
          onCommitLayout={commit}
        />
      )
      const divider = view.container.querySelector<HTMLElement>('[data-editor-resize]')
      const row = view.container.querySelector<HTMLElement>('.conversation-scroller')
      const typed = chat(view.container, 'source')
      if (divider === null || row === null || typed === null) {
        throw new Error('the project row is not drawn')
      }
      fireEvent.change(typed, { target: { value: 'draft preserved while scrolling' } })
      expect(row.scrollLeft).toBe(500)
      fireEvent.wheel(row, { deltaX: -500, deltaY: 0 })
      fireEvent.scroll(row)
      expect(row.scrollLeft).toBe(0)
      expect(divider.getAttribute('aria-valuenow')).toBe('1000')
      expect(useWorkspaceStore.getState().rowScroll['p1']).toBe(-500)
      expect(useWorkspaceStore.getState().editorWidthFractions['p1']).toBeUndefined()
      expect(chat(view.container, 'source')).toBe(typed)
      expect(typed.value).toBe('draft preserved while scrolling')

      fireEvent.keyDown(divider, { key: 'ArrowLeft' })
      fireEvent.keyUp(divider, { key: 'ArrowLeft' })
      expect(divider.getAttribute('aria-valuenow')).toBe('992')
      expect(row.scrollLeft).toBe(8)
      expect(useWorkspaceStore.getState().editorWidthFractions['p1']).toBe(0.992)
      expect(useWorkspaceStore.getState().rowScroll['p1']).toBe(0)
      expect(commit).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
  })
})

describe('a project row losing the column to the left of a chat', () => {
  it('keeps the chat on the right mounted, with what was typed in it', () => {
    const view = render(<EditorPane {...props([session('source'), session('replacement')])} />)
    const typed = chat(view.container, 'replacement')
    if (typed === null) throw new Error('the replacement chat is not drawn')
    fireEvent.change(typed, { target: { value: 'restart draft kept through boot' } })
    typed.setSelectionRange(4, 10)

    act(() => {
      useWorkspaceStore.getState().removeSession('source')
    })
    view.rerender(<EditorPane {...props([session('replacement')])} />)

    expect(useWorkspaceStore.getState().conversationGroups['p1']?.layout).toEqual({
      kind: 'leaf',
      paneId: 'g2',
    })
    expect(chat(view.container, 'source')).toBeNull()
    expect(chat(view.container, 'replacement')).toBe(typed)
    expect(typed.value).toBe('restart draft kept through boot')
    expect(typed.selectionStart).toBe(4)
    expect(typed.selectionEnd).toBe(10)
  })
})

it('starts the extension row at its first chat without an editor prefix', () => {
  const settings = props([session('source'), session('replacement')])
  const view = render(
    <HostContext.Provider
      value={{
        capabilities: { ...DESKTOP_CAPABILITIES, embeddedEditor: false, nativeBrowserViews: false },
        views: { PaneWorkbench: null, Probe: null },
      }}
    >
      <EditorPane {...settings} />
    </HostContext.Provider>
  )
  expect(view.container.querySelector('.workspace-pane-workbench')).toBeNull()
  expect(view.container.querySelector('.workspace-pane-gutter')).toBeNull()
  expect(view.container.querySelector('[data-editor-resize]')).toBeNull()
  expect(view.container.querySelector('.browser-box')).not.toBeNull()
  const row = view.container.querySelector<HTMLElement>('.conversation-scroller')
  expect(row?.scrollLeft).toBe(0)
})

it('keeps overlays and toast popups inside a host without native views', () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'chorus')
  const visible = vi.fn(() => Promise.resolve({ stills: [] }))
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  Object.defineProperty(window, 'chorus', {
    configurable: true,
    value: { setWorkbenchVisible: visible },
  })
  const hook = renderHook(
    () => {
      useShellOverlay(true)
      return useToastWindow(true, () => undefined)
    },
    {
      wrapper: ({ children }) => (
        <HostContext.Provider
          value={{
            capabilities: {
              ...DESKTOP_CAPABILITIES,
              embeddedEditor: false,
              nativeBrowserViews: false,
            },
            views: { PaneWorkbench: null, Probe: null },
          }}
        >
          {children}
        </HostContext.Provider>
      ),
    }
  )
  try {
    expect(open).not.toHaveBeenCalled()
    expect(visible).not.toHaveBeenCalled()
  } finally {
    hook.unmount()
    open.mockRestore()
    if (descriptor === undefined) Reflect.deleteProperty(window, 'chorus')
    else Object.defineProperty(window, 'chorus', descriptor)
  }
})
