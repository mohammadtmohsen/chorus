# Status — VS Code editor context

Status: **Phase 6 done — feature complete, pending your UI verification.** Plan approved; implementation in progress.

## Done

**Phase 1 done: the wire contract and exact project matching.**

`@chorus/ide-protocol` is a new pure package — zod only, no filesystem, no Node globals —
so the VS Code extension can depend on it from inside the extension host without pulling
in the rest of the app.

The §4 invariant is now structural rather than a convention. `editorMetadata` and
`editorSnapshot` are separate `strictObject` schemas differing by one field, so a live
frame carrying source text fails validation in the broker instead of being quietly
accepted. `selectedBytes` is uncapped on the live frame — reporting an oversized selection
is how the pill reaches `tooLarge` without the text leaving VS Code — and capped on the
snapshot, where it must also equal the real UTF-8 length of `text`, so a client cannot
declare a small selection and deliver a large one. `utf8ByteLength` is hand-rolled because
`TextEncoder` is not in this package's lib, and it walks code points so an astral
character counts as four bytes rather than six.

`initialize` deliberately carries no workspace paths, closing the leak the merged review
found: the extension learns the roots first via `setRoots` and reports only against those.
`rootState` refines `editor` to be present exactly for `ready` and `tooLarge`, making both
"ready with nothing to show" and "not ready, but here is an editor" unrepresentable.
`decodeFrame` checks size before `JSON.parse`, returns failure as a value, and reports the
zod issue _path_ only — never the offending value, which could be a path or source text.
`toDisplayRange` is the single zero-to-one-based conversion, and it excludes a trailing
line the selection only touches at character 0.

`@chorus/workspace` gained `project-match.ts`, built on `path-safety.ts` rather than
restating it — `isWithin` and `safeRealpath` are now exported for that reuse. `CanonicalRoot`
is branded so a raw string cannot be passed where a resolved root is required, which keeps
the per-event `realpathSync` out of the 200ms-debounced hot path. Candidate paths are still
resolved on every check, because that is the part an attacker controls. `chooseWindow`
returns `null` for ambiguity rather than tie-breaking on arrival order.

Gate: `pnpm check` green — typecheck, lint, format, and 599 tests (up from 547), 3 skipped
(the `CHORUS_E2E` Codex suite, unchanged).

One bug worth recording: `decodeFrame` initially read `.value` off zod's success result
instead of `.data`, so every successful decode returned `undefined`. The round-trip test
asserted only `ok === true` and passed anyway; `tsc` caught it. The test now asserts the
decoded payload.

**Phase 2 done: the Electron IDE broker.**

`ide-bridge.ts` binds the Unix socket, publishes a per-pid descriptor
(`<tmp>/chorus-ide/<pid>.{sock,json}`, `0600` in a `0700` directory it refuses to use if
the mode or owner is wrong), authenticates the handshake against a per-launch token, and
keeps a window registry. Nothing in it is Electron-aware, so the tests drive real sockets
with real frames — a mocked broker would test nothing that can actually break.

Resolution distinguishes the states the plan insisted on: `unavailable` when nothing is
connected, `unmatched` when something is but this project is not open in it, `ambiguous`
when two unfocused windows both have it. Reports are re-checked against the roots Chorus
actually asked for, because the extension's filtering is disclosure minimisation and
Electron main is the security boundary. A reconnect from the same `windowId` replaces the
old connection rather than adding a phantom to focus arbitration. `setRoots` is idempotent,
since the caller resyncs from `runtime.subscribe` and most event batches are streaming
deltas that change nothing.

Wired into `main/index.ts` after `whenReady`, inside a try/catch — editor context is
additive, and a bridge that fails to start must leave Chorus exactly the app it was. On
quit the bridge closes before the runtime, unlinking its socket and descriptor and settling
anything waiting on a snapshot.

Gate: `pnpm check` and `pnpm build` green — 623 tests (up from 599), 3 skipped.

Two bugs the tests caught, both worth recording:

- `close()` deleted each pending request before invoking its callback, and the callback
  guards on its own `delete` returning true — so every waiter bailed out early and a quit
  during a pending Send would have hung forever. The test written for that exit criterion
  is what found it.
- Responses share the data channel and carry no `method`, so they failed the message
  schema and would have killed the socket on the first snapshot reply. They are now routed
  first, and only for an id actually outstanding.

Lint also caught a real type-design flaw rather than a style nit: `#handleLine` returned
`string | null | 'closed'`, and since a window id is a string the sentinel was
indistinguishable from a real id. It now returns a discriminated outcome.

**Phase 3 done: the first-party VS Code extension.**

`apps/vscode-extension` is a UI extension (`extensionKind: ["ui"]`, so Remote-SSH and
containers keep it on the Mac) activated `onStartupFinished`. It scans
`<tmp>/chorus-ide` for descriptors, PID-checks them, dials every live Chorus with capped
exponential backoff, and rescans every 5s so a Chorus started after VS Code is still
found. Workspace Trust is declared `limited`.

The disclosure policy lives in `editor-context.ts`, which imports nothing from VS Code —
that is what makes it testable directly rather than through a mock of the editor.
`extension.ts` is the only file that knows what a `TextEditor` is, and its whole job is
filling in structural shapes. Every ineligible branch returns `editor: null`, so a
document from another project never reaches Chorus even as a name; `tooLarge` is the one
refusal that still names the file, because the pill has to say which selection is the
problem.

`SelectionCache` implements the plan's narrow rule: absence of an editor is remembered,
the wrong editor is not. Focus sitting in the terminal, the sidebar, or Chorus itself
yields the last eligible in-project selection marked `cached`; a current editor that is
outside the project or unsupported clears it, so an unrelated file can never fall back to
an older in-project selection.

Gate: `pnpm check` and `pnpm build` green — 673 tests (up from 623), 3 skipped. The
bundle was smoke-loaded under a stubbed `vscode`: 552 KB CJS, `vscode` correctly external,
`activate`/`deactivate` both exported.

Two notes against the plan's own predictions:

- `turbo.json` needed **no** change. Its `build`/`typecheck`/`test` tasks are defined
  once for every workspace member, so the extension was covered the moment it had those
  scripts. The plan overstated this.
- `eslint.config.mjs` did need a change, but not for the predicted reason. Node globals
  and the ambient `vscode` module were already fine. What broke was `esbuild.mjs`: it
  belongs to no tsconfig, so the type-aware rules had no project to resolve it against.
  It joins the existing config-file exemption.

Lint also caught an `any` leak that would have violated the global rule: VS Code types
`Extension.packageJSON` as `any`, so reading `.version` off it was unchecked. Narrowed
rather than cast, and it degrades to `0.0.0` instead of putting `undefined` on the wire.

**Phase 4 done: scoped IPC, the live pill, and send-time composition.**

The renderer now sees editor context, and it is scoped twice. Main sends each pane only
its own conversation's state, and the payload deliberately omits the absolute path and the
file URL — a pane gets a path already relative to its own `cwd`, so it cannot display, or
leak into a screenshot, where the project sits on disk. No source text is on the live
channel at all.

`renderer/src/editor-context.ts` is the formatter, and it is not `asQuote()`. `quote.ts`
trims each line, which is right for prose and destructive for code, where indentation is
syntax. The fence grows to outrun the longest backtick run in the selection, because
selected code very often contains a Markdown sample and a three-backtick fence would close
early — handing the agent half the selection as prose. The language id is restricted rather
than escaped, since a newline in it would break out of the fence entirely. A bare cursor
sends no code: the agent is told where to look and reads the file itself.

Send captures the snapshot rather than trusting the pill, which is debounced and can be a
few hundred milliseconds stale. The draft and its attachments are cleared only once the
context is in hand, so a timeout, a moved selection, or an oversized one leaves everything
exactly as it was and explains why. The eye toggle, once off, stays off — a live selection
change cannot silently re-enable excluded context. `unavailable` renders nothing at all,
because a permanent "not connected" would be chrome telling the user about software they
may not use.

Gate: `pnpm check` and `pnpm build` green — 692 tests (up from 673), 3 skipped.

One test of mine was wrong rather than the code: I asserted `safeLanguageId` would keep
backticks. It strips them, which is the safer behaviour and what the fence rule needs. The
test now asserts what the implementation actually guarantees.

**Phase 5 done: VSIX distribution and project opening.**

The extension ships inside Chorus as `extraResources`, installed only when the user presses
a button in Settings. `--force` doubles as the update path, since `code` otherwise refuses
when any version is present. `code` is invoked with argument arrays, never a shell string —
a project path containing a quote would otherwise be a command injection, and there is a
test for exactly that path. "Open in VS Code" adds no window flags: which window to use is
a preference the user has already set.

**The VSIX is built without `@vscode/vsce`.** `vsce` pulls `keytar` — a native keychain
module — plus a signing binary, both wanting postinstall scripts. `pnpm-workspace.yaml`
states the policy that violates: build scripts are opt-in one package at a time, on a
one-native-module budget, because every entry is another binary to sign if M9 triggers.
Paying that for a credential store we do not use — publishing is out of scope for v1 — was
the wrong trade. A VSIX is an Open Packaging Convention zip, so `package.mjs` writes the
two XML parts and zips them, adding no dependency at all. Verified by installing the result:
`code --list-extensions` reports `chorus.chorus-vscode@0.4.0`, matching the id the parser
expects.

Gate: `pnpm check` green — 716 tests (up from 692), 3 skipped. `pnpm package` produces a
clean build carrying the VSIX at `Contents/Resources/chorus-vscode.vsix`, and the seal
re-verified as the plan required: `codesign --verify --deep --strict` passes, and
**`Sealed Resources rules=13 files=77`** — up from 76 by exactly the one added resource.

**Phase 6 done: end-to-end against the running app.**

`e2e/fake-ide.mjs` is a VS Code window that is not VS Code. It speaks the real protocol
over the real socket to the real app, so what runs is the whole path — descriptor
discovery, the token handshake, root filtering, and the snapshot request Send makes. Only
the editor is pretend, which is the one part that cannot be automated on a build machine.

Two specs, both green:

- **follows the editor for its own project, and only that one.** Proves the socket is
  reachable from a real main process, that the published root arrives canonicalized
  (macOS reaches the temp dir through `/var`, a symlink to `/private/var`), and that the
  pill names `src/a.ts:12-14`. Reporting a file from an unrelated directory leaves the
  pane reading "No file from this project is open" — the foreign path never appears.
- **Send asks the editor again rather than trusting the pill.** The pill is shown lines
  1-3, the selection then moves to 40-41 with an unsaved buffer, and the snapshot returns
  the fresh range, a project-relative path, exact text with its indentation, and the dirty
  flag. Diagnostics are asserted to contain neither the token nor the selected source.

The full suite is 12 specs and all pass, so the ten that existed before are unregressed.

Gate: `pnpm check` green — 716 tests, 3 skipped; `pnpm run e2e` 12/12.

Scope note, so the coverage is not overstated: the e2e harness drives the **built** app via
`npx electron .`, not the packaged `.app`. Packaged verification was done in Phase 5 —
`codesign --verify --deep --strict` clean, `Sealed Resources files=77`, VSIX present at
`Contents/Resources/`. What has **not** been done is a run against a real VS Code window
with the real extension installed, and the visual pass at normal and narrow widths. Those
are the UI-verification gate and are yours to walk.

## Approved decisions captured by the plan

- Live follow, with source text requested only at Send.
- Exact canonical VS Code workspace root must match the Chorus conversation `cwd`.
- First-party extension dialing Chorus over an authenticated Unix domain socket.
- No reuse of Claude Code's one-client IDE server.
- Bundled, version-matched VSIX for v1; no external marketplace publication in scope.
- One Chorus process is the supported configuration; multi-process arbitration is out of
  scope for v1.
