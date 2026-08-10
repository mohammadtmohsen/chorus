# See what changed

## The problem

An agent edits a file and the transcript says:

```
● Edit /Users/alex/code/example-app/src/features/billing/…
```

That is the whole record. To find out what the agent actually did to the file you
leave Chorus — for the editor, for `git diff`, for the Review panel's cumulative
working-tree diff, which can tell you the file changed but not which of the four
edits in this turn changed it, or which agent made it.

Claude Code shows the diff. It is in-process with the tool call, so it holds
`old_string` and `new_string` and prints ± lines with real line numbers, right
under the tool row, without being asked. Chorus is meant to be the only window on
the work. Today it is a strictly worse window than the CLI it replaces, for the
single most consequential thing an agent does.

This is not a rendering bug. The diff never leaves the adapter.

## Why nothing renders today

`describeToolInput` (`packages/adapter-claude/src/mapping.ts:562`) walks a
nine-key priority list and keeps exactly one string, capped at 120 characters. For
an `Edit` it lands on `file_path`. `old_string`, `new_string` and `content` are
never read, and `ToolStarted` (`packages/agent-protocol/src/events.ts:144`) has
nowhere to put them if they were — `name`, `parentRef`, and a `detail` documented
as "one line".

So the store schema, `reduceEvents`, and the `.tool-line` in `Entry.tsx:257` are
all faithfully rendering everything they were handed. There is nothing to fix
downstream until something upstream captures more.

One near-miss worth naming: `describePatch` (`mapping.ts:1202`) does read
`old_string`/`new_string`, and builds `- old\n+ new`. It fires only on the
approval path, and every non-read-only profile runs `permissionMode:
'acceptEdits'`, so for an ordinary edit it never runs at all. When it does run,
`Session.tsx:1656` shows it as an uncoloured `<pre>`. It is also wrong for
notebooks, which carry `new_source` rather than `new_string`, so it returns `''`.

## The shape of the answer

The first draft of this plan had the adapter reconstruct a diff from
`old_string`/`new_string`. That draft was wrong, and reading `sdk-tools.d.ts`
is what killed it — the house rule about reading shapes out of the types rather
than out of memory earned its keep again.

**The SDK already computes the diff.** `FileEditOutput` (`sdk-tools.d.ts:3025`)
and `FileWriteOutput` (`:3073`) both carry:

```ts
  structuredPatch: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }[];
```

Real hunks, with real line numbers on both sides, and `lines` already carrying
the `+` / `-` / ` ` prefixes. This is the exact thing Claude Code renders.

It reaches us. `SDKUserMessage.tool_use_result?: unknown` (`sdk.d.ts:4591`) is the
tool's full Output object, keyed by the matching `tool_use` block's name, and its
own doc comment says:

> render from it instead of parsing the tool_result text

Which is precisely what `mapToolResults` does not do today — it calls
`readResultText(block.content)`, takes the first line, and truncates at 120.

So the work is not "compute a diff". It is "stop throwing away the diff we are
already being sent". That reframing is most of the value of this plan.

### Serialize to a unified diff string, not to a structured payload

Given hunks in hand, the tempting move is to put them on the event as structured
data. Do not. Emit a unified diff **string**, because three separate existing
mechanisms key on that and we get all three for nothing:

1. **`parseDiff` already consumes it.** `packages/workspace/src/diff.ts:42` needs
   only a `diff --git a/x b/x` line, `@@ -a,b +c,d @@` headers, and prefixed
   lines. It ignores `index`/`---`/`+++`. It even already handles the blank
   interior context line (`diff.ts:124`) that this generator produces. The
   serializer is a join, not a parser.
2. **`FileDiff` already renders it.** `ReviewPanel.tsx:135` draws `DiffFile` as a
   table with two line-number gutters, a sign column, and green/red tinting. It
   depends on nothing but `useTranslation` and CSS.
3. **Redaction already covers it.** `redactPayload`'s `TEXT_FIELDS`
   (`packages/shared/src/redact.ts:126`) is
   `['text', 'chunk', 'brief', 'message', 'unifiedDiff', 'patch']`, applied at the
   single write path into the log (`event-store/src/store.ts:129`, _"Redact before
   validate, and before anything touches disk"_). **Name the field `patch` and the
   ten secret-scanning rules run on it automatically.** Store structured hunks
   instead and the strings sit under a key called `lines`, redaction never fires,
   and we have quietly written an agent's API keys into the append-only log.

That last point is not a nicety. It is the difference between this change being
compatible with C-021's secrets objection and being the thing C-021 warned about.

The only genuinely new code is a ~15-line pure serializer.

### It rides on `tool.completed`, not `tool.started`

`structuredPatch` arrives on the tool _result_, not the tool _use_. This is better
than the alternative on the merits, and the reason should be in a comment: a patch
on `tool.started` would be a diff the agent _proposed_, and a denied or failed
edit would leave a durable record of a change that never happened. On
`tool.completed` with `status: 'ok'`, the log says what the file actually became.

The renderer already merges both events into one `TranscriptMessage` keyed by
`toolRef`, so the diff still draws under the same row it belongs to.

## Phases

### Phase 0 — Prove the field arrives, and prove we can tell whose it is — **DONE**

Ran against a scratch git repo of contrived files, driving the user's installed
`claude` (2.1.226) through the SDK. Five scenarios, every message dumped verbatim.
Results are in `STATUS.md`; the three that change the plan are folded into the
phases below. Headline: **the premise holds — `tool_use_result` is populated and
carries `structuredPatch`** — and **the correlation problem does not exist**,
because the SDK delivers exactly one `tool_result` block per user message even for
genuinely parallel tool calls.

The original statement of this phase follows, for the record.

Nothing else in this plan is worth writing until `tool_use_result` is observed
populated on a real `SDKUserMessage`, with `structuredPatch` non-empty, for a real
`Edit` and a real `Write`.

This project has been bitten five times by payloads inferred rather than observed
— the flat rate-limit event, the `task_*` keys, three in M2 — and `unknown`-typed
is exactly the shape that bites. Record a session, assert against the recording,
and keep the recording as the mapping fixture.

**The correlation recording is the priority, because it decides whether Phase 1
exists.** `tool_use_result` is one message-level field
(`SDKUserMessage.tool_use_result`, `sdk.d.ts:4591`), while `mapToolResults` walks
every `tool_result` block in `msg.message.content` and there may be more than one.
Phase 0 must therefore force the parallel case — two file edits in one assistant
turn, and a mixed turn of one `Edit` beside one `Read` — and record:

- whether a multi-tool turn yields one user message with N `tool_result` blocks,
  or N user messages with one block each;
- if the former, whether `tool_use_result` is still singular, and which block it
  belongs to.

If results always arrive one block per message, the correlation problem is a
non-problem and Phase 1 asserts that invariant defensively rather than solving it.
If they do not, Phase 1 needs the id tracking described below. Either way the
answer gets written down here rather than assumed.

Phase 0 also answers two things the types will not: whether `originalFile` is
populated (it is `string | null`), and whether `gitDiff.patch` shows up in
practice. If `gitDiff.patch` is reliably present it is a real unified diff already
and the serializer could be skipped — but it is optional, its `filename` is
repo-relative rather than absolute, and a second code path that only sometimes
runs is worse than one that always does. **Default: always serialize
`structuredPatch` ourselves.** Phase 0 records what `gitDiff` actually does so the
decision is written down rather than assumed.

**The fixture must be authored, not captured raw.** `FileEditOutput.originalFile`
is the entire pre-edit file, and `FileWriteOutput.content` the entire written one.
A recording taken from whatever this machine happened to be editing would commit
someone else's source — possibly someone else's secrets — into this repository as
a test fixture, which is the same mistake as writing them to the log with the
review step removed. Drive the probe against a scratch directory with contrived
files, and hand-check the fixture before it lands.

### Phase 1 — Adapter

**No tool-name tracking is needed, and the draft that added it was solving a
problem that does not exist.** Phase 0 measured it: the SDK splits one assistant
turn into one message per content block, and returns each result as its own user
message carrying exactly one `tool_result`. Three Reads the model issued in
parallel arrived as three assistant messages sharing a single `message.id`
(`msg_011CduDygU9AiUsSG33ZYbaA`) and three separate user messages. Two parallel
`Edit`s behaved identically.

So the message-level `tool_use_result` is not ambiguous — it pairs 1:1 with the
one block in its message. That kills the `trackToolUses` map, the path-equality
rule, and the `Map<id, {name, path}>` memory cost along with it. `trackBashTools`
stays exactly as it is.

What replaces it is a structural test, which is also more robust than a name
match against a tool list that the SDK can grow:

1. the message has **exactly one** `tool_result` block — asserted, not assumed,
   because it is the invariant the whole approach rests on;
2. `tool_use_result` has a `filePath` string and a `structuredPatch` array.

Both true ⇒ serialize and attach to that block's ref. Either false ⇒ no patch, and
today's behaviour. A missing diff is cosmetic; a diff drawn under the wrong file
is a lie about what an agent did to the user's disk.

**`Write` on a new file has no patch to attach.** Phase 0's sharpest surprise:
`type: 'create'` returns `structuredPatch: []` with `originalFile: null`, and the
full text only in `content`. An `update` Write returns proper hunks; a create
returns nothing. So file creations show no diff unless we synthesize an all-added
hunk from `content` — which is a real decision, not an oversight, and it is where
the entire size problem actually lives (see Phase 4).

**`filePath` is echoed verbatim from the input, and may be relative.** The type
says "absolute path"; the probe got back `./alpha.ts` because that is what the
model passed. Absolute in, absolute out. It is therefore safe to use for the
header, but it is not safe to _assume_ absolute — anything that resolves or
displays it needs a `cwd`, which the pure mapper does not have. Simplest honest
answer: emit what the SDK gave us and let the renderer show the same path the
agent used.

Then the serializer, which is the easy half — and which is already validated:
running it over the recorded three-hunk `replace_all` result and feeding the
output to `parseDiff` reproduced all three hunks with correct before/after
numbering and `added=3 removed=3`.

```
diff --git a/<file_path> b/<file_path>
@@ -oldStart,oldLines +newStart,newLines @@
<lines verbatim>
```

`parseDiff` needs nothing else — it ignores `index`, `---` and `+++`
(`diff.ts:131`), and `structuredPatch.lines` already carry the `+`/`-`/` `
prefixes. Paths containing a space are the one header ambiguity worth a test,
since `FILE_HEADER` splits on ` b/`. An absolute path also yields a
cosmetically odd `diff --git a//tmp/…`; `FILE_HEADER` extracts it correctly
regardless, which the round-trip confirmed.

`mapping.ts` stays pure — still a total function from a recorded message to
events, with no filesystem and no process. That property is why the adapter is
testable and it is not being spent here.

Tests: an `Edit` with one hunk; an `Edit` with several; a `Write` creating a file;
a failed edit (`status: 'error'` → no patch); a malformed or absent
`tool_use_result` (→ no patch, no throw); **two edits in one message where only
one can be correlated** (→ no patch on either); an edit whose `filePath` disagrees
with the tracked path (→ no patch); a path containing a space; and a round-trip
asserting `parseDiff(serialize(hunks))` reproduces the hunks.

### Phase 2 — Through the log

Extending an existing event, not adding one, so the five deliberately-exhaustive
switches do not gain arms — but every file in the five-file list still needs a
decision:

1. `agent-protocol/src/events.ts` — `patch?: string` on `ToolCompleted`, with the
   comment about why it is here and not on `ToolStarted`. `tool.completed` is
   already `UNDROPPABLE`. If Phase 4 lands the truncation count as metadata rather
   than as a `\` meta line, `omittedLines?: number` is a sibling here and takes
   the same `.default(null)` treatment in the store schema for the same reason.
2. `event-store/src/events.ts` — `patch: z.string().nullable().default(null)` on
   the `tool.completed` member. **The `.default(null)` is load-bearing and the
   first draft of this plan got it wrong.** `toStoredEvent` (`store.ts:400`)
   reparses every row's payload through the _current_ schema on every read, so a
   bare `.nullable()` — which accepts `null` but not a missing key — would make
   every `tool.completed` already on disk fail validation, and every existing
   conversation fail to open. There is no upcasting step to save us: `schema_ver`
   is written at append (`store.ts:137`) and read back as data, never branched on.
   Optional-with-a-default is the only forward-compatibility mechanism this store
   has, which is why `resumed`, `userInitiated` and `kind` already use it.

   This needs its own test, not just coverage by accident: parse a `tool.completed`
   payload with no `patch` key and assert it yields `patch: null`. Any future
   field on an existing event has the same trap, and the test is where that gets
   recorded.

3. `orchestrator/src/conversation-service.ts:841` — `patch: event.patch ?? null`.
4. `event-store/src/projections.ts` — stays a no-op, and the existing comment
   needs extending to say why: no query asks "which edits touched this file", and
   the Review panel answers the file-level question from git instead. If that
   changes, this is where it changes.
5. `orchestrator/src/catchup.ts` — stays a no-op, and this one needs a real
   reason. The other agent shares the working tree and can read the file or run
   git itself; replaying our rendering of a change it can observe directly is
   both redundant and a large token cost on every catch-up.

### Phase 3 — Renderer

- Lift `FileDiff` out of `ReviewPanel.tsx` into its own module. It has two
  consumers now, and its prop type is currently derived from an IPC response type
  (`DiffFile = Workspace['diff'][number]`) — it should take
  `@chorus/workspace`'s `DiffFile` directly.
- `transcript.ts` carries `patch` onto `TranscriptMessage` in the `tool.completed`
  case. Parsing stays out of the reducer; the reducer carries the string.
- `Entry.tsx` renders the diff under `.tool-line` when `patch` is present.
- Strings into `i18n/en.json`. The reducers have no translator, as ever.

### Phase 4 — The size problem

You asked for expanded by default, and for an `Edit` that is plainly right — a
typical edit is a handful of lines and hiding it behind a caret is the thing we
are fixing.

Phase 0 moved where the risk actually is. `structuredPatch` is **naturally
bounded** — changed lines plus three lines of context per hunk — so an `Edit`, and
even a `Write` that _updates_ an existing file, produces a diff proportional to
the change rather than to the file. The 800-line flood this section was written
around cannot come from `structuredPatch`, because a `create` returns no hunks at
all.

It can only come from the one case we would have to synthesize: showing a new
file's contents as an all-added hunk built from `content`. So the size question
collapses to a single decision — **what to do about file creation** — and it has
three honest answers:

1. **Show nothing**, as the SDK does. Cheapest, and a visible regression against
   Claude Code, which does show new file contents.
2. **Show a head.** Synthesize an all-added hunk capped at a dozen lines and say
   how many are omitted. Matches the useful part of Claude Code's behaviour.
3. **Show a stat line only** — `+120 lines` and the path, no body. A new file's
   contents are rarely what you are reviewing; that it appeared usually is.

Leaning (2), because it keeps one rendering path for every case and degrades
honestly. Either way, **the line budget belongs only on the synthesized create
path** — an `Edit` diff should render whole, expanded, with nothing to click,
which is what you asked for and what the bounded hunks make affordable.

Separately, and independently: a **cap on what is stored**. There is no size cap
on any payload field today (`store.ts` stringifies and inserts whole), and
"expanded by default" is a rendering decision while the log is forever. These are
two different limits and the plan should not let them be confused.

Three constraints on how that cap truncates, all of which the first draft's "byte
cap with a truncation marker" would have violated:

- **Cut at hunk-line boundaries, never at a byte or character offset.** A raw cut
  splits a UTF-8 sequence or lands mid-line, and a half-line inherits the `+` of
  the line it was cut out of — so the diff still parses and still renders, as
  something the agent did not write. Drop whole lines, then whole hunks.
- **A truncation notice has to be something `parseDiff` keeps.** It discards every
  line it does not recognise (`diff.ts:131`), so a plain `... truncated ...`
  vanishes and the diff renders as if it were complete — silently short, which is
  worse than visibly short. The parser does support one escape: a line beginning
  `\` becomes a `meta` line (`diff.ts:104`), which `FileDiff` already draws with
  empty gutters, and it must sit inside a hunk to survive.
- **But prefer metadata over the meta line**, because English inside the patch
  string is a hardcoded user-facing string written into the append-only log, where
  no translator can ever reach it. This codebase's stated answer to exactly that
  problem is that events carry data and the renderer turns it into words. So: a
  sibling `omittedLines: z.number().nullable().default(null)` on `tool.completed`,
  and the renderer says how much is missing in the user's language. The `\` meta
  line stays the fallback if a second field proves not to be worth it.

**Scope the cap to `tool.completed` specifically, not to any field named `patch`.**
A generic rule keyed on the field name would also silently rewrite
`file.change.proposed.files[].patch` (`event-store/src/events.ts:147`) and the
approval payloads — Codex edits and approval cards, neither of which this plan is
touching and both of which would start losing content for a reason nobody reading
them could see.

## What this is deliberately not doing

- **Not `NotebookEdit`.** `NotebookEditOutput` has no `structuredPatch` — it
  carries `old_source`/`new_source`, and in snake_case where `FileEditOutput` uses
  camelCase, which is exactly the kind of inconsistency that punishes guessing.
  Diffing those two strings means the LCS implementation this plan otherwise
  avoids entirely. Notebooks keep today's behaviour, and `describePatch`'s
  notebook bug (returns `''`) gets a one-line fix rather than a feature.
- **Not the general tool-output fidelity problem.** `tool_use_result` is populated
  for `Read`, `Grep`, `Glob`, `Task` and the rest, and the SDK is telling us to
  render from all of it. That is **C-021**, it is a bigger question about what the
  log may contain, and this plan is deliberately the narrow file-mutation slice.
  Doing edits first is the right order: it is the highest-value case and its
  secrets story is answered by an existing mechanism.
- **Not the approval card.** It has the same latent diff (`describePatch`) shown
  as plain text, and once `FileDiff` is extracted the fix is small — but under
  `acceptEdits` no card fires for an edit anyway, so it changes nothing about the
  screenshot that prompted this. Follow-up, not scope.
- **Not a per-file or per-turn edit projection.** Tempting, and `projections.ts`
  is where it would go, but no query asks for it yet.
- **Not Codex.** `packages/adapter-codex` already emits `file.change.proposed`
  with `{path, patch}`, and `transcript.ts` has no case for it, so Codex edits are
  invisible in the transcript for a different reason. Once `FileDiff` is extracted
  and the renderer can draw a patch inline, wiring Codex up is small — but it is a
  separate change with a separate failure mode.

## Open questions

1. **Where does the size cap belong** — the adapter (never emit more than N), or
   the store (never persist more than N)? The adapter keeps the wire cheap and the
   delta buffer honest; the store is the one chokepoint that cannot be bypassed.
   Leaning store, alongside redaction, since that is already the place where
   "before anything touches disk" is enforced — but note that truncating at hunk
   boundaries means the cap needs to understand the patch, which is adapter-shaped
   knowledge sitting in a store-shaped place.
2. **What does a file creation render** — nothing, a capped head, or a stat line?
   Phase 0 turned this from a detail into the only real size decision, because a
   `create` carries no `structuredPatch` and an `Edit` diff is bounded anyway.
   Needs an answer before Phase 3.
3. **Does truncation metadata earn a second event field** (`omittedLines`) over a
   `\` meta line baked into the patch text? The i18n rule argues for the field;
   simplicity argues for the marker.

_(Answered by Phase 0, kept for the record: `replace_all` produces **many** hunks,
one per occurrence. The question of two edits to one file defeating path
correlation is moot — there is no path correlation, because there is never more
than one result block per message.)_

## Corrections after review

Four errors, found by Codex reviewing the first draft and each confirmed against
the code before being written in here. Recorded rather than quietly edited out,
because three of them are the kind that would have shipped:

1. **`patch: z.string().nullable()` would have broken every existing
   conversation.** Every stored payload is reparsed through the live schema on
   read. Fixed with `.default(null)` and a test.
2. **Phase 1 assumed knowledge the adapter does not have.** It only tracks Bash
   ids, and `tool_use_result` is message-level. The proposed fix — a
   `trackToolUses` map plus path-equality correlation — was then **disproved by
   Phase 0**: the SDK never sends more than one result block per message, so there
   is nothing to disambiguate. The review was right that the draft was
   unimplementable and right to demand the recording; the recording is what showed
   the remedy was unnecessary too. Replaced by a one-block assertion.
3. **The truncation marker would have been silently discarded** by `parseDiff`,
   rendering a short diff as a complete one, and a byte cut could split a line or
   a UTF-8 sequence. Fixed with hunk-boundary truncation and explicit metadata.
   The cap is also now scoped to `tool.completed` rather than to the field name,
   which would have caught Codex edits and approval cards.
4. **The resume/replay open question was about dead code.** `mapping.ts:124`
   discards replayed user messages deliberately — the Chorus log supplies resume
   history. Dropped; it would only matter if historical backfill became a goal.

Phase 0's fixture requirement — contrived files in a scratch directory rather than
a raw capture — also came out of this review, and it is the same class of problem
as the redaction argument above: `originalFile` is a whole file, and a fixture is
a file we commit.
