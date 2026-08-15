# Status — Windows installer

| Phase                                        | State                                     |
| -------------------------------------------- | ----------------------------------------- |
| 0 — Observe Windows                          | CI half shipped; VM observations not done |
| 1 — Platform-aware command launching         | shipped, unverified on Windows            |
| 2 — Shell, PTY, and process lifecycle        | not started                               |
| 3 — Named-pipe IDE bridge and Windows paths  | not started                               |
| 4 — Renderer and permission policy           | not started                               |
| 5 — Portable build and unsigned verification | not started                               |
| 6 — Signing and installer lifecycle          | not started                               |
| 7 — Release contract and documentation       | not started                               |

## Current state

- The plan was written on 2026-08-15 and corrected the same day after the
  claims in it were checked against the code (below).
- Implementation runs on `feat/windows-installer`, branched in place from `main`
  at `b26d0ca` rather than in a separate worktree.
- No Windows artifact has been built or runtime-tested.
- The repository's existing release path remains macOS ARM64 only.

## Corrections to the plan as first written

Per the repo rule that a plan contradicted by the code gets corrected rather
than implemented around:

- **Phase 1 stated the wrong signature.** `findExecutable` is already
  `async`/`Promise<string | null>` and already caches per name; the plan
  described it as synchronous.
- **Phase 2 scheduled work that already exists.** `shell.ts` already prefers
  `COMSPEC` on win32, already omits the `-l` login flag there, and already falls
  back to `cmd.exe`. The real defect is narrower: `isExecutableFile` gates on
  `stat.mode & 0o111`, which is never set on Windows, so `resolveShell` reaches
  its "nothing validated" fallback every time and returns the right shell by
  accident. Phase 2 now names that instead.
- **Phase 0 gained two prerequisites.** A `.gitattributes` pinning `eol=lf`,
  without which the `windows-latest` probe job fails `prettier --check` on every
  file in the repo; and starting certificate procurement immediately, because OV
  issuance is calendar time (HSM-backed keys, org validation) that Phase 6
  cannot absorb.

Findings from the same review that are **logged but not yet folded in**: the
`asarUnpack` glob would ship ~28 MB of node-pty `.pdb` symbols and the
`deps/winpty` source tree (Phase 5), and Phase 6's "fail on any unexpectedly
signed binary" contradicts electron-builder re-signing Electron's own DLLs and
shipping third-party `winpty.dll`/`winpty-agent.exe` (needs a stated allowlist).
Phase 6's SmartScreen exit criterion also needs to say whether a reputation
warning on a freshly issued certificate counts as a pass.

## What shipped, and a third correction

**Phase 0, automated half.** `.gitattributes` pins `eol=lf`; a `windows-latest`
probe job runs typecheck, lint, format and test. It is `continue-on-error` until
seen green once, because it lands in a shared workflow while another feature is
in flight. **It has never run** — whether the suite passes on Windows is still
unknown, and that is the question the job exists to answer. The VM observations
Phase 0 also asks for are not done.

**Phase 1, whole.** `command.ts` holds the pure platform reasoning and
`which.ts` the machine seam; `findExecutable` is gone and all five call sites
take a `ResolvedCommand`.

- **A third correction to the plan.** Phase 1 said to migrate all five call
  sites onto one contract. The Claude adapter cannot take it: it feeds the SDK's
  `pathToClaudeCodeExecutable`, a plain string, and `executableArgs` is flags for
  the JS runtime rather than a command prefix. So Claude resolves _past_ the
  `.cmd` shim to the script behind it and keeps its `string | null` contract —
  which means **only Codex needed widening**, not both adapters as first decided.
- `ResolvedCommand.file` is always spawnable and never the `.js`; the script
  rides in `scriptPath`. An earlier draft had `file` be the script, which makes
  `spawnSpec` return something Windows cannot exec.

**Unverified, and these are the ones to attack first on a VM:** the
`cmd /d /s /c` argument quoting, and whether npm's real Windows shim matches the
format `parseShimTarget` reads. The parser returns null rather than guessing, so
an unrecognised shim degrades to `cmd-shim` — right for every consumer except
the SDK, which then reports the CLI as missing rather than failing obscurely.

## Next action

Phase 0's VM observations, which now have two specific questions to answer
rather than a general brief. Then Phase 2 — where `isExecutableFile` is the one
line to change.
