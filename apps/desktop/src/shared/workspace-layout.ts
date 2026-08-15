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
/**
 * Matches `--sidebar` in `styles.css`, and the clamp the resize handle uses.
 *
 * Narrowed from 336/240/640 when the drawer stopped being the daily state. It
 * holds names, a search field and one overflow button now — everything that
 * used to need 336px moved to the preview or the menu — and the ceiling is a
 * ceiling because a temporary management panel should not be able to take half
 * the window and stay there. A width persisted from the old range is clamped
 * into this one on the way in.
 */
export const SIDEBAR_WIDTH = { default: 248, min: 220, max: 320 } as const

/**
 * Matches `--terminal-height` and the clamp the panel's grip uses.
 *
 * 212 rather than 240: in a 900px window the panel sits between a transcript
 * and a composer that is itself 180px, and 240 left the transcript with less
 * room than the two things framing it. 212 holds ten lines of shell output at
 * the terminal's own size, which is what the approved composition shows.
 */
export const TERMINAL_HEIGHT = { default: 212, min: 96, max: 720 } as const

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
   * warning on `WorkspaceSnapshot` below: a required field here sends
   * `parseOpenSessions` down a legacy path that also fails, and it returns
   * `{ sessions: [] }` — every open conversation gone, once, silently, with no
   * error anywhere. `open-sessions.test.ts` carries a fixture per defaulted
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
  globalTerminal: TerminalPanelState.default(CLOSED_TERMINAL_PANEL),
})
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>
