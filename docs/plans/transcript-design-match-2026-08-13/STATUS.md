# Status — matching the transcript to the approved composition

## Phase 5 — reactions · shipped 2026-08-14 · uncommitted

The plan is complete. This is the phase that writes to the log, so everything
here was checked before the first append rather than after.

**Capture:** [`visuals/06-reactions.png`](visuals/06-reactions.png) — 👍 1 under a
real Claude reply, put there by driving the picker. **And then found again after
a full quit and relaunch**, which is the only assertion that distinguishes a
durable event from component state: `after restart: {"reactions":["👍1"],"mine":1}`.

### What shipped

- **`reaction.toggled`** in the event-store schema. Not an `AgentEvent`: no
  provider sends one, so neither adapter is touched and the five-file rule does
  not apply as written.
- **No table, no migration.** `projections.ts` gets an explicit no-op beside the
  streamed detail, with the reason: "durable" and "projected" sound like the same
  word and are not. The only reader is the transcript, which folds the whole log
  anyway. This removed the plan's one irreversible step.
- **`REACTIONS` in `packages/shared`** — six emoji, imported by the schema, by
  runtime's validation and by the picker. `event-store` cannot import from
  `apps/desktop`, and duplicating the list is how a button ends up offering
  something the log refuses.
- **Validated before the append**, and refused with an error rather than
  written: the target must exist in this conversation and be a `user.message` or
  a completed agent message — a reaction on a row the transcript does not draw is
  a permanent row nobody can ever see or take back.
- **`actor: 'user'`**, unlike `conversation.renamed`, which is appended as
  `system`. A rename is bookkeeping; this is a person doing something in the room.
- **The fold is in the view** (`reactionsBy`), keyed by target, emoji and who —
  so two people reacting with the same emoji count two, and one person pressing
  twice counts one, across separate pushes.
- **Catch-up carries it**, with the three sentences the plan tabulated and a
  retraction line for the case a fold alone gets wrong.

### The case a simple fold gets wrong

An `off` with no matching `on` **in the same unseen slice** means the 👍 was
delivered in an _earlier_ catch-up. Dropping it there leaves the other agent
acting on approval that has since been withdrawn — the opposite of the reason for
carrying reactions at all. So: on-then-off inside one slice says nothing;
off-only says `· the user took back their 👍 on claude's message`. Both are
tests.

### A guard that turned out to have two levels

`z.string().refine(isReaction)` is a **type predicate**, so the payload type
narrows `emoji` to the six — which made the test that appends `💣` a compile
error before it could be a runtime one. It now casts deliberately, with a comment
saying why: the compiler covers code, and the cast is what lets the test prove
the runtime guard still holds for a payload arriving off disk or over IPC, where
no compiler was involved.

### Tests

Seven in `transcript.test.ts` (fold onto the target, taken back leaves the field
absent, two people count two, one person pressing twice counts one, emoji kept
apart, separate pushes replay identically, a reaction pointing at nothing is
dropped); three in `catchup.test.ts` (the three sentences, the unseen round trip,
the retraction across two deliveries); one in `store.test.ts` (the allowlist).

### Verified, and not

- **1,577 unit tests pass**; `pnpm check` green (same untouched `LOOP.md`).
- Driven in the running app: six offered, the reaction lands, it is marked as
  this reader's, and it survives a relaunch on the same data.
- **Not driven: taking one back in the app.** The reducer, the schema and
  catch-up all have tests for `on: false`, but no run has clicked it off.
- **Not run: the e2e suite**, now the largest outstanding gap in the whole plan.

## Phase 4 — the chrome · shipped 2026-08-14 · uncommitted

**Capture:** [`visuals/05-chrome.png`](visuals/05-chrome.png), with the values
read out of the running app rather than inferred from the picture.

### Two of the four were already done

- **The split target** is already an outlined column in the accent with a
  labelled chip — the rail work replaced the bare hairline it had, and the
  comment in `styles.css` records why. Verified against the golden, not rebuilt.
- **The unread badge** ships, as Phase 4's entry already said.

That leaves the phase smaller than planned, which is the honest outcome rather
than a reason to touch working code.

### What changed

- **The pane's far-right `×` is gone.** Safe because emptying a pane is what
  removes it: `closeTab` routes through `normalizeWorkspace`, which drops a leaf
  with no tabs, and `closePane` is _implemented_ as "empty it and let
  normalisation remove it". Driven: `paneCloses: 0`, `tabCloses: 1` — the tab
  keeps its own.
- **The terminal says `Terminal — <session>`**, not `Terminal — <path>`. It read
  `Terminal — /var/folders/…/T/chorus-abc123` in any scratch workspace, which is
  the one string on screen that said nothing about which session it belonged to.
  Driven: `"Terminal — alex"`, matching the tab.
- **The em dash explains itself.** Both of this machine's accounts report no
  windows, so four slots draw `—`, and a dash with no explanation reads as a bug
  in Chorus rather than as silence from a provider. The screen-reader line has
  said so all along; the tooltip is the same sentence for everyone else. Driven:
  four titles, one per unreported window.

### A driver mistake worth recording

The first run reported `tabCloses: 0` — which looks exactly like "removing the
pane close removed the last way to close a tab". It was the selector: the tab's
close is a _sibling_ of the tab button, not a child. The second attempt then
failed to parse, because the comment explaining the first mistake contained
backticks inside a template literal — the trap `CLAUDE.md` records for SQL,
in JavaScript.

### Verified, and not

- `pnpm check` green (same untouched `LOOP.md`), 839 unit tests pass.
- The terminal title assertion is **new**. The existing specs never looked at it,
  so "the specs still pass" would not have covered this change.
- **Not run: the e2e suite.**

## Phase 3 — the composer · shipped 2026-08-14 · uncommitted

**Capture:** [`visuals/04-composer.png`](visuals/04-composer.png), plus a driven
read-out of every control asserting it does its job rather than merely appearing.

### The blocker the plan did not see, and the decision it forced

`SessionMenu` was hosted by `SessionList` — the drawer — and reachable from
nowhere else; its rename, move, panel, restart, end, folder, profile and agent
callbacks were all wired in that one file. Both of the decisions taken on
2026-08-13 ("the caret opens the session cast menu", "the sliders open the
session settings") assumed it could be opened from the composer, which sits
inside a pane with `App` as the only common ancestor.

**Decided with the user, 2026-08-14: lift the menu to a shared owner.**
`Workspace` now holds it, along with the move-and-announce that only the menu
used. Everything opens it through `SessionMenuContext` — a capability, not state,
which is why it is a context and not a store action: the target carries a
`DOMRect` and the element focus returns to, and live DOM references have no
business in a store that persists a snapshot of itself. The drawer keeps its
inline rename by taking a `renameRequest` prop, so the two talk through a request
instead of reaching into each other.

### What shipped

- **`+`** — an add-context menu beside the paperclip: File… (the existing
  picker), Folder…, and Current selection, which appears **only when the editor
  bridge is ready** and is ticked and inert when the selection is already going.
- **`files:chooseDirectory`**, a new IPC. `conversation:chooseCwd` opens the same
  dialog and then **moves the project**; one control doing both silently is how
  an agent ends up working in the wrong tree. The new one takes no conversation
  id, so it cannot.
- **Sliders** — opens the session menu on its settings view.
- **`Included ▾`** — the chip became a menu trigger. The include/exclude toggle
  is its first item and takes focus on open, so click-then-Enter still does what
  the plain toggle did; each attachment gets a **remove** row.
- **Agent chips are controls**, each opening the session menu on the cast with
  its own agent's row focused (`data-menu-agent`).
- **A filled send**, in the app's accent rather than in Codex's teal — the send
  is the app's action, not an agent's — and **dimmed rather than emptied** when
  disabled, so the corner where sending happens still says so.
- **The placeholder is the cast**: `Ask Claude…`, `Ask Codex or Claude…`,
  interpolated. Hardcoding the golden's words would say "or Claude" to a room
  Claude had left.
- **`ComposerMenu`**, one implementation of the six behaviours all three menus
  need, with `SessionMenu`'s keys rather than a second convention.

### Three defects the drive caught

- **Menus took no focus on open.** Both `ComposerMenu` and `SessionMenu` focus
  their first item in an effect, while the surface is still `visibility: hidden`
  awaiting measurement — and a hidden element cannot take focus. Silent: the menu
  opened and the first arrow key went to the page. Both now focus after
  placement. This was latent in `SessionMenu` before this phase.
- **The composer printed identifiers**: `claude` in the chips and in the
  placeholder, which is what Phase 1 removed from the transcript and this row
  still did.
- **The `+` came out styled as a primary action**, sitting next to the paperclip
  looking like the thing to press.

### Verified, and not

- Driven in the running app: `+` flips `aria-expanded`, lists `file`/`folder`
  (no `selection`, correctly, with no editor attached), focuses `file` on open,
  closes on Escape and **returns focus to the trigger**; exactly one `.send` and
  no `.send--stop` with an idle agent; the chip reads `Claude` and opens the
  session menu on `settings` with `data-menu-agent="claude"` focused; the sliders
  open the same view; nothing is left open afterwards.
- `pnpm check` green (same untouched `LOOP.md`), 839 unit tests pass.
- **Not driven: Folder… and the attachment rows.** The folder chooser opens a
  native dialog that the debugger protocol cannot dismiss, and the attachment
  rows need a file attached first. Their behaviour is argued, not observed.
- **Not run: the e2e suite**, which now has five edited assertions plus a lifted
  menu riding on it.

## Phase 2c — the `Summary` card · shipped 2026-08-14 · uncommitted

**Capture:** [`visuals/03-summary-card.png`](visuals/03-summary-card.png) — a real
Claude reply asked to end with a `## Summary` and two bullets. Both cards appear
together: the summary inside the message's own row, `Changes` below it.

### What shipped

- **`trailingSummary` in `shared/markdown.ts`**, beside the parser whose fence
  rules it has to match. It returns a **cut offset**, so the body the reader sees
  is `source.slice(0, cut)` — an exact prefix of what the agent wrote, never a
  re-serialized tree.
- **The reducer lifts on completion only.** A card built mid-stream would appear
  as the bullets were typed and then move as the rest of the reply landed under
  it.
- **A `summary` field on the message**, absent rather than empty when there is
  none: an empty card and no card are different things.
- The card renders the bullets as **text**, not markdown — a summary line is a
  line, and re-parsing it would render agent markup in a second place for
  nothing.

### The three rules, and why each is not looser

- **The heading must be at column zero.** `parseMarkdown`'s own `HEADING` allows
  three leading spaces, and an indented heading is a child of the list item above
  it — so `- Example:` / `  ## Summary` / `  - not a summary` parses, on its own,
  as exactly `[heading, list]` and would have been lifted out of a list.
  Mutation-checked: relaxing the regex to `^ {0,3}#` fails that test and only
  that test.
- **Fences are matched by character and length**, not toggled on any marker: a
  three-backtick line inside a four-backtick block does not end it early and
  leave the rest read as prose.
- **The tail must parse as exactly a heading and an _unordered_ list**, which
  rejects prose after the bullets, a numbered list, and `> ## Summary` — a quote
  never parses as a heading.

### Honest limits

Nothing prompts an agent to write this section, so **most replies will have no
card**. The capture exists because the prompt asked for one. Making agents emit
it is a separate decision and is not in this plan; until then the card is a
convention the app honours, not a feature it delivers.

### Tests

Thirteen in `markdown.test.ts` (both blank-line forms, two summaries taking the
last, no heading, prose after, numbered list, fenced example, nested fence of a
different length, block quote, heading indented under a list item, "Summary of
the day", any level and case, emphasis flattened) and four in `transcript.test.ts`
(cut on completion, streaming left alone, absent when none, fenced example not
lifted).

### Verified, and not

- `pnpm check` green (same untouched `LOOP.md`).
- Driven in the running app: the reply's body no longer contains the heading, and
  the card carries the two bullets — read out of the DOM, not just photographed.
- Codex's half of `Changes` is **still unobserved**, and the e2e suite still has
  not been run.

## Phase 2b — the `Changes` card · shipped 2026-08-14 · uncommitted

**Capture:** [`visuals/02-changes-card.png`](visuals/02-changes-card.png) — a real
Claude turn in a scratch project: `M src/rate.ts +1 −1`, `A src/fee.ts +1`, read
back out of the DOM as well as photographed. The `A` is the proof that Phase 2a's
mode line survives the whole path from the adapter to the letter.

### What shipped

- **A `changes` row**, merged in place as more files land, rather than a bucket
  flushed at the end of a turn. `reduceEvents` is incremental, so anything held
  in a local between events is gone by the next push.
- **`openChanges` on the view** — `Record<AgentId, string | null>`, the key of the
  card currently open for each agent. Cleared by `turn.completed`, and by
  `session.ended` **from `payload.agentId`**, since that event is appended as
  `actor: 'system'`.
- **The card moves under the reply.** Agents edit before they narrate, so the
  card is created before the words explaining it; `agent.message.completed`
  splices it below. The capture shows it there.
- **Both providers feed it, from different events.** Codex reports a file change
  as its own item (`file.change.completed`, already counted). Claude has no such
  event at all — an edit is a tool result, and the patch on it is the only
  record, so `tool.completed` folds through `parseDiff` into the same card. This
  was missed in the first pass at 2b and would have shipped a card that stayed
  empty for the agent this machine actually runs.
- **Paths print relative to the project.** `Entry` takes the session's `cwd`;
  the full path stays on the row's `title`.

### Two things the capture caught that tests did not

- The **thinking rows in `Session.tsx`** are built by hand rather than by the
  reducer, and still used the pre-Phase-1 structure — so the name landed in the
  avatar column and the dot, now absolutely positioned, hung off the row's
  bottom-right corner. They now carry the same mark-and-head as every other step
  row, and say `Claude` rather than `claude`.
- **`direction: rtl`** on the path column — a trick for ellipsising the left of a
  long path — reordered a leading `/` to the end, so every row read
  `…/src/rate.ts/`. Gone with the absolute paths that motivated it.

### Tests

Twelve in `transcript.test.ts` (`changes card`): three separate reductions
building one card, replay equality against the incremental fold, the card sitting
after the message when edits came first, sums across a turn, a second turn
opening a second card, `session.ended` closing one under `actor: 'system'`,
declined and failed drawing nothing, a proposal drawing nothing, a rename folding
onto its own row, a malformed payload surviving, plus the two Claude paths — a
tool patch counted, and a created file lettered `A`.

### Verified, and not

- `pnpm check` green (same untouched `LOOP.md`).
- Driven in the running app three times; the first two runs are why the capture
  script now waits for the turn to **start and then end** rather than for "a
  reply completed" — an agent that says "I'll make both edits" satisfies the
  latter before touching anything.
- **Codex's half is still unobserved.** The card was photographed from Claude.
  Nothing has driven a Codex turn through `file.change.completed`, so that half
  remains typed-but-unseen.
- The e2e suite still has not been run.

## Phase 2a — the data the `Changes` card needs · shipped 2026-08-14 · uncommitted

No UI yet, and none of this is visible: 2a exists so the card in 2b is built on
data that is true.

### What shipped

- **`file.change.completed`** in `agent-protocol` —
  `{ itemRef, files: { path, oldPath?, change, added, removed }[], outcome }`,
  and **in `UNDROPPABLE`**. The proposal already was, so leaving the result
  droppable allowed the one pairing worse than losing both: "about to change this
  file", and never whether it did.
- **adapter-codex maps the completed phase**, which it previously threw away
  (`phase === 'started' ? … : null`). `kind` and `status` are typed by importing
  the generated `PatchChangeKind` and `PatchApplyStatus` rather than by
  hand-copying two enums — the drift trap this file has been bitten by twice.
- **The counts are computed in the adapter.** Codex's `diff` is raw file content
  for an add or a delete and headerless hunks for an update, and `parseDiff`
  needs a `diff --git` header — so parsing it downstream returns **zero for every
  Codex edit**. Every count assertion in the new tests is a number for that
  reason.
- **A rename crosses**: `path` is where the file went, `oldPath` where it was.
  Codex sends the reverse. Both are strings, so nothing but a test catches it.
- **`outcome` is three-way** — `applied | failed | declined`. A boolean would
  lose the difference between a patch the user refused and one that broke, which
  is the difference the open question about drawing those rows depends on. A
  completed item still reading `inProgress` is read as `failed`: a card must not
  claim a file changed on the strength of a missing field.
- **adapter-claude's created files now say so** — `new file mode 100644` and
  `--- /dev/null`. Without it a new file is a diff of pure additions, which is
  exactly what rewriting an existing one looks like.
- **`DiffFile.status`** in `packages/workspace`, read from the mode lines and the
  header's two paths, never guessed from the hunks.
- **Catch-up now reports what landed.** It was replaying `file.change.proposed`,
  which fires when the operation _starts_ — so a declined or failed patch was
  announced to the other agent as a changed file. The proposal case is now an
  explicit no-op with that reason.

### Boundaries kept

The adapter test asserts the synthesized create patch **as text**; the workspace
test parses that same text and asserts the letter. An adapter may not depend on
the workspace, so the string is the contract and each end owns one side of it.

### Tests

Eight in `adapter-codex/mapping.test.ts` (a case per `PatchChangeKind` including
the rename direction, a case per `PatchApplyStatus`, the missing-`kind` fallback,
and diff headers not counted as changes), two in `adapter-claude`, six in
`packages/workspace/diff.test.ts`, one rewritten in `catchup.test.ts` proving a
declined patch is not announced.

### Verified, and not

- `pnpm check` green (same untouched `LOOP.md` exception as Phase 1).
- **Not verified end to end**: no real Codex turn has been driven through this,
  so the claim that a `fileChange` completed item arrives with the fields the
  generated types promise is still a claim about types, not an observation. 2b's
  exit — a card from a real conversation with both agents — is what settles it.
- Open question 1 of the plan (which Claude edit tools produce a patch at all)
  is still open; it needs a real session to measure.

## Phase 1 — a message is a row, not a bubble · shipped 2026-08-14 · uncommitted

**Capture:** [`visuals/01-message-row.png`](visuals/01-message-row.png), 1440×900, from a
real exchange with Claude — not a fixture. Beside the golden
([`04-split-terminal-drag.png`](../readable-control-rail-2026-08-13/visuals/04-split-terminal-drag.png))
the row structure now agrees: round avatar, name, right-aligned time, unboxed
body starting beside the face and under the name.

### What shipped

- **`TranscriptMessage.at`**, from the event's `createdAt`, opened at the first
  delta and **carried through `agent.message.completed`** — which rebuilds the
  row from scratch and would otherwise stamp every reply with the moment it
  finished. `tool.started`'s refining event carries it too, the way it already
  carries the row's key.
- **`clockTime` in `format.ts`** — `Intl.DateTimeFormat`, hour numeric and minute
  2-digit, which is what the golden shows (`9:14 AM`). A locale argument exists
  so the tests are not asserting against whatever CI is set to.
- **The row**: `.entry` is a two-column grid, `32px 1fr`, with `avatar head` over
  `. said`. `ActorAvatar` draws a tinted disc with a glyph — a person for you, a
  machine for an agent — and `EntryHead` holds the name, anything inline (the
  handoff button, the thinking toggle) and the time.
- **The dot moved onto the avatar's corner** and gained one state: it pulses
  while a message streams, `prefers-reduced-motion` respected.

### Changed from the plan, and why

- **The rail is gone.** The plan said "the left accent bar goes" without naming
  `.rail`; in the code that bar _is_ the rail — a vertical line the dots were
  centred on, which the golden does not draw. It could not survive dots moving
  onto avatars. `--spare`, which existed only to hold the rail out of the room
  under the current turn, went with it.
- **`data-final`'s filled panel is gone too**, which the plan did not mention.
  With the bubble removed, the last answer was the only boxed thing left on
  screen — it reintroduced exactly the reading the row was meant to end. The
  answer is still marked, by brightness: its prose is lit where the working
  around it stays muted.
- **The user's avatar carries no dot.** The plan said the golden shows none
  there; the first capture had one anyway, because the dot was rendered for every
  actor. A mark that can only ever mean one thing is decoration.

### Tests

Six new in `transcript.test.ts` (`message times`), three in `format.test.ts`.
**Mutation-checked**: replacing the carry with `event.createdAt` fails
`keeps the first delta time through completion` and
`carries the opening time across separate reductions`, and nothing else — so both
guards are load-bearing rather than vacuous.

One of the six asserts something that is not about time at all: a run of
reasoning is still `status: 'streaming'` after a later message completes. Nothing
in the reducer ever completes a reasoning row, so a pulse bound to `status` alone
would run forever on every block of thinking. That fact is now pinned, because
the component depends on it.

### e2e specs rewritten, not deleted

Three assertions encoded the old composition and would now fail:

- `the voice rail runs through its own dots` → **`every dot sits on the mark it
belongs to`**. The rail is gone; the equivalent invariant is that a dot never
  escapes the avatar or mark it hangs off.
- The pinned-turn spec's `offRail` check (the header drew its own length of rail)
  — dropped; there is no rail to redraw.
- The narrow-pane spec's `offRail` → **the words clear the avatar at phone
  width**, which is where a column layout actually collapses.
- The final-answer spec asserted `border-left: 3px` and a filled background →
  now asserts the answer is **not** boxed and **is** lit relative to the rows
  around it.

### Verified, and not

- `pnpm check` green, apart from `docs/plans/readable-control-rail-2026-08-13/LOOP.md`
  — untracked, part of the uncommitted rail work, unformatted before this phase
  started. Not touched.
- Driven in the running app: question sent, reply streamed and completed, capture
  taken from that state. `rails: 0`, two avatars, two times, body 9px clear of
  the avatar and 34px below the head.
- **Not run: the 28-spec e2e suite.** The four specs above were edited without
  being executed — they need a real run before anyone claims they pass.
- Working tree is still the uncommitted rail work plus this. Nothing committed;
  a Phase 1 regression and a rail regression are currently one diff, which was
  the user's call on starting.
