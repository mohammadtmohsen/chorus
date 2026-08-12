# The mention that vanishes

Finishing C-003. The fix in `838827f` is measured good and cannot be certified,
and the reason it cannot is a mistake inside the fix itself.

Revised after a Codex review of the first draft. Four things it found are folded
in; two of them change what gets built, and one of them killed the fix this plan
was about to propose.

## The problem

`838827f` splits "what is being typed" from "whether the menu is on screen" and
measures well:

| test                                      | before           | after          |
| ----------------------------------------- | ---------------- | -------------- |
| slash spec, back to back on one machine   | **7 / 10**       | **10 / 10**    |
| full suite                                | —                | **5 × 28/28**  |
| `@c`, mention survives a focus round-trip | nulls every time | **4 / 4 kept** |

And then **two runs on that same fixed build lost the mention anyway**, reporting
`data-mention: "none"` with `@c` still in the box. Nothing explains them.

A fix that works four times, fails twice, and cannot say why is not finished.

## Why the record cannot answer it, and that is on this branch

`data-mention` is the attribute that broke C-003 open. The board is explicit:

> **Do not remove the instrumentation** — the original bug was solved by
> instrumenting `refreshMention`, that instrumentation was taken out, and this
> entry is what it cost.

`838827f` did not remove it. It did something quieter and nearly as bad:

```ts
- data-mention={mention === null ? 'none' : …}   // one meaning
+ data-mention={active === null ? 'none' : …}    // two meanings
```

`active` is `liveMention(mention, draft)`, null in **two different situations** —
nothing was parsed, or a mention exists and its stamp did not match. Both print
`none`, so the failing runs report a symptom that could be the original C-003 or a
completely different defect with a completely different fix. **The instrument was
made ambiguous in the same commit that needed it most.**

## The blocker: the stamp is weaker than it looks

Found by review, not by measurement, and it outranks the diagnosis above because
it is a live defect rather than a missing explanation.

`liveMention` compares **text equality and nothing else**:

```ts
return mention.from === draft ? mention.query : null
```

Two consequences the first draft missed:

**A stale mention can come back to life.** `send`, `quote`, `insert` and recall
all change the draft, and none of them clears `mention` — invalidation is
inferred from the text no longer matching. So the raw mention sits there, and if
the same text ever returns (send then recall, quote then undo, retyping the same
word) the old mention matches again and reactivates, carrying offsets from an
earlier edit.

**And `choose` mixes three sources in one call:**

```ts
applyMention(el.value, active, el.selectionStart, option)
//           ^live DOM  ^stamped  ^live caret
```

Text equality says nothing about the caret. A mention validated against identical
text, spliced at a caret that has since moved, writes the option into the wrong
place — the draft corruption the stamp was introduced to prevent. The first draft
knowingly left this "documented rather than fixed". That is not good enough to
certify a fix on.

## The fix the first draft was about to get wrong

Its open question proposed stamping `from: draft` instead of `el.value`. **That
inverts the invariant.** The query's offsets are derived from `el.value`; pairing
them with `draft` means that in exactly the race being hunted — DOM written,
React not yet re-rendered — the offsets come from the new text and the token from
the old, the equality check _passes_, and the stale splice it was meant to stop
goes through.

The rule this leaves: **the query and its validity token must come from one
snapshot.** Text equality is the wrong token because two different edits can
produce the same string. What is wanted is a revision counter bumped by every
draft write, or explicit invalidation at each writer — decided in Phase 3, from
evidence, not here.

## The shape of the answer

**Record the decision, not the outcome.** Every measurement so far reads state
after the fact; nothing records why a mention became unavailable. There are
**four** writers of `mention` — the parse, the `dismissed` branch, `choose`, and
Escape — plus `liveMention`'s rejection and the independent `leftBox` gate. The
first draft listed three of the six.

**And it records no content.** The first draft wanted `value`, `from` and `draft`
in a buffer, which would put what someone is typing in a second place and keep it
after it left the textarea. The composer already refuses that on purpose —
`data-draft-len` exists precisely because the draft itself must not be duplicated.
So: an enum reason, lengths, a caret, the live/stale status, `leftBox`, and
`document.hasFocus()`. Enough to name the branch, nothing anyone typed.

## Phases

### Phase 1 — say which `none` it is

`data-mention` goes back to reporting the **raw parsed mention**, one meaning
again. Alongside it: whether the stamp is live or stale, which of the six
branches last decided, the stamp's length against the draft's, `leftBox`, and
whether the document has focus.

**Exit:** with the stamp deliberately broken the record names the stamp; with the
parse forced null it names the parse; the two are never the same string. Proved
by forcing each, not by reasoning about them.

### Phase 2 — reproduce with a real keyboard first

**The order here is the correction that matters most.** The hypothesised race
needs a programmatic DOM write — and the checked-in helper is exactly that:

```js
Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text)
ta.dispatchEvent(new Event('input', { bubbles: true }))
```

Every probe run so far used that shape. So thirty runs of it could produce three
confident records of a **harness artifact**, and Phase 3 would then fix something
no user can reach.

So before any volume: reproduce with **real key events** (`Input.dispatchKeyEvent`
over CDP, which goes through the browser's own input path) or by hand in the
installed app. Only once the failure survives real input does repetition mean
anything — and if it does _not_ survive, that is the finding, the residual is a
harness artifact, and Phase 3 is about the stamp blocker alone.

**Exit:** a statement of whether the residual reproduces under real input, with
counts; then, if it does, at least three failing records carrying a decision
reason.

### Phase 3 — fix the named cause, and the stamp

Two things, and the second lands regardless of what Phase 2 finds, because it is
a defect on its own: **a validity token that cannot be forged by identical text,
and a `choose` that cannot mix snapshots.**

Written only when Phase 2 reports. This work has already produced two fixes that
were obviously right and measured worse — 2/5 and 9/10 — both caught by
measurement rather than review.

**Exit:** the A/B that has governed this throughout — slash spec and `@` probe,
back to back, 10 runs each, as rates; plus a test that a mention cannot
reactivate when the same text returns, and one that a moved caret cannot splice.

### Phase 4 — put it in front of a person

**Exit:** the branch installed via `pnpm app:install`, and `@c` typed by hand,
then alt-tab away and back.

## Needs a decision before Phase 3

**Should an intra-app blur close the menu at all?** Today clicking the transcript
closes it and returning to the box reopens it. The screenshot that reopened this
cannot distinguish that from the bug, and Phase 4's alt-tab check does not answer
it either — alt-tab is a _window_ blur, which is now deliberately ignored. This
is a product decision and it changes what Phase 3 is allowed to do, so it is
wanted before the fix rather than after.

## What this deliberately does not do

- **It does not touch the terminal branch.** This runs in a worktree at
  `../chorus-c003`. Earlier measurements rebuilt inside a tree holding
  uncommitted work; both sides of each A/B shared it so the comparisons hold, but
  it should not have happened.
- **It does not re-litigate the fix's shape.** Splitting visibility from
  derivation is measured on two menus. One path through it is unproven.
- **It does not add another timing fix.**
- **It does not chase C-029's other three specs.**
- **It does not log anything anyone typed.**

## Open questions

1. **Revision counter or explicit invalidation?** Both satisfy "one snapshot".
   A counter is one line per draft write and cannot be forgotten by a new caller;
   explicit invalidation is more obvious to read and easier to miss. Phase 3
   decides with the failing record in hand.
2. **Does the residual survive real key events?** Phase 2's first question, and
   the answer changes the whole shape of Phase 3.
3. **What is stealing focus on this machine?** A window blur was recorded with
   nothing driving it, ten seconds after a menu opened. It is why any of this is
   reachable in practice, and it is unidentified.
