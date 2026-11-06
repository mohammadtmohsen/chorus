import type { PaneWorkbenchProps } from '../host-views.js'
import { useState } from 'react'
import { WorkbenchFrame } from '../workbench/WorkbenchFrame.js'

/**
 * One project's workbench, mounted for **every** tab in the pane rather than
 * only the active one.
 *
 * **This is the terminal rule, one level further out.** `WorkbenchFrame` already
 * documents that unmounting it closes the surface — a whole `WebContents`
 * destroyed, every open file lost, a reload on the way back. Switching
 * project *tabs* had no such protection: the frame was rendered once for
 * `pane.activeTabId` and keyed on it, so changing tabs changed the key and React
 * tore the surface down and built a new one. Every switch paid a full workbench
 * boot, which on a cold cache is a download, a 257 MB extraction and a server
 * spawn. Reported as "the editor behaves like unmount and remount", which is
 * exactly what it was.
 *
 * So the frames are keyed by project and all of them stay mounted; only the
 * active one is visible, and switching is a compositing change. **The cost is
 * real and is accepted rather than unnoticed**: one live `WebContentsView` per
 * open project, on a memory ceiling the plan still owes as a number (R7/R11).
 * Chosen for two or three open projects; if that grows into eight, this is the
 * decision to revisit, and a bounded cache is the shape it would take.
 *
 * It is a component rather than a loop body because the failure message
 * belongs to the project that failed. Holding the error here rather than in the
 * pane also fixes a mislabelling the pane's own comment warned about — a
 * background surface that refused used to write its message into whatever
 * project happened to be on screen.
 */
export function PaneWorkbench(props: PaneWorkbenchProps): React.JSX.Element {
  const [failure, setFailure] = useState<string | null>(null)
  return (
    /*
     * `hidden` on the slot, not on the frame's own element. The attribute is what
     * takes the inactive surfaces out of layout — without it every mounted frame
     * would claim its share of the region and the visible one would be a
     * fraction of the pane.
     */
    <div className="workspace-pane-workbench-slot" hidden={!props.active}>
      <WorkbenchFrame
        target={{ projectId: props.projectId }}
        /* Displayed only, and any of the project's conversations answers it —
           they all share one root, which is what a project is. */
        projectRoot={props.projectRoot}
        hidden={!props.active}
        geometry={props.geometry}
        onActivityBar={(width) => {
          props.onActivityBar(props.projectId, width)
        }}
        onRevealRow={() => {
          props.onRevealRow(props.projectId)
        }}
        onScrollRow={(delta) => {
          props.onScrollRow(props.projectId, delta)
        }}
        onFailed={setFailure}
      />
      {failure !== null && <p className="workspace-pane-workbench-error">{failure}</p>}
    </div>
  )
}
