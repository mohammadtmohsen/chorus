# The reply that lost the thread

Asked for as: _"the last msg is too long and talk about many thing not related
directly to the task — it's useful but scattered. I need a button [to] make the
response more straight and direct and focus to the main task we working in."_

## Context

A long reply is not the problem. A long reply that has stopped being **about the
task** is. The complaint is precise and worth reading twice: the extra material
is _useful_ — it is not filler, it is not hallucinated — it is simply about four
other things, and by the time you reach the end you can no longer say what was
actually finished or what happens next.

Two mechanisms produce that, and both are documented rather than guessed:

- **Positional decay.** Models recall the beginning and the end of a context and
  degrade in the middle — the same U-shaped serial-position curve people show.
  ([Lost in the Middle](https://arxiv.org/html/2510.10276v1)) The task statement
  is usually in the middle by turn twenty. So the agent drifts toward whatever it
  most recently touched, which is what "not related directly to the task" is.
- **The reader has the same problem.** A reply of nine paragraphs is skimmed, and
  skimming a reply is how a decision made in paragraph six gets lost.

So the answer is not "ask it to be shorter." It is **a second, separate artefact
whose only job is to re-state the task and the state of it** — anchored to the
user's own words, which is the one thing in the conversation that cannot drift.

**Outcome:** a `Recap` action on the last finished reply. It opens a card holding
five short lines under four headings, and a button that puts that card into the
composer so the _next_ turn starts from the task rather than from the tangent.

## Why this is not the Summary panel

`summary.ts:302` already has `summaryPrompt`, wired to "Ask an agent" in
`SummaryPanel.tsx:161`. It is close enough that building beside it needs a reason.

|                | **Summary panel**                            | **Recap**                                          |
| -------------- | -------------------------------------------- | -------------------------------------------------- |
| Subject        | the **session** — every agent, every file    | the **task** — the one thing being worked on       |
| Anchor         | counted facts from the log                   | the user's own messages, verbatim                  |
| Question       | five open questions, "with a heading each"   | four bounded sections, capped in lines _and_ words |
| Where it lands | an ordinary `user.message` in the transcript | a read-only fork; the room stays clean             |
| What it is for | reporting on work                            | resuming work                                      |

The sharp difference is the last row. The summary panel is a report you read once
at the end. A recap is read **mid-task, repeatedly**, which is why it must be
free to run — a feature that costs a permanent turn in the transcript every time
gets used twice and then avoided. Folding this into `summaryPrompt` would mean one
string holding "answer five open questions" and "write at most ten capped lines",
and the first bad answer would be fixed in a direction that damages the other.

## Shape

**A fourth aside purpose.** The aside machinery already does this exact shape of
work — fork the agent that spoke, ask one thing, show it in a card, never touch
the parent, refuse to act (`runtime.ts:774`, `conversation-service.ts:704`). The
`docs/plans/translate-a-passage-2026-08-10` plan is the template for adding one,
and its cost estimate holds here.

Three things make a recap different from the three purposes that exist, and each
is a real branch rather than a flag:

1. **It is not anchored to a selection.** Every existing purpose starts from
   highlighted text and `openCard` (`Session.tsx:563`) reads `selected`. A recap
   starts from a **button on the last reply**, so it needs a sibling opener that
   builds the anchor from the button's own rect. `fitCard` (`aside.ts:94`) takes
   it unchanged — its doc already spells out the rect arithmetic.
2. **Nothing is quoted.** The other three quote the passage into the prompt; this
   one must not, because summarising the last reply is precisely the failure. The
   excerpt is still sent and still verified by `containsPassage` — the guard
   authenticates _which agent said this and in which session_, which a recap needs
   as much as an explanation does — it just never reaches the prompt or the card.
3. **Its anchor comes from the log, not the fork.** Below, and it is the part
   that makes this work at all.

### The anchor: the user's own messages, read out of the store

The fork inherits the agent's session **as persisted**, which means it inherits
whatever compaction has already thrown away — and compaction is, in this repo's
own words, "the one moment the transcript and an agent's memory stop agreeing."
Asking a drifted context to describe the task it has drifted from is asking the
symptom to diagnose itself.

The event log has not drifted. So main reads the parent conversation's
`user.message` events and puts them in the prompt verbatim, as the definition of
the task. This is the same move Claude Code's own compaction prompt makes with its
_"All user messages"_ section, and for the same reason.

Concretely, in `openAside`, which already holds `this.store.read(conversationId)`:

- filter to `payload.type === 'user.message'`;
- run each through `stripLeadingMentions` (`mentions.ts:70`) — `runtime.send:700`
  logs the raw typed text, so `@claude` is in there and is scaffolding, not task;
- take the most recent first under a **4,000-char budget**, each message capped at
  `catchup.ts`'s existing `MAX_MESSAGE_CHARS` of 1,500;
- disclose what was dropped the way `catchup.ts:88` does — `(N earlier messages
omitted)` — because a silently truncated anchor is worse than a short one.

**Deliberately not the whole ledger.** `summariseSession` (`summary.ts:80`) would
add files touched, failed commands and denied approvals, and it is tempting. It
lives in the renderer, and aside prompts are built in main on purpose
(`shared/ipc.ts:757`: _"prompt content from the renderer is the same class of
problem as an unverified source event"_). Moving a pure fold across that boundary
is a second change wearing this one's clothes. Parked as an open question.

### `recapPrompt(asked: string[], omitted: number)`

Written against what a recap is, not by editing `explainPrompt`. Every rule below
is either a lesson already recorded in this file's neighbours or a direct answer
to something the request named.

```
Someone has lost the thread of this conversation and needs to see where it stands.

Your reply is a status board, not a message. Four headings, in this order —
Task, Done, Open, Next. Nothing before them and nothing after them.

Task — one line. What is being worked on, taken from what the user asked for in
their own words below. Not what you happened to be talking about last.

Done — up to four lines. Only what is actually finished, each naming the file,
command or decision it refers to. If something has not been run or checked since
it changed, end that line with "unverified".

Open — up to three lines. What is unfinished, blocked, or waiting on the user.
Say what each one is waiting on.

Next — exactly one line, beginning with a verb. The single action that comes next.
It must follow from the user's most recent request, not from a tangent.

Then, only if there is something for it, a fifth heading — Parked — up to two
lines, for things raised that are worth keeping but are not part of this task.
Anything off-task goes there and nowhere else.

Fifteen words a line at most. No sub-bullets, no prose paragraphs, no preamble,
no closing remark. Omit Done or Open entirely if there is nothing true to put in
them; never pad a section to fill it.

Leave out:
- anything from your last reply that is not one of the five things above;
- how something works, or why a decision was right;
- suggestions, options or offers you were not asked for;
- praise, apology, or remarks about this conversation;
- restating the user's request beyond the one Task line.

If something is not in the conversation, leave the line out rather than inferring
it. A short board is correct. A padded one is not.

Do not continue the work or change anything. Write the board and stop.

These are the user's own messages, from Chorus's log. They define the task:

(3 earlier messages omitted)
> …
> …
```

Why each part is there:

- **The board framing leads.** `explainPrompt:217` records the lesson — _"Lead
  position, because the first clause is the one the model commits to"_ — learned
  from a real answer that ignored a rule stated later. "Not a message" first.
- **`Task` reads from the user's words, and says so twice** — once in the section
  rule, once at the bottom where the messages actually are. This is the whole
  mechanism against drift.
- **Capped in lines _and_ words.** `explainPrompt:234` records that "short"
  drifted twice before a number fixed it. Two numbers here, because a cap on lines
  alone produces four very long lines.
- **`Parked` is the answer to "useful but scattered."** The off-task material is
  worth something; the request says so. Given nowhere to go it leaks back into
  `Done`. Given a bounded home it is preserved and quarantined at once.
- **`unverified` on `Done`** is this Mac's standing rule — _"say when something is
  unverified"_ — and it is the line most worth having, because "done" and "done
  and checked" are what a recap is read to tell apart.
- **The do-not-work clause is not optional.** All three existing aside prompts
  carry it (`runtime.ts:176`, `:257`, and translate's), because without it a fork
  treats the request as the next turn and starts working — which no permission
  rule catches, since reading files is allowed. A request for a status board looks
  more like a task than a question does.
- **"Leave out" is a list, not a paragraph**, matching `explainPrompt:225`. Its
  five lines are seeded from the request's own description of what arrives unasked;
  expect to add to it after real answers, and record each addition's cause.

### Promotion — the part that fixes the next turn, not just this one

`aside.ts:132` already has `promotion(agent, excerpt, answer)` for _"take this and
continue"_, and `QuickQuestion.tsx:460` already wires it to the composer. A recap
needs its own, because it has no excerpt and a different claim to make:

```
@claude

> Task — …
> Done — …
> …

This is a recap you wrote in an aside, which is not in this conversation.
Work from it. Stay on the task it names.
```

The `@mention` is load-bearing: `runtime.send` only guarantees reaching a specific
agent through an explicit mention (`mentions.ts:32`), and `lastAddressed` is not
necessarily the last speaker. The "not in this conversation" label is the same
honesty `promotion` and `catchup.ts`'s `[Chorus]` marker exist for — the agent
does not remember writing this, and an agent acting confidently on a conclusion it
cannot place is worse than one that asks.

It stages into the composer and does **not** send (`QuickQuestion.tsx:444`
precedent). The recap is worth reading before it becomes the next turn.

## Where the button lives

`.entry-actions` already exists as a reserved grid row under an entry's words
(`styles.css:1396` grid-template-areas, `:3687`), currently holding exactly one
tenant, `.handoff-action` (`Entry.tsx:707`). Recap is its second, styled to match.

Two things fall out for free:

- **"Last reply only" is already computed.** `Session.tsx:821` builds `finalKey`
  and passes `final` to `Entry` (`:836`), and it is deliberately `null` while
  `view.busy` — so the button cannot exist mid-turn. That matters more than it
  looks: `runtime.ts:810` refuses to fork on a reply still arriving, so without
  this the button's most obvious click would be an error dialog.
- **The row's guard has to move.** It renders only when `onHandOff !== undefined`
  (`Entry.tsx:707`). With two tenants the condition belongs on each button.

`Entry` is `memo()`, and `Session.tsx:848` already defeats it with an inline
`onHandOff` arrow. The new callback should be `useCallback`'d rather than adding a
second one — `Entry.tsx:11` explains what that costs during streaming.

## What it touches

Read out of the code, in the shape the translate plan used. **Eight definition
sites, ten behavioural branches.**

| Definitions                                   | Branches                                                       |
| --------------------------------------------- | -------------------------------------------------------------- |
| `event-store/src/events.ts:67` (zod enum)     | `runtime.ts:905` needs no language                             |
| `event-store/src/events.ts:374` (`AsideMeta`) | `runtime.ts:984` which first turn is sent → `recapPrompt`      |
| `shared/ipc.ts:759` (`aside:open` purpose)    | `runtime.ts:946` the aside's title                             |
| `main/ipc.ts:626`                             | `runtime.ts` new: read + trim the user's messages              |
| `main/runtime.ts:784`                         | `aside.ts:175` `asideHeading` — compiler forces the case       |
| `renderer/src/aside.ts:153` (`AsidePurpose`)  | `aside.ts:204` `opensWithATurn` — recap does                   |
| `Session.tsx:175` (`askingAbout`)             | `QuickQuestion.tsx:380` excerpt blockquote hidden              |
| `QuickQuestion.tsx:60` (prop)                 | `QuickQuestion.tsx:460` recap promotion, no excerpt            |
|                                               | `Entry.tsx:707` row guard moves to the button                  |
|                                               | `Session.tsx` new `openRecap(message, rect)` beside `openCard` |

`events.ts:392` already defaults a purpose-less aside to `question`, so rows on
disk are unaffected. New i18n keys in `en.json` beside `aside` (~L441):
`aside.recap` (the button), `aside.recapping` / `aside.recappingPending` (the card
heading, matching the `explaining` pair), `aside.useRecap` (the promote button).

**One styling decision.** `.quick-question` is `width: min(420px, …)` and
`max-height: 440px` (`styles.css:779`). Four headings and ten short lines is more
than an explanation's hundred words of prose. A `--recap` modifier widening to
~520px is likely; measure it against a real answer before writing the number, and
if it scrolls a little, let it — a card that grows past the pane is the failure
that cap exists for.

## Phases

1. **The prompt and the anchor, in main.** `recapPrompt` + the user-message read,
   with unit tests over the trimming and the omission notice. Reachable by hand
   through `aside:open` with `purpose: 'recap'` before any UI exists.
2. **The purpose, end to end.** Enum through all eight definition sites, the
   `runtime.ts:984` arm, the two `aside.ts` switches, the card's two branches.
3. **The button.** `Entry.tsx` action row, `openRecap`, the anchor arithmetic.
4. **Promotion.** `recapPromotion` + the composer staging.
5. **Tune against real answers.** Drive the app on a genuinely long, drifted
   conversation. Every line added to "Leave out" gets a comment saying which real
   answer caused it, matching `explainPrompt`'s.

## Deliberately not doing

- **Not a turn in the transcript.** The room stays clean; promotion is the opt-in.
- **Not recapping any reply but the last.** Explain and Translate are available on
  every past passage; a recap of a state that is three turns stale is a worse
  answer than no recap.
- **Not automatic.** No recap on a length threshold, no recap on turn count. A
  status board that appears unasked is another long thing to skim.
- **Not the session ledger.** `summariseSession` stays in the renderer. See above.
- **Not a second summariser for the Summary panel.** They stay separate features
  with separate prompts.

## Open questions

- **Whose recap, in a two-agent room?** The fork is of the last speaker's session,
  so the board is that agent's view — what the other one did reached it only
  through `catchup.ts`'s 12,000-char budget, which C-004 says nobody has measured.
  Acceptable for a first cut; say so in `STATUS.md` rather than discovering it.
- **Does the anchor need the ledger after all?** If real answers get `Done` wrong
  — claiming finished work that never ran — the fix is `summariseSession`'s facts,
  and that is a boundary decision worth its own entry.
- **Is 4,000 chars of user messages right?** Guessed, not measured. C-004's
  question in miniature, and cheap to answer once the feature runs.

## Verification

- `pnpm check` — the gate.
- Unit: `recapPrompt` shape, the 4,000-char budget, the omission notice, and
  `stripLeadingMentions` removing `@claude` from the anchor. Prove each fails
  without its fix.
- Unit: `asideHeading` and `opensWithATurn` for `'recap'`; `containsPassage` still
  refusing a forged excerpt on a recap.
- `apps/desktop/src/renderer/src/aside.test.ts` for `recapPromotion`.
- **Drive the app.** `pnpm dev`, a real conversation of twenty-plus turns that has
  drifted, click Recap, and read what comes back — the whole feature is a
  judgement about output quality and no unit test can hold it. Then promote it and
  check the next turn actually starts from the task. Report what was observed.
- Not covered: the e2e suite is a separate, deliberate run.
