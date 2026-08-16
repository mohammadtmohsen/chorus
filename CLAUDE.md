# Chorus

A local-first workspace where a developer collaborates with several coding
agents in one shared conversation. Electron + React, pnpm workspaces, Turbo.

Chorus **drives** the user's installed `claude` and `codex` CLIs — it does not
replace them. Both run headless over stdio, with **no PTY between Chorus and an
agent**. Retiring the terminal here means retiring the _interface_, not the
binary.

That is a claim about agents, and only about agents. **The person gets a real
shell**: `⌘J` opens one per session and the activity bar opens a global one, and
those are PTYs (`main/terminal.ts`). Until 2026-08-12 this file said "there is no
PTY anywhere", which is why the distinction is spelled out rather than assumed —
read the old sentence with `node-pty` in the lockfile and the only honest
conclusion is that someone broke the rule.

## Commands

```bash
pnpm dev       # electron-vite dev — restarts the main process on its own sources
pnpm check     # typecheck + lint + format:check + test. Run this before saying done.
pnpm test      # vitest only
pnpm e2e       # builds the desktop app and drives it with Playwright
pnpm app:install   # packages and installs the local build
```

`pnpm check` is the gate. It is fast (~40s warm) and there is no reason to skip
it.

## Releasing

**"Release" is one word and it means all of this.** Asked to release, do the
whole sequence without asking which parts — the only thing worth confirming is
the version number when the bump is not obvious.

**Everything after the tag is `.github/workflows/release.yml`.** It gates,
builds the DMG and the `.exe` in parallel, verifies each against its own
packaged bundle, and publishes the release with both assets, both checksums and
notes assembled from the CHANGELOG. There is no manual packaging step and no
manual upload; adding one back would mean building an artifact from whatever
happens to be in a working tree, which is the bug described in step 4.

1. **Merge** whatever is outstanding into `main`, and check there is genuinely
   nothing left: `git cherry main <branch>` marks a commit `-` when an
   equivalent patch is already in `main`. `git branch --no-merged` compares
   _ancestry_, so a rebased or squashed branch shows as outstanding forever and
   merging it replays months-old files over current ones.
2. **Bump the version in both places** — `package.json` and
   `apps/desktop/package.json`. They are separate and drift silently, which is
   why the pipeline's first job refuses to build when they or the tag disagree.
3. **Write the CHANGELOG entry**, in its own voice: "what changed, for someone
   deciding whether to update". Say what was broken from the user's side, not
   which function was edited. If a previous release recorded a known gap that
   this one closes, say so — that is the line people are waiting for. The
   pipeline lifts this section verbatim into the release notes, so it is the
   thing people read, not a record.
4. **`pnpm check`** locally before tagging. The pipeline runs it too, and the
   point of running it here is to fail in seconds rather than after a
   ten-minute build. Never tag around a red gate.
5. **Commit** as `chore(release): X.Y.Z`, touching only the changelog and the
   two `package.json` files.
6. **Tag and push**: `git tag -a vX.Y.Z -m "Chorus X.Y.Z"`, then push `main` and
   the tag separately. **This is the release.** Everything above was
   preparation.
7. **Watch the run, and verify against the API rather than the exit code.**
   `gh run watch`, then `gh release view vX.Y.Z --json assets` for both files
   and their sizes, and `git ls-remote --tags` for the tag. The pipeline's own
   last step counts the `.dmg` and the `.exe` and fails if it does not find
   both — but a workflow that never started is also a workflow that never
   failed, so look.

**To rehearse it**, run **Release** from the Actions tab with no input: it
builds both installers and uploads them as workflow artifacts without
publishing. That is also how a tester gets a build without a release being cut.

### What a release does not prove, and must not be reported as proving

**Neither installer is signed in the way its platform wants.** The DMG is
ad-hoc signed and not notarized, so every downloader meets Gatekeeper (C-002).
The `.exe` has no certificate at all and meets SmartScreen — and a signature
alone would not fix that either, because SmartScreen scores reputation rather
than validity and a new certificate has none. Both paragraphs are in the notes
the pipeline writes, because every release has to repeat them.

**CI verifies at `bundle` scope only.** That is the native-file inventory, that
the app launches, and that the renderer is served. The full scope — the event
store opening, a terminal, an agent joining — needs an installed and
authenticated CLI that no runner has, so it still has to be run on a real
machine: `pnpm --filter @chorus/desktop run verify:package`. A release that
skipped that has not checked the thing `verify:package` was written for.

**The Windows installer itself is unproven.** The pipeline verifies the bundle
NSIS wrapped, not what the installer does to a machine. Install, upgrade,
uninstall and whether the event log survives a version change have never been
tested; they need clean VMs. `docs/windows-test-brief.md` is the brief for that.

**The e2e suite is not part of any of this.** It takes ~5 minutes, passes about
6 runs in 10 (C-029), is macOS-only, and has to be run deliberately. Anything
about the transcript, tabs, or a menu under load is unverified unless someone
ran the suite or drove the app. Say which of those happened.

## The one rule everything else follows from

**The event log is the source of truth, and it is append-only.**

Codex discards partial assistant output when a turn is interrupted, so a
transcript cannot be rebuilt from the providers. Everything an agent streams is
made durable in SQLite as it arrives. An append and every projection it updates
land in **one transaction**, so a projection can never be ahead of the log and
can always be rebuilt from it.

### State is not history

The corollary that is easy to get wrong. Some facts are about the _agent right
now_ rather than about what happened in the conversation:

- `limits` — how full the account's plan windows are
- `context.usage` — how full the agent's context window is

These are **never written to the log**. They travel on their own push channels
(`agents:limits`, `agents:context`) and are held in memory. The test: would
reading this value back a week later be worse than having none? Account limits
would be stale; context fill _resets on compaction_, so a stored series would be
a history of a number that repeatedly went backwards for reasons the log does not
explain.

If you add something in this category, push it — do not add a `ChorusEventPayload`.

### Terminal output is not a log event, and it fails the test above

Worth stating because the rule does **not** settle it. Ask "would reading this
back a week later be worse than having none?" of terminal scrollback and the
answer is plainly no — last week's build output would be useful. It passes, and
it is still excluded, for two reasons that are not that test:

- **The log records the conversation.** A shell you typed into is a second stream
  that happens to share a pane. Folding it in makes every consumer — `catchup.ts`,
  the projections, `transcript.ts` — answer "is this one mine?" forever. The
  global terminal makes it plain: it has no `conversationId` to file an event
  under at all.
- **It is the worst case of C-021's unsolved half.** That entry is open because
  storing what an agent _read_ means storing whatever it read, including files
  the permission engine treats as secret. A terminal is the sharpest instance —
  `cat .env`, `env`, `aws configure`, a pasted token — and nothing scrubs a shell.

Scrollback lives in a bounded `@xterm/headless` mirror in main, is replayed to a
view on attach, and goes when the app does.

## Where things live

```
packages/agent-protocol   the normalized AgentEvent union both providers project onto
packages/adapter-claude   Claude SDK -> AgentEvent. Pure mapping in mapping.ts
packages/adapter-codex    codex app-server JSON-RPC -> AgentEvent
packages/orchestrator     conversation service, policy engine, catch-up, supervisor
packages/event-store      SQLite, migrations, projections
packages/workspace        read-only git status and diff
apps/desktop/src/main     Electron main: runtime, IPC, windows, terminal.ts
apps/desktop/src/renderer transcript reduction and UI
```

Nothing provider-specific may leak past an adapter except `raw`, which exists
only for debugging.

### The second native module

`node-pty`, and it was a decision rather than a convenience — the build plan
budgeted for `better-sqlite3` **only**. It earns its place because a pipe is not
a terminal: no `vim`, no `htop`, no shell history, and `⌃C` closes a pipe instead
of signalling a process group.

Both native deps ship N-API prebuilds that load in Electron unmodified, so
**`npmRebuild: false`** is set explicitly in `electron-builder.yml`. Left at the
default, `@electron/rebuild` compiles `node-pty` — it recognises prebuilds only
from `prebuildify` or `prebuild-install`, and node-pty uses neither — and the
packaged app would then load a different binary from `pnpm dev`, silently.

There is no toolchain and no rebuild step. Keep it that way.

## Adding an event type is a five-file change

`mapping.ts` is the chokepoint, and three switches downstream are **deliberately
exhaustive** so a new type has to be considered rather than silently vanishing.
The linter enforces it (`switch-exhaustiveness-check`), which is how you will
find out:

1. `packages/agent-protocol/src/events.ts` — the event, and `UNDROPPABLE` if
   losing one under backpressure would wedge a turn
2. `packages/event-store/src/events.ts` — the `ChorusEventPayload` schema
3. `packages/orchestrator/src/conversation-service.ts` — the case that appends it
4. `packages/event-store/src/projections.ts` — a projection, or an explicit no-op
5. `packages/orchestrator/src/catchup.ts` — whether the _other_ agent should be
   told, or an explicit no-op

Then the renderer: `transcript.ts` to reduce it, `Entry.tsx` to draw it.

A no-op case needs a comment saying why. "It is not interesting" is not a reason;
"no query asks for it" and "the other agent runs under its own harness and cannot
act on ours" are.

## Adapters

`packages/adapter-claude/src/mapping.ts` is pure — it maps recorded SDK messages
with no process, which is why the adapter is testable at all. Keep it that way.

**Read shapes out of `sdk.d.ts`, never out of prose or memory.** Three bugs in M2
came from inferred payloads, and two since: the rate-limit event is flat where the
types describe it nested, and `task_*` keys on `task_id` with `tool_use_id`
optional rather than threading `parent_tool_use_id`. When a response carries both
a raw figure and a pre-computed percentage, derive it yourself — the types do not
say whether it is a fraction or a percentage.

The default arm raises a low-level `notice` rather than returning `[]`, so a
subtype a future SDK adds degrades to a muted line instead of silence.
`QUIET_SUBTYPES` is the short exemption list for things that arrive on a timer;
notices are durable, and `system/status` is a heartbeat.

`settingSources` is deliberately omitted, so agents inherit the user's full
config — their hooks, skills, MCP servers and slash commands all load. That is
why `mcpToolCall` is a first-class approval kind.

## The permission engine

`packages/orchestrator/src/policy/engine.ts`. The ordering is the design and is
rigid:

1. Kinds that may never be auto-decided (`mcpToolCall`)
2. **Deny rules — absolute.** Nothing later can un-deny.
3. Explicit `ask` rules, which outrank a later allow
4. Session grants
5. Profile allows
6. Otherwise ask

**A universal deny must be an irreversible _action_, never a pattern match on a
name.** `rm -rf`, force-push, history-rewrite qualify. A rule that decides by
filename does not, because the user's answer is exactly what distinguishes a
secret from a fixture — expressed as a deny it becomes a wall with no door, and
switching to Trusted cannot help because universal rules apply there too. A test
enforces this (`UNIVERSAL_DENIES` may not carry a `pathPattern`).

## Renderer conventions

- **Pure reducers, exported for tests.** `transcript.ts`'s `reduceEvents`,
  `store.ts`'s `reducePulse`, `notify.ts`'s `noticesFrom`. The judgement lives in
  the pure function; the component is plumbing.
- **Unless the bug _is_ the lifecycle**, in which case mount it. `useDialog`
  re-ran its effect on every render of the caller, and there is no pure part to
  extract because the defect was the dependency array itself. Such a test opts
  into a DOM with `@vitest-environment jsdom` at the top of the file; `node`
  stays the project default, so this is an exception that has to be asked for
  rather than a second way of writing tests. Two traps, both hit while writing
  the first one: jsdom does no layout, so `offsetParent` is `null` and anything
  filtering on it finds nothing focusable; and a `.click()` that calls
  `setState` is not wrapped in `act`, so the re-render has not happened when the
  assertion runs — that one passed with the bug reinstated. Drive a re-render
  with `rerender`, and prove the test fails without the fix.
- **Only the active tab of each pane is mounted** (max 4). Everything a session
  needs to survive unmounting rides in `SessionCarry`; background conversations
  stay live in the main process and report through the pulse. A terminal is the
  same shape one level further out: the shell lives in main, the component is a
  _view_ onto it, and unmounting calls `detach` and never `dispose` — otherwise
  clicking another tab would kill a running build.
- **No `dangerouslySetInnerHTML`, ever.** Agent output is untrusted, and building
  from a typed tree makes injection impossible by construction. xterm satisfies
  this by construction too — it builds its DOM with `createElement` and is handed
  output as data, never interpolated into markup.
- The markdown parser and syntax highlighter are hand-written on purpose. Adding
  a grammar engine is a decision, not a convenience.
- **`@xterm/xterm` is the exception, and the reason does not generalise.** The
  hand-written parser is tractable and its mistakes are cosmetic — a paragraph
  that looks slightly off. A conformant VT emulator is neither: running `vim`
  correctly means alternate screen buffers, scroll regions, origin mode, cursor
  save/restore and several hundred escape sequences whose behaviour is defined
  only by what `xterm` does. Hand-rolling it is the "guessed shape" failure the
  Adapters section warns about, one level up. Restoration uses
  `@xterm/headless` + `@xterm/addon-serialize` in main, because VT state is
  cumulative and a trimmed ring of raw bytes loses the alternate-screen entry
  that came before it.
- **No hardcoded user-facing strings** — `i18n/en.json`. The reducers have no
  translator, which is why events carry keys (`notice.source`) and the renderer
  turns them into words.

## Traps that have actually bitten

- **`useCallback` dependency arrays evaluate during render.** A callback declared
  above the thing it depends on throws a TDZ `ReferenceError` on first paint —
  a blank window, and typecheck does not catch it. Watch declaration order in
  `App.tsx`.
- **SQL in a template literal cannot contain backticks.** A comment quoting an
  identifier closes the string.
- **`summarize` in `transcript.ts` branches on approval kind before reading
  `toolName`.** Reordering makes every `Task` approval read "mcp: Task".
- **better-sqlite3 is synchronous** and lives on the main thread. Every delta
  from every conversation passes through it; `DeltaBuffer` coalescing is what
  makes that survivable.
- **node-pty ships `spawn-helper` without its executable bit.** Mode 0644 in the
  tarball; its `install` script only checks a prebuild exists and its
  `postinstall` does nothing off Windows. The binding execs that helper on every
  spawn, so the failure is a bare `posix_spawnp failed.` that never mentions
  permissions. Repaired in two places because dev and packaged load different
  files: `scripts/fix-spawn-helper.mjs` for `node_modules`, and
  `build/sign-adhoc.cjs` for the bundle — **before** `codesign`, since editing a
  signed bundle invalidates it. Projects that compile from source never see this,
  because `lib/utils.js` prefers `build/Release` where the linker sets the bit.
- **xterm paints `.xterm-viewport` `#000` and positions it over everything.** The
  theme colour lands on `.xterm` underneath and is covered, so the terminal draws
  on black whatever the app's ground is — in both colour schemes, which is what
  made it look deliberate. One rule in `styles.css` overrides it on specificity.
  Found by emulating `prefers-color-scheme` and reading the rendered colour;
  asserting the `--ansi-*` tokens resolved would have shipped it.
- **A test that counts panes to prove a shortcut was ignored can never fail.**
  Splitting a pane that holds its only tab is a legitimate no-op, so with one
  session the count cannot move and the assertion passes with the guard removed.
  Measure `defaultPrevented` on the key instead, and carry a control proving the
  mechanism fires when it should. This is C-027 from the inside.

- **`git diff main...HEAD -- <file>` does not answer "does this match main".**
  Three dots compares against the **merge base**, so an empty result means _the
  branch_ has not touched the file — which is exactly the set of files `main`
  has changed and you are about to overwrite. Used to decide which files were
  safe to copy from a branch working tree into a `main` worktree, it named every
  dangerous file as safe: two commits silently reverted a rail's i18n key and
  CSS, an entire select restyling, and a measured `ResizeObserver` fix. It also
  cascades, because the second commit re-reverted what the first had. Use two
  dots, or `git cherry-pick`, and **never copy whole files between worktrees** —
  re-apply the change instead. Verify by asserting the features are present, not
  by reading the diff: the diff is what was misread in the first place.

- **The e2e harness used to attach to whatever owned port 9800.** It counted up
  from a fixed base per node process, so a stray Electron left by an earlier run
  answered first and every assertion then described a real DOM belonging to a
  different build in a different checkout. A button provably in the source and
  provably in the bundle "did not exist", and the only tell was a CSS class
  renamed hours earlier, which could not have come from the code under test.
  `launch` now passes `--remote-debugging-port=0` and reads the port back out of
  the child's own stderr, so attaching to someone else's app is impossible rather
  than unlikely. If you add another way to drive the app, do the same.

## Plans

Work of any size goes through a plan first.

```
docs/plans/{slug}-{YYYY-MM-DD}/plan.md      problem -> shape -> phases -> open questions
docs/plans/{slug}-{YYYY-MM-DD}/STATUS.md    written after each phase ships
BOARD.md                                    what sits outside any one plan
```

`BOARD.md` is where a task goes when it belongs to no plan: something noticed in
passing, something that needs a person rather than a commit, something parked with
a reason. An entry says what it is, why it matters, and what would make it done —
if it cannot answer the third it is a thought, and belongs in a plan's open
questions.

Entries carry ids (`C-001` upward) so a commit can name what it closes. Ids never
get reused: the next one is the highest ever used plus one, including entries that
have already left the page.

Plans are prose that argues, not checklists. Say what the problem is, what the
shape of the answer is, and **what you are deliberately not doing**.

When the code contradicts the plan — and it does, often, because the plan was
written before reading the types — **correct the plan and say so in STATUS**.
Several phases here shipped differently from how they were planned, and the
record of why is worth more than a plan that pretends it was right.

Comments explain **why**, not what. Most of this codebase's comments record a
decision or a bug that was actually hit; match that.
