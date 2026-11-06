import type { ComponentType } from 'react'
import type { WorkbenchRect } from '../../shared/workbench-ipc.js'

export interface WorkbenchGeometry {
  readonly rect: WorkbenchRect
  readonly layoutWidth: number | undefined
}

export interface PaneWorkbenchProps {
  readonly projectId: string
  readonly active: boolean
  readonly projectRoot: string
  readonly geometry: (host: HTMLElement) => WorkbenchGeometry | null
  readonly onActivityBar: (projectId: string, width: number) => void
  readonly onRevealRow: (projectId: string) => void
  readonly onScrollRow: (projectId: string, delta: number) => void
}

export interface HostViews {
  readonly PaneWorkbench: ComponentType<PaneWorkbenchProps> | null
  readonly Probe: ComponentType | null
}
