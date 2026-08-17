# Open the file you clicked

Asked for as: _"when click on this path it should redirect to vscode the project
related to the chat"_ — pointing at a tool row reading
`● Edit /Users/mohamadtaleb/code/tpa/tpa-web-2/src/features/…/hcpc-pricin…`.

## What is there already, which is more than it looks

**`openProjectInEditor` ships and nothing calls it.** `main/ide-extension.ts:154`
resolves the `code` CLI through `resolveCommand`, spawns it with an argument
array via `spawnSpec` — which also refuses cmd-shim metacharacters on Windows —
and returns `{ok, reason}` rather than throwing. Its IPC channel
(`ide:openProject`), its preload binding and its four `ide.openError.*` strings
are all in the tree. No renderer file has ever called it. This feature is that
groove, one file deeper.

**The other two routes are worse.** `vscode://file/...` is refused on purpose:
`main/security.ts:66` hands only `https:` to `shell.openExternal`, and widening
that is a `SECURITY.md`-level change to gain nothing. Asking the running
extension to open the file would mean a third member of the `chorusMessage`
union, `PROTOCOL_VERSION` 3, a VSIX rebuild and a forced update for every user —
and it would stop working the moment the extension is not installed, which is the
common case.

## The part that is not a wiring job

**A tool row does not carry a path.** `tool.started` carries `detail`
(`agent-protocol/src/events.ts:193`), described as "one line: the path read, the
pattern searched, the subagent's brief". It is chosen by
`describeToolInput` (`adapter-claude/src/mapping.ts:579`) from an ordered key
list — `plan`, `description`, `pattern`, `file_path`, `notebook_path`, `path`,
`query`, `url`, `prompt` — and then **truncated to 120 characters with an
ellipsis** before it reaches the log.

So the string on screen is a display string that may be a regex, a URL or a
subagent brief, and for a deep path it is a prefix of the answer rather than the
answer. The path in the screenshot is about 98 characters, so it survived and the
`…` you see is CSS clipping. `src/features/insurance-info/procedure-pricing/…`
one directory deeper would not have.

Decided with the user: **store the path**. `tool.started` gains an optional
`path`, set only when the detail was chosen from a path key. That is a five-file
change by the rule in `CLAUDE.md`, and it is the honest one — the alternative,
linking only the paths that happened to fit, gives a row that is clickable or
dead for a reason nobody can see.

**Only Claude emits `tool.started`.** The Codex adapter has no such mapping; its
file work arrives as `file.change.completed` and lands on the Changes card, which
already carries whole absolute paths. So the adapter half of this is one file.

## Shape

`path` is the file **as the provider named it** — absolute for Claude — and it is
never trusted. The renderer sends `{conversationId, path}`; main resolves it
against `runtime.projectDirectory(conversationId)` and refuses anything outside,
with `isInside`/`relativeInside` from `ide-protocol/src/paths.ts`, which exist
because `/a/project-old` must not count as inside `/a/project`. That mirrors
`ide:snapshot`, which re-checks in main for the same reason: the renderer is not
the security boundary.

`openFileInEditor` is a **sibling** of `openProjectInEditor`, not a flag on it.
`ide-extension.test.ts:189` asserts that opening a project passes exactly one
argument and adds no window flags, and that assertion is guarding a real
decision — which window a file opens in is VS Code's preference, not Chorus's.
The new function passes `-g <path>` and nothing else.

**No line numbers, deliberately.** Nothing on a tool row or a changes row knows
one: `ChangedFile` is `{path, change, added, removed, patch?}`. `code -g` takes
`:line` and the hunk headers in `patch` hold one, so opening a changed file at
its first changed line is a real follow-up — and it is a separate change, because
it means threading a line out of a parsed diff rather than opening a file.

## What changes

**The event, five files** — `agent-protocol/src/events.ts` (the optional `path`
on `ToolStarted`), `event-store/src/events.ts` (the payload schema),
`orchestrator/src/conversation-service.ts` (the append), `projections.ts` (an
explicit no-op: no query asks which file a tool touched — the Changes card is
fed by `file.change.completed`), `catchup.ts` (a no-op: the other agent runs
under its own harness and cannot open an editor).

**`adapter-claude/src/mapping.ts`** — `describeToolInput` returns the key it
chose alongside the text, so `path` is set for `file_path`, `notebook_path` and
`path` and left off for a pattern or a prompt. Untruncated, because it is data
rather than a line of display.

**`shared/ipc.ts`, `main/ipc.ts`, `preload/index.ts`** — `ide:openFile`, request
`{conversationId, path}`, response `{ok, reason}`, matching `ide:openProject`
exactly. The handler resolves, contains, and calls `openFileInEditor`.

**`Entry.tsx`** — `onOpenFile?: (path: string) => void`. The tool row's
`.tool-detail` becomes a `<button>` when `message.path` is set, and the changes
row's `.changes-path` becomes one unconditionally. Both keep their class and
their exact `textContent`, which is what keeps `e2e/shots-changes.mjs:229`
green — it reads `.changes-path`'s text, so a nested icon would break it and a
button will not.

**`Session.tsx`** — `openFile`, a `useCallback` over `conversationId` that calls
the channel and puts a failure in the pane's error line using the
`ide.openError.*` strings that already exist.

**`transcript.ts`** — carry `path` onto the tool row. Several reducer tests use
`toEqual` on whole rows, so this is the file to run first.

## What this does not do

- **It does not make paths in prose clickable.** A reply's words go through
  `MarkdownView`, and adding chrome inside `.entry` is the class of bug that
  produced _"That passage is not part of that reply"_ (C-041). Tool and changes
  rows are outside it: `askableSource` already refuses anything whose `kind` is
  not `message`.
- It does not open anything but VS Code. `resolveCommand('code')` is what exists;
  a configurable editor is a settings decision, not this.
- It does not touch `openProjectInEditor`, so the "no window flags" test keeps
  meaning what it means.

## Verification

`pnpm check`, then drive it: click a path on a tool row and on a changes row and
watch VS Code raise the right file, then rename the folder under Chorus and click
again to see the containment refusal rather than a spawn. With `code` not on
`PATH`, the row must say so rather than doing nothing — that is what
`ide.openError.cli-missing` is for and it has never been shown to anyone.

## Open questions

- A tool row whose path is a directory — `Grep` with a `path` key — opens a
  folder in VS Code. Harmless, but it means "clicking a row opens a thing" rather
  than "opens a file". Left as is; the alternative is guessing from the string
  whether it is a directory, which is what a stat call is for and this is not
  worth one.
