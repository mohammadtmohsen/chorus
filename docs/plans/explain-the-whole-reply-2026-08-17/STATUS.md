# Status

**Shipped 2026-08-17.** `pnpm check` green: 18 tasks, 1877 tests, lint and format
clean. Not driven in the app yet — the UI claims below are unverified.

## What the plan got wrong, and what the code said instead

Three corrections, all made into `plan.md` itself rather than left as a diff
against it.

**The language label was already handled.** The plan opened by blaming
`<span class="md-lang">` for the refused selections and proposed a line in
`blockText`. That change was written and then reverted: `styles.css:1784` already
excludes `.md-lang` with `user-select: none`, and its comment carries the
Chromium string that motivated it — `"TSconst a = 1"`. The token never reaches a
selection, so the projection never needed to produce it. **Reading the stylesheet
before the parser would have saved the round trip**, and the same list turned out
to hold the real answer.

**What that list misses is `.entry-time` and `.summary-head`**, and both sit at an
end of the drag people actually make: the clock beside the speaker that a
top-down selection starts on, and the summary card's own word — drawn `Summary`
while `blockText` uppercases the heading it was cut from to `SUMMARY`, which
`containsPassage` refuses because case is significant on purpose. Both are now in
the rule. The general shape — an opt-out list nothing forces a new element to
join — is C-041.

**`promotion()` could not be left alone.** With the excerpt now a whole reply,
"take this forward" would have staged the agent's own last message back into the
composer in full. `explanationPromotion` drops the quote and keeps the two parts
that carry weight: the mention, because routing is by mention, and the line
saying the answer came from a fork this session cannot remember. The card's
Quote button goes with it, as a recap's already had.

**`explainPrompt` changed too**, which the plan had explicitly excluded. Every
"the passage below" was about to point at a whole answer, and the length
instruction only reads as a limit if the model knows it is compressing something
long — so the subject is named as the reply and the hundred words are held
against it in the prompt itself.

## Still to do

- **Drive it.** Set a language, ask for something long, click Explain, and read
  what comes back. Nothing here has been seen running.
- **The e2e offer spec** was updated from four actions to three but not run;
  the suite is macOS-only and takes ~5 minutes (C-029).
