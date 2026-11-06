import { WorkbenchProbe } from './workbench/WorkbenchProbe.js'
import { PaneWorkbench } from './workspace/PaneWorkbench.js'
import type { HostViews } from './host-views.js'

export const desktopHostViews: HostViews = { PaneWorkbench, Probe: WorkbenchProbe }
