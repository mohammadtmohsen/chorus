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

## Phases

### Phase 1 — a fork the port can keep

`ForkOpts` gains persistence. Claude omits `persistSession: false`; Codex passes
`ephemeral: false`. The port's current doc comment says _"Always ephemeral,
rather than a flag"_ and that sentence stops being true — it should be replaced
with the reason it now is a flag, not deleted.

No product change. It is separated because it is the only provider-facing risk in
Part B, it is independently testable against both CLIs, and getting it wrong
means branches quietly accumulating on disk.

**Done when:** both adapters can take a persistent fork, conformance covers it,
and a live run shows the branch surviving where an ephemeral one does not.

### Phase 2 — `aside.promoted`

The durable event, as a five-file change on the `conversation.renamed` pattern:
payload schema, a projection case that clears the conversation's aside identity,
a catch-up case (a no-op with a reason — the other agent runs under its own
harness and cannot act on ours), the runtime that appends it, and the renderer
reducing it to a line so the transcript says the room changed character.

The projection is the interesting part: it must clear `kind`, and it must survive
`rebuildProjections`. The test that matters builds a database with a promoted
aside in it and rebuilds — "does a fresh database get it right" was never the
risk.

**Done when:** a promoted aside is an ordinary conversation after a rebuild, and
an unpromoted one is still hidden.

### Phase 3 — `promoteAside` in the runtime

The operation, with no UI: fork the parent persistently, build an ordinary
`ConversationService` on the aside's **existing `conversationId`** so the log
stays one thread, replay the aside's exchange as opening context, append
`aside.promoted`, move it from `asides` into `active`, and close the aside's
ephemeral fork.

Two details that are easy to miss and both change behaviour:

- **The aside framing must not carry over.** `asideQuestion` wraps every
  follow-up with "do not continue the work". A promoted room that kept it would
  be a room that refuses to work, which is the whole point inverted.
- **Grants start empty, and the profile is chosen at promotion.** Inheriting the
  parent's grants is B2 arriving through a side door. Choosing a profile is the
  explicit act that makes this safe, and it is a real decision on a real surface.

**Done when:** the domain works headless — a promoted conversation takes an
approval, and a relaunch reopens it, which is what Phase 1 was for.

### Phase 4 — the surface

"Open as conversation" on the card. The card closes; the conversation appears as
a tab. `MAX_PANES = 4` bounds panes and **not** tabs, so there is no placement
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

**2. What if the parent has been closed?** The aside outlives its parent's pane
today only until the parent closes, which closes its asides too. Promotion of an
aside whose parent is gone has no fork source. Refuse, or fall back to design (3)
for that case alone?

**3. Does the promoted room need the parent at all?** If the answer to 1 and 2 is
"it is awkward", design (3) — reconstruct from Chorus's log — gets simpler by
comparison, and the honest comparison should be made once rather than assumed
away here.

**4. What does the sidebar show?** A promoted aside becomes a listed
conversation, and its title is the first 80 characters of the excerpt. That reads
oddly in a session list; it probably wants renaming at promotion.

**5. Codex has never done any of this.** All 11 asides are Claude's. Codex's fork
refuses `inherits: 'nothing'`, its sandbox is native, and `ephemeral: false` is
unverified. Phase 1 is where that gets settled, and it should be settled with a
live run rather than by reading the generated types.
