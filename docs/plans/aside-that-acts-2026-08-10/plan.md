# An aside that can act

`C-017`. Asked for as: _"when I click ask about this the agent should be able to
change files, run tools, do anything that a regular CLI can do — but inside the
side chat."_

## This is a deferred decision, not a new request

It was raised once already, in the aside plan, in the user's own words — _"when I
give you a permission I want to keep it on the side chat"_ — and the sharp end of
it was explicitly parked rather than answered:

> The plan now records the reconciliation and defers the sharp end of it —
> whether an aside may mutate under an inherited grant — to Phase 3.

Phase 3 shipped `neverAsks` and left the mutation question where it was. So this
plan is that deferred decision coming due, and it should be read against what was
already argued rather than as a fresh idea.

## What an aside cannot do today, and why — five layers, all deliberate

Not one switch. Five, and each was put there for a stated reason:

1. **The provider sandbox.** `runtime.ts` forks with
   `{ mode: 'readOnly', writableRoots: [], networkAccess: false }`.
2. **Chorus's profile.** `profileById('read-only')` — universal denies, universal
   asks, and a short safe-read allowlist.
3. **Grants.** `new SessionGrants()`, deliberately empty rather than the
   parent's, because a grant outranks an `ask`: an inherited "always allow
   `npm publish`" would run silently in a fork nobody is watching.
4. **`neverAsks: true`.** Every `ask` becomes an immediate deny, because a
   tooltip has no room for an approval card and an unattended fork holding one
   open is a wedged turn.
5. **The prompt.** The fork is told _"Answer it and nothing else: do not continue
   the work, do not change files."_ This one is easy to miss and was measured,
   not guessed: without it a fork treats the question as the next turn and starts
   working — _"which no permission rule catches, because reading files is
   allowed."_

**Layer 1 is weaker than it looks for Claude.** `sandboxPolicy` is `'emulated'`
for Claude and `'native'` for Codex. So on the provider whose asides are most
used, the OS is not enforcing anything and Chorus's own policy is the real gate.
Any design that leans on the sandbox is leaning on Codex only.

## The evidence: the only real refusal was a read

Measured over the log (`VACUUM INTO` snapshot, 2026-08-10). Eleven asides have
ever been opened — 7 explanations, 4 questions — against 372 conversations. In
all of them, exactly **one** approval was ever requested, and it was denied:

```
description: "Read T-061 board entry"
command:     sed -n '91,140p' …/BOARD.md
outcome:     deny   decidedBy: policy   policyRuleId: null
```

A `null` rule id on a deny is the signature of `neverAsks`: the engine returns an
`ask` with no rule id when nothing covers the request (`engine.ts:199`,
_"Read only does not cover this"_), and `neverAsks` converts it. `SAFE_READS`
lists `cat|head|tail|wc|file|which|grep|rg|find|ls|pwd` and some `git` — **`sed`
is not on it**.

So the single observed instance of an aside being stopped was **an aside trying
to read a file**, refused because it reached for a tool that is not on a short
allowlist, with no card and no way for the user to permit it.

That is worth sitting with, because it is not what the request assumes. The felt
problem is not "my aside cannot write files". It is "my aside cannot do the thing
it was already supposed to be able to do — look things up." The request for full
CLI power may be the reasonable generalisation of a much smaller failure.

## The shape of the answer

Split it, because the two halves have different risk and deserve different
answers.

### Part A — let an aside read properly

**An earlier draft of this plan said widening the allowlist was "cheap" and
"bounded by the existing universal denies". Both were wrong, and checking turned
up a live security bug — now `C-020`.**

`SAFE_READS` matches a **prefix of the whole command line**, so everything after
the first word is unexamined. Run through the real engine under `read-only`:

```
ALLOW <- find . -delete
ALLOW <- git branch -D scratch
ALLOW <- cat source > target
ALLOW <- rg needle . | xargs touch marker
ALLOW <- find . -exec rm {} ;
ALLOW <- cat evil > /Users/me/.zshrc
```

`UNIVERSAL_DENIES` catches none of them — it denies `rm -rf`, force-push and
history rewrites, and none of these is any of those. So the profile that promises
_"agents may look"_ already permits arbitrary writes through an allowlisted
reader, in every conversation, today. Asides make it worse rather than cause it:
`neverAsks` makes this allowlist the entire gate, under an `emulated` sandbox that
enforces nothing.

Part A is therefore **not "add `sed`"**. It is repairing a matcher that decides on
a prefix, and it has to survive redirects, pipes, `-exec`, `-delete` and mutating
subcommands of otherwise-safe tools. That is the work, and it is worth doing on
its own merits whatever happens to Part B — which is why it is filed separately as
C-020 and should ship first.

### Part B — let an aside act

Three ways, and the plan should choose one rather than drift into the first.

**B1. Give the card an approval surface.** Direct, and it contradicts the thing
the card was built to be. The tooltip behaviour was requested explicitly —
dismissible, non-modal, "like a tooltip" — and an approval that must be answered
turns it into a modal dialog wearing a tooltip's clothes, which is the exact
phrase the original design used to reject it.

**B2. Inherit the parent's grants.** What was asked for in the first place. The
recorded objection still stands and has not weakened: a grant outranks an `ask`,
so this hands a fork nobody is watching every "always allow" the room has ever
collected, with an emulated sandbox underneath it on Claude.

**B3. Promote: an aside that needs to act stops being an aside.** The moment it
wants something that needs a decision, it graduates into an ordinary conversation
— a pane, a profile, an approval card, a visible transcript. Everything that
exists starts applying and nothing is rebuilt in a smaller surface with weaker
guarantees.

**B3 is the one to argue for**, but an earlier draft of this plan described its
mechanism as "unhide and move" and that is wrong in three ways. Each is worth
stating, because each is real work that the cheap version would have skipped.

**It is not a projection flip.** `kind = 'aside'` is not stored once; it is
_derived from the original `conversation.created` event_ on every rebuild
(`projections.ts`, via `asideMetaOf`). A SQL update would be erased the next time
projections are rebuilt, which is the one operation the event log guarantees. So
promotion needs a **durable domain event** — an `aside.promoted` appended to the
log — plus a projection case and a rebuild test. That is the five-file change this
codebase already has a shape for, and it is the honest one: the log is the source
of truth, so a change of identity is an event, not an UPDATE.

**The existing service cannot simply be moved.** `neverAsks` and `grants` are
`private readonly` on `ConversationService`, so a promoted aside cannot become
askable in place. And the branch underneath it is deliberately non-persistent —
`ephemeral: true` on Codex, `persistSession: false` on Claude — while an ordinary
participant needs a supervised, resumable session. The `asides` map holds only
`{ service, parentId, excerpt }`; there is no participant to hand over. So B3
must choose between **a persistent-fork capability** that keeps the branch, or
**a fresh ordinary session** with the parent and aside context reconstructed into
it. The first preserves what makes an aside worth promoting; the second is easier
and loses exactly the thing the user is standing in.

**It cannot be triggered by the agent trying to act.** Every follow-up is wrapped
by `asideQuestion`, which says _"do not continue the work, do not change files"_,
so a compliant agent will not attempt the thing that was supposed to raise the
approval. And if one did, `neverAsks` denies it immediately — there is no pending
approval left to carry across. **Promotion must be an explicit user action**
("Open as conversation"), taken _before_ the first actionable turn is delivered.
Inferring it from an attempt is not merely unreliable, it is backwards: it would
reward an agent for ignoring its instructions.

Two pieces of evidence that this was half-anticipated: `listAsides` is wired
through IPC and **has no renderer caller at all**, and an `aside.reopened` string
sits in `en.json` referenced by nothing. The idea of returning to an aside as a
thing in its own right was already reached for and left unfinished.

The existing light promotion stays what it is: "Take this forward" stages the
excerpt and answer into the parent's composer as `@agent`-addressed text —
**staged, never sent**. That is a different act and should keep its name.

## What this is deliberately not doing

**Not removing layer 5.** Even with every permission granted, the prompt still
says "do not continue the work" — and it exists because a fork otherwise resumes
the task. An aside that may act still must not decide on its own that acting is
what was wanted.

**Not making the aside's power a setting.** "Let asides do anything" as a
checkbox moves the decision to a moment when nobody is thinking about it.

**Not touching `UNIVERSAL_DENIES`.** Irreversible actions stay irreversible
everywhere, and a fork is the last place to relax them.

**Not solving it by widening the sandbox alone.** It is emulated on Claude, so it
would buy the appearance of a control rather than one.

## Open questions

**1. ~~Is Part A alone enough — wait for a second refusal?~~ Answered, and the
draft that asked it was reasoning from a broken instrument.**

The proposal was to ship Part A and let the log say whether Part B was wanted.
It cannot. Every aside turn is wrapped with _"do not continue the work, do not
change files"_, so a compliant agent never attempts the thing that would produce
a refusal — **the log is measuring the prompt, not the demand.** "Only one aside
was ever refused" says almost nothing, and building a scope decision on it would
have been the same error as reading a payload shape out of prose.

The user's direct request is the evidence, and it is better evidence than a
silence that was engineered. Both parts, staged: **C-020 first** — it is a live
security bug, it is not aside-specific, and Part B's whole safety argument rests
on the permission engine being honest — then explicit durable promotion.

**2. What is a "read"?** C-020's whole difficulty, now that it is known to be
about repair rather than widening. Options: an argument-aware matcher that
understands redirects, pipes and `-exec`; leaning on a genuinely read-only sandbox
where one exists — which excludes Claude, whose sandbox is `emulated`; or refusing
to grow the allowlist at all and letting the aside ask, which needs Part B and so
cannot be C-020's answer.

**3. If B3, what does the promoted thing look like on screen?** Not the constraint
an earlier draft claimed: `MAX_PANES = 4` bounds **panes**, and tabs are unlimited
— _"conversations beyond this remain available as tabs"_ (`layout.ts:16`). So
there is no "fifth tab" problem. What is undecided is placement: a tab in the pane
the aside came from, or its own; whether it takes focus; and what becomes of the
card at that moment.

**3b. What profile does a promoted aside get?** It cannot keep `read-only` or
promotion buys nothing, and it must not silently become the parent's, because
that is B2 arriving through a side door. Most likely it asks, once, at the moment
of promotion — which is a real approval on a real surface, which was the point.

**4. Does an aside that can act need a deadline — and does the aside itself?**
An unattended fork holding an approval was one of the original reasons for
`neverAsks`, so C-013's engagement work applies directly and should be reused
rather than reinvented.

Worth naming separately, because it is a live gap rather than a hypothetical:
**there is no timeout and no cap on open asides today.** Four routes close a fork
— explicit close, the parent closing, app shutdown, and `openAside`'s own failure
cleanup — and none of them is a bound. Eleven asides have been opened in total, so
it has never mattered. An aside that can act, hold approvals, and outlive the
question that opened it is the case where it starts to.

**5. Codex.** Everything above is reasoned from Claude's behaviour, because every
aside in the log is Claude's — 0 of 11 are Codex. Codex's fork is `ephemeral`,
its sandbox is native, and whether it can express the same thing is unverified.

**6. Two things here are untested.** There is no rendering test for
`QuickQuestion.tsx` at all, so the dismissal, focus and close-the-fork wiring is
unasserted; and nothing covers `closeAside` being reached when a pane unmounts.
Both become load-bearing the moment a card can be holding a session that is
allowed to change files, and should be closed before, not after.
