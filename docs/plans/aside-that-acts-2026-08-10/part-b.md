# Part B — promoting an aside into a conversation

Part A is done (`STATUS.md`). This is the half that needs building: letting an
aside change files and run tools, by making the thing that acts a **room** rather
than by growing a tooltip's powers.

## The constraint that decides the architecture

The obvious design — "promote the aside by forking it" — **cannot work**, and it
is worth writing down why before anyone tries it.

Both providers fork from **persisted** state:

- Codex's `ThreadForkParams` says it plainly: _"load the thread from disk by
  thread_id and fork it into a new thread."_
- Claude's fork resumes a stored session; our own adapter comment records that
  `forkSession` without `persistSession: false` is what writes a branch to disk.

An aside is deliberately the opposite. Codex gets `ephemeral: true` (_"never
materialised on disk"_) and Claude gets `persistSession: false`, because
_"nothing wants a fork that outlives its question"_. **So there is nothing on
disk to fork, and no `sessionRef` a provider would still recognise.**

That leaves three ways, and the choice matters more than anything else here:

1. **Make every aside persistent.** Then promotion is a fork. It also means every
   "explain this in Arabic" writes a branch into `~/.claude/projects` forever,
   which is the cost the ephemeral design exists to avoid, paid by the 11 asides
   in 11 that are never promoted.
2. **Fork the _parent_ persistently at promotion, and replay the aside into it.**
   The parent is on disk and forkable — this is exactly what opening an aside
   already does, minus the ephemerality. The promoted room gets real
   provider-side context of the work, and the aside's question and answer are
   carried in as text.
3. **A fresh session with everything reconstructed from Chorus's log.** Simplest,
   and it throws away the provider-side context that made the aside worth
   promoting.

**Take (2).** It pays the persistence cost only when someone asks for it, it
keeps the provider context that matters, and it needs no change to how asides are
opened. What it loses is the fork's _own_ reasoning about the aside — only the
text survives — and that is an acceptable trade for not making every aside
durable.

## The other three contracts, from the review

**Promotion is an event, not an UPDATE.** `kind = 'aside'` is re-derived from the
original `conversation.created` on every rebuild (`projections.ts`, via
`asideMetaOf`), so a SQL flip is erased by the one operation the log guarantees.
`conversation.renamed` is the template for a Chorus-only domain event: schema,
projection case, catch-up case, and a runtime that appends it.

**The existing service cannot be reused.** `neverAsks` and `grants` are
`private readonly`. The promoted room needs a new `ConversationService` — which
is fine, because it also needs a new provider session.

**The trigger is a person, not an agent.** Every aside turn is wrapped with _"do
not continue the work, do not change files"_, so a compliant agent never attempts
the thing that would raise an approval — and `neverAsks` would deny it anyway.
Promotion is a button.

## Phase 0 — decide whether the parent fork is needed at all

**Before any provider work.** An earlier draft put this last, which was the wrong
order: if reconstructing from Chorus's own log turns out good enough, Phase 1
does not exist and neither does most of the risk in this plan.

The question is narrow. A promoted room needs the _work's_ context. Design (2)
gets it from the provider by forking the parent; design (3) gets it from our log,
which holds the whole transcript already. The difference is the model's own
reasoning about the work — real, but not obviously worth a persistent branch per
promotion, a new port capability, and the child-id hazard below.

**Done when:** one promoted-style room is built each way against a real agent and
asked something that needs prior context, and the answers are compared. If (3)
holds up, phases 1 and 3's forking disappear.

## Phase 1 — a persistent fork with a stable identity

_Only if Phase 0 chooses (2)._

**Not "omit `persistSession: false`" on the existing path.** `spawn` constructs
`new ClaudeSession(resume ?? '', …)`, so a forked session reports the **parent's**
id until the child emits its own. Today that is harmless because an aside is
never written to `open-sessions.json`; a promoted room is, so the window is long
enough to save, supervise and later resume the _parent_ under the child's name.

The SDK has the right tool and it is not the one we are using:

```ts
forkSession(sessionId, opts): Promise<ForkSessionResult>
// ForkSessionResult.sessionId — "New session UUID. Resumable via
// query({ options: { resume: sessionId } })"
```

Copy the transcript, take the returned id, then resume _that_. The child's
identity is known before anything attaches to it.

**And it must be supervised.** `AgentAdapter.fork` returns a raw session, while an
ordinary participant is a `SupervisedSession` — so a provider crash in a promoted
room would lose it rather than resume it. This needs `SupervisedSession.fork()`
alongside `start` and `resume`.

**Done when:** a persistent fork's `sessionRef` is non-empty and **different from
the parent's** before attachment, the branch survives where an ephemeral one does
not, and a killed provider process is resumed into the same branch.

## Phase 2 — `aside.promoted`

The durable event, as a five-file change on the `conversation.renamed` pattern:
payload schema, a projection case that clears the conversation's aside identity, a
catch-up case (a no-op with a reason — the other agent runs under its own harness
and cannot act on ours), the runtime that appends it, and the renderer reducing it
to a line so the transcript says the room changed character.

The projection is the interesting part: it must clear `kind`, and it must survive
`rebuildProjections`. The test that matters builds a database with a promoted
aside in it and rebuilds — "does a fresh database get it right" was never the
risk.

**Done when:** a promoted aside is an ordinary conversation after a rebuild, and
an unpromoted one is still hidden.

## Phase 3 — `promoteAside`, atomically

The operation, with no UI. Three things an earlier draft got wrong, each of which
changes the design rather than the wording.

**Promotion must not wake the model.** The draft said "replay the aside's exchange
as opening context", and there is no way to do that: `send()` starts a real user
turn. Replaying would produce an extra answer, possibly run tools under the
newly-chosen profile, and make "Open as conversation" behave like "ask that again,
now, with permissions". Catch-up cannot stand in either — `collect` skips events
whose `actor` is the recipient (`catchup.ts:101`), and the aside's answer was
written by the very agent being promoted, so the one thing worth carrying is
exactly what it drops.

So the context is **seeded, not sent**: a block holding the excerpt, the question
and the completed answer, labelled as already dealt with, held and prepended to
the **first real user message after promotion**. Promoting and then walking away
costs nothing and starts no turn.

**Grants are `newGrants()`, not `new SessionGrants()`.** The draft said "empty",
which sounds safe and is wrong twice: `newGrants()` seeds the machine-wide
remembered "always allow" answers and carries the `onRemember` callback that
persists new ones. A literally empty set would silently forget permissions the
user already gave permanently, and quietly fail to save any they gave in the
promoted room. Fresh instance, not the parent's — that part was right.

**The transition needs a commit point.** The draft's order created the persistent
service before closing the ephemeral one, so a still-streaming aside would have
two services appending interleaved lifecycle events to one conversation. And it
left four races: two rapid promotions creating two permanent branches; the parent
being closed while its fork is being taken; a failure after the branch exists but
before `aside.promoted` is appended, orphaning a provider session; and promotion
while the source agent has been removed, replaced, or is mid-turn.

What that needs: a **single-flight promise per aside**, an **idle precondition**
(the aside must not be streaming), **revalidation** of the source agent and
session at the moment of forking — the same checks `openAside` already makes — a
**defined commit point** (the `aside.promoted` append), and **failure cleanup**
that closes a branch created before a failure, the way `openAside` already closes
a fork it cannot finish setting up.

**The aside framing must not carry over.** `asideQuestion` wraps every follow-up
with "do not continue the work, do not change files". A promoted room that kept
it would refuse to work, which is the whole point inverted.

**Done when:** the domain works headless — a promoted conversation takes an
approval, survives a relaunch, and two promotion calls racing produce one branch.

## Phase 4 — the surface

"Open as conversation" on the card. The card closes; the conversation appears as a
tab. `MAX_PANES = 4` bounds panes and **not** tabs, so there is no placement
crisis — but which pane, and whether it takes focus, is still a decision.

**Done when:** the whole path is driven in the real app: notice something in a
reply, open an aside, promote it, approve an edit, and find the file changed.

## What this is deliberately not doing

**Not making asides persistent by default.** The cost falls on every aside to
serve the few that are promoted.

**Not letting the agent promote itself.** It cannot be inferred from an attempt
without rewarding an agent for ignoring its instructions.

**Not inheriting the parent's grants.** Ever, silently.

**Not promoting an aside whose fork has already ended.** A closed aside is
view-only today and stays that way; promotion needs a live session to fork
context from — or rather, needs the _parent_ live, which is the same check
`openAside` already makes.

## Open questions

**1. Which parent state is forked?** Promotion forks the parent as it is _now_,
not as it was when the aside was opened. That is arguably better — current
context — but it means the promoted room may know things the aside did not, and
the aside's excerpt may refer to a passage the parent has since moved past. Worth
deciding deliberately rather than discovering.

**2. ~~What if the parent has been closed?~~** Already answered by the code:
`closeConversation` closes and removes its live asides, so there is no promotable
aside without a parent. The real question is the **race** — a parent closing while
one of its asides is mid-promotion — which Phase 3's commit point has to settle.

**3. Moved to Phase 0**, because it can delete Phase 1. Answering "does the
promoted room need the parent's provider context at all" after building a
persistent-fork capability would be finding out whether the expensive part was
necessary once it is already paid for.

**4. What does the sidebar show?** A promoted aside becomes a listed
conversation, and its title is the first 80 characters of the excerpt. That reads
oddly in a session list; it probably wants renaming at promotion.

**5. Codex has never done any of this.** All 11 asides are Claude's. Codex's fork
refuses `inherits: 'nothing'`, its sandbox is native, and `ephemeral: false` is
unverified. Phase 1 is where that gets settled, and it should be settled with a
live run rather than by reading the generated types.
