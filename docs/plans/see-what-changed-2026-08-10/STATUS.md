# STATUS

## Phase 0 done: the premise holds, and the hardest open question dissolved

Probe: a scratch git repo of contrived files under `/tmp`, driven through the SDK
against the user's installed `claude` 2.1.226, with `settingSources: []` for
isolation and `pathToClaudeCodeExecutable` pointed at the user's binary — the
bundled native CLI is excluded by `pnpm-workspace.yaml`, which is the same failure
`resolve-executable.test.ts` pins. Five scenarios, every message dumped verbatim,
nothing inferred.

Scratch files were contrived rather than captured, because `originalFile` came
back holding the entire pre-edit file — a raw recording would have committed
whatever this machine happened to be editing into the repo as a fixture.

### What was measured

| Question                                              | Answer                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Is `tool_use_result` populated?                       | **Yes**, on every `user` message carrying a `tool_result`                          |
| Does an `Edit` carry `structuredPatch`?               | **Yes**, shape exactly as `sdk-tools.d.ts:3025` declares                           |
| One user message with N result blocks, or N messages? | **Always exactly one block per message**                                           |
| Is `tool_use_result` singular, and ambiguous?         | Singular, and **not ambiguous** — 1:1 with that one block                          |
| Is `gitDiff` present?                                 | **Absent in all five scenarios**, including inside a git repo with committed files |
| Is `originalFile` populated?                          | **Yes** — the whole pre-edit file (99 and 294 chars in the probes)                 |
| Does `replace_all` give one hunk or many?             | **Many** — 3 separated occurrences produced 3 hunks, line numbers correct          |
| Does `Write` carry a patch?                           | **`update` yes, `create` no** — a create returns `structuredPatch: []`             |

### The finding that changed the plan most

Parallel tool calls are **not** delivered as one message with N `tool_result`
blocks. The model does emit them as one turn — the three parallel Reads all shared
`message.id` `msg_011CduDygU9AiUsSG33ZYbaA` — but **the SDK splits that turn into
one message per content block**, and each result comes back as its own user
message with exactly one block.

That kills the correlation problem raised in review, and with it the
`trackToolUses` map, the path-equality rule, and their memory cost.
`trackBashTools` stays untouched. Phase 1 keeps a defensive assertion that the
message has exactly one result block, because that invariant is now what the whole
approach rests on — but it is an assertion, not machinery.

An earlier reading of the two-`Edit` scenario as "the model serialized them" was
**wrong**, and the shared `message.id` is what corrected it. Worth recording: the
message stream's shape hid genuine parallelism, and only the id disproved it.

### The finding that most changes the feature

`Write` with `type: 'create'` returns `structuredPatch: []` and
`originalFile: null`, with the full text only in `content`. **New files therefore
have no diff to render** unless one is synthesized. An `update` Write returns
proper hunks. Phase 4 was rewritten around this: the size problem is not "a big
`Write` floods the transcript" — `structuredPatch` is bounded by the change — it
is specifically "what do we show when a file is created", now an open decision
with three costed options.

### Also worth keeping

- **`filePath` is echoed verbatim from the input** and may be relative. The probe
  got `./alpha.ts` back, despite the type saying "absolute path"; passing an
  absolute path returned it absolute. Safe for the header, unsafe to assume.
- **The serializer is validated.** Feeding the recorded three-hunk `replace_all`
  result through the candidate serializer and into `parseDiff` reproduced all
  three hunks with correct before/after numbering and `added=3 removed=3`. An
  absolute path yields a cosmetically odd `diff --git a//tmp/…`; `FILE_HEADER`
  still extracts it correctly.
- **`gitDiff` never appeared**, so the "skip the serializer when git already gave
  us a patch" alternative is closed rather than merely deferred.

### Corrections carried into the plan

Of the four issues raised in review, Phase 0 resolved one by measurement (the
correlation problem does not exist) and left the other three standing: the
`.default(null)` schema fix, truncation that `parseDiff` will not silently
discard, and dropping the replay question as dead code.

### Not done

No production code has been written. Phases 1–4 are unstarted; the probe lives
outside the repo and nothing from it is committed except the findings above.

Open, and needing a decision before Phase 3: what a file creation renders
(nothing / capped head / stat line), and whether truncation metadata earns a
second event field over a `\` meta line.

## Phases 1–4 done: edits render their diff inline

Both open questions above were answered before implementing: a created file
renders a **capped head** with the remainder counted, and the count
travels as **metadata** (`omittedLines`) rather than as English inside the patch,
so the renderer can translate it. Phase 4 collapsed into Phase 1 as a result —
see below.

Eleven files. `pnpm check` green: typecheck, lint, format, 1199 tests.

### What shipped

- `agent-protocol` — `patch` and `omittedLines` on `ToolCompleted`, with the
  reasoning for both in the type.
- `adapter-claude` — `readPatch` reads `tool_use_result`, checks every field
  rather than trusting an `unknown`, and `toUnifiedDiff` serializes. Guarded on
  the message carrying exactly one `tool_result`, and skipped entirely when the
  result is an error, since a failed edit changed nothing.
- `event-store` — the two fields on the schema; `projections.ts` stays a no-op
  with its reason extended.
- `orchestrator` — threaded through `conversation-service`; `catchup.ts` stays a
  no-op with a new reason (the other agent shares the working tree and can read
  the file itself).
- `workspace` — a `./diff` export subpath.
- renderer — `FileDiff` lifted out of `ReviewPanel` into its own module,
  `transcript.ts` carries the patch, `Entry.tsx` draws it under the tool row,
  strings in `en.json`, styles in `styles.css`.

### Where the code contradicted the plan

Four places, all found by the compiler or the linter rather than by argument:

1. **`.optional()`, not `.default(null)`.** The plan was right that a bare
   `.nullable()` breaks every stored event, and wrong about the remedy: zod's
   `.default()` makes the field _required_ on the inferred output type, so every
   site constructing a `tool.completed` payload — including existing tests —
   stops compiling. `.optional()` gives the same backward compatibility with no
   churn, and is what `resumed` and `parentId` in that file already do.
2. **`FileDiff`'s prop type is declared structurally, not imported.** The plan
   assumed one `DiffFile`. There are two: `ReviewPanel`'s comes from the IPC zod
   schema, whose optional fields carry an explicit `| undefined` that
   `exactOptionalPropertyTypes` will not unify with `@chorus/workspace`'s. Naming
   the looser shape in the component lets both satisfy it, and incidentally makes
   the component a view over data rather than a client of a package.
3. **The renderer needed a new export subpath.** `@chorus/workspace`'s barrel
   re-exports `git.ts` and its `node:child_process`. `./diff` points at a file
   with no imports at all. Verified in the built bundle, not just typechecked:
   `parseDiff` is present and no Node built-in leaked in.
4. **The cap lives in the adapter, not the store.** Open question 1 leaned store.
   It is wrong: only the _synthesized_ create path needs capping, and that is
   where the lines are being counted anyway. Capping at the store would mean
   teaching it to truncate at hunk boundaries — adapter knowledge in a
   store-shaped place, for a case that no longer exists. Nothing else needs a cap,
   because `structuredPatch` is bounded by the change.

### Verified

- Unit: adapter (one hunk, `replace_all` hunks, create capped and counted, create
  that fits, failed edit, five malformed `tool_use_result` shapes, and a
  two-result message attaching nothing).
- Contract: `parseDiff` tests pin the thin header shape the adapter emits, from
  the consumer side, so the two silently disagreeing would fail a test rather than
  make diffs vanish.
- Store: a `tool.completed` payload with no `patch` key still parses — the
  regression that would have made every existing conversation unopenable. Plus a
  live assertion that `redactPayload` scrubs a key written into a `.env`, which is
  the whole reason the field is a string named `patch`.
- End to end on **real recorded SDK messages**, not hand-written fixtures: the
  probe's JSONL through `mapSdkMessage` → `parseDiff` produces the exact rows the
  table will draw, including the synthesized `@@ -0,0 +1,2 @@` for a created file
  and line numbers 1/10/19 for the three-hunk `replace_all`.

### Verified in the running app

Driven with the repo's own CDP harness (`e2e/harness.mjs`, `ensureBuilt()` then
`launch()`), against a real Claude turn in a scratch git repo — no seeded events,
no injected log. Two runs, screenshots kept out of the repo.

An `Edit` renders `@@ -1,5 +1,5 @@` with a red `−` on old line 3, a green `+` on
new line 3, and context lines carrying both gutters. A `Write` that creates a file
renders `@@ -0,0 +1,1 @@` with a correctly blank before-gutter. A 60-line creation
renders twelve lines and `+48 more lines not shown`, plural resolved.

Two things asserted rather than eyeballed, because they are invisible when right:
`.tool-patch`'s previous sibling is `.tool-line`, which proves the table was not
hoisted out by the HTML parser — a `<p>` may not contain a `<table>`, and the old
markup was a `<p>`. And `overflow-x: auto` holds, so a long line of code scrolls
inside the diff instead of widening the transcript.

### What driving it found that the tests could not

**40 lines is too many for a created file.** The unit test proves the cap works;
the screenshot shows what it costs. A 40-line all-added block fills the entire
transcript pane and scrolls its own `Write …/big.ts` row off the top, so you are
looking at a wall of `+` lines with nothing on screen saying which file they
belong to. The `Edit` case, by contrast, reads exactly as intended.

This is the argument the plan's rejected option 3 was making — that a new file's
contents are rarely what you are reviewing, whereas the fact that it appeared
usually is. The fix was a smaller number, not a different design.
**`MAX_CREATE_PATCH_LINES` is now 12**, and the reason is recorded at the constant
so nobody raises it back on the grounds that more context is obviously better.
Enough to recognise a file beats enough to read it; the omitted count carries the
rest.

Re-driven at 12 to check the fix rather than assume it: the same 60-line creation
now occupies **313px of a 795px pane** instead of overflowing it, and a turn that
creates a file _and_ edits another shows both diffs, with both labels, on one
screen. One honest wrinkle — the label-visibility assertion passed at `settle()`,
while the screenshot taken moments later had scrolled on, because the turn was
still streaming. The size measurement is the durable claim; label visibility holds
for a finished turn, not for every frame of a live one.

Also observed, and _not_ caused by this change: the sidebar card still read
`READ ONLY` and `No folder` after `setProfile` and `setProjectDirectory` were
called over IPC, while the edits demonstrably went through (`Allowed
automatically · allow-edits`, and the files changed on disk). That is the card not
re-reading state it was never told changed — an artifact of driving the app
programmatically rather than clicking, and pre-existing.

Also untouched, as planned: `NotebookEdit` (no `structuredPatch`), Codex edits
(`transcript.ts` still has no `file.change.proposed` case), the approval card, and
C-021's general tool-output fidelity.
