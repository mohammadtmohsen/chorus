# Status

**Shipped 2026-08-17.** `pnpm check` green: 1919 tests. The path is driven end
to end by a new spec — `a problem sent from the editor lands in the composer,
unsent` — which passes.

What it proves, across three processes: a frame the **extension** initiates,
carrying source Chorus never asked for, routed by main to the conversation whose
project it belongs to, arriving in the composer as a reference, the message
quoted, and the code fenced —

    VS Code problem: `src/rate.ts:55` (react-compiler(memoization))

    > Existing memoization could not be preserved

    ```ts
    const providerTypeSelected = useMemo(
    ```

with no turn started, nothing said in the conversation, and the absolute path
absent. A diagnostic for a root Chorus never published changes nothing.

## The open question is closed, and the extension answered it

The plan asked whether an untrusted workspace should refuse. It should, and the
extension had already promised as much in its own manifest — `chorus.trust`
reads _"In a restricted workspace Chorus reports that the window exists, but
sends no file path, range, or text."_ A diagnostic is all three at once, so it is
refused whole rather than trimmed, exactly as `reportFor` returns
`bare('untrusted')`. `diagnosticFrame` takes `isTrusted` and has a test.

## What differed from the plan

**The routing rule.** The plan said focus first, then most recent, then a notice.
That was written as if main could see which pane has focus; it cannot, and
neither can the bridge. So **every conversation open on that root is sent to**,
which is the honest reading of "this project" — two panes on one repository are
both looking at the file, and a draft is not a turn, so staging in both costs
nothing and guesses nothing. A root with no conversation is dropped in main, and
the person who pressed the button is told by VS Code either way.

**The message is truncated where a selection is refused.** `MAX_SELECTED_BYTES`
refuses, because a cut selection means something different from what was
selected. A diagnostic is a report: the first four kilobytes of a compiler's
essay still says what it objects to, and refusing would make the longest
messages — the ones most worth asking about — the ones you cannot send.

**Nothing instructs the agent.** The block is a reference, a quoted message and
the fenced code, and stops. What to _do_ about a problem is the thing the user
came to type, and a composer that has already said "fix this" has answered the
only question it was there to ask.

## The price, as planned

`PROTOCOL_VERSION` is 3. **Every installed copy of the extension drops to
"update the extension" until it is reinstalled from Chorus's Settings panel.**
That was not avoidable by making the change smaller — the frames are
`strictObject`, so even an optional field is a schema change.

## Still to do

- **Nothing has been driven through a real VS Code.** The e2e spec drives
  `FakeIde`, which speaks the protocol but is not the extension: the command,
  the context-menu entry, `vscode.languages.getDiagnostics` and the four
  messages the command shows have never run inside an extension host.
- The VSIX has not been rebuilt or reinstalled, so the first person to try this
  meets the version-mismatch state rather than the feature.
- `code` as an object (`{value, target}`) is handled by `codeOf` but has not been
  seen from a real linter.

```

```
