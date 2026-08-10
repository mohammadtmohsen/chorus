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
- **The language setting**, `explainLanguage`, unchanged — see the open question
  about whether one value can honestly serve both.
- **RTL, free.** `unicode-bidi: plaintext` per paragraph with `isolate` on inline
  code already handles Arabic and Hebrew with code left-to-right inside them.
- **The card, `asideState`, promotion, the whole lifecycle.**

## Shape

**`purpose` grows a third member.** It is an enum in two places —
`event-store/src/events.ts` (`ChorusEventPayload`, defaulted to `question`) and
`shared/ipc.ts` — plus the `AsideMeta` type. Old rows are unaffected: they carry
`question` or `explanation` and keep meaning what they meant.

**`translatePrompt(excerpt, language)`**, written against what a translation is
rather than by editing the explain prompt:

- Render the passage in the target language. Do not explain, summarise, expand or
  comment on it.
- Keep identifiers, file names, paths and code exactly as written, in their own
  script — the same rule explain has, and more load-bearing here.
- Match the register: terse stays terse, a heading stays a heading.
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

## Open questions

**1. Can one setting serve both actions?** `explainLanguage` is free text by
design, and its own placeholder suggests _"simple Arabic"_. That is a good
instruction for an explanation and a strange one for a professional translation.
Options: reuse it and accept the oddity; reuse it but have the translate prompt
read only the language and ignore qualifiers; or add a second setting, which is a
second decision to make and a second thing to keep in sync. **Needs deciding
before the prompt is written**, because the prompt depends on the answer.

**2. Icon or text?** The request says "translate icon", and the toolbar is
**text-only today** — `Quote in message`, `Ask about this`, `Explain simply`. A
single icon among three labels reads as an accident rather than a decision, and
an unlabelled icon is the least legible thing on a bar people use rarely. Either
all four get icons or this one gets a label; both are defensible, and mixing is
not.

**3. Does a fourth button fit?** The offer is a small floating bar anchored to the
selection, and it already reflows. Four labels may be wider than the passage they
are anchored to, on a narrow pane. Worth measuring before choosing wording, since
the fix might be shorter labels rather than fewer actions.

**4. Is the fork actually needed?** Explanation demonstrably needs the
conversation. Translation might not — and if it does not, the cheaper path is
worth knowing about, because it changes what happens when the source session is
gone. Measurable: translate the same passage with and without context and compare.

**5. What about a passage that is mostly code?** A code block selected whole has
almost nothing to translate. The prompt should say what to do — most likely
translate comments and leave everything else — rather than leaving the model to
choose per selection.
