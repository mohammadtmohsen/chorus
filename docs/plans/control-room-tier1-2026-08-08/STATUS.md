# Status

## Phase 1 done: Notifications and the dock badge

Chorus can now say something when you are not looking at it. Before this, a turn
that finished in another project was invisible unless its pane was on screen.

**Changed**

- `apps/desktop/src/renderer/src/notify.ts` (new) — `noticesFrom`, `shouldRaise`,
  `trackPending`, `roomsWaiting`. Pure, so what deserves an interruption is
  testable and arguable.
- `apps/desktop/src/renderer/src/App.tsx` — a second `onEvents` subscription
  beside the pulse one, plus `raise()`.
- `apps/desktop/src/shared/ipc.ts`, `main/ipc.ts`, `preload/index.ts` —
  `app:setBadge` and `app:focus`.
- `i18n/en.json` — `notify.*`.

**The plan was wrong and the plan has been corrected.** It put this in the main
process and settled for notifying when the window was unfocused. That is only
half the condition: a conversation in an inactive tab is unseen even when Chorus
is frontmost, and that is the exact case the feature exists for. Only the
renderer knows which tab is active, and it is also the only side with a
translator. Main kept the two things genuinely its own — `app.setBadgeCount` and
bringing the window forward.

**What it will and will not interrupt you for**

| Event                                      | Banner                      |
| ------------------------------------------ | --------------------------- |
| Approval or question raised                | Yes — the agent is blocked  |
| Turn completed                             | Yes                         |
| Turn failed, or an unrecoverable error     | Yes                         |
| Turn interrupted by the user               | No — you pressed the button |
| Recoverable error (the supervisor retries) | No                          |
| Messages, deltas, tool calls, notices      | No                          |

One banner per conversation per push, most urgent reason winning, and `tag` set
to the conversation id so a room that finishes twice replaces its own notice
rather than stacking. Clicking focuses the window and opens that conversation.

The badge counts **rooms**, not requests: the question it answers is "how many
need me". Pending requests are tracked by id rather than counted, because a
request and its answer arrive in separate pushes and a counter cannot tell a
second question from a replayed first.

**Verification** — full `pnpm run check` green: 18 typecheck tasks, eslint,
prettier, **865 tests**. Fifteen new, all against the pure module.

**Not verified in the running app.** Needs a real turn finishing while another
pane is active, and macOS notification permission granted to the built app.
Worth checking that the packaged build gets permission at all — an unsigned dev
build sometimes does not, and the failure is silent by design here.

## Phase 2 — Persist unread

Not started.

## Phase 3 — Reopen an ended conversation

Not started.

## Phase 4 — Make "project" real

Not started.
