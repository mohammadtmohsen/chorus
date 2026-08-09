# Explain in my language

Select a passage you did not follow and have the agent say it again in your own
language, in its own words, with everything it knows about the conversation.

Status: **not started, revised once after review.** A follow-up to
`ask-on-the-fly`, which it depends on entirely — the fork, the hidden child
conversation, the card and the read-only boundary are already built.

The first draft got the product decision right and the contracts wrong. What
changed, and why, is recorded in "What the review corrected" below rather than
quietly folded in.

---

## The problem, and why it is not translation

Asked for, in the user's words: _"when I ask for translation and select a few
words of response that means I'm not getting it right — explain in my language."_

That sentence is the whole design. Selecting three words and pressing translate
is not a request for those three words in another language; it is someone saying
**I did not follow this.** A literal translation of a sentence you did not
understand is a sentence you still do not understand, now in your own language.

So the feature is not a translator, and should not be built as one:

- A translator works on text. This works on a **passage in a conversation**, and
  the fork already knows the conversation — why the agent chose that approach,
  what the file it names does, what was decided three turns ago.
- A translator preserves register. This should **lower** it. The reason someone
  is asking is that the original was too dense.
- A translator leaves technical terms alone or mangles them. This keeps
  `projection`, `WAL`, `fork` as the terms they are and explains each one, in the
  requested language, immediately after using it.

### Simpler, and in your own language — both, neither optional

Sharpened after the first revision, and it changes the shape: _"the answer should
be simplified in basic language — I don't know something and want to make it
clear for me."_

Two things at once, and neither is optional: **simplified, and in the reader's
own language.**

**The register has to be chosen deliberately.** "Basic language" is not
baby-talk, and getting that wrong is the likeliest way to make the feature
annoying rather than useless. The person asking is a competent developer who has
hit something they have not seen before — not someone who needs programming
explained. The target is a colleague turning to another colleague and saying
_"sorry, what does that mean?"_: short sentences, concrete over abstract, no
jargon except the jargon being explained, and no lecture around it. An answer
that explains what a database is, to someone who asked what a projection is, has
failed in the other direction.

**Simplifying is not a substitute for translating.** A revision of this plan
briefly had an unset language mean "simplify in place", reasoning that a dense
English sentence explained in simpler English is the same request. It is not, and
the correction is the user's: _"no — it should be in my native language, like
Arabic."_

Reading a second language costs effort even when you read it well, and here that
cost is being paid on top of not having understood the thing. Simplifying without
translating removes one of those and leaves the other. So the language is
**required**: an unset one means the action does not appear, because the feature
is not "make this simpler", it is "make this clear to _me_".

Calling the action "Translate this" would be a promise to do the wrong thing. The
working label is **"Explain simply"**.

**Fixed rather than naming the language, and this is a real trade.** "Explain in
Arabic" puts the language where it is discoverable and answers "what will this
give me" before the click. But it also makes the pill's width depend on a string
the user typed, and a pane can already be too narrow for two fixed labels — that
overflow was found and fixed once in `ask-on-the-fly` and a user-supplied label
would reintroduce it in a form no constant can bound.

So the lean is a constant label with the language in the card's heading —
_"Explaining in Arabic"_ — where it is read at the moment it matters. If seeing
the language on the button turns out to matter more than the width, that is a
decision to make on the running app, and it is listed as an open question rather
than settled here.

## The shape

Almost nothing new. `ask-on-the-fly` built the expensive parts:

|             | Ask about this                     | Explain in {language}                  |
| ----------- | ---------------------------------- | -------------------------------------- |
| classifier  | `askableSource`                    | the same, unchanged                    |
| session     | fork of the passage's author       | the same                               |
| storage     | hidden child conversation          | the same, plus purpose and language    |
| permissions | read-only, `neverAsks`, own grants | the same                               |
| card        | `QuickQuestion`                    | the same, input hidden until an answer |
| prompt      | the user's question                | the explain instruction, built in main |

## The opening contract: the click starts it, not the card

The first draft had the card boot its fork in a mount effect and — for this
feature — send the prompt from the same place. That is wrong in two ways that
both cost the user money.

React invokes a mount effect **twice** in development. Existing cleanup closes
the first fork, but a prompt sent from mount has already been sent and already
persisted before any cleanup runs, so the fix that works for a leaked process
does not work for a paid turn. Dismissing during the boot has the same shape.

So the contract changes for **both** actions:

- **The click handler opens the aside.** `Session` calls `openAside` once, in the
  handler, and passes the resulting promise to the card. A click happens once per
  click; a mount effect does not.
- **The card never boots and never sends on mount.** It receives a promise, waits
  on it, subscribes, and renders. Its only send is a follow-up the user types.
- **`openAside` takes the purpose** and builds the prompt in main. For an
  explanation the first turn is part of opening, so there is exactly one place
  that can send it and exactly one call that can reach that place.

This costs `ask-on-the-fly` nothing: the boot still starts on click, which is
what buys the ~1.4s first token, and the double-invoke window closes for the
existing feature too.

## The action is the whole question

There is nothing to type. Selecting and pressing says everything: _this, in my
language._ The card opens, the first turn is already on its way, and the
follow-up input appears only once an answer has arrived — after which it is an
ordinary aside.

That is a better interaction than the aside's, and **slower**. The aside reaches
~1.4s because the CLI boots while the user types; this has no typing, so the
honest expectation is the cold figure, around four seconds.

Rejected: booting on selection (a CLI per drag) and on hover (speculative, and
invisible to the keyboard). The card appears instantly with the passage and the
working pip, and can be dismissed mid-flight. If four seconds proves intolerable
in use, hover-boot is a small change and this section reopens.

### Focus, when there is nothing to focus

The card focuses its textarea on mount today. In explanation mode the textarea is
not there and the toolbar that was clicked has gone, so focus would fall to the
document and Escape would be the only key that worked.

- Initial focus goes to **the card itself** (`tabIndex={-1}`), so it is the
  Escape target and a screen reader announces what opened.
- The heading and `aria-label` differ by mode: asking names the agent, explaining
  names the agent and the language.
- When the follow-up input appears after the answer, it **does not take focus**.
  The user is reading; moving the caret under them mid-sentence is the same
  mistake as a card that resizes while it streams.

## The setting

One global preference in Settings, beside model and effort. Not in the card: the
language is a fact about the reader, and a picker in a tooltip would ask the same
question every time.

**Free text, not locales.** A picker offers `ar-LB`, `fr-FR`, `es-419`. What this
wants is what the user would say to a colleague — "Arabic", "Lebanese Arabic" —
— and "simple Arabic" or "Lebanese Arabic" if the dialect matters, which a locale
list cannot express and a person can. The field needs **persistent helper text**
rather than a placeholder that vanishes on the first keystroke, because what it
accepts is wider than the word "language" suggests.

**Free does not mean unconstrained.** `z.string().default('')` alone accepts
newlines, whitespace and arbitrary length — which would produce a blank-looking
action, an oversized prompt, and a single button wider than a pane no measurement
can rescue. So:

- trimmed on write, collapsing internal whitespace to single spaces;
- one line — newlines are stripped, not rejected, because a paste should not
  become an error;
- a maximum of 40 characters, enforced in the schema and in the field;
- whitespace-only is empty, and empty means the action does not appear.

**Empty means the action does not appear.** Not "default to English": the feature
exists to answer in the reader's own language, and there is no sensible guess at
what that is. Chorus cannot detect it, the system locale is a different fact
about the machine rather than about the person, and an English-speaking user has
no use for the action at all. Setting a language is the opt-in, which also makes
the Settings row where the feature is found.

### Where the field goes, and who owns the value

**Not inside the model fieldset.** `Settings.tsx:278` returns `null` for that
whole block when no live Claude model list exists, so a language field placed
there would silently vanish on a machine whose CLI has not been asked yet.

**The renderer's copy is for the label only.** `App` reads settings once at
`App.tsx:305` and destructures `{agents, cwd, profileId}`, discarding the rest —
so nothing mounted would learn the language had changed. `App` therefore holds
`explainLanguage` in state, refreshed on mount and after any settings write, and
passes it down for the button's label and for whether the button exists at all.

**Main reads the authoritative value when opening.** `openAside` does not accept
a language from the renderer. The renderer is the least trustworthy thing in the
process tree and already re-resolves its source event for that reason; a language
string is prompt content, and prompt content from the renderer is the same class
of problem.

### What the setting is not

It does not translate Chorus's interface. Menus, buttons and notices stay in
`i18n/en.json`, which has its own machinery and tests. One is the app's voice, the
other is the agent's, and the Settings copy has to say so in a line rather than a
paragraph.

## What the log has to remember

"Same storage" was too glib. An aside currently records its parent and its source
event, and its first user message is the question as typed. An explanation has no
typed question, so without a decision here the log would hold answers in Arabic
with nothing saying what was asked or why.

The log is append-only, so this cannot be added later for rows already written —
which is the argument for deciding it now rather than deferring it to the
reopening question:

- the aside's metadata gains **`purpose: 'question' | 'explanation'`** and, for an
  explanation, **`language`** — the language as it was at the time, because the
  setting can change and a row explaining what a passage means in Arabic does not
  become a French row later;
- the first user message is logged as the **visible intent** — "Explain this in
  Arabic." — while the provider receives the full instruction, which is exactly
  the split `sendUserMessage(logged, delivered)` already exists for.

`purpose` is a discriminated addition to the existing optional `aside` object, so
old rows continue to parse as ordinary conversations and asides written before it
read as `'question'` by absence.

## The prompt

Built in main, pure, testable without a provider. **Level first, language
second** — that ordering is the feature, and a prompt that leads with the
language produces a faithful translation of something still too dense.

It must say, in substance:

- someone did not follow this passage; say what it means, plainly;
- short sentences, concrete over abstract, one idea at a time;
- no jargon except the jargon being explained — and explain that where it
  appears rather than assuming it;
- identifiers, file names and technical terms stay exactly as written, each
  explained immediately after it appears;
- you have the whole conversation; use it, and say _why_ where the why is the
  confusing part;
- do not restate the passage, and do not expand the scope — answer what was
  asked and stop;
- answer only this, and change nothing.

And, layered on top rather than replacing any of it:

- **all explanatory prose is in `{language}`** — not a bilingual answer, and not
  a drift back to the conversation's language after the first sentence.

Two failure modes the wording has to work against, both of which read as a bad
feature rather than a bad prompt:

**Condescension.** "Explain simply" invites an answer that starts from first
principles, which is insulting to someone who understood every word except one.
The prompt names the reader as a developer working in this project who has not
met this particular thing, which is what they actually are.

**Length.** A model asked to explain will keep explaining. A passage of one
sentence deserves an answer of two or three, and the card is 190px tall by
design — an essay in it is a scroll bar where a sentence was wanted.

The do-not-work clause is not optional: `ask-on-the-fly` found a fork treats a
question as the next turn of the work and starts doing things, which no
permission rule catches because reading files is allowed.

The language clause is this firm in the **first** version rather than after a
retry affordance is built, because the likely failure is a model drifting into
English on an identifier-heavy passage, and the cheap fix is the prompt.

## Direction, which the setting cannot tell us

An Arabic answer rendered left-to-right is not merely ugly. Punctuation lands at
the wrong end of the sentence, a trailing full stop jumps to the left of the
line, and a passage that mixes Arabic prose with `snake_case` identifiers — which
is precisely what this feature produces — reorders into something that reads
wrongly rather than looking wrong. The reader cannot tell a rendering fault from
a bad answer.

**The setting cannot tell us the direction, and that is the point.** "Lebanese
Arabic", "simple English" and "français" are what the field accepts by design, so
there is no language code to map to `rtl`. Any attempt to derive direction from
that string is a lookup table that will be wrong for the first user who types
something reasonable.

So direction is inferred from the text itself, not from the setting:

- the answer renders inside **`dir="auto"`**, which takes its direction from the
  first strong character — right for Arabic and Hebrew, right for English, and
  right for a language nobody thought of, with no list to maintain;
- **inline code and identifiers are isolated** (`unicode-bidi: isolate`, or
  `<bdi>`), so `hard-redeploy.ps1` inside an Arabic sentence stays a single
  left-to-right run instead of being reordered around the surrounding text. This
  is the case the feature creates deliberately by keeping identifiers untranslated;
- **paragraph by paragraph, not once for the block.** An answer that opens with
  an English identifier and continues in Arabic would otherwise take its
  direction from the wrong first word.

Three places this reaches beyond the answer:

1. **The excerpt and the answer disagree.** The passage is the agent's original
   English; the answer is Arabic. Both live in the same card, and each needs its
   own direction rather than the card picking one.
2. **The card's chrome does not flip.** Chorus's interface is English and stays
   left-to-right — the heading, the buttons, the close. Mirroring the whole card
   for an Arabic answer would be applying a locale the app does not have.
3. **The composer.** A promotion carries a quoted English passage _and_ an Arabic
   explanation into one textarea. `dir="auto"` there is an improvement and not a
   solution: a genuinely mixed draft has no single correct direction, and the
   honest position is that the user is editing it anyway. Worth looking at in
   Phase 4 rather than engineering in advance.

`MarkdownView` builds from a typed tree, so this is a property applied where the
tree is rendered rather than anything parsed out of the text — and there is no
`dangerouslySetInnerHTML` to reach for, which is the usual way bidi handling goes
wrong.

## The offer, and measuring it

A third action on a pill that already wraps to two lines at a 200px pane and is
centred there because it cannot fit. The lean is to let it wrap to three and look
at it; if it reads as a menu rather than an offer, the fallback is collapsing the
two aside actions behind one — a trade to make on evidence.

**Measuring it needs more than replacing the width constant.** `anchorFor` clamps
using its estimate and `Session` stores the already-clamped result, so the
original selection geometry is gone by the time anything could measure the real
width. Phase 3 therefore keeps the **raw selection rectangle** in state and fits
after render, the way `fitCard` already does for the card. Swapping the constant
alone would measure accurately and still position from a number derived before
the measurement.

## Phases

**Phase 1 — the setting.** `explainLanguage` through `Settings`, `SettingsShape`
and the sheet, with normalisation, the 40-character bound, helper text naming
"simple English", and placement outside the model fieldset. `App` holds and
refreshes it. Nothing else observes it. Shippable alone and inert.

**Phase 2 — the opening contract and the prompt.** Move the boot from the card's
mount effect to the click handler for both actions; `openAside` takes a purpose,
reads the language itself, builds the prompt, and logs the visible intent. The
aside metadata gains `purpose` and `language`. Pure prompt tests: the passage is
quoted, the plain-language clauses present, the do-not-work clause present, and
the language named. There is no prompt without a language, because there is no
action without one — a template that can render "explain in " has a caller that
should not have got that far.

**Phase 3 — the action and the card.** The third offer action, shown only when a
language is set and the selection is askable. `QuickQuestion` gains explanation
mode: no input until answered, card-level focus, mode-specific heading and
`aria-label`. Per-paragraph `dir="auto"` on the answer, isolation on inline code,
and the excerpt keeping its own direction. Retain the raw selection rect; fit the
offer after render. Verify at full width, a narrow pane and a four-way split —
every layout bug in `ask-on-the-fly` was found by looking, none by a test.

**Phase 4 — verification in Arabic, judged by a reader.** An identifier-heavy
passage, explained in Arabic, read by someone who reads Arabic. Two questions a
test cannot answer: is it genuinely _simpler_, or merely translated at the same
density — and is it genuinely _Arabic_, or Arabic that drifts into English by the
third sentence. This is the one phase that cannot be reduced to pass/fail:
a literal translation, an answer that starts in Arabic and finishes in English,
and a correct answer reordered by bad bidi all satisfy every assertion a test
could make. Arabic is the right language for this precisely because it exercises
direction and identifier isolation at the same time.

## What this deliberately does not do

- It does not translate the interface, and does not mirror it. Chorus's chrome is
  English and stays left-to-right; only the agent's own words take a direction.
- It does not translate a whole transcript or reply. The unit is a passage.
- It does not offer a language picker in the card.
- It does not detect the passage's language, so it cannot hide itself when the
  passage is already in the user's language. A detector that is occasionally
  wrong is worse than a button that is occasionally pointless.
- It does not add a second card, or a second boot path.
- It does not pre-warm a fork on selection or hover.
- It does not add retry UI for a wrong-language answer before Phase 4 has shown
  the prompt cannot carry it.
- It does not become a general "do X to this passage" menu. Two doors into a fork
  is a feature; five is a right-click menu.

## What the review corrected

Recorded rather than folded in, because the errors are the useful part.

1. **The auto-send belonged to the click, not to mount.** A mount effect runs
   twice in development, and unlike a leaked process a sent prompt cannot be
   cleaned up after the fact — it is already paid for and already in the log.
2. **Free text still needs bounds.** Whitespace, newlines and unbounded length
   would each produce a distinct visible failure, and one of them — a button
   wider than the pane — is exactly what measuring cannot fix.
3. **Nothing owned the setting.** `App` discards everything but session defaults,
   so a mounted session would never learn the language changed; and main must
   read it itself rather than accept prompt content from the renderer.
4. **The log needed the decision now.** Purpose, language and a visible intent
   line cannot be backfilled into an append-only log, so deferring them to a
   later question would have made old rows permanently unclassifiable.
5. **Hiding the input removes the focus target.** The clicked toolbar is gone and
   the textarea is absent, so focus falls to the document.
6. **Measuring the offer needs the raw geometry.** The clamped anchor is what is
   stored, so a later measurement cannot recover the position it should have had.

## Open questions

1. **Does a three-action offer still read as an offer?** A judgement to make by
   looking at it in a split pane.
2. **Should the button name the language?** "Explain in Arabic" is clearer before
   the click and reintroduces the variable-width problem that overflowed a narrow
   pane once already. The lean is a constant label, decided by looking at both.
3. **Should an explanation look different in the transcript from an aside?** Both
   get the same badge mechanism; `purpose` now makes telling them apart possible,
   so this is a design question rather than a data one.
4. **What happens when the model answers in the wrong language anyway.** The
   prompt is firm from the first version; Phase 4 decides whether that is enough
   before any retry affordance is built.
5. **What a mixed-direction draft should do in the composer.** A promotion
   carries an English passage and an Arabic explanation into one field, which has
   no single correct direction. `dir="auto"` improves it and does not solve it,
   and the user is editing the text anyway — worth looking at in Phase 4 before
   deciding it is a problem.
