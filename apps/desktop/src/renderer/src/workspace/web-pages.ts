import { useCallback, type MouseEvent } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { BROWSER_HOME_URL } from '../../../shared/browser-ipc.js'
import { isSafeHref } from '../../../shared/markdown.js'
import { useHostCapabilities } from '../host-context.js'
import type {
  BrowserAction,
  BrowserDownloads,
  BrowserPasswordPrompt,
  BrowserPasswords,
  BrowserPush,
  BrowserSettingsStatus,
  BrowserState,
  BrowserWebCommand,
} from '../../../shared/browser-ipc.js'
import { WEB_TABS_MAX } from '../../../shared/workspace-layout.js'
import { useWorkspaceStore } from './store.js'

export interface WebPage {
  readonly browserId: string | null
  readonly state: BrowserState | null
  readonly settings: BrowserSettingsStatus
  readonly prompt: BrowserPasswordPrompt | null
  readonly passwords: BrowserPasswords | null
  readonly found: { readonly matches: number; readonly active: number } | null
  readonly revision: number
  readonly failed: boolean
  readonly pendingAddress: string | null
  readonly focus: 'address' | 'find' | null
  readonly focusRequest: number
  readonly findText: string
}

interface WebPages {
  readonly pages: Readonly<Record<string, WebPage>>
  readonly downloads: BrowserDownloads
}

const EMPTY_PAGE: WebPage = Object.freeze({
  browserId: null,
  state: null,
  settings: 'ready',
  prompt: null,
  passwords: null,
  found: null,
  revision: 0,
  failed: false,
  pendingAddress: null,
  focus: null,
  focusRequest: 0,
  findText: '',
})

const useWebPagesStore = create<WebPages>(() => ({ pages: {}, downloads: [] }))
const pending = new Map<string, Promise<void>>()
let commitLayout: () => void = () => undefined

export function useWebPageStates(): Readonly<Record<string, BrowserState | null>> {
  return useWebPagesStore(
    useShallow((state: WebPages) =>
      Object.fromEntries(Object.entries(state.pages).map(([id, page]) => [id, page.state]))
    )
  )
}

export function useWebPage(id: string): WebPage {
  return useWebPagesStore((state) => state.pages[id] ?? EMPTY_PAGE)
}

export function useBrowserDownloads(): BrowserDownloads {
  return useWebPagesStore((state) => state.downloads)
}

export function updateBrowserDownloads(downloads: BrowserDownloads): void {
  useWebPagesStore.setState({ downloads })
}

export function updateWebPage(id: string, change: Partial<WebPage>): void {
  if (!useWorkspaceStore.getState().webTabs.tabs.some((tab) => tab.id === id)) return
  useWebPagesStore.setState((state) => ({
    pages: { ...state.pages, [id]: { ...(state.pages[id] ?? EMPTY_PAGE), ...change } },
  }))
}

export function clearWebPrompt(id: string, candidateId: string): void {
  if (useWebPagesStore.getState().pages[id]?.prompt?.candidateId === candidateId) {
    updateWebPage(id, { prompt: null })
  }
}

export function openLink(address: string, inWebTab: boolean): void {
  if (!isSafeHref(address)) return
  if (inWebTab) {
    const added = useWorkspaceStore.getState().addWebTab(true)
    if (added !== '') {
      updateWebPage(added, { pendingAddress: address })
      return
    }
  }
  window.open(address, '_blank', 'noopener,noreferrer')
}

export function useOpenLink(): (event: MouseEvent<HTMLAnchorElement>) => void {
  const inWebTab = useHostCapabilities().nativeBrowserViews
  return useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      openLink(event.currentTarget.href, inWebTab)
    },
    [inWebTab]
  )
}

export function nextWebRevision(id: string): number {
  const revision = (useWebPagesStore.getState().pages[id]?.revision ?? 0) + 1
  updateWebPage(id, { revision })
  return revision
}

export function attachWebPage(id: string): Promise<void> {
  const waiting = pending.get(id)
  if (waiting !== undefined) return waiting
  if (useWebPagesStore.getState().pages[id]?.browserId != null) return Promise.resolve()
  updateWebPage(id, { failed: false })
  const attaching = window.chorus
    .attachBrowser({ webTabId: id })
    .then((reply) => {
      if (!useWorkspaceStore.getState().webTabs.tabs.some((tab) => tab.id === id)) {
        return window.chorus
          .closeBrowser({ browserId: reply.browserId, index: 0 })
          .then(() => undefined)
      }
      updateWebPage(id, {
        browserId: reply.browserId,
        state: reply.state,
        settings: reply.settings,
        failed: false,
      })
      const address = useWebPagesStore.getState().pages[id]?.pendingAddress ?? null
      if (address !== null) {
        updateWebPage(id, { pendingAddress: null })
        return window.chorus
          .navigateBrowser({ browserId: reply.browserId, address })
          .then((navigated) => {
            if (useWebPagesStore.getState().pages[id]?.browserId !== reply.browserId) return
            updateWebPage(id, { state: navigated.state })
          })
          .catch(() => undefined)
      }
      return undefined
    })
    .catch(() => {
      updateWebPage(id, { failed: true })
    })
    .finally(() => {
      if (pending.get(id) === attaching) pending.delete(id)
    })
  pending.set(id, attaching)
  return attaching
}

export function actOnWebPage(id: string, action: BrowserAction): void {
  const browserId = useWebPagesStore.getState().pages[id]?.browserId
  if (browserId == null) return
  window.chorus
    .actOnBrowser({ browserId, action })
    .then((reply) => {
      if (useWebPagesStore.getState().pages[id]?.browserId !== browserId) return
      updateWebPage(id, { state: reply.state })
    })
    .catch(() => undefined)
}

export function findWebPage(id: string, forward: boolean, start: boolean): void {
  const page = useWebPagesStore.getState().pages[id]
  if (page?.browserId == null || page.findText.length === 0) return
  window.chorus
    .findInBrowser({
      browserId: page.browserId,
      text: page.findText,
      forward,
      start,
    })
    .catch(() => undefined)
}

export function runWebCommand(command: BrowserWebCommand): void {
  const state = useWorkspaceStore.getState()
  const roster = state.webTabs
  const id = roster.activeId
  if (command === 'new-tab') {
    const added = state.addWebTab(true)
    if (added !== '') {
      updateWebPage(added, { pendingAddress: BROWSER_HOME_URL, focus: 'address', focusRequest: 1 })
    }
    return
  }
  if (command === 'reopen-tab') {
    if (roster.tabs.length >= WEB_TABS_MAX) return
    window.chorus
      .reopenBrowser()
      .then(({ reopened }) => {
        if (reopened === null) return
        const current = useWorkspaceStore.getState()
        if (current.webTabs.tabs.length >= WEB_TABS_MAX) {
          window.chorus
            .attachBrowser({ webTabId: reopened.webTabId })
            .then(({ browserId }) =>
              window.chorus.closeBrowser({ browserId, index: reopened.index })
            )
            .catch(() => undefined)
          return
        }
        current.insertWebTab(reopened.webTabId, reopened.index, true)
        updateWebPage(reopened.webTabId, { state: reopened.state })
      })
      .catch(() => undefined)
    return
  }
  if (!roster.showing || id === null) return
  if (command === 'close-tab') {
    state.closeWebTab(id)
    return
  }
  if (command === 'move-tab-left' || command === 'move-tab-right') {
    const index = roster.tabs.findIndex((tab) => tab.id === id)
    state.moveWebTab(id, index + (command === 'move-tab-left' ? -1 : 1))
    return
  }
  if (command === 'next-tab' || command === 'previous-tab') {
    const index = roster.tabs.findIndex((tab) => tab.id === id)
    const next =
      roster.tabs[
        (index + (command === 'next-tab' ? 1 : -1) + roster.tabs.length) % roster.tabs.length
      ]
    if (next !== undefined) {
      state.activateWebTab(next.id)
    }
    return
  }
  if (command === 'focus-address' || command === 'find') {
    const page = useWebPagesStore.getState().pages[id] ?? EMPTY_PAGE
    updateWebPage(id, {
      focus: command === 'find' ? 'find' : 'address',
      focusRequest: page.focusRequest + 1,
    })
    return
  }
  if (command === 'find-next' || command === 'find-previous') {
    findWebPage(id, command === 'find-next', false)
    return
  }
  actOnWebPage(id, command === 'back' ? 'back' : 'forward')
}

function receive(push: BrowserPush): void {
  if (push.kind === 'downloads') {
    useWebPagesStore.setState({ downloads: push.downloads })
    return
  }
  if (push.kind === 'tab-open') {
    const state = useWorkspaceStore.getState()
    const roster = state.webTabs.tabs
    if (roster.length >= WEB_TABS_MAX) {
      window.chorus.closeBrowser({ browserId: push.browserId, index: 0 }).catch(() => undefined)
      return
    }
    const opener = roster.findIndex((tab) => tab.id === push.openerWebTabId)
    state.insertWebTab(push.webTabId, opener < 0 ? roster.length : opener + 1, !push.background)
    updateWebPage(push.webTabId, { browserId: push.browserId, state: push.state })
    return
  }
  const entry = Object.entries(useWebPagesStore.getState().pages).find(
    ([, page]) => page.browserId === push.browserId
  )
  if (entry === undefined) return
  const [id] = entry
  switch (push.kind) {
    case 'state':
      updateWebPage(id, { state: push.state })
      break
    case 'prompt':
      updateWebPage(id, { prompt: push.prompt })
      break
    case 'passwords':
      updateWebPage(id, { passwords: push.passwords })
      break
    case 'found':
      updateWebPage(id, { found: { matches: push.matches, active: push.active } })
      break
    case 'command':
      runWebCommand(push.command)
      break
    case 'favorites':
    case 'devtools':
    case 'devtools-row-wheel':
    case 'row-wheel':
    case 'select':
    case 'dialog':
      break
  }
}

export function startWebPages(commit: () => void): () => void {
  commitLayout = commit
  let announced = false
  const announce = (): void => {
    if (announced) return
    announced = true
    window.chorus.announceWebReady().catch(() => undefined)
  }
  const sync = (
    tabs: readonly { readonly id: string }[],
    previous: readonly { readonly id: string }[]
  ): void => {
    const ids = new Set(tabs.map((tab) => tab.id))
    const pages = useWebPagesStore.getState().pages
    previous.forEach((tab, index) => {
      if (ids.has(tab.id)) return
      const browserId = pages[tab.id]?.browserId
      if (browserId != null) {
        window.chorus.closeBrowser({ browserId, index }).catch(() => undefined)
      }
    })
    useWebPagesStore.setState({
      pages: Object.fromEntries(Object.entries(pages).filter(([id]) => ids.has(id))),
    })
    for (const tab of tabs) void attachWebPage(tab.id)
  }
  const unsubscribeBrowser = window.chorus.onBrowser(receive)
  const unsubscribeRoster = useWorkspaceStore.subscribe(
    (state) => ({ webTabs: state.webTabs, hydrated: state.hydrated }),
    (current, previous) => {
      if (!current.hydrated) return
      if (!previous.hydrated || current.webTabs.tabs !== previous.webTabs.tabs) {
        sync(current.webTabs.tabs, previous.webTabs.tabs)
      }
      announce()
      if (previous.hydrated && current.webTabs !== previous.webTabs) commitLayout()
    },
    {
      equalityFn: (left, right) =>
        left.webTabs === right.webTabs && left.hydrated === right.hydrated,
    }
  )
  const current = useWorkspaceStore.getState()
  if (current.hydrated) {
    sync(current.webTabs.tabs, [])
    announce()
  }
  window.chorus
    .readBrowserDownloads()
    .then(({ downloads }) => {
      useWebPagesStore.setState({ downloads })
    })
    .catch(() => undefined)
  return () => {
    unsubscribeBrowser()
    unsubscribeRoster()
  }
}
