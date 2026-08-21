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

/**
 * Matches `--changes-height` and the clamp the panel's grip uses.
 *
 * Taller than the terminal's 212 because the content is two columns — a file
 * list beside a diff — and a diff worth reading is more than ten lines. The
 * ceiling is the same: a panel must not be able to take the whole window and
 * stay there.
 */
export const CHANGES_HEIGHT = { default: 320, min: 140, max: 780 } as const

/**
 * Matches `--changes-width` and the clamp the panel's side grip uses.
 *
 * Only consulted when the panel is beside the transcript rather than under it.
 *
 * The default is wide enough to hold the panel's *own* two columns — a file
 * list beside a diff — because that is the shape the panel has in both
 * layouts. An earlier default of 420 was not, and the first answer to that was
 * to stack the list above the code when the panel was narrow, which traded the
 * feature for something that merely rendered. The floor is set the same way:
 * below 360 there is no arrangement of a list and a diff worth showing.
 *
 * **The ceiling was 820 and is now 1180**, because 820 was quietly deciding
 * something else: Monaco's `renderSideBySideInlineBreakpoint` is 900, so a
 * panel that could never exceed 820 could never show a side-by-side diff at
 * all — the setting was correct and permanently inert. Past 900 it starts
 * working on its own, which is what its comment in `MonacoDiff` predicted.
 */
export const CHANGES_WIDTH = { default: 560, min: 360, max: 1180 } as const

/**
 * How wide the file list is, inside the panel.
 *
 * Fixed at 240px until 2026-08-21, which truncated almost every path in a real
 * project — `specs.m…`, `runt…`, `theme.…`. A file list whose filenames cannot
 * be read is a list of status letters.
 *
 * A ceiling as well as a floor, because the two columns are read against each
 * other: past this the diff is the one being squeezed, and the diff is the half
 * that cannot be truncated.
 */
export const CHANGES_LIST = { default: 260, min: 160, max: 560 } as const

/**
 * How wide a pane has to be before the Changes panel moves beside the
 * transcript instead of under it.
 *
 * Measured on the *pane*, never the window — `.pane` is already an inline-size
 * container for exactly this reason: three panes on a wide screen are each as
 * cramped as one pane on a narrow one, so a window-width test would put a
 * 300px-wide pane into a side-by-side layout.
 *
 * Read it with the two numbers below rather than on its own: it is
 * `CHANGES_WIDTH.default + TRANSCRIPT_MIN_WIDTH`, rounded up — so it moved with
 * them when the transcript's floor came down. Side-by-side
 * turns on at the width where the panel can open at its full size *and* leave
 * a readable transcript — not one pixel earlier, because a layout that arrives
 * already squeezed is one people turn back off.
 */
export const PANE_SIDE_BY_SIDE_MIN = 880

/**
 * What the transcript keeps, whatever the panel does.
 *
 * Enforced twice on purpose. The grip clamps against it so a drag cannot cross
 * it, and `.changes-panel[data-orientation='side']` carries it as a
 * `max-width` so a *stored* width from a wider pane cannot either — the case
 * the drag clamp never sees, because nobody dragged anything.
 *
 * **Lowered from 420 to 320 on 2026-08-21**, to give the editor room. 420 was
 * chosen for the transcript alone; it is a floor, not a target, and the panel
 * beside it was hitting that floor long before it ran out of useful width. The
 * CSS mirror `--transcript-min` has to move with it or the two clamps disagree
 * — and the one that disagrees silently is the CSS, because nobody dragged
 * anything to trigger the other.
 */
export const TRANSCRIPT_MIN_WIDTH = 320

/**
 * One conversation's Changes panel: visibility, size, and what it compares
 * against.
 *
 * **Every field defaulted**, and that is not tidiness — see the warning on
 * `WorkspaceSnapshot` below. A required field here sends `parseOpenSessions`
 * down a legacy path that also fails, and every open conversation is lost,
 * once, silently. `terminals` above carries the same warning for the same
 * reason.
 */
export const ChangesPanelState = z.object({
  open: z.boolean().default(false),
  height: z.number().default(CHANGES_HEIGHT.default),
  /**
   * How wide the panel is when it sits *beside* the transcript.
   *
   * A second number rather than one size reused in both layouts, because the
   * two are measured along different axes and a person sets them for different
   * reasons: a height is "how much diff do I want under the conversation", a
   * width is "how much of the pane is review". Carrying one value between them
   * would mean widening the panel and finding the stacked layout had changed
   * height behind your back.
   */
  width: z.number().default(CHANGES_WIDTH.default),
  /**
   * The branch to compare against, or null for the working tree.
   *
   * Persisted, because the answer is stable per session — a branch cut from
   * `develop` is reviewed against `develop` every time — and re-picking it on
   * every relaunch is the kind of small friction that stops people using a
   * panel at all.
   */
  base: z.string().nullable().default(null),
  /** Committed work only, hiding what is not pushed yet. */
  committedOnly: z.boolean().default(false),
  /** Which file is showing. A path that no longer changed falls back to the first. */
  selectedPath: z.string().nullable().default(null),
  /**
   * The hunks git printed, or whole files in an editor.
   *
   * **Defaults to `hunks`, and that is a measured decision rather than a
   * preference.** It defaulted to `editor` until Monaco's cost was priced: on a
   * shared panel-open-to-content-ready boundary, ten paired runs put Monaco at
   * a median 270 ms against the hunks viewer's 137 ms — **+156 ms, with every
   * pair in the same direction**. Reviewing a change is what the panel is for,
   * and paying that on every open for a view most opens do not need is the
   * trade the measurement rejects.
   *
   * `editor` stays one click away and is the better view for what it is for:
   * whole-file navigation, intra-line detail, folding and `⌘S`. It is an
   * opt-in, not a fallback — and `FileDiff` is correspondingly not a fallback
   * either, which is why it is the default and not merely kept alive.
   *
   * **A persisted `'editor'` is never migrated.** It may be a deliberate
   * choice, and this schema cannot tell that apart from an old default. Only
   * profiles with no stored value take the new one, so on any machine with
   * existing conversations this change looks like it did nothing — which is
   * also exactly what a broken implementation would look like. See
   * `docs/plans/the-editor-you-already-know-2026-08-20/plan.md`.
   */
  view: z.enum(['editor', 'hunks']).default('hunks'),
  /**
   * The file list's width, dragged from the divider between the columns.
   *
   * `.default(...)` for the reason this file warns about at the top: a required
   * field silently loses every open conversation, because the parse fails and
   * the whole panel falls back.
   */
  listWidth: z.number().default(CHANGES_LIST.default),
  /**
   * Which list the left column shows: what changed, or the whole project.
   *
   * `changed` stays the default — the panel is for reviewing a change, and the
   * tree is how you reach the file that explains one.
   */
  column: z.enum(['changed', 'tree']).default('changed'),
  /**
   * Which directories are expanded, repo-relative.
   *
   * Persisted, because collapsing a deep tree again on every relaunch is the
   * kind of friction that stops people opening it. Bounded in
   * `normalizeChangesPanel` rather than here: a schema can only reject, and
   * rejecting this costs every open conversation.
   */
  expanded: z.array(z.string()).default([]),
})
export type ChangesPanelState = z.infer<typeof ChangesPanelState>

/**
 * A Changes panel nobody has opened.
 *
 * Frozen and shared, like `CLOSED_TERMINAL_PANEL`: it is handed out as the
 * fallback for every conversation without one, so a stray write would give all
 * of them the same panel.
 */
export const CLOSED_CHANGES_PANEL: ChangesPanelState = Object.freeze({
  open: false,
  height: CHANGES_HEIGHT.default,
  width: CHANGES_WIDTH.default,
  base: null,
  committedOnly: false,
  selectedPath: null,
  // Must track the schema default above, or a panel nobody has opened and a
  // panel parsed from `{}` would disagree about which view they are in.
  view: 'hunks',
  listWidth: CHANGES_LIST.default,
  column: 'changed',
  expanded: [],
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
  /*
   * Defaulted, under the same warning as `terminals` directly above — this is
   * the third field to land here and the reason the warning is written down.
   *
   * Keyed by conversation like `terminals`, and for the same reason: a change is
   * a property of one project's repository. There is no global equivalent,
   * because there is no repository that belongs to no conversation.
   */
  changes: z.record(z.string(), ChangesPanelState).default({}),
})
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>
