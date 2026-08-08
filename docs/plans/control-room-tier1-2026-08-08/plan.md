# Control room, tier 1

Chorus already runs any number of agents across any number of projects at once,
and keeps every one of them working while you read a different pane. What it
cannot do is tell you about any of it when you are not looking at it.

## The problem

The engine is a control room; the shell is a window. Four gaps, and they share a
shape — each one is a fact Chorus already holds and does not surface.

1. **Nothing leaves the window.** `grep` for `Notification`, `setBadgeCount`,
   `flashFrame` across `apps/desktop/src/main` returns nothing. A turn that
   finishes in another project is invisible unless Chorus is on screen, which
   defeats the premise: the reason to run four agents is to not watch four
   agents.
2. **Unread is amnesiac.** `SessionPulse` lives in memory and `hydrate` seeds
   every conversation to `EMPTY_PULSE`, so every relaunch says nothing happened
   while you were away.
3. **A conversation cannot be reopened.** `conversation:history` fetches one by
   id, and no channel lists them. Press End and the transcript stays in SQLite
   forever, unreachable.
4. **"Project" is not modelled.** `migrations.ts:35-41` creates a `projects`
   table that is never written to — grep finds exactly one reference, the
   `CREATE TABLE`. `conversations.project_id` holds a raw cwd, and
   `StartConversationOptions.projectId` is dead code no caller passes.

## Phases

Ordered by how much each one changes what the app can be used for, not by size.

### Phase 1 — Say something when Chorus is not on screen

OS notifications and a dock badge, off the existing event push.

**Corrected while building: this belongs in the renderer, not main.** The first
draft of this plan put it in the main process and settled for "notify when the
window is unfocused". That condition is only half right — a conversation sitting
in an inactive tab is unseen even when Chorus is frontmost, and that is precisely
the case the feature exists for. Only the renderer knows which tab that is, and
it is also the only side with a translator. Main keeps just the two things that
are genuinely its own: `app.setBadgeCount` and bringing the window forward.

- A pure `notify.ts`: `noticesFrom(events)`, `shouldRaise`, `trackPending`,
  `roomsWaiting` — so the decision of _what is worth interrupting for_ is
  testable without Electron or a window.
- Raise when **you cannot see it**: the window is unfocused, or the conversation
  is not the active tab of any pane.
- Three things are worth interrupting for: an agent is **waiting** on you
  (approval or question), an agent **finished**, an agent **failed**. Deltas,
  tool calls and notices are not. A turn _you_ interrupted is not news either.
- One banner per moment per conversation, most urgent reason winning. A finished
  turn arrives alongside its lifecycle and usage events, and three banners for
  one moment is how people turn notifications off.
- Clicking focuses the window **and opens that conversation**. A notification
  that drops you where you already were is a second thing to do rather than the
  thing done.
- Dock badge counts conversations with something waiting, not messages. The
  question it answers is "how many rooms need me".

### Phase 2 — Remember what happened while you were away

Persist the unread count so relaunching does not erase it.

`open-sessions.json` is the honest home: it already exists to answer "what did
the user have on screen", is versioned, and is explicitly _not_ derived from the
log. Add `unread` per session, written where `rememberOpen` already writes.

### Phase 3 — Reopen a conversation that was ended

- `conversation:list` — id, title, cwd, last activity, agents, whether ended.
  A projection query, not a log scan.
- A picker in the sidebar.

**Corrected while building: reopening restarts the agents.** The plan said it
should resume nothing and show only the transcript, with joining an agent as a
separate act. Two things argued against that once it was in front of me.

The first is that a read-only transcript is a new mode `Session` does not have —
it assumes participants, a composer, an approval dock — and inventing one is a
larger change than the feature is worth. The second is more important: the reason
to go looking for an ended conversation is to pick it back up. Landing on
something you cannot reply to is a dead end that then needs a second action, and
"reopen, then also add an agent" is two steps for one intention.

So `reopenConversation` reuses the existing `reopen` path. Agents are **started,
not resumed** — the provider threads died with the session, and resuming a
forgotten id is the one call that hangs without failing — and they read the
transcript as catch-up on the first thing asked, exactly as an agent joining
mid-conversation does. Permissions deliberately return to the default rather than
to whatever the conversation last ran under.

### Phase 4 — Make "project" real

Write the `projects` table, key conversations to it, and give the sidebar
optional grouping. Worth doing last because it is the only phase that changes
the data model, and the three before it are what make the app usable meanwhile.

## What we are not doing

- **No notification for every message.** An agent narrating its work is not an
  event worth a banner; finishing is.
- **No auto-focus.** A notification offers; it does not rearrange the workspace
  while you are mid-sentence somewhere else. Same reasoning as the wings not
  auto-restoring.
- **No per-conversation notification settings** yet. One switch is enough until
  someone wants two.

## Open questions

1. Should "finished" notify when the turn produced no reply — an interrupt, or a
   turn that failed silently? Leaning yes for failure, no for a user interrupt,
   since you caused that one.
2. Badge counts rooms needing a decision. Should a finished-but-unread room
   count too? Leaning no: the badge is for blocking work, and unread already has
   a home on the card.
3. ~~Notifications while the window is focused but the conversation is in another
   pane — currently silent, because main cannot see panes.~~ **Answered by
   building it in the renderer instead:** an unseen pane notifies, and only the
   pane you are actually looking at stays quiet.
4. Should there be a switch to turn notifications off? Nothing here is
   configurable yet, and the honest reason is that nobody has been annoyed by it
   in anger. A `Settings.tsx` toggle is small when it is wanted.
