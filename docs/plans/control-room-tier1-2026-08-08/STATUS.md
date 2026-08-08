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

## Phase 3 done: Reopen an ended conversation

Ending a conversation no longer loses it. Its transcript always stayed in SQLite;
what was missing was anything that could name it.

**Changed**

- `packages/event-store/src/store.ts` — `listConversations`,
  `ConversationSummary`.
- `apps/desktop/src/main/runtime.ts` — `listConversations` (marking the open
  ones) and `reopenConversation`.
- `shared/ipc.ts`, `main/ipc.ts`, `preload/index.ts` — `conversation:list`,
  `conversation:reopen`.
- `renderer/src/HistoryPanel.tsx` (new) — the sheet.
- `renderer/src/App.tsx` — `openFromHistory`.
- `renderer/src/workspace/Workspace.tsx`, `styles.css`, `en.json` — the button
  beside the sidebar search.

**Corrected while building: reopening restarts the agents.** The plan said show
only the transcript and treat joining an agent as a separate act. A read-only
transcript is a mode `Session` does not have — it assumes participants, a
composer, an approval dock — and more to the point, the reason to go looking for
an ended conversation is to pick it back up. Landing somewhere you cannot reply
is a dead end that needs a second action.

So it reuses the existing `reopen` path: agents **started, not resumed** (the
provider threads died with the session, and resuming a forgotten id is the one
call that hangs without failing), reading the transcript as catch-up on the first
thing asked. Permissions return to the default rather than to whatever the
conversation last ran under — restoring week-old permissions silently is not a
thing to do on a click.

**Four smaller calls**

1. The list is a projection query. `conversations.updated_at` is already touched
   by every append, so "what was I working on" is one indexed read.
2. `cwd` comes from the most recent `agent_sessions` row, falling back to
   `project_id` — a `project.changed` event can move a conversation, and a room
   nobody ever started an agent in still knows where it was created.
3. Rows are already-open aware. Choosing one that is on screen focuses it rather
   than asking the runtime to start a second set of agents.
4. Relative times are fixed when the sheet opens, so rows do not re-time
   themselves while being read.

**Verification** — full `pnpm run check` green: 18 typecheck tasks, eslint,
prettier, **876 tests**. Five new, against the store query.

One trap worth recording: `openFromHistory` was first written above
`updateSessions`, and a `useCallback` dependency array is evaluated during render
— so it would have thrown a TDZ `ReferenceError` on first paint. Typecheck did
not catch it; reading the order did.

**Not verified in the running app.** Needs a conversation ended and then reopened
from the sheet, with a message sent afterwards to confirm the agent actually read
the transcript it came back to.

## Phase 4 — Make "project" real

Not started.

## Phase 4 — Make "project" real

Not started.
