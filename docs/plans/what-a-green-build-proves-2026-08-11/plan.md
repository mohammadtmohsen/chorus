# What a green build proves

Closing C-006, or deciding out loud that it cannot be closed.

## The problem

CI runs typecheck, lint, format, unit tests and a build. Not one of those opens
a window. So a green check on a pull request means "it compiles, and the pure
functions still agree with their tests" — it does not mean the app starts, lays
out, restores a draft, or survives a relaunch.

The board entry records the cost already paid: a transcript change shipped on a
green PR, and a local run afterwards caught an unrelated defect that CI could
never have seen.

The 28 e2e specs are exactly that missing evidence. They do not run in CI, and
the assumed reason — they need real agents with real credentials, which GitHub
cannot have — turns out to be about half true. Which half is the whole plan.

## What is actually true

**There are 28 specs, not 26.** The board and `packaged.mjs:8` both say 26; the
`specs` array in `specs.mjs` holds 28. Counted rather than cited by line, because
a line number in a plan is stale the first time anyone edits the file — this one
was, twice, while the plan was being written.

**Two gates, not one.** They have been treated as a single requirement and they
come apart:

- **A `claude` binary must exist.** This gates _all 28_. The default roster is
  `['claude']` (`settings.ts:112`), and `startConversation` throws
  `'No agent could be started'` when no participant starts (`runtime.ts:596`).
  Even a spec that only measures sidenav widths needs a window with a pane in it.
- **Credentials must work.** This gates **11** specs — the ones that send a
  message and then block on the agent actually replying.

The remaining 17 split into **14 shell specs** — layout, sidenav docking and
resizing, tab splitting, drafts surviving a quit, relaunch, the two `FakeIde`
specs, `@`-mentions, reopening an ended conversation — and **3 that sit between
the two groups**: account limits (5), the slash-command menu (21), and message
recall (24). The three are the interesting ones, because they read data a live
session supplies without ever needing a turn.

**The SDK is not lazy, and an earlier draft of this plan was wrong to say so.**
`ClaudeAdapter.spawn()` calls `query()` inline at `claude-adapter.ts:1115`, and
the pinned SDK spawns the CLI transport there and then. The empty session ref at
`runtime.ts:808` means Claude has not assigned a conversation id yet — not that
no process exists. The mistake came from reading `Promise.resolve(this.spawn(…))`
as deferral, when it is only a synchronous value in a promise shape.

This matters for honesty rather than feasibility. A probe against an isolated
config reporting `loggedIn: false` initialized successfully and returned the
model and slash-command catalogues **without a message being sent**. So an
unauthenticated CLI does get far enough to satisfy the shell specs — but it is a
real Claude process, started and running.

## The shape of the answer

**Run the shell specs in CI against a real, pinned, unauthenticated `claude`.**

Call it what it is: an **unauthenticated real-CLI shell subset**. Not "no
agents". The distinction is not pedantry — C-006's done-condition says "a launch,
a window, a store that opens — _no agents_", and this does start an agent
process.

**As written, that wording binds, and this plan does not meet it.** So choosing
this route carries an obligation: the done-condition is **revised**, in the same
change that adds the job, to say _no credentials and no agent turn_ — which is
what is actually being delivered and what the entry actually cares about. What
must not happen is the entry being ticked off against wording it does not
satisfy, because the next person to read the board would be told CI proves
something it does not. Revising a done-condition on purpose is honest; quietly
meeting a looser one is how a board stops being worth reading.

Chosen over the alternative — a scripted adapter behind an env hook at
`runtime.ts:2528`, which would need no binary and no auth and would unblock all
28 — for one reason: it adds no production code. The scripted adapter is a real
new surface on a shipping path, and it tests the renderer against events we
wrote. This tests the renderer against the app as built. If the probe below
fails, that trade reverses and the adapter becomes the only answer; it is
deliberately kept as the fallback rather than deleted.

### Selection is metadata, not a name list

`run.mjs:12` filters on a single positional substring of the spec name. A CI
subset expressed as a list of titles would rot the first time a spec is renamed,
and it would rot silently — the runner would simply select fewer specs and still
print `all N passed`.

So each spec gains an explicit `requiresTurn: true` where it blocks on agent
output, and the runner learns to select on it. The three in-between specs get
their own honest marking rather than being forced into one bucket. A spec with
no marking is a shell spec, so the default is the safe direction: a new spec that
secretly needs a turn shows up as a CI failure, not as silent under-coverage.

### The CI job

Three things the current workflow gets in the way of:

- **`ELECTRON_SKIP_BINARY_DOWNLOAD: 1` is workflow-global** (`ci.yml:16`), so an
  e2e job would install a pnpm tree with no Electron binary in it and fail at
  launch. It moves onto the jobs that want it, or the e2e job unsets it for its
  own install.
- **The `claude` CLI is pinned**, mirroring what the workflow already does for
  Codex. Installing `latest` would make every PR an upstream-drift test, and
  drift is a separate question the workflow deliberately answers on a schedule.
- **macOS runners only.** The app is mac-only — `mac-arm64`, an `.app`, ad-hoc
  signing — and the whole workflow already runs there.

## Phases

### Phase 0 — prove it on the runner, before building anything

Two questions, both unanswerable from a desk:

1. Does Electron open a window on a GitHub macOS runner at all?
2. Does an unauthenticated session get far enough for a pane to appear?

**This phase runs on CI, not locally.** A local probe was inconclusive: Electron
aborted with `SIGABRT` before opening a window under both an authenticated and an
isolated config, which tells us nothing about either question and is itself
unexplained. A throwaway workflow on a branch, installing a pinned `claude` with
no credentials and launching the app, answers both directly and in the
environment that matters.

Phase 0 also measures the wall clock of a single launch. Fourteen specs run
serially, each starting its own Electron, and macOS runner minutes bill at a
multiplier — if a launch is slow enough that the subset costs more than it is
worth, that is a fact worth having before Phase 2 and not after.

**If Phase 0 fails**, stop and reopen the choice. A failure on question 2 means
the scripted adapter is the only route to any CI coverage. A failure on question
1 means C-006 closes as a written decision, and the release checklist becomes the
whole deliverable.

### Phase 1 — mark the specs

`requiresTurn` on the 11, an honest marking for the 3, nothing on the 14.
`run.mjs` learns to select. Verified by running the selected subset locally,
where credentials exist, and confirming the count is what it claims.

### Phase 2 — the job

The workflow change: Electron installed, `claude` pinned, the subset run. Green
on a branch before it goes near `main`.

C-006's done-condition is rewritten in this same commit, not a later one, for the
reason above: the job and the claim it satisfies have to land together, or the
board briefly says CI proves something it does not.

### Phase 3 — the record

Four corrections that are true regardless of how Phases 0–2 land:

- `CLAUDE.md:16` says `pnpm e2e` "drives it with Playwright". It does not.
  `harness.mjs` speaks raw CDP — "no test build, no mocked main process, no
  injected renderer" — and there is no Playwright dependency in the repo.
- The count is 28. `packaged.mjs:8` says 26.
- `e2e/smoke-packaged.mjs` is referenced by nothing and still asserts
  `appVersion === '0.5.0'` against an app at `0.10.0`. It is dead, and it is the
  kind of dead that looks alive.
- **There is no release checklist anywhere.** C-006's fallback done-condition
  names one. It has to exist before it can say anything.

## What this deliberately does not do

- **It does not run the 11 credential specs in CI.** They stay local, before
  tagging. Anything else means credentials on a build machine, and the entry does
  not ask for that.
- **It does not run `verify:package` in CI.** Minutes plus a signing step, and
  `packaged.mjs` says itself it belongs at a release rather than on every change.
- **It does not build the scripted adapter.** Held as the fallback if Phase 0
  fails or if "no agents" is read literally.
- **It does not touch the specs' contents.** Marking is metadata; a subset that
  needed specs rewritten to pass would be measuring the rewrite.

## Open questions

1. **Does "no agents" bind literally?** An unauthenticated real CLI _is_ an agent
   process. If C-006 means no agent process at all, this plan does not close it
   and the scripted adapter is required. Needs a decision, not an inference.
2. **What is the `SIGABRT`?** Electron aborting before a window locally, under
   two different configs, is unexplained. If it reproduces on the runner it is
   Phase 0's answer; if it reproduces only locally it is a separate entry.
3. **Do the three in-between specs pass unauthenticated?** The probe suggests the
   slash-command menu might, since catalogues arrived with `loggedIn: false`.
   Worth testing rather than assuming — and spec 21 is C-003's flaky one, which
   is a reason for care, not for optimism.
4. **Codex-side coverage is untouched.** The default roster is claude-only, so
   nothing here exercises the Codex adapter in CI. Deliberate for now; worth
   naming so it is not mistaken for an oversight.
