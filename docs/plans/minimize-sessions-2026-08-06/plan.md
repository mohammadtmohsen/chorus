# Minimize sessions

Let a developer keep one or two conversations on stage and send the rest to the
wings — still running, still watched, but costing the renderer nothing.

## The problem

`App` renders every open session as a live `Session` pane. A pane is not cheap:
it holds the whole reduced transcript in state, re-renders on every streamed
token, runs a typewriter, renders markdown and syntax highlighting for the full
history, keeps two `ResizeObserver`s, a `selectionchange` listener, and its own
`onEvents` subscription that filters the global stream. Four of those at once is
four transcripts painting while you read one.

Worse, it is four transcripts painting while you *think*. The grid caps at four
columns, so a fifth session has nowhere to go — the only way to reduce the noise
today is to End a session, which kills the agent and loses the thread.

So the feature is not "hide a pane". It is: **stop paying for a session you are
not reading, without stopping the session.**

## The shape

Minimized sessions collapse into **the wings** — a slim strip below the grid,
one chip per session: name, agent dots, status, and a badge when something is
waiting on you. Click a chip to bring it back on stage.

```
┌──────────────────────────────────────┐
│  Chorus                    [New] [⚙] │
├───────────────────┬──────────────────┤
│                   │                  │
│   chorus (claude) │  example-app (codex) │
│                   │                  │
│   ● on stage      │  ● on stage      │
│                   │                  │
├───────────────────┴──────────────────┤
│ ▣ api-contract ●working  ▣ docs ⚠2   │  ← the wings
└──────────────────────────────────────┘
```

Named the wings, not the dock: `.dock` already means the strip inside a pane
holding the composer and approval cards, and the app's vocabulary is already
theatrical — the stage, the score, the voice rail. A session in the wings is off
stage and about to come back on, which is exactly the state being described.

Bottom rather than a left rail: the panes are short of *horizontal* space, not
vertical — the grid already steps 4→3→2→1 columns as the window narrows.

### Three states, not two

| State | Agents | Renderer cost | How you get there |
|---|---|---|---|
| On stage | running | full pane | default; click a chip |
| In the wings | **running** | one chip | the — button, or Focus |
| Ended | stopped | nothing | the ✕ button |

Minimize is a *view* decision and nothing else: no interrupt, no process
teardown, no `sessionRef` churn. The distinction from End has to be legible in
the UI or people will avoid the feature for fear of losing work.

## How it actually saves anything

**Unmount, don't hide.** `display: none` keeps the React tree, the observers,
the typewriter's `requestAnimationFrame` loop, and the per-pane event reducer
all alive — it saves paint and nothing else. Removing `<Session>` from the tree
drops all of it.

That is only safe because of two things already true in this codebase:

1. The transcript is not owned by the component. `Session` rebuilds `view` from
   `window.chorus.history({ conversationId })` on mount (`Session.tsx:171`), so
   an unmounted transcript is recoverable from the event store, not lost.
2. `conversation:history` already accepts `afterSeq` (`shared/ipc.ts:292`).

So restore is O(events you missed), not O(whole conversation) — provided we keep
the last reduced view.

**What must survive the unmount.** This is the one real correctness risk, and
skipping it makes the feature feel lossy:

- `draft` — half-typed message
- `attached` — files staged but not sent
- `view` — the reduced transcript, so restore is instant and incremental

These get carried in an `App`-level `useRef(new Map<string, Carry>())`. `Session`
keeps a `latest` ref updated on each render (plain assignment, no effect, no
re-render) and writes it into the map from its unmount cleanup. On remount it
seeds from the carry, then asks only for `afterSeq: view.lastSeq`. Closing a
session deletes its entry.

Bonus: this also fixes a latent bug — Restart currently discards a typed draft.

**The chips still need to be live**, but cheaply. `App` gains a single
`onEvents` subscription reducing to a tiny per-conversation `Pulse`:

```ts
interface Pulse {
  lastSeq: number
  unread: number        // messages since it went to the wings
  working: boolean
  waiting: number       // approvals + questions blocking
}
```

No message bodies, no markdown, no highlighting. One subscription for all
minimized sessions instead of one per pane.

### What we are not doing

- **No auto-minimize past N sessions.** Rearranging your workspace on your
  behalf is the thing that makes tiling managers annoying.
- **No auto-restore when an agent needs you.** A minimized session that hits an
  approval turns its chip amber, pulses, and counts what is waiting — but it
  does not pop back and rearrange the grid while you are mid-sentence in another
  pane. Not being interrupted is the entire point of minimizing. (Revisit as a
  Settings toggle if it turns out people miss approvals.)
- **No minimizing the last session on stage.** Guarded the way `canClose` is.

## Phases

### Phase 1 — Layout state and persistence (no UI)

- `OpenSession` gains `minimized: z.boolean().default(false)` in
  `main/open-sessions.ts`. `.default()` keeps existing `open-sessions.json`
  files parsing, so nobody's grid resets on upgrade.
- Replace `conversation:reorder { order }` with `conversation:layout
  { order, minimized: string[] }` — order and minimized change together and a
  single channel means a single write. Update `shared/ipc.ts`, `main/ipc.ts`,
  `preload/index.ts`, `runtime.ts`.
- `App` holds `minimized: Set<string>`; `restoreConversations` seeds it.
- `data-count` on the grid becomes the count of **on-stage** sessions.
- Unit tests: zod back-compat on an old file, layout round-trip.

### Phase 2 — The wings, and the carry

- `—` button in `.pane-title-actions`, before ↻ and ✕. Glyph only, with both
  `aria-label` and `title`, matching the existing pair.
- New `Wings.tsx`: the strip, chips as `<button>`s, `role="toolbar"`.
- `.wings` / `.wing-chip` in `styles.css`, following the existing container-query
  and `data-*` conventions. Hidden entirely when nothing is minimized.
- The carry map: `draft`, `attached`, `view` across unmount; `afterSeq` restore.
- i18n keys under `conversation.minimizeLabel`, `wings.*` — nothing hard-coded.

### Phase 3 — The pulse

- `pulse.ts`: a pure reducer, `(Pulse, events) => Pulse`, unit-tested the way
  `transcript.ts` is.
- One `onEvents` subscription in `App` feeding it.
- Chips show working / unread count / amber `waiting` badge. Unread clears on
  restore.

### Phase 4 — Focus, keyboard, verification

- **Focus** action on a pane: minimize every other session in one click. This is
  the actual ask — "let me focus on one or two and minimize the rest" — and
  doing it one ✕ at a time is the version people won't use.
- Keyboard: chips reachable by Tab; consider ⌘1…⌘9 to bring a session on stage,
  matching the ⌥←/⌥→ reorder precedent.
- Prefers-reduced-motion respected on the collapse, like the FLIP reorder.
- e2e in `apps/desktop/e2e/specs.mjs`: minimize drops `.pane` count and adds a
  chip; the agent keeps working while minimized; restore brings back the
  transcript **and** an unsent draft.
- Measure before/after: renderer CPU with 4 sessions streaming, 2 minimized.

## Open questions for review

1. Wings at the bottom, or a left rail? (Recommending bottom — horizontal space
   is the scarce one.)
2. Badge-only on attention, or auto-restore? (Recommending badge-only.)
3. Should Focus be a button on the pane, or ⌥-click on the minimize button?
