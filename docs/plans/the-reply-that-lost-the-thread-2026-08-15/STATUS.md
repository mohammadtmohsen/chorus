# Status

## Phases 1–4 — shipped in one pass, 2026-08-15

`pnpm check` green: 1,696 tests pass, typecheck, lint and format clean.

Phases 1 through 4 landed together rather than separately, and that was a
correction to the plan rather than impatience. Phase 2 (the purpose) touched
`QuickQuestion.tsx`'s excerpt block and Phase 4 (promotion) touched the buttons
directly underneath it — splitting them would have shipped an intermediate state
where a recap card offered "Quote in message", which stages the whole scattered
reply into the composer. That is not a smaller version of the feature, it is the
feature backwards.

**Phase 5 has not been done.** Nothing has been driven in the running app. See
_What is not verified_ below, which is the part of this file worth reading.

## What shipped

| Piece                                              | Where                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `recapPrompt` + `taskAnchor` + `trimBothEnds`      | `main/runtime.ts`                                                                                       |
| The anchor read (user messages, mentions stripped) | `main/runtime.ts`, in `openAside`                                                                       |
| `purpose: 'recap'` through 8 definition sites      | `event-store/src/events.ts`, `shared/ipc.ts`, `main/ipc.ts`, `main/runtime.ts`, `renderer/src/aside.ts` |
| `recapPromotion`                                   | `renderer/src/aside.ts`                                                                                 |
| The button                                         | `Entry.tsx` action row, gated on `final`                                                                |
| `openRecap`                                        | `Session.tsx`, beside `openCard`                                                                        |
| Card branches: no excerpt, no Quote button, wider  | `QuickQuestion.tsx`, `styles.css`                                                                       |
| 4 i18n keys                                        | `i18n/en.json`                                                                                          |

## Corrections to the plan

**The action row's condition is the union of its buttons, not "a finished
message".** The plan said the guard "moves onto the button", which was half of
it. Moving it only onto the buttons leaves an empty `.entry-actions` under every
_user_ message, and that row carries a `margin-top` — a few pixels of drift under
every message you typed, with nothing on screen explaining them. The row now
tests `onHandOff !== undefined || (final && onRecap !== undefined)`.

**`opensWithATurn` needed no case.** The plan listed it as a branch. It is
written as `purpose !== 'question'`, so a recap was already correct. Only its
comment changed, to say that the shape is deliberate: a fifth purpose that opens
with a turn needs no edit, and one that does not is a visible decision rather
than a forgotten line.

**`asideHeading` has no pending variant for a recap**, unlike `explaining` /
`explainingPending`. There is nothing to resolve — no language, no passage — so
the heading is the same on the first frame as on the last. A test asserts the
language argument is ignored, specifically so the pair above does not get copied
into place by reflex.

**The card is 560px, not the ~520px the plan guessed.** Still guessed. The plan
said measure it against a real answer first; that has not happened, so this
number is the one thing here that should be expected to change. The height cap
is untouched.

**`stripLeadingMentions` is not exported**, so the anchor uses
`parseMentions(text, { participants: ['codex', 'claude'] }).text`, whose `text`
field is documented as "the message with its leading mentions removed, as the
agent should see it". Both agent ids are named rather than the live participants:
the job is stripping scaffolding, not routing, and a mention of an agent since
removed from the room is scaffolding too.

## Phase 5, and it rewrote the feature

Driving it did what the plan said it would, and more than expected: **the fork
was wrong, and the ledger I would have shipped was mostly noise.** Both were
found by running against the real store, neither by reading the code.

### The fork could not work when it was most wanted

Second real click: `claude has not started a session yet`. `finalKey` comes from
the log, which survives a restart; forking needs `participant.session.sessionRef`,
which is _live_ — Claude's id only arrives with its first message of the process
(`claude-adapter.ts:561`), and a resume that falls back to a fresh session has
none. So the button was offered on every replayed transcript and refused. Dead at
exactly the moment a recap is wanted: reopen the app, ask where you were.

**The reader is now a fresh session, and the prompt carries everything.** Not a
workaround — the better design, and the one the plan's own open question was
circling. A fork's memory is the thing that drifted; the log has not. The prompt
now says "you were not part of it", fences the facts off under a heading that
attributes them to Chorus, and works whether or not any agent is live.

`FakeAdapter` gained `startsWithoutRef`, because it handed out an id immediately
— more generous than either real provider. That gap is why a feature requiring a
ref passed every test here and died in the app. Two tests now cover the window:
a recap succeeds in it, an explanation still correctly refuses.

### The ledger, measured against 183MB of real log

Four findings, each of which would have shipped as a confident lie:

- **`file.change.completed` has never been written. Not once**, in 454
  conversations. Files are written through `Edit`/`Write` tool calls whose
  `tool.started.detail` is the absolute path. A ledger built on the obvious event
  would have reported "no files changed" for every conversation that has ever
  existed — and "none recorded" reads as a fact, not as a gap.
- **Every non-zero command exit belonged to a compound line.** Twenty of twenty
  sampled were `cd … && python3 - <<'PY' … | grep -E "×" | head` — whose status
  is the trailing grep's. Only simple lines are reported now, which keeps
  `pnpm check → exit 1` and drops the noise. The cost is silence about a build
  that failed inside a `&&` chain; that is the right way round, because a board
  listing five greps is read as five failures.
- **`/tmp` probe scripts crowded out real source files.** Half the busiest
  conversation's file list. Files outside the project cwd are dropped.
- **`agent claude exited unexpectedly; restarting` was the most common
  `error.raised`** in every conversation sampled — three of three in one. True,
  and not news about the work. Filtered.

Also: `/bin/zsh -lc '…'` wraps every real command, so unstripped, every failure
line began with the same fourteen characters and the useful part fell off the
trim.

`file.change.completed` is still handled, though nothing writes it. If a provider
starts, a board that ignored it would be wrong in the hardest direction to notice.

### What is still not verified

**No agent has answered this prompt yet.** The inputs are now real and checked;
the output is not. The "Leave out" list is still seeded from the original request
rather than from an answer that padded. The card has still not been seen, and
560px is still arithmetic.

**The ledger is blind to edits made through the shell.** One sampled conversation
— 10,039 events, 124 asks — reported zero files, because its edits went through
`python3 - <<'PY'` heredocs rather than the Edit tool. Real, and not fixable by
reading `tool.started`.

## First real click: a stale main process, not a bug

The first attempt to use the button failed with

```
Invalid request on "aside:open": values: ["question","explanation","translation"]
```

which reads exactly like the enum was never widened. It was — in the source. The
running `pnpm dev` had bundled `out/main/index.js` at 14:24 and the change landed
at ~14:50, and `grep -c recap out/main/index.js` returned **0**. Restarting the
dev server fixed it; the same grep then returned 14.

Worth writing down because of _which half_ was stale. The renderer reloads
through Vite, so it picked up the new button immediately and started sending
`purpose: 'recap'`. Main did not, so the two halves of one file — `shared/ipc.ts`
is imported by both — disagreed about what the contract said, and the error blamed
the value rather than the build. Any IPC contract change can produce this, and it
will always look like the change did not take.

**The mechanism is not established.** Main sources (`main/runtime.ts`,
`main/ipc.ts`) were edited in the same window and main still did not rebuild, so
"electron-vite does not watch `src/shared`" is a plausible story and not a
measured one. Not written into `CLAUDE.md`'s traps list for that reason — the
symptom and the fix are recorded here; the cause is not known.

## What is verified, and how

Unit tests only, but the sharp ones were proven by mutation rather than assumed:

- **`taskAnchor` keeps newest-first and returns oldest-first.** `kept.unshift`
  → `kept.push` fails 4 tests.
- **One message always survives its own budget.** Dropping the `kept.length > 0`
  guard fails 1.
- **The reply never reaches the prompt, and the mention never reaches the
  anchor.** Removing `parseMentions` and flattening the title branch fails 3.
- The recap's logged line is `Where are we?` while the fork receives the whole
  prompt — the same log/deliver split `explanation` and `translation` use.
- `containsPassage` still refuses a forged excerpt on a `recap`, which is the
  point of keeping the excerpt at all.
- A conversation with no user messages yet still produces a prompt.

## What is not verified

**Everything about how it reads.** The whole feature is a judgement about output
quality, and no unit test holds one. Nothing here has been run in the app:

- No recap has ever been generated by a real agent. The prompt has been read, not
  answered. The "Leave out" list is seeded from the request that prompted this
  feature, not from a real answer that padded — so unlike `explainPrompt`'s list,
  none of its five lines has yet been earned.
- The card has not been seen. 560px is arithmetic, not a measurement, and whether
  a board of five headings scrolls at 440px tall is unknown.
- The button's placement in the action row has not been looked at, and neither
  has what it does beside "Hand off →" in a two-agent room.
- Promotion has never been clicked, so whether the next turn actually starts from
  the board is the central claim of this feature and is untested.
- The e2e suite has not been run, deliberately — it is a separate, deliberate
  run (C-029).

## Open, carried from the plan

- **Whose recap, in a two-agent room?** The fork is of the last speaker's
  session, so the board is that agent's view; what the other agent did reached it
  only through catch-up's 12,000-char budget, which C-004 says nobody has
  measured. Shipped this way knowingly.
- **Does the anchor need the ledger?** If real answers get `Done` wrong —
  claiming work that never ran — the fix is `summariseSession`'s counted facts,
  which live in the renderer and would have to cross the main boundary. Not done.
- **Is 4,000 chars right?** Guessed. C-004's question in miniature.
