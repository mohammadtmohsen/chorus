# Sticky current turn

Keep the latest user message in view as the anchor for the answer being written,
with each waiting agent's existing `agent · thinking…` row directly beneath it.

Status: **awaiting approval.** No implementation code has been written for this
behavior.

---

## 1. Interaction contract

- The most recent user message is the current turn. It becomes the sticky row at
  the top of that session's transcript and remains the current turn until the
  next user message is sent.
- A working agent that has not started writing yet keeps the existing visual:
  its name, voice dot, `thinking`, and breathing dots. That row sits immediately
  below the sticky user message and sticks with it.
- The thinking row retains its current truthful lifetime: it disappears when
  the agent's first visible output arrives. The user row remains sticky while
  the reply continues.
- With two agents waiting, their thinking rows stack beneath the same user
  message in participant/event order.
- Scrolling back into older history is still respected. The UI must not pull the
  reader back to the current turn until they send another message or return to
  the live end themselves.
- Sending the next message transfers the sticky state to that new row; no older
  user message remains sticky.

## 2. Implementation

### Phase 1 — Current-turn structure and scroll anchor

In `Session.tsx`, split the rendered transcript at its final user message:

- earlier entries remain ordinary transcript rows;
- the final user entry and the entries after it form a current-turn block;
- the final user entry and waiting-agent rows share one sticky header inside
  that block;
- the current-turn block has at least one transcript viewport of height, giving
  the new user row enough room to reach the top immediately instead of waiting
  for a long answer to create scroll space.

Keep the existing bottom-follow behavior for live output and its opt-out when
the reader scrolls upward. When a new user event appears while following, move
the scroller to the new current-turn anchor even if the transcript's total
height happens not to change.

### Phase 2 — Sticky presentation

In `styles.css`:

- pin the combined current-turn header to the transcript's top edge;
- give it the pane's opaque background so older content cannot show through;
- redraw the voice rail through the sticky header so the line and dots remain
  aligned with the screenshots;
- preserve the narrow layout where the rail moves to the compact gutter;
- avoid horizontal overflow with long or wrapped user messages.

No new copy is needed; the existing translated `thinking` label is reused.

### Phase 3 — Regression coverage and verification

Add an Electron end-to-end regression that sends two addressed messages and
checks:

1. the first user row becomes the sticky current-turn header;
2. `CODEX · thinking…` appears directly below it while Codex is waiting;
3. long output scrolls beneath the pinned user row without breaking bottom
   following;
4. manual scroll-back is not overridden;
5. the second user message takes over and the first loses sticky status;
6. the layout remains contained at the normal width and at the 390px narrow
   width.

Run `pnpm run check`, the focused Electron spec, and a live visual pass covering
idle, thinking, streaming, complete, scroll-back, and the second-message handoff.

---

## 3. Files in scope

- `apps/desktop/src/renderer/src/Session.tsx`
- `apps/desktop/src/renderer/src/styles.css`
- `apps/desktop/e2e/specs.mjs`
- `docs/plans/sticky-current-turn-2026-08-05/STATUS.md` as phases complete

The existing uncommitted app-version changes in `App.tsx` and `styles.css` are
preserved; they are not part of this behavior.

## 4. Edge cases

- No user message yet: keep the existing ordinary transcript and footer
  thinking indicator.
- Restored conversations: reconstruct the current turn from the event-derived
  transcript without adding new persisted state.
- Two agents working: stack both waiting rows without overlap.
- A command or notice before prose: it remains below the sticky turn header in
  chronological order.
- A wrapped user message: the sticky header grows naturally, and every thinking
  row stays below its measured height because both live in the same container.
- Reduced motion: breathing dots retain the existing non-animated fallback.
