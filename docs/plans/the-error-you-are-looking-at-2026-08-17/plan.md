# The error you are looking at

Asked for as: _"add send to Chorus from vscode extension error or description
tooltip"_ — pointing at a React Compiler hover in VS Code: a paragraph of
explanation, a file and line, and the offending expression underlined.

## Why this is not the same shape as what already works

Editor context already crosses, and it crosses in a very particular way. The
extension pushes **metadata only** — file, language, dirtiness, selection offsets
and a byte count, never text (`ide-protocol/src/protocol.ts:162`, and
`strictObject` is what enforces it: a frame smuggling a `text` field fails
validation in the broker). Source text moves exactly once, when **Chorus asks**:
you press Send, `ide:snapshot` fires, the extension answers `currentContext` with
the selected text.

Every part of that is Chorus-initiated. **This feature is the first thing the
extension would ever start**, and it is source text plus a path plus a message —
which is why the design argument is about consent and routing rather than about
plumbing.

## The price, stated first

`PROTOCOL_VERSION` is 2 and both ends refuse a mismatch outright — the extension
will not dial (`connection.ts:108`), Chorus destroys the socket
(`ide-bridge.ts:458`). Any new message means **3**, and every already-installed
copy of the extension drops to the "update the extension" state in the status bar
until it is reinstalled from Chorus's own Settings panel. That is not avoidable
by making the change smaller: the unions are `strictObject`, so even an optional
field on an existing message is a schema change. `protocol.ts:15` documents the
hard boundary as deliberate.

So the version bump is the cost of the feature, and the plan spends it once —
adding the message the feature needs rather than the smallest thing that
compiles.

## Shape

**One diagnostic, the one under the cursor**, decided with the user. Right-click
in the editor, or the command palette; `vscode.languages.getDiagnostics(uri)`
filtered to the ranges containing the cursor, most specific first. Nothing in
this repo has ever touched that API, so there is no collector, no debounce and no
severity mapping to reuse — all of it is new and all of it is small.

**It lands in the composer, staged, not sent.** Also decided with the user, and
it is the same rule the rest of the feature follows: nothing reaches an agent
without you pressing Send. It arrives in the focused pane's draft, formatted the
way `renderer/src/editor-context.ts` formats editor context, and you type what
you want done with it.

**Routing is by root, then by focus.** A diagnostic arrives with the workspace
root the extension reported it under; main already re-validates that the root is
one Chorus asked about (`ide-bridge.ts:519`). The renderer picks the focused pane
when its `cwd` matches, otherwise the most recently active conversation with that
cwd. **When nothing matches, it is a notice and not a guess** — dropping a
compiler error from `tpa-web-2` into a conversation about something else is worse
than saying "no open conversation is in that project".

**What travels**: the message, severity, source (`eslint`, `ts`, `react-compiler`)
and code; the file and the one-based range through `toDisplayRange`, which is the
single zero→one-based conversion in the feature and must stay so; and the
offending lines, capped like `MAX_SELECTED_BYTES` caps a selection. The hover in
the screenshot is four sentences and five lines of code — that is the size this is
built for, not a file.

## What changes

**`packages/ide-protocol`** — `PROTOCOL_VERSION` 3, and a `sendDiagnostic`
variant on `extensionMessage` carrying `{root, file: editorMetadata-shaped,
range, severity, source?, code?, message, text}`. `protocol.test.ts`'s
`describe('direction separation')` is the test that already asserts each end
cannot accept the other's messages; the new variant joins it.

**`apps/vscode-extension`** — a `chorus.sendDiagnostic` command, the first
`contributes.menus` entry in the repo (`editor/context`), and the picking rule in
its own module beside `editor-context.ts`, because everything testable in this
extension lives outside `extension.ts` on purpose (`extension.ts:33`). The
version and the VSIX are rebuilt by `pnpm package`.

**`apps/desktop/src/main/ide-bridge.ts`** — accept the frame, re-validate the
root against `#roots`, and hand it out through the existing `subscribe()` fanout.

**`shared/ipc.ts` + `main/ipc.ts` + `preload/index.ts`** — a push channel beside
`IDE_PUSH_CHANNEL`, with the payload **restated** rather than imported, as
`ipc.ts:192` already does for editor context and for the reason it gives there.

**`renderer` — `App.tsx`, `Session.tsx`, `Composer.tsx`** — route it, then
`composer.current?.insert(...)`, which is the handle an aside brought forward
already uses. Strings under `ide.diagnostic.*` in `i18n/en.json`; the block the
agent reads is composed in the renderer, never in the extension, so the words are
translatable and the extension stays a reporter.

**`e2e/fake-ide.mjs`** learns the method, because it is what drives the bridge in
`specs.mjs`.

## What this does not do

- **It does not send every problem in the file.** One error is what a person is
  looking at when they reach for this; a file's worth is a different task with a
  different shape (a list to triage, not a question to ask).
- It does not auto-send, and it does not open a conversation. A gesture in
  another application that spends a turn in this one is the wrong default.
- It does not add a `ChorusEventPayload`. A diagnostic that reaches an agent does
  so **as your message**, because you sent it — the log records the conversation,
  and a problem you looked at and did not send is not part of it.

## Verification

`pnpm check`, then both halves on a real machine: reinstall the extension from
Settings (the version bump makes this mandatory, and it is also the thing most
likely to go wrong), right-click a real diagnostic in a project Chorus has open,
and read what lands in the composer. Then the negative: the same gesture with no
Chorus conversation in that project must say so.

## Open questions

- **Which pane, when two are open on the same project?** Focus first, then most
  recent. It is a guess either way; the alternative is a picker, which is three
  clicks for the common case of one.
- Should the extension refuse when the window is untrusted? `package.json`
  already declares `untrustedWorkspaces: limited`, and a diagnostic carries source
  text, so probably yes — but the existing limited mode is not documented in terms
  of what it withholds, and reading that before deciding is part of the work.
