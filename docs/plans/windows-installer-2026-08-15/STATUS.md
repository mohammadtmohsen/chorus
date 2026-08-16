# Status — Windows installer

| Phase                                        | State                                     |
| -------------------------------------------- | ----------------------------------------- |
| 0 — Observe Windows                          | CI half shipped; VM observations not done |
| 1 — Platform-aware command launching         | shipped, unverified on Windows            |
| 2 — Shell, PTY, and process lifecycle        | shipped, unverified on Windows            |
| 3 — Named-pipe IDE bridge and Windows paths  | shipped, unverified on Windows            |
| 4 — Renderer and permission policy           | shipped, unverified on Windows            |
| 5 — Portable build and unsigned verification | code shipped; no Windows artifact built   |
| 6 — Signing and installer lifecycle          | **blocked** — needs a certificate and VMs |
| 7 — Release contract and documentation       | shipped                                   |

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

## Phases 2–7

**Phase 2 found two bugs behind the one it was looking for.** `isExecutableFile`
gated on `stat.mode & 0o111`, which libuv never sets on Windows — but the
"nothing validated" fallback then returned `COMSPEC` anyway, so a terminal
opened and nothing looked wrong. Writing the test for it exposed that the
fallback took `fallbacks()[0]`, the value already rejected, so a `COMSPEC`
naming a directory came back as the shell to spawn; and that Windows had one
fallback where unix has three.

Busy/idle turned out to be unavailable rather than wrong. node-pty's
`WindowsTerminal` returns `this._name` from `.process` — the terminal _type_,
assigned once at construction — so every Windows terminal reported permanently
busy and the kill dialog named `xterm-256color` as the process. Reported as
`false` now, which loses the running-build warning; recovering it needs
`conpty_console_list`, which is its own piece of work.

`reap.ts` is off on Windows and says so. Per the plan, no strategy was guessed:
PPID 1 has no Windows equivalent, `SIGKILL` is not a signal there, and a ported
`pgrep -f` scan would match the user's own `codex`.

**Phase 3's bridge was dead twice over, silently.** `assertPrivateDirectory`
threw on every Windows launch into a `try`/`catch` that only logs; independently
the extension's `isPrivate` skipped every descriptor. Two silent failures
presenting as one missing feature. Containment was also defined twice and had
already drifted — main used `path.sep`, the extension hardcoded `/` — so the
rule and the endpoint both moved into `@chorus/ide-protocol`, the package both
ends already import. Three of the bugs found are **not Windows-only**:
`safeRealpath` and `projectRelativePath` both sliced `root.length + 1`, which
eats a character at any root ending in a separator, and `joinInside` split on
`/` alone so a backslash path walked past its own `..` guard.

**Phase 4's policy half is the one with teeth.** Trusted allows any command by
profile, so `UNIVERSAL_DENIES` is all that stands between it and an irreversible
action — and `del /s`, `rd /s`, `Remove-Item -Recurse` and `git.exe push --force`
were all allowed outright. Denies now match case-insensitively; allows
deliberately do not, since `i` on `SAFE_READS` would widen an allowlist.

**Phase 5 has no artifact.** The pipeline is portable — `zip`, `env` and `rm`
are gone, `icon.ico` is generated, the NSIS target is configured, and
`verify:package:windows` exists — but no Windows machine has run any of it. The
macOS package still builds and its bundle is unchanged.

**Phase 6 is blocked, not skipped.** It needs a code-signing certificate and
clean Windows VMs. Neither exists in this environment, and no part of it was
attempted.

## What is verified, and how

Everything Windows-shaped is asserted from macOS with an injected platform, so
it proves the _shape_ and not the machine. Where a claim could be checked against
something real, it was: the VSIX validates with `unzip -t` and rebuilds
byte-identically, `crc32` matches the standard `0xCBF43926` vector, `file(1)`
reads `icon.ico` back as a 7-icon resource, and the macOS bundle still carries an
executable `spawn-helper`.

The security-relevant tests were mutation-checked in both directions — removing
the Windows deny rule, dropping the `.exe` suffix and restoring case-sensitivity
each fail the test written for them, and widening the rule to any `del` fails the
must-not-deny cases.

**Nothing here has run on Windows.** The `windows-latest` probe job has still
never executed.

## Review, 2026-08-16 — two release blockers, both mine

Codex reviewed the branch as code rather than as a summary and found two defects
that unit coverage had not. Both are fixed in `e07cc54`; both were introduced by
the phases above, and neither would have been caught by anything short of
reading the call path.

**A command injection through `cmd.exe`.** Phase 1 routed every npm shim through
`cmd.exe /d /s /c`, and Phase 5 shipped it. Node quotes an argument only when it
contains a space or a quote — so `a&calc` was passed bare, `cmd` read the `&` as
a separator, and `calc` ran. Agent output reaches those arguments as file paths,
plugin names and project directories, so this was arbitrary execution on
Windows. I had flagged the cmd quoting as "unverified" in Phase 1's own comments
and then shipped four more phases on top of it, which is the wrong order.

The fix removes cmd from the path rather than escaping for it: reading an npm
shim already yields the interpreter and the script, so a readable shim now
resolves to `node <script>`. What remains is a shim we cannot read — VS Code's
hand-written `code.cmd` — where `spawnSpec` now **refuses** cmd-unsafe arguments.
A verbatim command line is the correct general fix and is not something to write
from documentation with no Windows machine to check against.

**`health()` spawned the path meant for the SDK.** Phase 1 split Claude's
resolution so the SDK got the `.js` behind the shim, and missed that the adapter
_also_ execs that value for its own version probe. Windows cannot execute a
`.js`, so every npm install of Claude would have reported unavailable before a
session started. The resolver now returns both answers, because there are two
consumers and they want different things.

**Also fixed:** the Windows verifier omitted `conpty_console_list.node`, which
`windowsPtyAgent` forks a child to load during cleanup — so it would have failed
when a terminal was _closed_, the least likely moment to connect to a packaging
fault.

### What this says about the phases above

The pattern in both blockers is the same: a value that answered two questions,
and only one consumer considered. The unit tests passed throughout because they
asserted the shape reaching the consumer I was thinking about.

**Still open, and unchanged by this round:** the signing certificate, clean-VM
installer testing, and a Windows packaging job in CI — none of which exist. The
named pipe still has no ACL; Node exposes no way to set a security descriptor on
a pipe it creates, so closing that properly means a third native dependency and
is a decision rather than a patch.
