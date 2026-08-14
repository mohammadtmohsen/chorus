# Matching the transcript to the approved composition

## The problem

The rail work shipped a layout that was accepted twice and then rejected on
sight, because what was being judged was an image and what was being built from
was prose. The image is now the reference, and the second look at it says
something the first pass missed: **most of the remaining gap is not styling.**

Put the golden beside the current build and the panes differ in what they
contain, not in how it is spaced. The golden's transcript is a sequence of rows —
round avatar, name, right-aligned time, then unboxed body text — carrying two
kinds of card the app has never drawn and a reaction the app has no concept of.
The current build draws a small speaker label beside a filled bubble with a left
accent bar, no time, no cards, and no reactions.

So this is not a polish pass. It is: restructure the message row, add two cards
whose data has to be **defined** rather than assumed, finish the composer, and
add one genuinely new feature.

## The reference, named exactly

**Golden:**
[`../readable-control-rail-2026-08-13/visuals/04-split-terminal-drag.png`](../readable-control-rail-2026-08-13/visuals/04-split-terminal-drag.png)

**Current build, same composition:**
[`../readable-control-rail-2026-08-13/visuals/impl-parity-01-composite-drag-split.png`](../readable-control-rail-2026-08-13/visuals/impl-parity-01-composite-drag-split.png)

Everything below is measured against that one file. The previous draft said "the
image is authoritative" and then named no image, which is the same failure this
plan exists to prevent, one level up: a reviewer and an implementer can both be
sure they agree while looking at different pictures.

**Every phase produces its own capture**, at 1440×900, into this plan's own
`visuals/` folder — `visuals/NN-<phase>.png` — and the phase is not done until
the capture is in the folder and named in STATUS. "Reads as the golden" is not an
exit criterion, because nobody can fail it. A capture beside the golden can.

## What is being matched, and what is not

**Matched.** The message row (avatar, name, time, no bubble), the `Changes` and
`Summary` cards, the composer's full bottom row, the split target, the terminal's
title, and reactions.

**Already shipped, so verified rather than built.** The rail's unread badge
exists — `QuickRail.tsx:306` draws `.rail-badge` from `facts.count`. The earlier
draft listed it as work. It is a line in a capture, nothing more.

**Deliberately not matched — the Codex quota.** The golden shows
`CODEX 5h 42% · Week 18%`. This machine's Codex account reports no windows, which
is why the rail draws `—`, and that was confirmed when the limits spec passed
against real data. Inventing the number would mean writing something the provider
did not say into a channel whose whole rule is that it carries only what the
provider said. The block keeps its four fixed slots and the em-dash gains a
tooltip that explains itself. **Decided with the user, 2026-08-13.**

**Deliberately not matched — the header row.** The golden has none; the user
asked for `CHORUS 0.12.0` after seeing it. It stays, as an already-recorded
exception.

## Phase 1 — a message is a row, not a bubble

The single change that makes the app look like the reference. `.entry` becomes
`[32px avatar] [name] [time, right-aligned]` over full-width unboxed body text.
The filled `.said` background and the left accent bar go; the speaker stops being
a label floating to the left of a bubble and becomes a heading inside the row.

**This is not a CSS-only phase, and the earlier draft was wrong to imply it.**
`TranscriptMessage` (`transcript.ts:11`) has no time field at all, so there is
nothing for the row to render.

**The time shown is when the message began, not when it finished.** `createdAt`
is on every event (`ipc.ts:50`), so a new `at: number` on `TranscriptMessage`
costs nothing to fill. Which event fills it is the decision: an agent message is
opened by its first delta and closed by `agent.message.completed`, and stamping
it at completion makes the column non-monotonic — a reply that started at 9:14
and finished at 9:18 would print `9:18` above tool rows stamped `9:15`, so the
times would read backwards down the screen. First-delta it is.

**Which means `agent.message.completed` has to stop discarding it.**
`transcript.ts:213-227` rebuilds the row from scratch and assigns a fresh
`eventId` — the completion event's — over the streamed row it replaces. An `at`
set at first delta is destroyed by exactly that line unless it is carried
across:

- `appendStreamed` sets `at` when it creates the row and never again.
- `agent.message.completed` reuses the existing row's `at` when there is one, and
  takes `event.createdAt` only when the completion arrives with no prior delta
  (which happens — a short turn can complete without streaming).
- `user.message`, `command.started`, `notice.raised`, `handoff.created` take
  their own event's `createdAt`.
- `appendReasoning` keeps the opening event's `at`, matching how it already keeps
  that event's `key`.

**The dot is identity, not status, and it stays that way.** The golden puts a
small dot on the agent avatar's bottom-right corner and none on the user's. The
app's `.tick` (`Entry.tsx:294`) is already a per-actor colour — whose voice this
is — and the honest change is to _move_ it onto the avatar rather than to give it
a new meaning. It gains exactly one state it lacks today: it pulses while the
message is streaming, which `message.status` already carries.

The tempting alternative — the dot reports the agent's live session state, the
way the rail tile does — is rejected on cost. `Entry` is memoised precisely
because the transcript hands down a fresh array on every delta; a prop that
changes on every pulse would re-render every message in the conversation on every
pulse, which is the exact regression the memo comment describes.

**Only `message` rows get the new treatment, and that is a scope decision, not
an omission.** `Entry` also draws `reasoning`, `command`, `tool`, `notice` and
`handoff`, and the golden contains none of them — its transcript is user and
agent messages and nothing else. Applying an avatar/name/time header generically
would invent a composition for five row kinds nobody has judged. So:

| kind                                     | Phase 1                                                       |
| ---------------------------------------- | ------------------------------------------------------------- |
| `message`                                | new row: avatar, name, right-aligned time, unboxed body       |
| `handoff`                                | keeps its card, gains the time in the same right-aligned slot |
| `reasoning`, `command`, `tool`, `notice` | unchanged, indented under the speaker row above them          |

**The pulse is scoped to `kind === 'message' && status === 'streaming'`, and the
reason is a bug waiting to happen.** `appendReasoning` creates its row with
`status: 'streaming'` and **nothing ever completes it** — no case sets a
reasoning block to `complete`. A dot bound to `status` alone would pulse forever
on every block of thinking in the conversation. Assert that in a test rather than
trusting the reading: a reasoning row followed by a completed message still has
`status: 'streaming'`, so the component, not the reducer, is what must not
pulse.

**Why first:** every later phase drops a card or a control into this row, and
building them against the old shape would mean laying them out twice.

**Tests — new, not "still pass unchanged".** A new field that survives an event
boundary is precisely the kind of thing that passes a suite written before it
existed. In `transcript.test.ts`:

- a streamed message keeps its first-delta `at` after `agent.message.completed`;
- a completed message with no prior delta takes its own `createdAt`;
- a reasoning run keeps the opening event's `at` as more deltas arrive;
- a user message carries its own.

**Exit:** the four tests above, `pnpm check` green, `visuals/01-message-row.png`
captured beside the golden, and no `dangerouslySetInnerHTML` anywhere near the
new markup.

## Phase 2a — the data the `Changes` card needs, which does not exist yet

**Two drafts of this plan have now been wrong about this data, in opposite
directions.** The first said it was already there. The second found the shape but
took the wrong event. What is actually true, read out of the generated types
rather than out of prose:

- `file.change.proposed` carries `{ path, patch }` and nothing else
  (`agent-protocol/src/events.ts:72-76`) — no counts, no status letter.
- The transcript reducer **ignores it** — no case, so it falls to the default arm
  and vanishes (`transcript.ts:651`).
- What `Entry` draws as a diff today is `tool.completed`'s `patch`
  (`transcript.ts:288`).
- **`file.change.proposed` is emitted on `phase === 'started'` only**
  (`adapter-codex/src/mapping.ts:236-248`); the completed phase returns `null`.
  It is a _proposal_. A patch that was declined or failed to apply would draw a
  row in the card saying the file changed.
- **adapter-claude never emits it at all.** Its file changes arrive as
  `tool.completed.patch`, read off `tool_use_result` — which is a _result_, so
  that half is already applied.
- `diff.updated` is emitted by **adapter-codex only**. Nothing derives it for
  Claude, despite the sentence in `CLAUDE.md` saying the workspace service does.

### Codex has been telling us the answer and the adapter drops it

`ThreadItem`'s `fileChange` arm, from the generated types:

```ts
{ type: 'fileChange', id: string, changes: FileUpdateChange[], status: PatchApplyStatus }
FileUpdateChange = { path: string; kind: PatchChangeKind; diff: string }
PatchChangeKind  = { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }
PatchApplyStatus = 'inProgress' | 'completed' | 'failed' | 'declined'
```

The adapter's own local `ThreadItem` interface (`mapping.ts:33-43`) types
`changes` as `{ path; diff?; patch? }[]` and has **no `kind` and no `status`
field at all**, so both are dropped on the floor. This is the inferred-payload
trap the Adapters section of `CLAUDE.md` was written about, sitting in the file
that section names.

`kind` says what happened to the file and `status` says whether it landed —
both facts we currently throw away.

**Neither crosses the adapter boundary in Codex's shape.** `PatchChangeKind` is a
tagged object carrying `move_path`, which is Codex's representation of a rename;
putting it in `agent-protocol` would leak provider-specific structure through the
one boundary the architecture exists to defend, and `CLAUDE.md` is explicit that
nothing provider-specific may pass an adapter except `raw`. The adapter
normalizes:

| Codex                                 | protocol                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `{ type: 'add' }`                     | `change: 'added'`                                                            |
| `{ type: 'delete' }`                  | `change: 'removed'`                                                          |
| `{ type: 'update', move_path: null }` | `change: 'modified'`                                                         |
| `{ type: 'update', move_path: 'x' }`  | `change: 'renamed'`, **`oldPath` = the item's `path`, `path` = `move_path`** |
| `status: 'completed'`                 | `outcome: 'applied'`                                                         |
| `status: 'failed'` / `'declined'`     | `outcome: 'failed'` / `'declined'`                                           |

**The rename direction is the easy thing to get backwards.** Codex's `path` is
where the file _was_ and `move_path` is where it _went_, so the mapping crosses
them: `{ oldPath: path, path: move_path }`. A test asserts that direction
explicitly, because both fields are strings and swapping them fails nothing else.

**`outcome` is a three-way enum, not `applied: boolean`.** A boolean would throw
away the difference between a patch the user declined and one that failed to
apply — and the open question about drawing a row for those depends on that
difference still existing in the log. Only `'applied'` feeds the card.

### The counts cannot come from parsing Codex's `diff`

**Codex's `diff` field is not uniformly a git diff**, which quietly breaks the
plan as it stood. The protocol's own `FileChange` type says it: an `add` and a
`delete` carry `content` — the raw file — while an `update` carries
`unified_diff`, a bare diff body with **no `diff --git` header**.

`parseDiff` requires that header. Its loop is `if (current === null) continue`
(`diff.ts:85`), so a headerless diff produces **zero files, and therefore zero
counts** — a `Changes` card that renders `+0 −0` for every Codex edit and passes
any test that only checks the row exists. Raw file content produces the same
nothing.

**So the counts are computed in the adapter and carried on the event.** An
`update` counts the `+` and `−` lines of its hunks; an `add` is
`added = lines(content), removed = 0`; a `delete` is the reverse. This is
arithmetic on data the provider already sent, not inference about its meaning.

**The Claude side keeps taking its counts from `parseDiff`,** because
`toUnifiedDiff` writes a real `diff --git` header by construction
(`adapter-claude/src/mapping.ts:771`) — the asymmetry is not laziness, it is that
one provider sends a parseable diff and the other does not. The card takes
`{ path, change, added, removed }` from whichever source its row came from and
knows nothing about either.

**The event carries no patch text at all.** Nothing renders a Codex file-change
patch today — `file.change.proposed` is ignored by the reducer — so there is
nothing to preserve, and synthesizing git-format patches out of raw file content
would mean inventing a bounded-and-truncated representation for a view no one
has asked for. The full diff stays available where it already is: `diff.updated`,
which `latestDiff` (`runtime.ts:1324`) already reads for the review view. If a
per-file Codex diff is ever wanted, that is the change that does it.

### What Phase 2a builds

**Decided with the user, 2026-08-13: the card is built from applied changes, so
the completed phase gets mapped.**

1. **`agent-protocol`** — a new `FileChangeCompleted` event:
   `{ itemRef, files: { path, oldPath?, change, added, removed }[], outcome }`.
   `file.change.proposed` stays exactly as it is; a proposal and its outcome are
   two facts and the log keeps both. **It goes in `UNDROPPABLE`**
   (`events.ts:342`), beside `file.change.proposed` and `tool.completed`: the
   proposal is already undroppable, so leaving the result droppable would let
   backpressure keep "codex is about to change this file" and lose "it did" —
   the one pairing that is worse than losing both.
2. **adapter-codex** — **import the generated `ThreadItem`**
   (`generated/v2/index.ts:449`) and narrow to its `fileChange` arm, rather than
   hand-widening the local copy. A third hand-written shape is how the first two
   drifted; the generated file is regenerated from the server's own types and is
   the only copy that cannot silently fall behind. Narrow at the boundary with a
   runtime check rather than trusting the type — the CLI on the machine may be
   older or newer than the types in the repo, which is why the reads in this file
   are defensive in the first place. The normalization above and the counts both
   live here, which is the whole point of an adapter: the shape and the arithmetic
   that depend on Codex's representation stop at this file.
3. **adapter-claude** — the synthesized create patch must say it is a create.
   `toUnifiedDiff` (`mapping.ts:771`) writes `diff --git` and `@@` and **no mode
   line**, so a new file is indistinguishable from an edit and would be lettered
   `M`. The create path (`mapping.ts:826`) already knows `r['type'] === 'create'`;
   it emits `new file mode 100644` and `--- /dev/null`. Pure mapping, tested with
   a recorded `tool_use_result`.
4. **`packages/workspace`** — `DiffFile` gains
   `status: 'added' | 'removed' | 'modified' | 'renamed'`, from `new file mode` /
   `deleted file mode` / `oldPath !== path`. Tests per letter against recorded
   diffs. **This is the Claude path only.** Where the event carries `change`, the
   card uses it and never re-infers — inferring from headers what the provider
   already told us is how the two would come to disagree, and the provider's
   answer is the authoritative one. `parseDiff`'s status exists for
   `tool.completed.patch`, which carries no such field, and for the diff views
   that already parse patches.
5. **The five-file rule applies in full**: the event-store schema, the
   `conversation-service` case, a `projections.ts` no-op (same reason as its
   neighbours — the transcript reads it back off the log), and a `catchup.ts`
   decision.

**Catch-up changes behaviour here, and it is an improvement worth naming.**
Today it reports proposals — `· codex changed src/a.ts` fires when the patch is
_offered_. It moves to the completed event, so the other agent is told what
landed rather than what was suggested, and a declined patch stops being reported
as a change. The proposal case becomes a no-op with that reason. Its existing
test changes accordingly; that is a real behaviour change, not a refactor.

**`D` and `R` are Codex-only in practice.** `readPatch` handles `structuredPatch`
and a `create`; nothing in the Claude path produces a deletion or a rename, so
those letters will only ever be seen from Codex until that changes. Say it rather
than discover it.

**Exit for 2a:** mapping tests for both adapters against recorded payloads,
asserting the **normalized** fields rather than the provider's —

- one per `PatchChangeKind`, each asserting **nonzero counts**. A card of `+0 −0`
  is the failure this whole section exists to prevent, and only a count assertion
  catches it.
- the `move_path` rename, asserting `oldPath` is where the file was and `path` is
  where it went — not merely that both are set.
- one per `PatchApplyStatus`, asserting `outcome` distinguishes `failed` from
  `declined`.
- a Claude create, asserting the mode line and the `A` letter.
- `parseDiff` status tests; `pnpm check`.

## Phase 2b — the card

**The card is a row, not a flush, and that is forced by how the reducer is
called.** `reduceEvents(view, events)` is incremental — `Session.tsx:249` folds
each push into the previous view — so anything held in a local variable during
one call is gone by the next. A push can deliver the file completion, the final
message and `turn.completed` in three separate calls, and `TranscriptView` today
has nowhere to keep a half-built card between them.

So the changes card is a `TranscriptMessage` of kind `changes`, created by the
first applied change and **merged in place** as more arrive — the same
merge-by-ref idiom `tool.started` already uses (`transcript.ts:648-671`), which
is replay-safe because the state lives in the view rather than in the call.

- One field on `TranscriptView`, `EMPTY_VIEW` and `Mutable`:
  `openChanges: Partial<Record<AgentId, string>>`, the key of the row currently
  open for that agent. **`Partial`, not `Record`** — a full `Record` cannot be
  initialised as `{}` in `EMPTY_VIEW` without lying about the keys it holds.
- The first applied change for an agent with no open row pushes a `changes` row
  and records its key. Later ones find the row by key and merge, summing
  `added`/`removed` per path.
- `turn.completed` clears that agent's entry, so the next turn starts a new card.
- **`session.ended` clears by `payload.agentId`, not by the event's actor.**
  Session-ending events are appended as `actor: 'system'` —
  `reconcileOrphanedSessions` does exactly that (`store.ts:333`) — so clearing by
  actor would clear an entry under `system` that never existed and leave the
  agent's card open across a crash recovery, growing into whatever came next.
  Each case reads the field that actually names the agent: `turn.completed`
  carries it as the actor, `session.ended` carries it in the payload.
- Only `outcome: 'applied'` changes contribute. A declined patch draws nothing.

**The row is keyed and live, and it moves to sit after the message.** Codex edits
before it narrates, so a card that simply stayed where the first edit landed
would sit **above** the agent's text — the opposite of the golden, and precisely
the kind of known mismatch that is not allowed to reach visual review under this
plan's own rules. So `agent.message.completed` for an agent with an open card
splices that card to sit immediately after the completed message. The row keeps
its key and its contents, so it is still merged into as more edits land, and the
move is driven entirely by logged events — replay produces the same order.

**The numbers count what the turn wrote, not the net result. Decided with the
user, 2026-08-13.** Summing successive patches per path measures churn: a line
added and then removed in the same turn appears in both columns. The card says so
in its own terms rather than implying a net diff. The alternative — net per turn
from `diff.updated` — is available for Codex and **for Codex only**, which would
make half the card disappear; deriving it for Claude is separate work and is not
in this plan.

**Historical, not current.** A card records what that turn did. Later edits do
not rewrite it, and **`git diff --numstat` may legitimately disagree with it** —
which is why the first draft's exit criterion ("the numbers agree with
`git diff --numstat`") is deleted. It would fail correct code.

**Exit for 2b:**

- **Three separate `reduceEvents` calls** — change, message, `turn.completed` —
  produce one card. Folding two payloads inside a single call proves nothing
  about the case production actually hits.
- The same events replayed in one call from `EMPTY_VIEW` produce an identical
  view. That is the replay-safety property, and it is the one a card built from
  hidden state would fail.
- **Edits before narration put the card after the message**, asserted on the
  order of `messages` — this is the golden's layout and the reason the splice
  exists.
- **A `session.ended` appended as `actor: 'system'` closes the agent's card**, so
  a later turn opens a new one rather than growing the orphan. Replayed, not just
  pushed.
- A second turn opens a second card rather than growing the first.
- A `declined` payload draws nothing.
- The card rendered from a **real** conversation with both agents in the running
  app, captured to `visuals/02-changes-card.png`.

## Phase 2c — the `Summary` card

**This card has no data source in the app today, and the earlier draft's
"`SummaryPanel.tsx` is the obvious source" was wrong twice over.** That component
is a modal over the whole session, not a card on a message; and its own header
comment says the log cannot answer what the golden's card shows — "whether the
work was any good, what is still missing, what to do next"
(`SummaryPanel.tsx:12-22`). Its counts answer "what was done". The golden's
bullets — `Throughput: +3.2x (local), +1.8x (staging)` — are outcomes. Reusing it
would produce a card that looks like the golden and says something else. **It is
not reused, and open question 2 is closed by that.**

**Decided with the user, 2026-08-13: a markdown convention in the reply.** The
reducer lifts a trailing summary block out of a **completed** agent message and
carries it as `summary: readonly string[]`, removing it from the body so it is
not drawn twice.

**The rule, narrow on purpose.** A heading whose text is exactly `Summary`
(case-insensitive), immediately followed by a bullet list, ending the message.
Nothing else qualifies. "Ends in bullets" was considered and rejected: replies end
in bullets constantly, and a card that appears by accident is worse than no card.

**It runs on the parse tree, not on the lines. The previous draft said "a line
scan, not a second markdown parser" and that was the wrong half of the choice** —
a line scan finds `## Summary` inside a fenced code block, and an agent
explaining this very convention in a fenced example would have its own text
lifted out of its reply and redrawn as a card.

There is no need to write one. `apps/desktop/src/shared/markdown.ts` already
exports `splitBlocks` and `parseMarkdown`, it is in `shared/` so the reducer can
import it exactly as it imports `ipc.js`, and `splitBlocks` tracks `insideFence`
(`markdown.ts:729`) — a fenced block comes back as one block, whatever is inside
it. Quotes are handled by the same move: a `> ## Summary` parses as `kind:
'quote'`, not `kind: 'heading'`, so requiring the block to parse as a heading
rules it out for free.

**But "parse the last two blocks" is wrong, and it is worth writing down why so
the next draft does not reinvent it.** `splitBlocks` splits on _blank lines_, so
the normal form

```md
## Summary

- one
- two
```

is **one** raw block holding two semantic blocks — there is no "last two blocks"
to take. And `splitBlocks` discards the blank lines between blocks, so rejoining
its output cannot reproduce the original body byte-for-byte even when the split
is right.

**So the helper returns a cut position, and the body is a prefix of the original
string.** One function in `shared/markdown.ts`, beside the parser whose internals
it depends on:

- Walk the source line by line, recording the offset of every candidate heading.
- **A candidate is at column zero.** `parseMarkdown`'s own `HEADING` allows three
  leading spaces, and a heading indented under a list item is a _child of that
  item_, not a top-level heading:

  ```md
  - Example:
    ## Summary
    - not a real summary
  ```

  Parsing the suffix alone returns `[heading, list]` and would extract that. A
  scanner cannot establish "top-level" by looking at the tail; requiring
  column zero is what makes the tail's parse trustworthy, and it is a convention
  agents can follow. Indented headings are ignored by construction.

- **Fence tracking matches the way the parser's does**, not by toggling on any
  fence marker: record the opening marker's character and length, and treat only
  a fence of the same character and at least that length as the close. A
  ` ```` ` inside a ` ``` ` block otherwise closes it early and everything after
  is read as prose.
- For the last surviving offset, `parseMarkdown(source.slice(offset))` must
  return **exactly** `[heading, list]`, with **`list.ordered === false`** — the
  convention is a bullet list, and a numbered list is a different thing that
  should stay in the body rather than silently becoming a card.
- Return `{ cut: offset, items }`. The body is `source.slice(0, cut).trimEnd()` —
  an exact prefix, so nothing is re-serialized and no blank line can be lost.

Blank-line handling between the heading and the list is exactly where this breaks
if it is written carelessly, so **both forms are tested**: heading immediately
followed by the list, and heading, blank line, list.

- Only on `status: 'complete'` — a card must not flicker into existence
  mid-stream and then move as more text arrives.
- Bullet text is rendered through the existing `MarkdownView` path, so inline
  code in a bullet still works and nothing is interpolated into markup.

**What this honestly buys.** Nothing prompts the agents to write this section, so
the card will be absent on most turns until something does. Prompting for it is a
separate decision and is **not** in this plan. The card is a convention the app
honours, not a contract the app enforces — say so in STATUS rather than
discovering it in review.

**Exit:** tests for heading+list at the end **with and without a blank line
between them** (card, and the body is the exact prefix), bullets with no heading
(no card), `Summary` mid-message followed by prose (no card), streaming (no card
yet), **a reply ending in a fenced block containing `## Summary` and bullets (no
card, and the fence survives byte-for-byte)**, the same inside a block quote,
**a heading indented under a list item (no card)**, **a nested fence of a
different length (no card, and nothing truncated)**, and **a numbered list under
the heading (no card)**; plus a capture from a real reply that follows the
convention, `visuals/03-summary-card.png`.

## Phase 3 — the composer

The golden's composer has, and the build lacks: a `+` beside the paperclip, a
sliders control in the tool row, `Included ▾` with its caret, per-agent chips
`● Codex ▾` and `● Claude ▾` rather than one merged cast line, a filled blue
send, and the placeholder `Ask Codex or Claude…`.

**Every one of these is a control, and a control with undefined behaviour is how
the last pass went wrong.** All five were decided with the user on 2026-08-13
before this phase was approved, and none of them ships as a placeholder.

**`+` — an add-context menu.** The paperclip keeps its one-click file picker, so
the two controls have two jobs rather than one job and a spare. Three items, each
with a defined path rather than a name:

- **File…** — clicks the existing hidden `<input type="file">`. Nothing new.
- **Folder…** — a **new** IPC. `conversation:chooseCwd` (`ipc.ts:313`) is the
  only directory dialog today and it **sets the project directory**; reusing it
  would silently move the conversation's `cwd` when the user meant to attach a
  folder. The new handler opens `showOpenDialog` with `['openDirectory']`,
  returns the path, and touches no runtime state. The path then joins the
  existing pipeline at the point `attach` reaches after resolving files — the
  preview step — so a folder becomes an ordinary path attachment, which is
  exactly what Chorus sends anyway (`attach.ts` — agents get paths, not
  uploads). `previewFile` already handles it: a directory fails the
  `stats.isFile()` guard and returns `{ name, bytes, dataUrl: null }`
  (`stash.ts:60-66`), the same shape a non-image file returns. So this needs a
  test pinning that behaviour and, since the row would otherwise look like an
  unpreviewable file, a folder icon to tell the two apart.
- **Current selection** — acts on the flag the `Included` chip already owns.
  Shown only when `ide.status === 'ready'`: choosing it re-includes a selection
  the user previously excluded, and when it is already included the row is shown
  checked and inert. When there is no editor, no selection, or the bridge is not
  ready, the row is **absent** — a disabled row promising context that does not
  exist is worse than no row.

**Sliders — the session settings view, as it actually exists.** `SessionMenu`'s
settings view holds the cast, the folder, the permission profile and plan mode.
It holds **no model selector**, and the model settings elsewhere are defaults for
_new_ sessions — switching a live session's model is a runtime and protocol
feature, not a menu item. So the sliders open the four controls that exist, and
the earlier draft's phrase "permission profile and model" is corrected here
rather than shipped as a promise the menu cannot keep.

**`Included ▾` — the chip becomes a menu trigger, and each row removes.** Today
it is a plain toggle with `aria-pressed` (`Composer.tsx:997`). It gains
`aria-haspopup="menu"` and `aria-expanded`; the menu lists what will actually be
sent — the editor selection and each attachment — with the include/exclude toggle
as its focused first item, so click-then-Enter still does what a single click
does today. **The "once excluded, stays excluded" rule survives unchanged**: a
live selection change must never silently re-enable context the user turned off.

**Per attachment the action is remove, not exclude. Decided with the user,
2026-08-13.** Exclusion would need three things the app does not have:
`Attachment` has no inclusion flag, `send` maps straight over `attached` to build
the paths, and `SessionCarry` carries `attached` and a single `ideIncluded` and
nothing per item — so an excluded file would come back included after a tab
switch, silently, which is the worst possible failure for a control whose whole
job is "do not send this". Remove reuses `Attachments`' existing `onRemove`, adds
no state, and cannot resurrect anything. The trade is that removal is not
reversible.

**Agent carets — the session cast menu.** `SessionMenu.tsx` is where the cast is
changed (`App.tsx:620` add/remove). Both carets open it, opened with that agent's
row focused. The known objection is recorded rather than waved away: two controls
opening one identical menu is close to the "looks like a selector" problem the
current single cast line was written to avoid, and the mitigation is the focused
row. If review disagrees, the fallback is the chips without carets.

**The picker that does not exist.** For the avoidance of the earlier draft's
mistake: `mention-menu.ts` is coupled to an `@` query and inserts text into the
draft (`mention-menu.ts:252`). It is not a reusable per-agent dropdown and cannot
be dropped behind a caret. Anything opened by these controls is a menu this phase
builds.

**Keyboard, for all four, taken from the mention menu rather than re-invented.**
Enter/Space opens; Arrow keys move the highlight; Enter chooses; Escape closes and
returns focus to the trigger; `aria-expanded` tracks the state; pointer-down
rather than click on menu items, since the textarea blurs first.

**Send and placeholder.** `.send` becomes the filled accent button. The
placeholder is interpolated from the actual cast — `t('conversation.placeholder',
{ agents })` giving `Ask Codex or Claude…` for two, and the right sentence for
one or none — never the golden's literal string, since the cast varies. Every
string goes through `i18n/en.json`.

**Exit:** the composer spec keeps its assertion that there is exactly one primary
Send-or-Stop action — the one that caught a stale test last round — and gains,
**per control, an assertion that the control does its job**, not merely that a
menu appeared:

- opens, Escape closes, focus returns to the trigger (all four);
- **Folder…** returns a path and the conversation's `cwd` is **unchanged** —
  the specific failure the new IPC exists to avoid;
- **Current selection** re-includes an excluded selection, and is absent when the
  editor bridge is not ready;
- an attachment row removes that attachment, and the draft still sends without
  it;
- an agent caret opens the cast menu with that agent's row focused.

Capture: `visuals/04-composer.png`.

## Phase 4 — the chrome

Three small changes, grouped because none deserves its own phase. The unread
badge is **not** among them — it already ships.

**The pane's far-right `×` goes** (`Workspace.tsx:810`, `.workspace-pane-close`);
the golden has only the tab's own. The previous draft flagged this as possibly
stranding an empty pane; it does not. `closeTab` routes through
`normalizeWorkspace`, which drops a leaf with no tabs (`layout.ts:104`), and
`closePane` is _implemented_ as "empty it and let normalisation remove it"
(`layout.ts:278`). Closing the last tab already removes the pane, so the button is
genuinely redundant.

**The split target becomes an outlined column** rather than a bare dashed line.

**The terminal header says `Terminal — <session>`.** Today it is
`t('terminal.sessionTitle', { project: shortenPath(props.session.cwd) })`
(`Session.tsx:1237`) — a path, which in a scratch workspace is a temp directory.
`SessionInfo.title` (`Session.tsx:82`) is the name the golden shows and is already
in the props.

**The Codex em-dash gets its tooltip.**

**Exit:** the split-drop and terminal-ownership specs still pass, **and** a new
assertion reads the rendered terminal title from the running app. The earlier
draft's "specs pass unchanged" was not an exit criterion for a change those specs
never asserted on.

## Phase 5 — reactions, which is the one that touches the log

A reaction is **not** an `AgentEvent`. It never comes from a provider, so it does
not touch `agent-protocol` or either adapter, and the five-file rule in
`CLAUDE.md` does not apply as written.

It passes the "state is not history" test in the direction of the log: reading
back a week later that someone thumbed-up the message where the bug was found is
**better** than having none. So it is a durable event, not a push channel.

**Shape.** One event type, `reaction.toggled`, carrying the target event id, the
emoji, `on: boolean`, **and the target's actor and kind**. Append-only means a
removal is another append, never a delete; the fold is last-write-wins per
`(targetEventId, emoji, actor)`.

**The target metadata is on the event because catch-up cannot look it up.**
`CatchupInput` is `{ recipient, events, participants }` and `events` is "everything
the recipient has not seen" (`catchup.ts:43-48`) — there is no store, no history,
no way to ask who wrote the message being reacted to. A sentence naming the
target's author is unbuildable from the event as the previous draft specified it.
Runtime _does_ have the log, validates the target at append time anyway, and can
therefore write `targetActor` and `targetKind` into the row as validated facts
rather than as a claim. This is the same move as `handoff.created` carrying its
`sourceEventIds`.

**No table, and therefore no migration.** The earlier draft called for both. The
codebase's own rule says otherwise: `projections.ts:213-222` lists the streamed
detail that gets no table, with the reason — "the transcript reads back off the
log directly. Giving each of these a table would add write cost for no query we
make." Reactions are exactly that shape. The only reader is the transcript, which
already replays the whole log through `reduceEvents`. So:

1. `event-store/src/events.ts` — the payload schema.
2. `projections.ts` — an **explicit no-op**, with that reason as its comment.
3. `transcript.ts` — the fold, onto the targeted message.
4. `catchup.ts` — carried (below).
5. `runtime.ts` — the validated append, plus IPC and the renderer.

This removes the plan's only irreversible step. If a future query does need
reactions without a replay, that is when the table is earned.

**Identity: `actor: 'user'`.** The earlier draft called `conversation.renamed` the
closest precedent; it is not a clean one — `runtime.ts:2042` appends it as
`system`, because a rename is bookkeeping. A reaction is a person doing something
in the room, so its precedent is `user.message`.

**Validation happens before the append, because the log is append-only and a bad
row is permanent.** In `runtime.ts`, refuse — with an error, not an append —
anything where:

- the target event id is not in this conversation;
- the target is not a `user.message` or a completed `agent.message.completed`
  (a reaction on a tool row or a notice has no meaning in the golden and no place
  to draw);
- the emoji is outside the fixed allowlist — an unbounded string reaches a
  durable row and, from there, a button.

**The allowlist lives in `packages/shared`.** "Defined in the renderer, enforced
in the schema" was a layering mistake: `event-store` cannot import from
`apps/desktop`, and duplicating the list is how the two drift until a picker
offers an emoji the schema refuses. `@chorus/shared` is already a dependency of
`event-store` and is already imported by the renderer (`useUsage.ts`,
`SessionRow.tsx`), so one constant there is imported by the schema, by runtime's
validation, and by the picker.

**Catch-up carries it. Decided with the user, 2026-08-13.** The argument for a
no-op — the other agent runs under its own harness and cannot act on it, which is
what `notice.raised` and `conversation.renamed` are dropped for — was weighed and
lost: a thumbs-up is the clearest feedback signal a human ever gives, and catch-up
exists precisely to carry what the other agent missed. It is one short line and it
is bounded by the same budget as everything else there.

The line is built from `targetActor` and the `recipient` catch-up already knows,
which settles the three cases the previous draft left unwritten:

| target                      | line                                         |
| --------------------------- | -------------------------------------------- |
| the recipient's own message | `· the user reacted 👍 to your message`      |
| the other agent's message   | `· the user reacted 👍 to <agent>'s message` |
| the user's own message      | `· the user reacted 👍 to their own message` |

**Catch-up folds before it emits, and skipping that step would invert the whole
argument for carrying reactions at all.** `collect` walks the unseen events in
order, pushing a line per event (`catchup.ts:101`). A reaction added and then
taken back — both inside the same unseen slice, which is the _normal_ case for an
agent that has been quiet for a while — would emit the 👍 and then silently
ignore its removal, telling the other agent about approval that no longer exists.

So the reaction lines are built from a pre-pass: fold every unseen
`reaction.toggled` last-write-wins per `(targetEventId, emoji, actor)`, then emit
one line per surviving key, positioned at the seq of that key's last event so
ordering is unchanged.

**A removal is not always silence, and the previous draft got this wrong in the
other direction.** Catch-up is not one delivery; it runs before every turn. The
three cases are distinguished by what the slice itself contains:

| the unseen slice holds   | line                                             |
| ------------------------ | ------------------------------------------------ |
| `on`, or `off` then `on` | `· the user reacted 👍 to …`                     |
| `on` then `off`          | none — it came and went while the agent was away |
| `off` only               | `· the user took back their 👍 on …`             |

The third row is the one that matters. An `off` with no matching `on` in the same
slice means the 👍 was delivered in an **earlier** catch-up: the agent has already
been told the approval exists, and staying silent leaves it acting on feedback
that has since been withdrawn — the exact opposite of the reason for carrying
reactions at all.

Regression tests, named because both would ship broken:

- `on → off` inside one slice produces **no** line;
- **two successive catch-ups** — the first delivering `on`, the second an
  `off`-only slice — produce the reaction line and then the retraction line.

**Exit:** a reaction survives a restart (replayed from the log, no table
involved); toggling twice leaves no reaction and two events; a reaction targeting
an unknown or ineligible event is refused and nothing is appended; an emoji
outside the shared allowlist is refused by the schema; a catch-up assertion **per
row of the table above**, plus the `on → off` and `off → on` fold tests;
`visuals/05-reactions.png`.

## Risks

- **Phase 1 is a wide diff in a file that just churned 3,600 lines.** The rail
  work is unapproved and uncommitted in the same tree. If that is still unmerged
  when this starts, a mistake here is hard to bisect — which is an argument for
  landing the rail work first, and it is the user's call, not this plan's.
- **Phase 2a is now the largest phase, and it is the one with adapter changes in
  it.** A protocol event, both adapters, `parseDiff`, and a behaviour change to
  catch-up. It is split from the card deliberately so the data can be proven with
  mapping tests before any markup depends on it; if it slips, Phases 3–5 are
  independent of it and should not wait.
- **The Claude half depends on which tools produce a patch at all.** `readPatch`
  returns `undefined` unless the result carries `structuredPatch`, or is a
  `create` with `content`. Whatever `MultiEdit`, `NotebookEdit` or a plugin's
  write tool returns is unverified, and each one that returns neither is a file
  the card will not list. Measure it against a real session in Phase 2a, and if
  the gap is wide, the card is honest only if it says it lists edits it could
  read.
- **The `Changes` numbers can exceed the net diff** and someone will eventually
  read them as `git diff --numstat`. The card's own wording is the only defence,
  and it is a weak one.
- **The card's position depends on a splice that has to be right on replay.**
  Moving the row after the completed message is what keeps the golden's layout
  when an agent edits before it narrates, and a splice driven by events is only
  as deterministic as its ordering rules. The replay-equivalence test is the one
  that guards it.
- **Phase 2c ships a card most turns will not show.** The convention is not
  enforced anywhere. That is the honest cost of not inventing an event, and it
  should be reported that way rather than as parity achieved.
- **Two carets, one menu** (Phase 3) is the known weak point of the composer
  decision. Reviewed as design, not accepted as parity.
- Reactions have no visible producer in the golden beyond one 👍 — no picker, no
  hover state, no removal affordance. Those are being designed, not copied.

## Decisions taken with the user, 2026-08-13

| #   | Question                               | Answer                                                                                                                                                            |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Summary` card's data                  | Markdown convention in the reply (`## Summary` + list, at the end, complete messages only)                                                                        |
| 2   | Agent chip carets                      | Open the existing session cast menu, focused on that agent                                                                                                        |
| 3   | Reaction in catch-up                   | Carried, as an activity line                                                                                                                                      |
| 4   | Composer `+`                           | Add-context menu: file, folder, current selection                                                                                                                 |
| 5   | Sliders glyph                          | Opens the session settings view — cast, folder, permission profile, plan mode. **No model control**: none exists for a live session                               |
| 6   | `Included ▾`                           | Chip becomes a menu trigger listing what will be sent, toggle as its focused first item                                                                           |
| 7   | `Changes` source                       | Applied, not proposed: map Codex's completed `fileChange` phase into a new protocol event, **normalized in the adapter** — no `PatchChangeKind` past the boundary |
| 8   | `Changes` numbers                      | Per-turn sums, stated as what the turn wrote, not the net diff                                                                                                    |
| 9   | Attachment rows in the `Included` menu | Remove, not exclude — no per-item state to carry or resurrect                                                                                                     |

Closed by this revision: whether `SummaryPanel` can be reused (no — different
job, and its own comment says the log cannot answer this); what the per-agent
caret opens; and what closes a pane whose last tab was closed (normalisation
already does, `layout.ts:104` and `:278`, so the pane `×` is redundant rather
than load-bearing).

## Open questions

1. **Which Claude edit tools actually produce a patch?** Not whether the patches
   parse — they do, `toUnifiedDiff` writes `diff --git` by construction
   (`adapter-claude/src/mapping.ts:771`), which narrows the previous draft's
   question. The real unknown is coverage: `readPatch` yields `undefined` for any
   result without `structuredPatch` or a `create` body, and every such tool is a
   file missing from the card. Measured in Phase 2a against a real session.
2. Should anything prompt agents to write the `Summary` section? Out of scope
   here; without it the card is rare.
3. Does a declined or failed patch deserve a visible row — greyed, struck
   through — rather than silence? `outcome` keeps the two apart in the log
   precisely so this stays answerable; the golden shows no such row, and
   inventing one is exactly what this plan keeps refusing to do. Raised, not
   answered.

Closed since the last revision: what `files:preview` returns for a directory
(`{ name, bytes, dataUrl: null }` — `stash.ts:60`, so `Folder…` needs a test and
an icon, not a design).
