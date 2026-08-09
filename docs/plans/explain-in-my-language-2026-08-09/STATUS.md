# Status

## Phase 1 done: the setting

`explainLanguage` through `Settings`, `SettingsShape` and the sheet.
`normaliseExplainLanguage` lives in `shared` and is applied as a zod transform,
so the rule holds on write and on a hand-edited file alike: whitespace collapses,
a pasted newline flattens rather than erroring, and 40 characters bounds a value
that reaches a prompt and possibly a button.

**Codex's placement warning was right, and the app proved it.** `DefaultModel`
returns `null` when no live Claude model list exists, and the driver reported
`modelsPresent: false` on this machine — so a language field placed inside it
would have been invisible today, on the only surface the feature is discoverable
from.

**Found by driving it:** the value was written on blur, and blur is not
guaranteed. Closing the sheet with Escape never fires it, so a typed language
would silently fail to save. It writes on change now, like the model and effort
rows. The _display_ stays raw until blur — normalising every keystroke would
collapse the space in "Lebanese Arabic" the moment it was typed and make the
second word impossible to start.

## Phase 2 done: the opening contract, the prompt, and the log

`pnpm check` green — 1063 tests.

**The click opens the aside, not the card.** The boot moved out of
`QuickQuestion`'s mount effect and into `Session`'s click handler, for _both_
actions. A mount effect runs twice in development; a leaked fork can be closed
after the fact, but an explanation sends its first turn on open and a sent prompt
is already paid for and already in the log before any cleanup could run. This
also closes the same window for `ask-on-the-fly`.

**The log records purpose and language.** `aside` gains
`purpose: 'question' | 'explanation'` (`'question'` by absence, so rows written
before this read correctly) and, for an explanation, the `language` **as it was
at the time** — a row explaining a passage in Arabic must not become a French row
because someone later edited a preference. This could not be deferred: the log is
append-only, and a row written without it can never be classified.

What is _logged_ is the intent in the user's own words — "Explain this in
Arabic." — while the instruction is what gets delivered. `sendUserMessage(logged,
delivered)` already existed for exactly that split.

**Main reads the language itself.** `openAside` does not accept it from the
renderer, which already has its source event re-resolved for the same reason: a
language string is prompt content, and prompt content from the renderer is the
same class of problem wearing a smaller word.

### The prompt, and one flaw in writing it

Level first, language second — a prompt that leads with the language produces a
faithful translation of something still too dense. It names the reader as a
developer who has not met this particular thing, because "explain simply" invites
an answer starting from first principles, which is insulting to someone who
understood every word but one.

A test caught the phrase `do not continue the work` split across a line break —
`"and do\nnot continue the work"`. That is a real flaw in the prompt rather than
only in the assertion: a clause split mid-phrase is harder to read and easier to
weaken by editing one half. Each clause now sits whole on its own line.

## Verified in the app, in Arabic

Driven end to end on an identifier-heavy passage with the language set to Arabic.
Three failures found, all fixed, none of which any unit test could have seen.

**The card could not take focus.** It starts `visibility: hidden` until measured,
and a hidden element cannot hold a caret — so `card.focus()` silently did
nothing and the caret stayed on the document, leaving Escape as the only key that
worked. Focus now waits for the measurement.

**The follow-up box never appeared.** It was gated on `answered`, which waits for
the provider to close the turn — seconds after the last word arrives, long enough
to look like it is never coming. It is gated on there being an answer now.

**Arabic rendered left-to-right.** Fixed with `unicode-bidi: plaintext` per
paragraph rather than a direction derived from the setting, because the setting
is free text and there is no locale to map. `unicode-bidi: isolate` on inline
code keeps `DeltaBuffer` and `better-sqlite3` as single left-to-right runs inside
right-to-left prose — the case this feature creates deliberately by keeping
identifiers untranslated.

Looked at, not only asserted on: the Arabic is right-aligned, the English excerpt
above it stays left-aligned, and the identifiers hold their own direction inside
the Arabic. The answer defines what `log`, `projection` and `deltas` each mean
rather than rendering the sentence word for word — which is the whole point, and
the thing no assertion could have distinguished from a good translation.

**Time to first token: ~13.5s.** Much slower than an aside's 1.4s, and expected:
there is no typing to hide the CLI boot behind, and the answer is long because it
explains several terms. Whether that is tolerable is the open question this plan
always said it was, and it is now answerable from the running app.

## Phase 3 done: one positioner, everything measured

`anchorFor` is gone. It decided above-or-below and clamped using a hand-written
guess at the offer's width — 96 for one action, 240 for two, and a third would
have needed a revision nobody would have remembered to make. Worse, the clamped
result was what got stored, so the real geometry was gone before anything could
measure the truth.

`anchorOf` now reports the passage and stops. Whoever is being positioned
measures itself and calls `fitCard`, which is the only thing that decides where
anything goes — the offer and the card alike. Two positioners cannot disagree
about which edge `top` means when there is one.

The measurements are the argument. At full width the offer is **348×26**; at a
200px pane it wraps to **192×73** and still hangs exactly above the passage
(`bottom` 167 against a passage top of 167). No constant tracks a width that
changes by wrapping.

Verified with three actions at 804, 364 and 200 pixel panes: three actions,
inside the pane horizontally and vertically, at each. Looked at as well —
stacked, centred, and hanging off the highlighted passage.

## Review round two: five substantial issues, all confirmed in code

**An aside written by the earlier build lost its identity.** The worst of them,
and a regression introduced on this branch. `ask-on-the-fly` shipped `kind`,
`parentId` and `sourceEventId` at the payload's top level; gathering them into
`aside` meant zod stripped the old names on read. Reproduced before fixing: the
row came back as an ordinary conversation, projected `kind: null`, and **appeared
in the session list** — someone's "what did you mean by that" filed beside the
work it was about. The log is append-only, so the reader is what had to keep up:
`asideMetaOf` prefers the current shape and falls back to the old one, and every
reader goes through it rather than reaching for `payload.aside`.

**The migration backup was not a snapshot.** It copied the main file and then its
`-wal` and `-shm` in turn — three moments, with no single-instance lock to stop
another process writing between them. `VACUUM INTO` is SQLite's own answer: one
consistent file from a live database, no sidecars, synchronous. Verified by
opening the result — `user_version` 1, the pre-migration row present, the new
columns absent.

Worse than the backup was where its failure landed. The `try` wrapped the
migration as well as the open, and the recovery renames the database aside and
starts an empty one — so a disk-full or permission error while backing up
presented as "your database was unreadable" and moved the user's history out of
the way. Only opening may be treated as corruption now.

**Strict Mode closed the only fork.** Moving the open into the click handler
stopped two forks being created, but the card's cleanup still closed the promise
it had adopted — and React runs setup → cleanup → setup in development, so the
simulated cleanup closed the fork the second setup was using. Opening and closing
are one pair; `Session` now owns both.

**`openAside` was not failure-atomic.** The language check ran after the fork, so
"No language is set" leaked a CLI. Everything past the fork is wrapped now, with
the first send wrapped again because it happens after the service is registered —
failing there stranded an entry as well as a process, and the caller never
learned an id so could not close what it did not know about.

**The historical-session guard never fired for Claude.** It compared
`sessionRef`, and Claude's is empty when `session.started` is written — the real
id arrives with the first message. It compares which `session.started` event is
current now, because event identity does not depend on a field filled in late.

Smaller: the card took its language from the renderer's own copy, which lags a
settings change, so main echoes back the language it actually used; the aside
metadata is a union rather than one shape with optional parts, so an explanation
cannot exist without a language nor a question with one; and the focus effect
re-ran on every re-measure, pulling the caret back each time the card resized —
including the moment the follow-up box appears, which is when someone is reading.

Driving it afterwards found one more: the heading read "Explaining in " while the
language resolved. A whole sentence now stands in until it is known.
