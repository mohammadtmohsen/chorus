# Explain the whole reply

Asked for as: _"still getting this error when select large text — let's adjust
Explain simply to be a button below the Handoff button, to explain the response
in my language, not only the selected text."_

The error is `Error invoking remote method 'aside:open': Error: That passage is
not part of that reply`.

## Why it happens, and why "large" is the tell

`openAside` re-resolves the source event from the log and refuses an excerpt it
cannot find in it (`runtime.ts:1447`). The comparison is
`containsPassage({ said, excerpt })` — the reply's markdown, and the reply's
markdown projected through the same parse tree the renderer draws
(`shared/plain-text.ts`), both collapsed to one space per run of whitespace.

That guard is right and is not the thing to loosen: the renderer is the least
trustworthy thing in the process tree, and a caller that could name any event
and any excerpt could put words in an agent's mouth and have them quoted back as
its own.

What is wrong is that the DOM lets you select **chrome inside `.entry` that no
block in `blockText` emits**.

**Corrected after reading the CSS — the first version of this section was
wrong.** It named the fence's language label as the culprit, which is a real gap
in `plainTextOf` and is already closed a level up: `styles.css:1784` puts
`.md-lang` in a `user-select: none` list, written for exactly this failure and
carrying the measured Chromium strings in its comment (`"TSconst a = 1"`). The
projection never sees the token because the selection never contains it. Editing
`blockText` would have been a fix to nothing, and it is the reason to read the
stylesheet before the parser.

What that list **misses** is two things, and both sit at an end of the drag
people actually make:

| Selectable in the DOM                         | Why it cannot match                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.entry-time` — the clock beside the speaker  | `.speaker` was excluded, its own head-mate was not, so a drag starting above the words takes `14:32`                                                          |
| `.summary-head` — the summary card's own word | drawn `Summary` from `i18n/en.json`; `blockText` uppercases the heading it was cut from to `SUMMARY`, and `containsPassage` keeps case significant on purpose |

That is why the failures cluster on long selections. Selecting a whole answer
means starting at the top — where the time is — and dragging to the bottom, which
on any reply that ends in a summary lands inside the card. A one-line drag inside
a paragraph meets neither.

So the fix that belongs in this change is one more line in that same
`user-select` list, not a change to the projection. The general problem — that
the list is opt-out and nothing makes a seventh piece of chrome join it — is
C-041.

## The shape: stop asking a selection to be the input

The request reframes the bug rather than patching it. Explaining a reply in your
own language is not a question about a passage — it is a question about the
reply — and the selection was only ever how it got there.

So **Explain becomes an action on the reply**, beside `Hand off →` in
`entry-actions`, and its excerpt is `message.text`. That is exactly what Recap
already sends and what main already accepts: the excerpt authenticates _which
agent said this, in which session_, and for a whole reply it is a prefix of
`said` by construction. There is no projection left to disagree with, so this
path cannot raise the error at all.

**Translate keeps the selection**, and should: translating a whole reply is a
different feature, and a passage is genuinely its subject. `Ask about this` keeps
it for the same reason — so the two missed selectors are fixed here as well,
because those two still go through that path.

**The shape of that bug is deliberately not fixed**, and goes to `BOARD.md` as
C-041: a projection that cannot see the chrome, guarded by an opt-out list of
selectors somebody has to remember to add to. The honest repairs are all bigger
than this change — send the source offsets instead of the rendered text, or make
`.said` the only selectable region of an entry by construction.

## What changes

**`styles.css`** — `.entry-time` and `.summary-head` join the `user-select:
none` list, with the comment saying which end of the drag each one broke.
`plain-text.ts` is untouched, for the reason recorded above.

**`Entry.tsx`** — a third tenant in the actions row: `onExplain?: (message,
from: DOMRect) => void`, rendered inside `entry-actions-do` directly after
Handoff, on any finished agent message. Not gated on `final` the way Recap is —
Recap is about where the work stands, which is only ever a question about the
last reply, while any reply can be the one you did not follow. The row's union
condition grows a third arm.

**`Session.tsx`** — `openExplain`, sibling of `openRecap` and near enough its
twin: same anchor-from-a-button-rect, same `inPane` conversion, excerpt is
`message.text`, purpose is `explanation`. The offer loses its Explain button;
Quote, Ask about this and Translate stay.

**`App.tsx` → `Session`** — `explainLanguage` moves up. It is read on mount and
re-read when the Settings sheet closes, then passed down, replacing the
per-selection `readSettings()` Session does today. A button that lives under
every reply cannot wait for a selection to learn whether it should exist, and
"re-read when the sheet that edits it closes" is the only moment the value can
change from inside the app.

**`QuickQuestion.tsx`** — `explanation` joins `recap` in not drawing the excerpt
blockquote. The card is anchored under the reply it explains; repeating the whole
reply inside it would push the answer off the card, which is the exact reason the
recap branch exists.

**`aside.ts`** — `explanationPromotion`, and this is the second place the plan
was written before reading the code. It said `promotion()` would be left alone.
It cannot be: `promotion` opens by quoting the excerpt, which was the passage you
chose and is now the agent's own entire last message. Taking an explanation
forward would have staged that whole reply back into the composer for the agent
that wrote it. The new function keeps the two load-bearing parts — the mention,
because routing is by mention, and the sentence marking the answer as reported
rather than remembered — and drops the quote. `QuickQuestion`'s Quote button
goes with it, for the same reason a recap has none.

**`i18n/en.json`** — `settings.explainNote` currently opens _"When you select part
of a reply…"_, which stops being true. It has to say that Explain is offered
under every reply and Translate on a selection. `conversation.explainSimply` is
reused as the button's label; the words did not change, only where they sit.

## What this does not do

- It does not loosen `containsPassage`. The one guard that authenticates a
  passage's author stays byte-for-byte as strict as it is.
- It does not add a length cap for the new path. `MAX_EXCERPT_CHARS` is about
  what a _question_ may carry; a reply is as long as it is, and Recap already
  sends whole replies with no cap.
- It does not add a second Explain anywhere. The selection offer loses it
  outright rather than keeping a passage version alongside the reply version.

**It does touch `explainPrompt`, which the plan said it would not** — the third
correction. Every "the passage below" in it was about to point at a whole answer,
and the line that matters most is the length: a model told it holds a passage
reads a long one as licence for a long explanation, which is a second long answer
rather than a way through the first. So the subject is named as the reply and the
hundred words are held against it explicitly.

## Verification

`pnpm check`, then drive it: set a language in Settings, ask an agent something
long enough to contain a fenced block and a trailing summary, and use the button.
The old repro — drag-select that whole reply and hit Explain — is gone by
construction, so the honest test of the `user-select` fix is `Ask about this` on
a drag that starts above the first line and ends inside the summary card, which
failed before.

`e2e/specs.mjs` asserted the offer has four actions and now asserts three.

## Open questions

- Explain under every reply, or only under the last one? Written as every reply
  above. The cost is a third button on every row of a long transcript; the cost
  of the other choice is that the reply you did not follow is usually not the
  most recent one.
