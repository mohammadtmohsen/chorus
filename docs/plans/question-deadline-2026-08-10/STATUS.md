# Status

## Phase 1 done: a blocking card says when it is about to expire

The deadline existed and nothing mentioned it. Now a question or approval card
shows how long is left, but only once that is worth knowing.

**The threshold is one minute, and it comes from the data.** The median
successful answer in the log took **55 seconds**, so a minute is enough to finish
a typical answer from a standing start — which is the only useful test of the
number. A warning that arrives with less time than an answer takes is not a
warning, it is notice of a loss. Five minutes of visible counting was rejected
for the opposite reason: it applies pressure to the 60% who were never at risk,
and a timer that is always on is a timer nobody reads.

**The judgement is pure and the component is plumbing**, following the
convention the rest of this renderer uses. `deadline.ts` decides _whether_ to
warn, _what_ to show, and _when the display next becomes wrong_; `useDeadline`
only schedules. 13 tests.

`nextChangeInMs` is the part worth keeping. Without it the card would run a 1Hz
interval for the four minutes it has nothing to say — one re-render per second of
an unchanged card. Instead it sleeps once until the warning is due, then ticks
only inside the last minute, and stops entirely at zero.

**`ceil`, not `floor`.** Flooring reaches "0" a full second before the deadline
does, so the card would read `0:00` while still perfectly answerable — a lie told
at exactly the moment it is being read most carefully.

### The seam, which is the point of doing this first

Both cards take a `deadline` **prop** rather than reading `request.expiresAt`.
Today the caller passes exactly that, so nothing changes; when Phase 2 lets
engagement push the deadline out, only the expression filling that prop moves and
neither card is touched.

This was not tidiness. The renderer replays the _original_ `expiresAt` from
`userinput.requested`, so a card that read it directly would show a stale
deadline after the first extension — the countdown becoming wrong precisely
because the feature above it started working.

### Accessibility

Both cards are `aria-live="assertive"`. A number changing every second inside one
would be announced every second, which is not urgency but noise. The ticking
digits are `aria-hidden`; a static sentence beside them says the same thing once
and, because its text never changes, announces once.

### Verified on a real card

Driven end to end against a live Claude question set, not a fixture:

- silent for the first four minutes — `hasClock: false`
- appears at exactly `1:00`
- `aria-hidden="true"` on the digits, `"Less than a minute left to answer."` for
  a screen reader
- counts down rather than freezing: `1:00 → 0:57`

**One correction made during the work.** The first version coloured the countdown
with a `--warn` token that does not exist, behind a hex fallback. Every render
would have used the fallback, and carried a dark-theme colour into the light
theme where it has no contrast. It uses `--alert`, which is real and defined for
both.

**Not verified live: the approval card.** It is wired through the same component
and prop, but only the question path was driven. Approvals time out 4 times in
4,186 in this log, so the opportunity is rare.

**A weak assertion, recorded rather than hidden:** the driver's "under a minute
when it appears" check parsed the seconds field of `1:00` and so was trivially
true. The real evidence is that the element was absent at four minutes and
present at exactly sixty seconds.

## What is left

Phase 2 and Phase 3, both still blocked on the contracts in the plan — two live
provider probes and a state-path decision for Phase 2, the identity and
secret-lifecycle rules for Phase 3. Neither is schedulable yet.
