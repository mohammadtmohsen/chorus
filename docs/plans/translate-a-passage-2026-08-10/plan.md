# Translate a passage

A fourth thing to do with a selection: render it in the reader's own language,
faithfully. Asked for as _"english => my language, professional translation for
the selected text"_.

## Why this is not "Explain simply" with a different prompt

The two look adjacent and are opposites, which is the whole reason this is worth
building rather than folding into the existing action.

**Explain** answers _what does this mean_. Its output is deliberately **not** the
passage: `explainPrompt` says "Do not restate the passage", caps the answer at
about a hundred words, forbids headings, and leans on the fork's context to say
what the passage refers to _here_. That prompt was rewritten three times, and
every line in its "Leave out" list is something a real answer did unasked.

**Translate** answers _what does this say_. Its output **is** the passage, in
another language. Faithful, same register, same length, nothing added and nothing
explained. Almost every rule that makes `explainPrompt` good makes a translation
wrong — most sharply "do not restate the passage", which is precisely the job.

So: a new purpose with its own prompt, not a flag on the old one. Sharing the
prompt would mean one string trying to hold two contradictory instructions, and
the first bad answer would be edited in a direction that damages the other.

## What it reuses, which is nearly everything

The aside machinery already does this shape of work: fork the agent that wrote
the passage, ask one thing, show it in a card, never touch the parent. A
translation is another `purpose` on that path.

- **A fork, for the same reason explanations use one.** Translation looks
  context-free and is not: pronouns, elided subjects and project-specific terms
  all resolve against the conversation. A fork costs two uncached input tokens
  and already exists.
- **The language setting**, `explainLanguage`, unchanged in behaviour — only its
  Settings copy is reworded, since it now describes two actions. See Decisions.
- **RTL, free.** `unicode-bidi: plaintext` per paragraph with `isolate` on inline
  code already handles Arabic and Hebrew with code left-to-right inside them.
- **The card, `asideState`, promotion, the whole lifecycle.**

## Shape

**`purpose` grows a third member.** This draft guessed "an enum in two places";
it is eight, and nine branches switch on it — the count is in _What it touches_
below, read out of the code. Old rows are unaffected: they carry `question` or
`explanation` and keep meaning what they meant.

**`translatePrompt(excerpt, language)`**, written against what a translation is
rather than by editing the explain prompt:

- Render the passage in the target language. Do not explain, summarise, expand or
  comment on it.
- **Do not continue the work or change anything. Answer this and stop.** Not
  optional, and not explanation-specific tuning: _both_ existing aside prompts
  carry this clause (`runtime.ts:169` and `:249`), because without it a fork
  treats the request as the next turn of the work and starts doing things — which
  no permission rule catches, since reading files is allowed. A translation
  request looks even more like a task than a question does.
- **Target the standard written form of the language.** A professional
  translation is in the standard literary register — Modern Standard Arabic
  rather than a dialect or a simplified reading level. See Decisions for why this
  matters given the field it reads from.
- **Preserve code, translate prose.** Stated as two rules rather than one,
  because "keep code exactly" and "translate the comments" contradict each other
  if comments count as code. Executable syntax, identifiers, string literals,
  delimiters, paths, file names and formatting are reproduced **byte for byte in
  their own script**. Natural-language comments and docstrings are translated.
  Nothing else in a code block changes.
- Match the register of the source: terse stays terse, a heading stays a heading.
- No preamble, no "here is the translation", no notes about choices made.
- If the passage is already in the target language, say so in one line rather
  than producing a paraphrase that looks like a translation and is not.

**The action appears only when a language is set**, exactly as Explain does. An
action that cannot say which language it would produce is worse than an absent
one.

## What this is deliberately not doing

**Not a language picker in the toolbar.** The setting is global for the same
reason Explain's is: a picker on a floating bar is a decision asked at the moment
someone least wants one.

**Not translating whole replies.** The selection is the unit, as with every other
action on that toolbar. Translating a reply as it streams is a different feature
with different costs.

**Not round-tripping.** English → your language only, as asked. The reverse — your
language → English on the way into the composer — is a plausible sibling and is
not this.

**Not inheriting `explainPrompt`'s tuning.** Its hard-won rules are hard-won for a
different job.

## What it touches

Read out of the code rather than estimated. A third `purpose` is **eight type or
schema sites** and **nine behavioural branches**:

| Definitions                                   | Branches                                             |
| --------------------------------------------- | ---------------------------------------------------- |
| `event-store/src/events.ts:67` (zod enum)     | `runtime.ts:776` default                             |
| `event-store/src/events.ts:345` (`AsideMeta`) | `runtime.ts:778` whether a language is read          |
| `shared/ipc.ts:684`                           | `runtime.ts:779` the refusal with no language        |
| `main/ipc.ts:550`                             | `runtime.ts:852` which first turn is sent            |
| `main/runtime.ts:655`                         | `Session.tsx:1032` the button                        |
| `Session.tsx:175` (`askingAbout`)             | `QuickQuestion.tsx:143` where focus lands            |
| `Session.tsx:497` (`openCard`)                | `QuickQuestion.tsx:322` the card heading             |
| `QuickQuestion.tsx:60` (prop)                 | `QuickQuestion.tsx:336` when the answer region shows |
|                                               | `QuickQuestion.tsx:408` whether follow-up is hidden  |

`QuickQuestion.tsx:321` is a **binary ternary, not a switch** — a third purpose
forces it to become a real one, which is the good kind of forcing. Old rows are
safe: `asideMetaOf` (`events.ts:358`) already defaults a purpose-less aside to
`question`.

Plus three or four i18n keys — a toolbar label, and a `translating` /
`translatingPending` pair beside `explaining` at `en.json:378`.

## Decisions

**The shared field is read for its language, and translation renders the standard
form of it.** Asked for as _"standard arabic translation"_, which resolves this
more cleanly than either option on the table.

The conflict is real and I first underweighted it. `explainLanguage` is free text
**by design**, and its own comment names the two things it exists to accept:
_"'Lebanese Arabic' and 'simple Arabic' are answers a locale list cannot
express"_ (`ipc.ts:69`). Those are two different kinds of modifier — one names a
**variety**, the other a **reading level** — and only the second obviously fights
a faithful translation. Arguing from the placeholder being `"Arabic"`, as this
plan did, missed that the field's stated purpose is precisely to hold more than a
name. Rewording Settings also does nothing about values already saved.

So the rule is explicit rather than implied, and it is a property of the prompt,
not of the field: **translation takes the language named and renders it in its
standard written form**, applying neither a reading level nor a dialect. Someone
who set _"simple Arabic"_ for explanations gets simple explanations and standard
translations; someone who set _"Lebanese Arabic"_ gets Lebanese explanations and
standard translations. No second setting, no migration, and nothing silently
inherited — the two actions read the same value and are documented to use it
differently.

**Deliberately not doing**: a dialect-targeted translation. It is a coherent
thing to want, it is not what was asked for, and it would need its own setting to
express — at which point it is the second-setting design, chosen on purpose
rather than by drift.

**The fork stays.** This was the last question that could change the shape, so it
is settled rather than deferred: translation forks the agent that wrote the
passage, exactly as explanation does. Pronouns, elided subjects and
project-specific terms resolve against the conversation, and being wrong about
those is the failure a translation cannot recover from — a fluent sentence that
says the wrong thing reads as correct.

The cost of leaving it open was the real argument. `openAside` requires a live
parent, a forkable participant with a `sessionRef`, and a `freshStartAfter` guard
(`runtime.ts:645–766`). A context-free translation would need none of those, so
the two paths differ in lifecycle and in how they fail, not just in price —
choosing late would mean choosing twice. Whether a fork is _necessary_ remains
worth measuring, but as a later optimisation against a working feature, not as a
gate in front of one.

**A fourth button fits, and needs no positioning work.** The width-guessing this
question feared was deliberately removed: `Session.tsx:452` measures the rendered
bar with `offsetWidth` and a `ResizeObserver`, `fitCard` clamps or centres it, and
`flex-wrap: wrap` with `max-width: calc(100% - 8px)` handles a narrow pane. The
history is in `quote.ts:113` — a hardcoded guess "was 96 for a fourteen-character
button and had to become 240 for two of them".

**But it lands on an existing bug, so that gets fixed first — and the fix is not
the obvious one.** `styles.css:537` says _"Once wrapped, the divider belongs above
rather than beside"_ and then declares `border-left`. The same rule is duplicated
verbatim at `styles.css:553`.

Swapping it to `border-top` does not work, and neither does any sibling selector:
**CSS cannot tell whether a flex item wrapped.** `+` matches the second button
whether it began a new row or not, so `border-left` is wrong on a wrapped row and
`border-top` would be wrong on every unwrapped one. The mechanism has to make the
divider a property of the _gaps_ rather than of the items:

```css
.quote-offer {
  gap: 1px;
  background: color-mix(in srgb, var(--bone) 18%, var(--line)); /* the hairline */
}
.quote-offer-action {
  flex: 1 1 auto;
  background: var(--raised); /* was transparent */
}
.quote-offer-action:hover {
  background: color-mix(in srgb, var(--bone) 8%, var(--raised));
}
```

The container's colour shows through the one-pixel gaps — vertically between
buttons in a row, horizontally between rows — so it is wrap-aware by construction
with no selector at all. Three details make it work rather than nearly work:
the buttons must become **opaque** (they are `transparent` today, which would let
the hairline colour flood each button); `:hover` must mix over `--raised` rather
than `transparent` for the same reason; and `flex: 1 1 auto` is what stops a
short wrapped row from leaving hairline-coloured space beside it, since
`justify-content: center` would otherwise centre it and expose the container.

`border-radius: 999px` with `overflow: hidden` already clips the ends, so the
gaps cannot escape the pill.

**Verified in both states or not at all.** The failure this replaces was invisible
until a pane got narrow, so Phase 0 is checked at a width where the bar wraps
_and_ one where it does not — the e2e harness can set the viewport directly
(`app.viewport(width, height)`).

## Phases

**Phase 0 — the divider.** The gap mechanism above, and delete the duplicate at
`styles.css:553`. No feature work; it stands on its own. Checked at a width where
the bar wraps and one where it does not, because the bug it replaces was
invisible in the unwrapped case.

**Phase 1 — the purpose and the prompt.** The eight type sites, the
`QuickQuestion` ternary becoming a switch, and `translatePrompt`. Prompt tests
beside `explainPrompt`'s at `main/aside.test.ts:283`, which is the model to copy:
eleven assertions, each recording a real answer that went wrong.

**Phase 2 — routing, which the prompt tests do not cover.** A prompt that is
correct and never reached is still a broken feature, so this mirrors
`describe('opening an explanation')` at `main/aside.test.ts:359`:

- a translation refuses **before forking** when no language is set, exactly as
  explanation does (`runtime.ts:779`) — no orphaned fork, nothing appended;
- opening sends **exactly one** turn, and it is the translation turn;
- `purpose: 'translation'` and the language are persisted on
  `conversation.created`, and are not rewritten when the setting later changes;
- **question and explanation still behave as they did** — the regression this
  phase exists to prevent, since a third arm on nine branches is nine chances to
  change the meaning of the other two;
- an aside with no `purpose` still reads as `question` (`asideMetaOf`).

**Phase 3 — the button and the copy.** The fourth action in `Session.tsx:1027`,
gated on a language exactly as Explain is, plus the reworded Settings strings —
`explainHeading`, the `"Answer in"` label, and `explainNote`, which now describe
two actions and must say how each reads the value.

**Phase 4 — the toolbar's first test.** There is **no test of the selection
toolbar at all** — zero hits for `quote-offer`, `explainSimply` or `askAboutThis`
across every test file. Not this plan's debt, but four actions gated on two
different conditions is where it starts to cost. `data-askable` already exists on
the bar (`Session.tsx:987`) for exactly this, and the e2e harness can drive a real
selection at a chosen viewport.

## Open questions

**Icon or text on the fourth button — needs your call, and blocks Phase 3.** The
request said "translate icon"; the bar is text-only today. I recommended a
`Translate` label and was wrong to record that as decided: the comment I cited
(`QuickQuestion.tsx:315`) argues only that the _language name_ does not belong on
a button, which is about unbounded width, not about icons. It establishes no
no-icons convention, so a text label knowingly declines what was actually asked
for. Three defensible answers — a `Translate` label, icons for all four, or
shortening all four to single words — and mixing one icon among three labels is
the only one that is not.

**Is the fork ever removable?** Now an optimisation rather than a gate, since the
fork is chosen. Worth measuring against a working feature: translate the same
passages with and without conversation context and compare. If context turns out
not to matter, a standalone path would survive the parent session being gone —
but that is a different feature with different failure modes, not a tweak.
