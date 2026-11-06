import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ChorusApi } from '../../shared/ipc.js'
import type { WindowRole } from '../../shared/detached-window-ipc.js'
import type { HostCapabilities } from '../../shared/host-capabilities.js'
import { App } from './App.js'
import { HostContext } from './host-context.js'
import type { HostViews } from './host-views.js'
import { configureHostStorage, type HostStorage } from './host-storage.js'
import './i18n/index.js'

/*
 * The emulator's own stylesheet, before ours.
 *
 * xterm ships the rules that make its rows and cursor lay out at all; loading it
 * first is what lets `styles.css` override the parts that are ours — the surface
 * it sits on and the space around it.
 */
import '@xterm/xterm/css/xterm.css'
import './styles.css'

export interface MountAppOptions {
  readonly api: ChorusApi
  readonly role?: WindowRole
  readonly capabilities: HostCapabilities
  readonly views?: HostViews
  readonly storage?: HostStorage
}

export function mountApp(container: HTMLElement, options: MountAppOptions): Root {
  if (window.chorus !== options.api)
    Object.defineProperty(window, 'chorus', { value: options.api, configurable: true })
  configureHostStorage(options.storage)
  const capabilities = options.capabilities
  const views = options.views ?? { PaneWorkbench: null, Probe: null }
  const Probe = views.Probe
  const root = createRoot(container)
  root.render(
    <StrictMode>
      <HostContext.Provider value={{ capabilities, views }}>
        <App role={options.role ?? { kind: 'main' }} />
        {/*
         * Beside `App`, not inside it. `App` returns early for a restoring shell and
         * for one with no sessions, and the containment probe has to be reachable in
         * both — a gate you can only get to once the app is fully up is a gate that
         * cannot report on a broken one.
         */}
        {Probe !== null && <Probe />}
      </HostContext.Provider>
    </StrictMode>
  )
  return root
}
