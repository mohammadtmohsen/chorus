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
  /** Tab ids, in the order their tabs appear in this pane. */
  tabs: z.array(z.string()),
  activeTabId: z.string().nullable(),
})
export type WorkspacePane = z.infer<typeof WorkspacePane>

/**
 * Renderer-owned workspace state that is safe to write beside the open-session
 * note. It contains no transcript or draft content.
 */
/**
 * Matches `--sidebar` in `styles.css`, and the clamp the resize handle uses.
 *
 * There is no ceiling: the drawer takes whatever width it is dragged to. The
 * floor is only there to stop a persisted or dragged value collapsing it to
 * nothing, since the width comes from a file a person can edit.
 */
export const SIDEBAR_WIDTH = { default: 248, min: 100 } as const

export const EDITOR_WIDTH = { defaultOffset: 500, min: 500, maxFraction: 1 } as const

export const BOX_WIDTH = { default: 500, min: 500 } as const

export const CONSOLE_WIDTH = { default: 500, min: 500 } as const

export const DEVTOOLS_WIDTH = { default: 600, min: 400 } as const

export const GIT_WIDTH = { default: 520, min: 380 } as const

export const TRAFFIC_WIDTH = { default: 700, min: 500 } as const

export const PROJECT_TERMINAL_WIDTH = { default: 500, min: 480, run: 480, slot: 320 } as const

/**
 * How big a note is, as fractions of the window. Both notes, one set of bounds.
 *
 * Fractions rather than pixels, unlike its three neighbours here, and the
 * difference is what each one is measured against. A sidebar and a divider live
 * inside a layout that reflows around them, so a pixel width stays meaningful at
 * any window size. A note is drawn over the window, so the only thing its size
 * means anything relative to *is* the window — and a stored pixel count would
 * reopen wider than the screen on a smaller display.
 *
 * **The window even for a project's note, which floats over a column rather than
 * over the app.** Measuring that one against its column would be the more
 * obvious answer and is the wrong one: the column's width is itself dragged, so
 * a note stored as a fraction of it would change size when the panes moved. The
 * window is the one frame both notes share and the only one that holds still.
 * What keeps that note inside its column is a `max-width` in CSS, which costs
 * nothing and cannot disagree with the layout.
 *
 * Ceilings, unlike its neighbours, because there is nothing on the other side of
 * these to stop at. A divider dragged too far leaves a squeezed editor that is
 * still visibly there; a note dragged to the far edge covers the app with no
 * visible handle to pull it back from.
 *
 * `height` has no default on purpose. Never dragged means "as tall as it needs
 * to be, up to the cap the stylesheet sets" — a number here would replace that
 * with a fixed box for everyone who has never asked for one.
 */
export const NOTE_SIZE = {
  width: { default: 0.25, min: 0.25, max: 0.9 },
  height: { min: 0.08, max: 0.9 },
} as const

/**
 * Matches `--terminal-height` and the clamp the panel's grip uses.
 *
 * 212 rather than 240: in a 900px window the panel sits between a transcript
 * and a composer that is itself 180px, and 240 left the transcript with less
 * room than the two things framing it. 212 holds ten lines of shell output at
 * the terminal's own size, which is what the approved composition shows.
 */
export const TERMINAL_HEIGHT = { default: 212, min: 100 } as const

/**
 * One terminal in a panel's roster. **Not the shell** — that lives in main.
 *
 * An object rather than a bare id string, and that is a deliberate hedge rather
 * than speculative generality: every field added later is defaulted and
 * therefore cheap, but changing an array's *element type* from `string` to an
 * object is the migration that is not. One field now is the shape that extends.
 *
 * `id` is permissive on purpose — see `normalizeTerminalPanel`. A stricter
 * schema would reject a hand-edited or duplicated roster, and a rejected
 * `WorkspaceSnapshot` does not lose the roster, it loses **every open
 * conversation**. Duplicates and blanks are repaired, never refused.
 */
export const TerminalTab = z.object({ id: z.string() })
export type TerminalTab = z.infer<typeof TerminalTab>

/** One panel's visibility, size and roster. Not the shells — those are in main. */
export const TerminalPanelState = z.object({
  open: z.boolean().default(false),
  height: z.number().default(TERMINAL_HEIGHT.default),
  /*
   * Which terminals this panel holds, in tab order.
   *
   * **Defaulted, and this is the line that can lose someone's work.** See the
   * warning on `WorkspaceSnapshot` below: a required field here makes
   * `parseOpenProjects` reject the whole envelope, and it returns
   * `{ projects: [] }` — every open conversation gone, once, silently, with no
   * error anywhere. `open-projects.test.ts` carries a fixture per defaulted
   * field for exactly this reason.
   *
   * A panel written before the roster existed parses to `[]` and is backfilled
   * one tab by `normalizeTerminalPanel` in the renderer — main only applies
   * schema defaults and does not repair.
   */
  tabs: z.array(TerminalTab).default([]),
  /** Which of `tabs` is on screen. Repaired, not trusted, when it names none. */
  activeId: z.string().nullable().default(null),
})
export type TerminalPanelState = z.infer<typeof TerminalPanelState>

/**
 * A panel nobody has opened yet.
 *
 * Exported and shared, because it used to be copied into `store.ts` and
 * `hooks.ts` as well — three literals of the same shape, in three files, and the
 * roster had to be added to all of them. One definition beside the schema it
 * mirrors is one place for the next field to land.
 *
 * Frozen so a consumer cannot mutate the shared default: it is handed out as the
 * fallback for *every* conversation with no panel, so a stray write would give
 * all of them the same one.
 */
export const CLOSED_TERMINAL_PANEL: TerminalPanelState = Object.freeze({
  open: false,
  height: TERMINAL_HEIGHT.default,
  tabs: [],
  activeId: null,
})

export const WEB_TABS_MAX = 100

export const WebTab = z.object({ id: z.string() })
export type WebTab = z.infer<typeof WebTab>

export const WebTabsState = z.object({
  tabs: z.array(WebTab).default([]),
  activeId: z.string().nullable().default(null),
  showing: z.boolean().default(false),
})
export type WebTabsState = z.infer<typeof WebTabsState>

export const NO_WEB_TABS: WebTabsState = Object.freeze({
  tabs: [],
  activeId: null,
  showing: false,
})

export const TrafficPanelState = z.object({
  open: z.boolean(),
  width: z.number(),
  widthCustomized: z.boolean().optional(),
  collapsed: z.boolean().optional(),
  hiddenPathPrefix: z.string().optional(),
})
export type TrafficPanelState = z.infer<typeof TrafficPanelState>

export const DevtoolsPanelState = z.object({
  width: z.number(),
  collapsed: z.boolean(),
})
export type DevtoolsPanelState = z.infer<typeof DevtoolsPanelState>

export const GitPanelState = z.object({
  width: z.number(),
  collapsed: z.boolean(),
})
export type GitPanelState = z.infer<typeof GitPanelState>

export const MAIN_PROJECT_SHELL = 'main'

export const ProjectTerminalPaneState = z.object({
  width: z.number(),
  shells: z.array(TerminalTab).default(() => [{ id: MAIN_PROJECT_SHELL }]),
  collapsed: z.boolean().optional(),
})
export type ProjectTerminalPaneState = z.infer<typeof ProjectTerminalPaneState>

/**
 * How one project arranges its conversations, and it is **the same shape as the
 * workspace's own pane tree**.
 *
 * It began as a row of at most two groups, which was enough for "two side by
 * side" and nothing else. The instruction that replaced it was "exactly the same
 * as project level, from all directions" — and the only way to guarantee two
 * behaviours are identical is for them to be one behaviour. So this is a
 * `layout` / `panes` / `focusedPaneId` triple, structurally a `PaneTree`, and
 * every operation on it is the function the outer level already uses.
 *
 * **A "pane" here is a conversation group.** The word means "a container of tabs
 * in a tree" at both levels — the same sense VS Code uses for editor groups —
 * which is why nothing is renamed: a function that splits a tree does not care
 * what its leaves hold.
 *
 * Absent means "never arranged". `reconcileConversationGroups` builds the
 * default from the live conversation list, so a project nobody has split has no
 * entry and cannot drift out of step with what is running.
 */
export const ConversationArrangement = z.object({
  layout: WorkspaceLayoutNode.nullable(),
  panes: z.record(z.string(), WorkspacePane),
  focusedPaneId: z.string().nullable(),
  widths: z.record(z.string(), z.number()).optional(),
})
export type ConversationArrangement = z.infer<typeof ConversationArrangement>

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
   * `parseOpenProjects` returns `{ projects: [] }` when this schema fails, so a
   * required field here loses **every open conversation**, not merely the
   * layout, once, with no error anywhere. `sidebarWidth` above is the precedent
   * and carries the same warning for the same reason.
   *
   * The trap got sharper rather than softer when the file changed. The old
   * parser had a legacy bare-array fallback, which was itself no use — it failed
   * too — but its existence at least suggested a second chance. There is no
   * fallback now, by design, so a schema failure is final on the first attempt.
   *
   * Separate fields rather than one map keyed by conversation id, matching
   * `TerminalService` in main and the store in the renderer: the global panel
   * belongs to no conversation, and anything walking sessions must not reach it.
   */
  terminals: z.record(z.string(), TerminalPanelState).default({}),
  globalTerminal: TerminalPanelState.default(CLOSED_TERMINAL_PANEL),
  /**
   * How each project arranges its conversations inside its own Chorus column.
   *
   * The outer layout is a tree of panes keyed by project. This is one level
   * further in: a project's conversations, which until now were a strip of
   * chips where exactly one was on screen. Splitting here puts two of them side
   * by side **sharing the project's one editor** — the workbench is per project
   * and stays whole, so no second `WebContentsView` and no second REH
   * connection.
   *
   * **A row of at most two groups, not a tree**, and that is a decision rather
   * than a first step. The column has a 300px minimum and lives beside an
   * editor, so two is what actually fits; arbitrary nesting already exists one
   * level out, where a pane can be split four ways. A third conversation side by
   * side is expressible today — split the *pane* — and it is the right level for
   * it, because at that point you want two editors too.
   *
   * Absent means "never arranged", and it is not the same as a single empty
   * group: `reconcileConversationGroups` builds the default arrangement from the
   * live conversation list, so a project nobody has split has no entry at all
   * and cannot drift out of step with what is actually running.
   *
   * Defaulted, under the same warning as every field above: a required record
   * here would make `parseOpenProjects` reject the snapshot and lose every open
   * conversation, not merely an arrangement.
   */
  conversationGroups: z.record(z.string(), ConversationArrangement).default({}),
  trafficPanels: z.record(z.string(), TrafficPanelState).default({}),
  devtoolsPanels: z.record(z.string(), DevtoolsPanelState).default({}),
  gitPanels: z.record(z.string(), GitPanelState).default({}),
  projectTerminals: z.record(z.string(), ProjectTerminalPaneState).default({}),
  collapsedBrowsers: z.record(z.string(), z.boolean()).default({}),
  collapsedWebsites: z.record(z.string(), z.boolean()).default({}),
  rowScroll: z.record(z.string(), z.number()).default({}),
  editorWidthFractions: z.record(z.string(), z.number()).default({}),
  consoleWidths: z.record(z.string(), z.number()).default({}),
  webTabs: WebTabsState.default(NO_WEB_TABS),
})
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>

export const ReturnSlot = z.object({ paneId: z.string(), index: z.number().int().nonnegative() })
export type ReturnSlot = z.infer<typeof ReturnSlot>

export const ProjectLayoutSlice = z.object({
  conversationGroups: ConversationArrangement.optional(),
  trafficPanel: TrafficPanelState.optional(),
  devtoolsPanel: DevtoolsPanelState.optional(),
  gitPanel: GitPanelState.optional(),
  projectTerminal: ProjectTerminalPaneState.optional(),
  browserCollapsed: z.boolean().optional(),
  websiteCollapsed: z.boolean().optional(),
  rowScroll: z.number().optional(),
  editorWidthFraction: z.number().optional(),
  consoleWidth: z.number().optional(),
})
export type ProjectLayoutSlice = z.infer<typeof ProjectLayoutSlice>
