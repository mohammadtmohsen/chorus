# Status

**Shipped and driven, 2026-08-17.** `pnpm check` green: 1897 tests. The app was
driven against a live Claude — a `Read` of `package.json`, then the channel
exercised both ways — and VS Code opened the file.

What was seen:

- the tool row rendered as
  `<button class="tool-detail tool-detail--path" data-open-file="/Users/…/chorus/package.json">`,
  carrying the whole path;
- `ide:openFile` with `/etc/passwd` refused as `outside-project`;
- `ide:openFile` with `package.json` returning `{ok: true}`, and VS Code raising
  the file.

## Where the plan was wrong: it is a three-file event change, not five

The plan called `path` on `tool.started` "a five-file change by the rule in
`CLAUDE.md`". That rule is about adding an event **type** — a new type has to be
considered by three deliberately exhaustive switches. Adding a **field** to a
type that already exists is a different shape: `projections.ts` already routes
`tool.started` through its "streamed detail the transcript reads back off the
log" no-op group, and `catchup.ts` already has it in a no-op arm with a reason.
Neither needed an edit, and editing them to say the same thing again would have
been noise.

So it landed in `events.ts` (the protocol), `event-store/src/events.ts` (the
schema, **optional** rather than nullable so logs written before it keep
parsing), and `conversation-service.ts` (the append, which omits the key rather
than nulling it — a field that is sometimes absent and sometimes null is two
shapes).

## `describeToolInput` returns a pair now, and that is the whole feature

It used to return a string. It returns `{detail, path?}`, and `path` is set only
when the key that won was one of `file_path`, `notebook_path`, `path`. That
asymmetry is the point: `pattern` beats `path` for a `Grep`, so the row reads as
the search it is — and a click that opened the directory it searched would not
match what the row says.

The tests are the two halves of the reported problem: a path longer than
`MAX_TOOL_DETAIL` keeps its whole `path` while its `detail` still ends in an
ellipsis, and a search, a subagent brief and a URL carry no `path` at all.

## What is refused, and where

`ide:openFile` takes `{conversationId, path}` and never a directory. Main
resolves against that conversation's own `projectDirectory` and refuses anything
outside with `isInside`, which is segment-wise — `/p/a-old` is not inside `/p/a`.
A conversation that has closed throws from `projectDirectory` and is caught: a
pane closing mid-click is a race, not an error to surface.

`openFileInEditor` is a **sibling** of `openProjectInEditor` rather than a flag
on it, because that function's test asserts it passes exactly one argument and
adds no window flags — an assertion guarding a real decision about whose
preference window placement is.

## A test that opened VS Code twice

The first version of the `ide:openFile` tests asserted the positive path: a
contained path is not refused. There is no seam between the handler and
`extensionDeps()`, so on a machine with `code` installed — this one — that
spawned VS Code during `pnpm check`. The suite now asserts refusals only, with
the reason written down; the positive path is what driving the app is for, and it
was.

## Still to do

- **`cli-missing` has never been shown to anyone.** The string has existed unused
  since the extension shipped, and this is the first UI that can raise it — but
  it needs a machine without `code` on `PATH`, which this is not.
- No line numbers, as planned. `code -g` takes `path:line` and the changes card's
  patches hold hunk headers, so opening a changed file _at its first change_ is a
  real follow-up and a separate one.
- `e2e/shots-changes.mjs` reads `.changes-path`'s `textContent`, which a
  `<button>` keeps — but the shots have not been re-run, so the screenshot
  baseline for that card is unverified.
