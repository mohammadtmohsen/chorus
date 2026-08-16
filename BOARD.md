# Board

Somewhere to drop a task so it is not lost, and somewhere to look when deciding
what is next.

**Not a plan.** Work of any size still goes through
`docs/plans/{slug}-{date}/plan.md`, and a plan's own progress belongs in its
`STATUS.md`. This file is for the things that sit outside any one plan: what needs
a person rather than a commit, what was noticed in passing and is worth doing, and
what is deliberately parked.

**An entry says three things** — what it is, why it matters, and what would make
it done. An entry that cannot answer the third is a thought, not a task, and
belongs in a plan's open questions instead.

**Every entry has an id**, `C-001` upward, so a commit or a PR can name the thing
it closes. Ids are permanent and never reused: when an entry ships it moves out
and its number retires with it, because a recycled id makes an old reference point
at the wrong work. The next id is the highest ever used plus one — including the
ones no longer on this page.

Move an entry out when it ships. A board that keeps its finished work stops being
read, which is how the status summary went stale a day after it was written.

---

## Needs you

Nothing here can be finished by me alone.

## Open

### C-004 · Measure what catch-up actually costs

In a shared room each agent is fed what the other said, up to 12,000 characters a
turn, with activity capped at 40% so it cannot crowd out speech. It is the one
input Chorus invents, and it is careful — labelled `[Chorus]`, truncation
disclosed, the user's real message fenced off.

Nobody has measured it in practice. It does not make answers worse directly, but
it brings **compaction** forward, and compaction is the one moment the transcript
and an agent's memory stop agreeing.

**Done when:** a real two-agent room reports the catch-up size per turn and what
share of the context window it accounts for, so 12,000 can be judged as generous,
tight, or irrelevant on evidence.

### C-005 · The composed catch-up is not recorded

`user.message` holds what you typed; the agent received that plus a preamble
composed at delivery. It is a pure function of the events, so it is
reconstructible in principle — but if an agent behaves oddly you cannot read back
the exact text it was given.

**Done when:** either the delivered text is recoverable for a past turn, or this
is closed with the reason the log deliberately records the conversation rather
than the prompts.

### C-006 · Should any of the e2e suite run in CI

**Half unblocked, and the other half got worse when it was measured.** This
entry was briefly marked "unblocked for the first time" on the strength of five
clean suites. **That was withdrawn**: twenty runs put the suite at **6 of 10
clean** (C-029), so a green suite is what a full run says about 60% of the
time.

What genuinely improved is the _meaning_ of a green run rather than its
frequency. C-027 gave the runner a third outcome, so `all N passed` now means N
specs actually ran instead of possibly skipping in silence — which is what this
entry needed before CI could prove anything at all. And C-003's fix took the
worst offender to 0 failures in 560 spec-executions.

**But a 60% pass rate is not something to put in front of a pull request.** A
required check that fails four times in ten teaches everyone to ignore it, which
is worse than not having it — the same trade this entry already warns about in
its own last paragraph. **C-029 is now this entry's blocker, not C-027.**

The plan is written and unstarted at
`docs/plans/what-a-green-build-proves-2026-08-11/`. Its Phase 0 — does Electron
open a window on a GitHub runner at all — is still worth answering, because it is
independent of the flake rate and a failure there closes this entry a different
way.

Note C-031 before designing the job: the focus-dependent checks cannot run
alongside anything that takes the window server's attention.

**Do not write the spec count down anywhere.** This paragraph used to correct 26
to 28, `packaged.mjs` carried the 26, and by 2026-08-14 the real figure was 32 —
so the correction had itself gone stale, which is worse than the number it was
fixing. Both are now phrased without a total. `specs.mjs` is the count.

**Half of the fallback now exists.** The plan for this entry recorded that there
was no release checklist anywhere, and one of the two ways to close C-006 runs
through it. `CLAUDE.md` § Releasing is now that checklist, and it is explicit
that the e2e suite is **not** part of the release sequence and that a release
therefore proves launch, the native module, the composer and an agent joining —
nothing about the transcript, tabs, or a menu under load.

What it deliberately does **not** say is "run the suite before tagging", because
at 6 of 10 clean that would block two releases in five on a coin toss. Making it
a gate is exactly what fixing C-029 would buy.

CI runs typecheck, lint, format, tests and a build. It **cannot** run the e2e
specs or `verify:package`, because both drive real `claude` and `codex` CLIs with
real credentials. So a green PR is not evidence about the renderer, and this
session shipped a transcript change that way before a local run caught an
unrelated defect.

**Done when:** either a credential-free subset exists in CI (a launch, a window, a
store that opens — no agents), or the answer is written down as "run it locally
before tagging" and the release checklist says so.

### C-013 · A question card expires while you are answering it

`mapping.ts:1011` stamps every question set with `expiresAt: ctx.now +
ctx.approvalTtlMs`, and `approvalTtlMs` defaults to five minutes
(`claude-adapter.ts:788`). The deadline is wall-clock from the moment the agent
_raised_ the question, and nothing restarts it. Answering is not an input to it:
the card can be on screen, focused and half-filled, and it still goes. Approvals
carry the same stamp (`mapping.ts:1070`–`1126`).

Hit twice in one session. An agent asked a three-part question; both times the
card vanished mid-answer while the user was typing into it in another pane.

A question that runs out its deadline leaves a notice reading `A question went
unanswered in time.` (`transcript.ts:359`), and the agent is told nothing was
chosen and carries on. `transcript.ts:345` argues for that notice existing at
all, and the argument applies here exactly: _"without this the only trace is a
reply that quietly assumed something."_

**Confirmed from the log** (2026-08-10): 25 question sets raised, 15 answered,
**10 timed out, 0 cancelled** — and every one of the ten died at exactly 300.0s,
which is the TTL and not a dismissal. The inference was right and the count was
low by a factor of five. Planned in
`docs/plans/question-deadline-2026-08-10/plan.md`.

Why it matters beyond the annoyance: the deadline is hardest on the longest
answers, which are the ones attached to the questions most worth asking. Up to
four panes are mounted at once and attention is _expected_ to move between them,
so "typing in the other pane" is ordinary use rather than idling.

**The TTL is not the bug.** An approval nobody ever answers would wedge a turn
forever, and the timeout is what stops that. What is wrong is that the clock
ignores the person it is waiting for.

**In progress — phase 1 shipped** (`139bc41`). A card now shows a countdown in
its last minute, so a deadline is no longer invisible until the card is gone. The
threshold comes from the data: the median successful answer took 55 seconds.

Two of the three conditions below are met. What remains is the deadline itself
responding to the person.

**One of its two blockers has since cleared.** `askUserQuestionTimeout` defaults
to `'never'` in `sdk.d.ts`, confirmed with a stalled `canUseTool`, so **Claude
does not give up** and extending is safe from its side — the five minutes is
entirely ours to choose. Still open: the Codex probe, and how an extended
deadline reaches a card that has remounted, since the renderer replays only the
_original_ `expiresAt`.

One correction to the measurement above: those 15 `answered` outcomes record that
Chorus _sent_ an answer, not that Claude took it, and for part of that period it
did not (C-018). **10 of 25 is the optimistic reading**, and the figures are worth
re-taking now that answers land.

**"Holds focus" has since become a weaker signal than it was when this was
written, and the change came from the other direction.** A card no longer takes
the caret when someone is part-way through a sentence (C-028), because landing on
**Allow** mid-word meant the next Enter approved an unread command. The
consequence here is that a card can now be on screen, with a person plainly
working, and never hold focus at all — so a deadline keyed to focus would expire
on exactly the user it was meant to protect. A partial answer, or any input to
the card, survives that change; focus does not.

**Done when:** ~~the log has been read back to confirm which outcome actually
fired~~; a question the user is demonstrably engaged with cannot expire under
them — the deadline held while the card holds a partial answer, or reset on
input — and ~~a card genuinely about to expire says so while it can still be
answered~~.

### C-015 · An agent cannot address another agent

`parseMentions` runs in exactly one place: `runtime.send`, the path the **user's**
message takes. An agent's own output goes `ConversationService.consume` →
`handle` → `lifecycle` → `append`, and nothing on that path reads a mention. So
when one agent writes `@codex` in a reply, it is prose. It reaches the other
agent only as catch-up — trimmed to 1,500 characters per message inside a 12,000
character budget, with activity capped at 40% — and never as a turn addressed to
it.

Noticed by being unable to do it. Asked to have codex review 3,383 lines, the
only thing I could produce was a brief for the user to copy across by hand, or
to point at the hand-off button. `sendHandoff` does deliver in full and does
bypass catch-up, but it is driven from the UI by a person: `Entry`'s `onHandOff`
is a button, not something an agent can reach.

**Why it matters:** the premise is several agents in one shared conversation, and
right now every exchange between them is relayed by hand. Review, second
opinions and hand-backs are exactly the collaboration the product is for, and
each one currently costs the user a copy and paste.

**Why it is not obviously a bug.** Agents addressing each other directly is a
real product decision with teeth: two agents that can each start the other's turn
can loop, and a loop here spends the user's money while they are not looking.
Whatever ships needs a bound — a depth limit, a visible cost, or the user
confirming the first hop — and choosing which is the actual work.

**Done when:** either an agent's mention routes like the user's, with that bound
written down and enforced; or this is closed with "agents talk through the user
on purpose" recorded as a decision, so it stops being rediscovered as a gap.

### C-016 · A delegation that comes back

Asked for directly: _"claude writes the plan and asks codex to review; after the
review let codex notify claude, fix the plan from the review, then start
implementing."_

**This is not C-015, and filing it as one would lose the hard half.** C-015 is the
outbound hop — a mention in an agent's reply routing like the user's. This is the
_return_, and the return is what makes it a workflow rather than a message:

- the delegating agent has to still be **waiting** — its turn suspended on an
  answer from another agent, not ended;
- the reviewer's reply has to arrive as something it must **act on**, not as
  catch-up prose it may summarise;
- and it has to **carry on with the original task** afterwards, which means the
  continuation is a turn nobody typed.

Every one of those is absent today. C-015 is a prerequisite, not a duplicate.

**Why it matters:** this is the product premise, and this session paid for its
absence repeatedly — every codex review was relayed by hand, in both directions,
because there was no other route.

**The teeth are in the failure modes**, and they are worse than C-015's. Two
agents that can each resume the other can loop; a suspended turn that is never
answered wedges rather than merely going quiet — the same clock problem C-013
describes, one level up; and a continuation nobody typed spends money while the
user is away from the screen.

**Done when:** the round trip above completes without the user relaying anything;
the delegating agent's resumption is in the log as its own turn, attributable to
the delegation rather than appearing from nowhere; and a reviewer that never
answers, or a pair that ping-pongs, is bounded — with the bound written down and
visible to the user rather than implicit.

### C-021 · The log cannot rebuild a conversation, because tool output is capped

Found by C-017's Phase 0. `tool.completed` stores a `summary`, and for a `Read`
it is capped at `MAX_TOOL_DETAIL = 120` characters — measured over the live log,
196 Reads with a **maximum of 120 and an average of 41**. `Edit` and `Write` sit
at the cap too.

120 is a sensible width for a **line in a transcript**. It is sitting on the
**durable log**, which is the thing this project says is the source of truth, and
the consequence was measured rather than argued: a room rebuilt from Chorus's own
record could not answer a question about a file the agent had read, while a
provider fork could.

**Why it matters:** "the event log is the source of truth" is the rule everything
else here follows from. For agent _speech_ it holds. For what an agent _saw_ it
does not — the log records that a tool ran and roughly what it was, not what came
back. Anything that needs to reconstruct an agent's working state from the log is
therefore built on sand, and C-017's Part B has to fork a provider session
precisely because of this.

**Why it is not a simple fix.** Storing full tool output means storing whatever a
tool read — including the contents of files the permission engine treats as
secret, which the answer-redaction path deliberately keeps out of the log. Size
is the lesser problem; deciding what may be written down is the real one.

**One slice has since landed.** `tool.completed` now carries a `patch` for file
edits, so what an agent _changed_ is in the log in full. That was tractable
because the secrets question had an existing answer — the field is a string named
`patch`, so `redactPayload` scrubs it on the way to disk. Nothing about what an
agent _read_ has changed, which is the harder half and the one this entry is
about.

**Done when:** either the log carries enough tool output that a conversation can
be reconstructed from it — with a stated rule about secrets — or it is written
down that the log records the conversation and not the agent's working set, so the
next person does not rediscover this as a bug.

### C-022 · The transcript reducer hardcodes English

`transcript.ts` builds every system notice from an English literal —
`'A question went unanswered in time.'`, `'Interrupted.'`,
`'Denied — nobody answered in time.'` and now
`'Opened as a conversation…'` — while `CLAUDE.md` says the opposite:

> **No hardcoded user-facing strings** — `i18n/en.json`. The reducers have no
> translator, which is why events carry keys (`notice.source`) and the renderer
> turns them into words.

The stated design exists and is used for some things; the notice path is not one
of them. Noticed while adding `aside.promoted`, whose line was written the same
way rather than inventing a second mechanism for one event.

**Why it matters more than it looks:** the app already ships an explain-in-your-
language feature and RTL support, so a user reading Arabic gets a transcript with
English system lines in it. And the workaround is not "translate in `Entry`" —
the reducer decides the _wording_, so the key has to come from the reduction.

**Done when:** the notices `transcript.ts` produces carry keys rather than
sentences, `en.json` holds the words, and a pure-reducer test can still assert
what was produced without a translator.

### C-019 · A rejected answer is still logged as answered

Split out of C-018, which it hid. `userinput.answered` is appended when _Chorus_
sends the answer, and nothing checks whether the provider took it — so for as
long as the answer shape was wrong, the transcript read `outcome: 'answered'`
while the agent behaved as though nobody had replied. The bug was invisible in
the one place anyone would look for it.

The same is true of approvals: `approval.decided` records our verdict, not the
provider's acceptance of it.

**Why it matters beyond the bug that is now fixed:** it will hide the next one.
It also means the log cannot be trusted for exactly the kind of measurement
C-013's plan is built on — "15 of 25 answered" counts answers sent, not answers
received.

**Why it is not trivial.** `canUseTool` returns a value; a rejection surfaces as
a later tool error or a retry, not as a failed promise, so there is no obvious
place to notice. Anything built here has to avoid claiming the opposite falsehood
— an answer that did land, recorded as failed — and must not add a round trip to
the common path.

**Partly addressed.** `answerUserInput` now refuses an `answered` response whose
answer ids do not exactly match the questions asked, before anything is written —
so the one case Chorus can detect for itself no longer produces a false record,
and the adapter denies rather than sending a partial set. What remains is the
case Chorus cannot see: an answer the _provider_ rejects for a reason of its own.

**Done when:** an answer the provider rejects is distinguishable in the log from
one it accepted, or this is closed with the reason the log deliberately records
what Chorus did rather than what the provider made of it.

### C-026 · A resize costs two seconds of settling — **measured, and much smaller than filed**

Filed as "a narrow pane never stops resizing itself", from an observation that
the `ResizeObserver` fired fourteen times in 107ms and was "still firing" when
the measurement ended.

**That was wrong.** Measured properly in
`docs/plans/the-pane-that-never-settles-2026-08-11`: a quiet narrow pane costs
**zero** callbacks over ten seconds, and so does a selection. The 107ms had
landed inside a settling burst that follows a _resize_, and the burst had simply
not finished yet. Extrapolating it to "forever" was the error.

The scrollbar and the spacer were both eliminated by measurement rather than
argument: `clientWidth` and `offsetWidth` never moved across any callback, and
`spare` converged monotonically instead of alternating.

**What is actually left:** a resize takes about **38 layout-and-observer cycles
over roughly two seconds** to converge, where a settle might reasonably take two
or three. It terminates on its own, nothing is visibly wrong, and it costs
nothing when the pane is not being resized.

**Why it stays on the board at all:** a resize is a user action, and two seconds
of churn behind it is perceptible on a slow machine. It is a performance nicety
now, not a defect.

**A second resize path now exists, and the obvious instrument does not work.**
The terminal panel resizes `.score` on every toggle and every drag, so this is
slightly more reachable than it was. Measuring it was attempted and abandoned:
counting frames until `.score`'s geometry stops moving is **not valid in a driven
window**, because Electron throttles `requestAnimationFrame` when the window is
not frontmost — it produced 0, then 1, then hung. That is C-031's problem wearing
different clothes.

The original 38 came from wrapping the app's own `ResizeObserver`, which has to be
installed **before the renderer's scripts run**. The harness attaches after load,
so re-measuring needs a harness change rather than another probe. That is the
next step, and it is the same change C-031 would want.

**Done when:** either a resize converges in materially fewer cycles — with the
count before and after stated, over the same stimulus — or this is closed as
acceptable, with the 38 written down so nobody re-derives the alarm from the
same observation.

### C-028 · The blocking cards are only ever tested away from the app

Three focus defects were fixed in one session and **not one of them can fail the
suite**. `e2e/specs.mjs` drives an agent, a transcript, tabs, the sidenav and the
composer; it never raises an approval or a question, because raising one means an
agent deciding to ask. So the two cards that stop a turn are the two surfaces
nothing exercises.

What was fixed, and what each was actually verified against:

- **A card took the caret mid-sentence.** An approval or question arriving while
  you typed moved focus to **Allow** — the rest of the words went nowhere and the
  next Enter approved a command nobody had read. Verified by a pure predicate
  (`focus.ts`) and a Chromium read of `document.activeElement` over real
  controls.
- **`useDialog` re-focused on every parent render.** Every caller passes an
  inline `onClose`, so a `Session` re-rendering on each streamed delta tore the
  effect down and set it up again, throwing the caret out of the handoff's brief
  box and back onto its `Ask them to` select. Verified by bundling the real hook
  with React 19 and driving re-renders: the old one jumped to the select after
  one, the new one held through five.
- **A long approval put its own buttons off the pane.** Measured against the real
  stylesheet in an 800px pane: the dock stood at **1529px** and Allow sat **684px
  below the bottom of the pane**, unreachable — at every pane height tried.

Every number there came from a harness holding the app's real stylesheet or its
real hook. The harnesses were temporary; the regressions they would catch are
not.

**Why it matters:** this is the most expensive place in the product to be wrong —
approving an unread command is the worst outcome it has — and two of the three
fixes are one careless dependency array from coming back. It is C-027 seen from
the other side: that entry is about a suite reporting green while testing
nothing, and this is a suite that cannot go red for these at all.

**Done when:** a spec provokes a real approval and asserts three things — the
caret stays in a half-typed composer, the buttons are inside the pane for a long
command, and a handoff sheet keeps focus across a parent re-render — or it is
written down that these are covered by unit and harness only, with the reason a
real approval cannot be provoked on demand.

### C-029 · A slow run fails, and load is not why — **measured over 20 runs**

Filed as "four specs fail under the suite that pass on their own". After twenty
full-suite runs the shape is different in every particular except the symptom.

**The rate: 6 of 10 clean**, in two separate ten-run batches that agreed exactly.

| batch                                  | clean | failing |
| -------------------------------------- | ----- | ------- |
| first (contended — other work running) | 6/10  | 4/10    |
| second (nothing else on the machine)   | 6/10  | 4/10    |

The second batch exists because the first was taken while a merge and a full
`pnpm check` ran alongside it, and that had to be ruled out rather than argued
about. It was not the cause.

**Duration predicts failure perfectly. Load does not predict duration.**

| run      | wall     | load before → after | result            |
| -------- | -------- | ------------------- | ----------------- |
| clean ×6 | 285–324s | —                   | 28/28             |
| slow ×4  | 400–665s | —                   | 2–3 failures each |

Every clean run finished in **285–324s**; every failing run took **400–665s**.
But the load average says the obvious explanation is wrong:

- run 3 started at load **12.19** and passed; run 8 started at **19.11**, the
  highest in the batch, and passed;
- run 5 failed while load **fell**, 7.22 → 4.23; run 9, the worst at 665s, sat at
  a mild 7.75 → 8.52.

**So "they fail under load" is dead**, and so is the focus-stealing story that
replaced it — that was inferred from a single unprompted window blur (now C-030)
and never survived a measurement. Something makes a run take twice as long, and
whatever that is, it is not CPU contention and it is not the machine being busy.

**Which specs, over the clean ten:**

| spec                                                       | rate |
| ---------------------------------------------------------- | ---- |
| `keeps the offer when the transcript scrolls under it`     | 4/10 |
| `offers only the actions a passage can actually take`      | 3/10 |
| `the question stays at the top of the answer it asked for` | 2/10 |

**The population is not stable and that is a finding, not noise.** The first
batch had two _sidenav_ specs failing 2/10 each — layout specs that were never on
this entry's list — and they did not fail once in the second. The worst offender
swapped places between batches. What survives across both is the quote-offer
family plus the question spec.

**Two of the original four are fixed and gone from this list.** `typing a slash
offers the commands this project actually has` and `an @ offers the cast` failed
**0 times in 20 runs — 560 spec-executions** — after C-003. That is the strongest
evidence available that the blur fix holds.

**What is known about the survivors.** All three wait on something that appears
after a selection or a turn completes. The quote offer is built synchronously on
mouse-up and then _cleared_ by a later `selectionchange` when the selection
collapses — and a selection is a Range over text nodes, so a re-render that
replaces them collapses it. That is a hypothesis with a mechanism, not a
diagnosis: it was never instrumented, because the fix for C-003 landed first and
this was left.

**Two cautions this entry paid for, worth keeping:**

- **Five runs cannot see a 30% flake.** A five-run baseline came back clean and
  was reported as "does not reproduce"; it was withdrawn. Ten is the floor for a
  per-spec rate.
- **A remembered baseline is worth less than a back-to-back A/B**, because the
  machine drifts between measurements — identical work took 274s and 665s in one
  day.

**Done when:** the three surviving specs have a named cause — the obvious next
move is to instrument _why_ `setSelected(null)` fires, the same "record the
decision, not the outcome" move that broke C-003 open — or the suite is made to
tolerate whatever doubles a run's wall clock, with the rate restated over ten
runs.

### C-030 · Something blurs this machine's windows unprompted

Found while diagnosing C-003 and never explained. A debug run watching a single
Electron window recorded `document.hasFocus()` going from `true` to `false`
**with nothing driving it** — no click, no app switch, no probe action — about
ten seconds after a menu opened.

**Why it matters:** it is the reason C-003 was reachable at all. A blur that
nobody asks for is what turns "the menu never comes back" from a theoretical bug
into one a user meets, and it means any measurement of window behaviour here has
a hidden variable in it.

**It is not the explanation for C-029, and this entry used to claim it was.**
That claim came from one observation and was never measured. Twenty full-suite
runs since then put every C-003 spec at 0 failures and leave three specs failing
that have nothing to do with focus — and the load evidence there kills the wider
"the machine was busy" story too. This stays open on its own merits, not as
another entry's cause.

Candidates never eliminated: `mediaanalysisd` (seen at 171% CPU), Spotlight
indexing, a notification, or something in the window server. Whether it happens
on other machines is unknown, and that is the first thing worth knowing.

**Done when:** the source is named, or it is shown not to happen on a second
machine — in which case it is this Mac's problem and gets recorded as such rather
than chased in the app.

### C-031 · The e2e probes take focus from whoever is using the machine

The harness drives a real window, and several diagnostics for C-003 had to steal
OS focus with `osascript` to test blur and refocus. Two costs, both paid:

- **Stray keystrokes land in the composer under test.** A probe run was scored as
  a failure carrying `mention: "@0:ceten"` — characters typed by the person at
  the keyboard, arriving in the test's own box while the probe held focus.
- **The probes stop working when the machine is in use.** Twelve consecutive runs
  failed at `never became true: window focus`, because macOS would not hand
  focus over while someone was working in another app.

**Why it matters:** it makes a class of measurement unrepeatable at exactly the
times someone is around to ask for it, and worse, it can produce a _confident
wrong result_ rather than an obvious failure — the `ceten` run looked like a
defect and was not.

**Done when:** either the focus-dependent checks can run without taking focus —
a second display, a headless window, or a `WebContents`-level blur that does not
touch the window server — or the suite states plainly that these specs need an
idle machine and skips with a reason when it cannot get one, which C-027's
mechanism now makes possible.

### C-032 · The terminal is covered by seven throwaway probes and no specs

`apps/desktop/build/*-probe.mjs` and `pty-smoke.cjs` drive the real app and cover
things nothing else does: a shell surviving its own view, `⌘K` clearing both the
screen and main's mirror, the caret staying in the terminal on a click, panels
returning at the right height after a relaunch, and the packaged bundle spawning
a PTY at all.

They are not run by anything. `pnpm e2e` does not know about them, CI cannot run
them, and each has to be remembered by name.

**Why they were not written as specs:** C-029. A suite whose result needs two
runs to interpret is a poor home for coverage of a feature nobody has used for
long, and the plan said so rather than adding to the pile.

**Why it matters anyway:** every one of them found something. Two found defects
that four earlier probes had missed, and one — the `⌘K` chord check — passed with
the guard removed until it was rewritten to measure `defaultPrevented`. That is
C-027's failure mode in new code, caught only because someone mutated the guard.

**Done when:** the coverage lives somewhere that runs on its own, or the files are
deleted with a note saying what was given up. Sitting in `build/` as neither is
the outcome to avoid.

### C-033 · Nothing decides whether killing a terminal loses work

`TerminalService.describe()` reports `{ running, foreground, busy }`, and nothing
consumes it. Ending a conversation kills its shell without asking, and quitting
kills the global one — mid-`ssh`, mid-`psql`, mid-migration, with no confirmation.

The plan deliberately built the _answer_ without choosing the _policy_, so that
all three candidates — never ask, ask when busy, ask only on quit — sit on top
without changing a signature.

**One measurement that constrains the choice.** `busy` is an instantaneous
sample, not a claim about the next second. A probe asserting it stayed true
failed with foreground `zsh` while a `for … echo … sleep` loop was demonstrably
still running, because between sleeps the foreground _is_ the shell. **A
confirmation keyed on `busy` alone would say "nothing running" mid-loop and kill
the work it exists to protect.** Whatever ships needs either a window rather than
a sample, or a different signal.

**Done when:** a terminal with live work either cannot be killed silently, or it
can and that is written down as a decision with the reason — and if it asks, the
signal it asks on is not a single sample of `busy`.

### C-035 · A notebook cell is a document the editor context cannot name

`resolveDocument` (`apps/vscode-extension/src/document-identity.ts`) now parses
`file:`, `git:` and `gl-review:` and refuses everything else, on purpose: a
scheme nobody has read yields a wrong path rather than none, and main's
re-validation turns a wrong path into a silent `unmatched`.

`vscode-notebook-cell:` is the one refusal a user will actually hit. A cell is a
real `TextEditor` with a real selection, so the selection is there to be read —
but its URI names the `.ipynb` and carries the cell in a fragment, and a
reference of `notebook.ipynb:12-14` means nothing to an agent: line 12 of the
JSON file is not line 12 of the cell. Making it work means carrying a cell
identity through `EditorMetadata`, the pill and the reference format, which is a
protocol decision and not a parsing one.

Until then a notebook behaves as it did before this work: no context, and — since
"a document is not a file" landed — at least no longer wiping the selection you
already had.

**Done when:** either a cell selection produces a reference an agent can act on,
or the refusal is written down as permanent with the reason, so the next person
does not rediscover it as a gap.

### C-036 · The extension speaks English, and the app's rule says it must not

"No hardcoded user-facing strings — `i18n/en.json`" is a renderer convention that
`apps/vscode-extension` has never followed. Its manifest strings go through
`package.nls.json` properly, but everything it writes at runtime is a literal in
`extension.ts`: the status bar's `Chorus: linked`, `Chorus: not running`, both
`update the extension` / `update Chorus` warnings with their tooltips, and every
line of the `Chorus: Diagnose editor context` dump.

Pre-existing — the first two shipped with the feature — but the protocol-2 work
added five more without deciding anything, which is how a convention quietly
becomes an exception.

**Why it matters:** these are the strings a user reads at the worst moment. The
mismatch warning exists precisely because editor context has gone silent, and it
is the one instruction that unblocks them. If Chorus is worth translating, the
sentence telling you the extension is out of date is not the place to stop.

**What makes it awkward rather than obvious:** the extension host has its own
mechanism, `vscode.l10n`, which is not the app's `t()` and wants bundle files
declared in the manifest and shipped inside the VSIX. So this is not "import the
translator" — it is a second localisation system, in a build that deliberately
writes its own VSIX by hand to avoid dependencies. The diagnostics dump is also
arguably not user-facing prose but a bug-report artifact, and translating it
would make pasted reports unreadable to whoever receives them.

**Done when:** either the runtime strings a user acts on go through `vscode.l10n`
with the VSIX carrying its bundle, or the extension is written down as English-only
with the reason — and in that case the diagnostics dump is named as the thing that
stays English on purpose.

### C-037 · A session spawns codex app-servers and reaps none

Observed 2026-08-13, 21:50. One `pnpm dev` Electron process (pid 41382) held **26
children, 16 of them `node codex.js app-server`**, spawned in a roughly
twenty-second burst and then idle at **0% CPU** for seventeen minutes. The codex
agent in that session stopped answering and never recovered; `SIGTERM` was
ignored by all sixteen and `SIGKILL` was needed. Six more, aged two to twelve
hours, were sitting under a different parent, so this had already happened at
least twice earlier the same day without anyone noticing.

Killing them was enough to un-wedge the app — codex then reported `codex
app-server exited (code=null signal=SIGKILL)` and could be restarted — which says
the pile-up is the failure rather than a symptom of one.

**Why it matters:** a wedged agent looks exactly like a slow one. There is no
surface anywhere in Chorus that shows how many provider processes a session owns,
so the only way this was found was `ps`. The user's read on it was "why does every
task take hours", and for the last seventeen minutes of that, the honest answer
was that nothing was running at all.

**What is not yet known:** which side leaks. It could be the supervisor spawning a
fresh app-server per turn or per reconnect and dropping the handle, or the adapter
failing to close one whose turn was interrupted, or a restart loop that races
itself. Sixteen in twenty seconds looks like a retry loop rather than one per
turn, but that is inference from a process table, not from a log — nobody has read
`packages/orchestrator`'s supervisor against this yet.

**Done when:** a session's provider processes are bounded and reaped — one live
app-server per agent, with the previous one killed before a replacement is
spawned — and something fails loudly when it is not. A count in the pulse would
be enough to make the next occurrence visible in a second instead of an hour.

### C-038 · The global terminal can be toggled into a state hydration throws away

`hydrate` applies its result with `set({ ...reconcileWorkspace(saved) })`, and
`shared/workspace-layout.ts:93` always produces a `globalTerminal` — closed, on a
profile with nothing saved. So a toggle that lands between the rail rendering and
hydration finishing is not merely early, it is **overwritten**, and the panel
never appears however long you wait.

Found while writing the terminal colour spec, which failed on it in roughly half
its runs before the cause was understood: the click reported success, the store
said open, and the next `set` reverted it with no error anywhere. The spec works
around it by clicking until it sticks.

**That workaround does outlive the fix, and has to be deleted by hand.** An
earlier draft of this entry claimed otherwise — that the loop would simply pass on
its first attempt and so cost nothing. It would, and it would also still be there,
a retry with no defect left to retry against, reading to the next person as though
the toggle were unreliable. Closing this means removing the loop in
`specs.mjs` and clicking once.

**Why it matters:** a person who clicks the terminal in the first moment after
launch gets nothing at all, and nothing tells them why. The window is short —
under a second on this machine — but launch is exactly when someone reaches for a
shell, and the second click always works, which is what makes it read as a
flaky button rather than a bug worth reporting.

**Not just the terminal.** `globalTerminal` is the instance that was caught; every
field `reconcileWorkspace` supplies has the same shape, so any pre-hydration
interaction with workspace state is discarded the same way.

**Done when:** either the store refuses interactions until `hydrated` is true —
it already carries the flag — or `hydrate` merges rather than replaces the fields
a user can have touched. A test that toggles before hydration and asserts the
state survives is what would hold it.

### C-039 · A reader who scrolled up is re-followed by a layout they did not cause

Reported as _"when i drag and split workspace or reorder the tabs it scroll to top
for the moved workspace"_. Half of that was a real restore bug and is fixed
(`c160be7`, corrected after). This is the half that is not, and it is a design
question rather than an oversight.

**Following stops on a gesture and resumes on position** — `9393281` made that
split deliberately, because inferring "the reader scrolled up" from `scrollTop`
moving backwards was wrong: anchoring and `makeRoom` both move it backwards, and
either one ended following permanently. Position was kept as the resume signal
on the grounds that _"arriving at the bottom is unambiguous however you got
there."_

**It is not unambiguous, because the bottom moves.** `makeRoom` sizes the spare
room against the view, so the scroll range changes without the reader touching
anything — measured here 209 → 141 across one remount, and `9393281` itself
records the spare room oscillating 686→663→686 during a turn. A reader parked
100px up is 100px up until the range shrinks under them; then they are inside the
32px resume band, and the next resize takes them to the bottom.

**Measured** (`e2e/split-scroll.mjs`, viewport 1000×360): wheel up, park at
`40 of 209`, switch tabs and back. The trace reads `141/141` from the _first_
frame — so the pane is re-following before the mount restore is even consulted,
which is why fixing this from the restore side does not work and should not be
attempted again.

**Why it matters:** it is the original report's remaining half, and it is the
failure mode `9393281` names as the worst one — _"a transcript that yanks you to
the bottom while you are reading something further up is worse than one that
never follows at all"_ — arriving by the other door.

**Done when:** a reader who has gestured away stays away until they return by
their own gesture or genuinely reach the end under their own steam — with the
range changing under them counting as neither. The obvious shape is to have the
resume test ignore range changes the app itself caused, but that is a decision
about which signals are trustworthy and belongs with whoever owns the follow
logic. `e2e/split-scroll.mjs` already fails on it and is the test that would hold
it.

## Parked, with reasons

Not open questions and not oversights: judgements already made, written as tickets
so they can be cited and argued with rather than rediscovered as gaps. The third
line of each is **what would reopen it** — a parked ticket with no such condition
is not parked, it is forgotten.

Full reasoning, including the probes, is in the plan's `STATUS.md` and `DONE.md`.

### C-002 · Whether to notarize

Ad-hoc signed, not notarized, and that is a decision rather than an oversight.
`electron-builder.yml` sets `identity: null` and then ad-hoc signs in
`afterPack`, with a comment explaining why the two are not the same thing: an
ad-hoc build is called _untrusted_, which is a warning you can click past, while
an unsigned one is called _damaged_, which you cannot. `docs/install-macos.md`
walks through the dialogs, and every release's notes repeat the two ways round
them.

Notarizing means the Apple Developer Program, a Developer ID certificate, and
uploading each build to be scanned and stapled — an annual fee and an Apple
account, neither of which is a commit. Parked rather than deleted for the reason
this section exists: without a paragraph saying ad-hoc signing was chosen, the
next person to build a DMG meets Gatekeeper and re-opens the question from
nothing.

**Reopens if:** the DMG goes to anyone but the person who built it. A one-time
right-click → Open is friction on your own machine; it is a scary dialog and a
documentation link to a stranger.

### C-007 · The todo panel

The detail line shipped: a `TodoWrite` row reads `Fixing the parser · 1/3` instead
of the bare tool name, using the field names and the one-in-progress invariant read
out of the CLI binary's own tool description.

The panel did not. It cannot be built honestly on this machine, whose config
replaces `TodoWrite` with `TaskCreate`/`TaskUpdate` — asked to write todos, the
agent said so itself. Building a surface nobody here can see means shipping a
schema commitment on faith and calling it verified.

**Reopens if:** a machine has `TodoWrite`, so the panel can be driven and looked at
— or the `Task*` shape is worth handling as a second reduction on its own merits.

### C-008 · Dialogs

Carried unbuilt through three phases before being decided rather than carried a
fourth time. `refusal_fallback_prompt` is the only kind the CLI declares.

The reason not to build it inverts the intuition that wiring the callback is the
safe half: the CLI treats an **undeclared** kind as "cannot display" and fails
_closed_, so today's behaviour is a defined degradation — the classic refusal
error. Declaring the kind is a promise Chorus can render it, and breaking that
promise parks the turn instead. Against which `payload` is `Record<string,
unknown>` defined per kind, and the trigger is a model refusal that cannot be
produced on demand to test against.

**Reopens if:** a second dialog kind appears, or the payload shape is documented —
either makes the renderer testable, which is the whole objection.

### C-009 · Checkpoints

`rewindFiles(userMessageId)` wants the CLI's own uuid for a user message. Probing
every message the SDK yields for one prompt gives `system/init`, `assistant`,
`rate_limit_event`, `result` — and nothing else. **The CLI never echoes the user's
message back**, so there is no uuid to capture. Setting
`enableFileCheckpointing: true` changes nothing, which disposes of the hope that
the option makes it start announcing them.

The uuid exists in exactly one place: `~/.claude/projects/<slug>/<sessionId>.jsonl`.
That route is available and wrong — an undocumented private format belonging to a
self-updating binary, read to drive an operation that **reverts files on disk**,
where a format change rewinds to the wrong point rather than failing.

**Reopens if:** the SDK exposes the id — an echoed user message, or a `rewindFiles`
that accepts something a host can legitimately know.

### C-010 · The context breakdown

`getContextUsage()` carries a full inventory — system prompt, tools, memory files,
skills, messages — and the temptation is a panel showing where the window went.

Measured, the obvious version lies. `totalTokens` **excludes** the deferred
categories: 253 + 12,725 + 4,289 + 2,110 + 4,787 = 24,164, exactly `totalTokens`,
while two deferred rows carry another 59,538 that costs nothing until something
loads them. A panel presenting "MCP tools: 45,930" as consumed would be wrong by
more than twice the total.

Also unused and more interesting than the breakdown: `autoCompactThreshold` is
967,000 against a `maxTokens` of 1,000,000, so compaction fires at 96.7% and a bar
drawn against the maximum never fills before it resets.

**Reopens if:** someone designs it with the deferred distinction drawn honestly.
The blocker is design, not plumbing.

### C-011 · Terminal sessions in the history sheet

Chorus's log is authoritative, decided in open question 2. A CLI session is a
different unit: a Chorus conversation is a _room_ spanning several sessions, and
`listSessions()` is Claude-only, so codex does not appear at all.

Measured on this repository, `listSessions()` returns 21 sessions of which eight
are throwaway — three `Say OK`, two `hi` — five created by this project's own
probes in one afternoon. Merged rows would put `Say OK` in the history sheet
looking reopenable.

**Reopens if:** importing terminal work is wanted, as its own labelled surface
rather than merged rows. `sessionRef` is already recorded, so a room can name its
CLI session whenever the correlation is useful.
