import { createContext, useContext } from 'react'
import { DESKTOP_CAPABILITIES, type HostCapabilities } from '../../shared/host-capabilities.js'
import type { HostViews } from './host-views.js'

export interface HostEnvironment {
  readonly capabilities: HostCapabilities
  readonly views: HostViews
}

export const HostContext = createContext<HostEnvironment>({
  capabilities: DESKTOP_CAPABILITIES,
  views: { PaneWorkbench: null, Probe: null },
})

export function useHostEnvironment(): HostEnvironment {
  return useContext(HostContext)
}

export function useHostCapabilities(): HostCapabilities {
  return useHostEnvironment().capabilities
}
