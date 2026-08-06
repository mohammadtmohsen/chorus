# Status — VS Code editor context

Status: **Phase 1 done.** Plan approved; implementation in progress.

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

## Not started

- Phase 2 — Electron IDE broker
- Phase 3 — first-party VS Code extension
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
