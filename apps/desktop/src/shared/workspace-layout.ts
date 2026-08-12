import { z } from 'zod'

/** A leaf is one editor group; branches describe how groups divide the workspace. */
export type WorkspaceLayoutNode =
  | { kind: 'leaf'; paneId: string }
  | {
      kind: 'branch'
      orientation: 'row' | 'column'
      children: WorkspaceLayoutNode[]
      sizes: number[]
    }

export const WorkspaceLayoutNode: z.ZodType<WorkspaceLayoutNode> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal('leaf'), paneId: z.string() }),
    z.object({
      kind: z.literal('branch'),
      orientation: z.enum(['row', 'column']),
      children: z.array(WorkspaceLayoutNode),
      sizes: z.array(z.number()),
    }),
  ])
)

export const WorkspacePane = z.object({
  id: z.string(),
  /** Conversation ids, in the order their tabs appear in this pane. */
  tabs: z.array(z.string()),
  activeTabId: z.string().nullable(),
})
export type WorkspacePane = z.infer<typeof WorkspacePane>

/**
 * Renderer-owned workspace state that is safe to write beside the open-session
 * note. It contains no transcript or draft content.
 */
/** Matches `--sidebar` in `styles.css`, and the clamp the resize handle uses. */
export const SIDEBAR_WIDTH = { default: 336, min: 240, max: 640 } as const

/** Matches `--terminal-height` and the clamp the panel's grip uses. */
export const TERMINAL_HEIGHT = { default: 240, min: 96, max: 720 } as const

/** One panel's visibility and size. Not the shell — that lives in main. */
export const TerminalPanelState = z.object({
  open: z.boolean().default(false),
  height: z.number().default(TERMINAL_HEIGHT.default),
})
export type TerminalPanelState = z.infer<typeof TerminalPanelState>

const CLOSED_PANEL: TerminalPanelState = { open: false, height: TERMINAL_HEIGHT.default }

export const WorkspaceSnapshot = z.object({
  layout: WorkspaceLayoutNode.nullable(),
  panes: z.record(z.string(), WorkspacePane),
  focusedPaneId: z.string().nullable(),
  sidebarHidden: z.boolean().default(false),
  /*
   * Defaulted rather than required, so a workspace written before the sidebar
   * could be resized still parses and simply opens at the width it had.
   */
  sidebarWidth: z.number().default(SIDEBAR_WIDTH.default),
  /*
   * Both defaulted, and this is the sharpest trap in the file.
   *
   * `parseOpenSessions` falls through to a legacy bare-array parse when this
   * schema fails, and that fails too — so it returns `{ sessions: [] }` and
   * **every open conversation is silently lost**, not merely the layout. A
   * required field here would do that to everyone who upgraded, once, with no
   * error anywhere. `sidebarWidth` above is the precedent and carries the same
   * warning for the same reason.
   *
   * Separate fields rather than one map keyed by conversation id, matching
   * `TerminalService` in main and the store in the renderer: the global panel
   * belongs to no conversation, and anything walking sessions must not reach it.
   */
  terminals: z.record(z.string(), TerminalPanelState).default({}),
  globalTerminal: TerminalPanelState.default(CLOSED_PANEL),
})
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>
