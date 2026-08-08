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

## Phase 2 done: Persist unread

Relaunching no longer claims nothing happened while you were away.

**Changed**

- `apps/desktop/src/shared/unread.ts` (new) — `UNREAD_EVENT_TYPES`,
  `countsAsUnread`.
- `apps/desktop/src/main/open-sessions.ts` — `lastSeenSeq`, defaulted.
- `apps/desktop/src/main/runtime.ts` — `lastSeenSeq` on `ActiveConversation`,
  `markSeen`, `unreadSince`; `unread` in the restore payload.
- `shared/ipc.ts`, `main/ipc.ts`, `preload/index.ts` —
  `conversation:markSeen`.
- `renderer/src/App.tsx` — debounced watermark reporting.
- `renderer/src/workspace/store.ts` — `hydrate` seeds unread; the reducer now
  uses the shared list.

**The design decision: store a watermark, not a count.**

The plan said "add `unread` per session". Persisting the number would have been
smaller and wrong — a stored count can disagree with the transcript underneath
it and there is no way to tell which is lying. What is persisted instead is
`lastSeenSeq`, the point a card had been read to, and the count is derived by
asking the log how many noteworthy events came after it. The log is the thing
that actually knows what happened, so the two cannot drift.

That is also why `UNREAD_EVENT_TYPES` is in `shared/`: the renderer counts these
live as pushes arrive and the main process counts the same ones back out of the
log at launch. Two lists would mean a card that says 3 before a restart and 5
after it. A test pins the list.

**Three smaller calls**

1. The watermark comes from the **event batch**, not from the store. Two
   subscribers read the same push and their order is undefined, so the pulse may
   not have folded them yet; what is in hand cannot be stale.
2. Reporting is debounced a second. `open-sessions.json` is rewritten whole on
   every `markSeen`, and a streaming turn would otherwise trigger one per push.
   Worst case of losing one is a card that overstates by one.
3. A new conversation seeds its watermark at `store.lastSeq()`, not zero.
   Starting at zero would count the entire existing database as news.

**Verification** — full `pnpm run check` green: 18 typecheck tasks, eslint,
prettier, **871 tests**. Six new.

Two existing `open-sessions` tests changed: old files now parse with
`lastSeenSeq: 0`, which is the back-compat default working. Their assertions say
so rather than being loosened.

**Not verified in the running app.** Needs a turn to finish in a background tab,
then a relaunch — the card should come back with a count on it.

## Phase 3 — Reopen an ended conversation

Not started.

## Phase 4 — Make "project" real

Not started.
