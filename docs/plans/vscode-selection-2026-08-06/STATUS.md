# Status — VS Code editor context

Status: **Phase 3 done.** Plan approved; implementation in progress.

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

## Not started

- Phase 4 — scoped IPC, live context pill, and send-time composition
- Phase 5 — VSIX distribution and project opening
- Phase 6 — end-to-end, live, packaged-app, and visual verification

## Approved decisions captured by the plan

- Live follow, with source text requested only at Send.
- Exact canonical VS Code workspace root must match the Chorus conversation `cwd`.
- First-party extension dialing Chorus over an authenticated Unix domain socket.
- No reuse of Claude Code's one-client IDE server.
- Bundled, version-matched VSIX for v1; no external marketplace publication in scope.
- One Chorus process is the supported configuration; multi-process arbitration is out of
  scope for v1.
