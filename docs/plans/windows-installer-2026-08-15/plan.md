# A Windows installer for an app that works on Windows

**Date:** 2026-08-15

**Status:** in progress — see `STATUS.md`, which also records where the code
contradicted this plan and what was corrected.

**Delivery branch:** `feat/windows-installer`, branched in place from `main`
rather than in a separate worktree. Rule 1 of the parallel-work contract below
was relaxed deliberately; the ownership and rebase rules in 2–6 still hold, and
matter more for it.

---

## The outcome

Chorus ships a signed x64 Windows installer that a standard user can download,
install, launch from the Start Menu, upgrade, and uninstall. The installed app
can discover and run the user's Codex and Claude CLIs, open real terminals,
connect to the companion VS Code extension, enforce its permission policy, and
preserve its SQLite data across an upgrade.

The installer is not the first deliverable. It is the last wrapper around a
Windows-capable application. Adding `win: { target: nsis }` before the runtime
work would create an artifact that looks finished and installs an app whose
agent, terminal, and editor paths are not yet reliable.

## First-release decisions

These are the working defaults. Changing one is a product decision, not an
implementation detail.

- **Operating systems:** Windows 10 and Windows 11, 64-bit.
- **Architecture:** x64 only. ARM64 waits for native hardware verification of
  Chorus, both agent CLIs, node-pty, better-sqlite3, and the VS Code extension.
- **Installer:** electron-builder NSIS, assisted rather than one-click.
- **Install scope:** per-user by default, with the install-mode page allowing a
  per-machine choice.
- **Shortcuts:** Start Menu yes; desktop no by default.
- **Uninstall:** remove application files and shortcuts; preserve user data.
- **Privilege:** the app runs `asInvoker`; ordinary app use never requires
  administrator privileges.
- **Distribution:** a signed installer attached to the GitHub release, with a
  SHA-256 checksum.
- **Updates:** full signed installer upgrades in the first release. An automatic
  updater is a separate feature.
- **Agent mode:** native Windows processes. WSL integration is not part of this
  release. Claude's native Windows prerequisite, Git for Windows, is documented.

Keep `appId: dev.chorus.desktop`, `productName: Chorus`, and the publisher
identity stable. Windows uses those identities for installed-app and upgrade
continuity; they are not cosmetic release strings.

## Current gaps

The line that prompted this plan, `apps/desktop/src/main/ipc.ts:162`, begins the
`terminal:ack` handler and is not itself Windows-specific. The platform gaps are
distributed across the boundaries behind IPC:

| Boundary          | Current assumption                                                                                       | Consequence on Windows                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| CLI discovery     | `which.ts` asks zsh, searches Unix directories, splits PATH on `:`, and returns one executable path      | npm `.cmd` shims for Codex, Claude, and VS Code are not found or cannot be launched correctly |
| Shell and PTY     | the shell resolver checks POSIX execute bits; terminal process-name comparisons assume Unix-shaped names | `COMSPEC` can be selected only by fallback luck, and busy/idle detection can be wrong         |
| Process cleanup   | `reap.ts` uses `pgrep`, `ps`, PPID 1, and `SIGKILL`                                                      | the orphan backstop silently does nothing                                                     |
| IDE bridge        | Unix socket files, `chmod(0600)`, and POSIX mode checks                                                  | the extension cannot discover or trust a Windows bridge                                       |
| Path security     | several checks require `/`-rooted paths or concatenate `/`                                               | drive letters, case-insensitive paths, and UNC roots fail or are compared unsafely            |
| Renderer          | primary shortcuts check `metaKey`; labels always show `⌘`; the frame uses `hiddenInset`                  | normal Ctrl shortcuts fail and the window chrome looks macOS-specific                         |
| Permission policy | destructive and safe-read command patterns describe Unix shells                                          | Trusted mode does not recognize native Windows destructive commands                           |
| Build             | macOS-only builder target and icon; package scripts call Unix `env`, `rm`, and `zip`                     | a clean Windows runner cannot execute the release pipeline                                    |
| Verification      | the packaged verifier names `mac-arm64/Chorus.app` and checks Unix helper modes                          | a produced Windows artifact has no meaningful release gate                                    |

The native dependencies currently include Windows x64 prebuilds. That lowers
the packaging risk, but it does not prove that the packaged paths load under
Electron. `npmRebuild: false` remains deliberate; the Windows verifier must fail
loudly if a required prebuild is absent rather than silently compiling a
different binary.

## Parallel-work contract

Windows work may proceed while another feature is being implemented, with these
rules:

1. **Separate worktree and branch.** Never run two agents in the same working
   directory. Create the Windows worktree with:

   ```bash
   git worktree add ../chorus-windows -b feat/windows-installer
   ```

2. **Small phase commits.** Command launching, bridge portability, UI
   portability, packaging, and verification remain separate commits. A conflict
   can then be resolved without replaying the whole Windows project.
3. **File ownership before edits.** The Windows agent announces before changing
   `ipc.ts`, `runtime.ts`, `index.ts`, `App.tsx`, `Workspace.tsx`, root
   `package.json`, or `ci.yml`. If the feature agent owns one, the Windows phase
   waits or lands a prerequisite abstraction in a separate commit agreed by
   both agents.
4. **Do not duplicate an integration point.** If the other feature is changing
   terminal identity, session lifecycle, or renderer platform state, Windows
   support extends that final design after it lands; it does not build a second
   temporary route beside it.
5. **Integration checkpoints.** Rebase onto `main` after the command-launch
   contract lands, after renderer/runtime portability lands, and immediately
   before the signed package candidate. Resolve conflicts semantically and run
   the whole gate after every checkpoint.
6. **The final candidate comes from merged code.** A green installer from an
   earlier branch revision is invalidated when the parallel feature changes any
   packaged source. Rebuild, re-sign, and re-run installer verification.

Low-conflict work can begin immediately: Windows research probes, new unit-test
fixtures, ICO generation, the Windows packaged verifier, documentation, and a
builder configuration overlay. The highest-conflict files are left until their
owner is known.

## Phase 0 — observe Windows before designing around it

**First, a prerequisite that has nothing to do with Windows code.** There is no
`.gitattributes`, `.prettierrc` pins `endOfLine: "lf"`, and `pnpm check` runs
`prettier --check`. GitHub's `windows-latest` runners ship Git for Windows with
`core.autocrlf=true`, so the checkout converts every file to CRLF and the format
step fails on all 848 TypeScript files before a single line of Windows code
exists. Commit `* text=auto eol=lf` first, or the probe job below is red for a
reason that teaches nothing.

**Second, start the certificate now, not in Phase 6.** Since the CA/Browser
Forum's 2023 change an OV signing key must live on an HSM or hardware token, and
issuance needs organization validation — days to weeks of calendar time that no
amount of engineering compresses. Phase 6 reads as though the certificate is on
hand when you arrive at it. Choose the legal publisher identity and begin
procurement during Phase 0, in parallel with everything else here.

Add a `windows-latest` check job that installs the pinned Node and pnpm versions
and runs typecheck, lint, format, and unit tests. This is an early portability
probe, not yet the release job.

On a clean Windows VM, record rather than infer:

- the installed forms and locations of `codex`, `claude`, and `code`;
- whether each is a native executable, a `.cmd` shim, or a script;
- the exact environment inherited by an installed Electron app;
- the actual approval payloads emitted by both agent adapters for cmd,
  PowerShell, and Git Bash commands;
- the value node-pty reports for `child.process` under ConPTY;
- child-process behavior when Chorus exits normally and when it crashes;
- Windows user-data, temp, and VS Code-extension discovery locations.

**Exit criterion:** the observations are committed as test fixtures or concise
notes, and every later platform choice cites one of them. No command-policy
regex or process-reaping strategy is written from memory.

## Phase 1 — one platform-aware launch contract

Replace the `findExecutable(name): Promise<string | null>` boundary — it is
already async, and already caches per name — with a resolved command that
includes the executable and any required argument prefix:

```ts
interface ResolvedCommand {
  readonly file: string
  readonly argsPrefix: readonly string[]
  readonly kind: 'native' | 'cmd-shim' | 'node-script'
}
```

The resolver:

- uses `path.delimiter`, `PATHEXT`, and Windows npm locations;
- considers `.exe`, `.com`, `.cmd`, and `.bat` without losing the existing
  newest-version selection;
- launches `.cmd` files through one explicitly tested `cmd.exe` adapter rather
  than enabling `shell: true` globally;
- preserves arguments containing spaces, quotes, Unicode, `&`, `|`, and
  parentheses;
- resolves the VS Code `code.cmd` launcher through the same contract;
- leaves the existing macOS login-shell discovery behavior intact.

Migrate agent probes, the Codex transport, Claude startup, plugin commands, and
VSIX installation together. A partially migrated resolver would make the
Settings probe green while a real session or extension install still fails.

**Tests:** table-driven PATH/PATHEXT discovery, version selection, cmd quoting,
missing launchers, space-bearing paths, and unchanged Darwin behavior.

**Exit criterion:** both agents can be probed and started from an installed app
launched outside a terminal, and a VSIX can be installed through `code.cmd`.

## Phase 2 — shell, PTY, and process lifecycle

**`shell.ts` is already most of the way there, and the remaining defect is one
line.** It already prefers `COMSPEC` on win32, already omits the `-l` login flag
on win32, and already falls back to `cmd.exe` — so three of the five things this
phase originally listed are no-ops. What is actually broken is `isExecutableFile`,
which gates on `stat.mode & 0o111`. libuv never sets execute bits on Windows, so
_every_ candidate fails validation, the loop over `fallbacks()` finds nothing,
and `resolveShell` always reaches its "nothing validated" return. That return
hands back `COMSPEC` anyway, which is why a Windows terminal opens at all — the
right shell arrives through the path meant for a broken machine, and any future
edit to that fallback silently changes behaviour on Windows only.

So: make `isExecutableFile` answer the platform's own question — existence and
file-ness on win32, the mode check on Unix — and let the normal branch select
`COMSPEC` on its merits. Then:

- keep cmd as the initial default rather than silently promoting the user to
  PowerShell;
- normalize node-pty process names before busy/idle comparison;
- keep terminal references, epochs, acknowledgement flow control, and the
  headless mirror unchanged.

Drive ConPTY through startup, resize, Unicode output/input, Ctrl+C, exit codes,
kill, detach/reattach, hidden output, several terminals, paths containing
spaces, and drive-root working directories.

Measure process cleanup before changing `reap.ts`. If normal pipe closure and
the existing supervisor reliably terminate agent trees, disable the Unix reaper
on Windows and document that result. If an orphan survives, implement a
Windows-specific strategy whose target is proven to belong to Chorus; do not
port the `pgrep` pattern scan by guessing.

**Exit criterion:** no agent or PTY process remains after normal quit, and the
tested crash case has either a safe recovery strategy or a recorded, explicitly
accepted limitation.

## Phase 3 — named-pipe IDE bridge and Windows-safe paths

On Windows, bind the bridge to a user-scoped named pipe. Keep the random token
handshake and per-process descriptor, but store the descriptor in a private
per-user location and replace POSIX mode checks with a Windows ownership/ACL
decision.

Convert containment and identity code to path-segment operations:

- drive-letter roots and mixed drive-letter case;
- `\\server\share` UNC roots;
- sibling-prefix rejection;
- `..` rejection where the protocol requires a repository-relative path;
- symlink/canonical-root enforcement in Electron main;
- a clear distinction between host paths and Git-relative `/` paths.

Use `path.win32` fixtures so the security cases run on every CI host, then drive
the real named-pipe connection on Windows.

**Exit criterion:** the packaged VSIX connects to installed Chorus, editor
selection reaches the correct conversation, and tests prove that drive, UNC,
sibling, and escape cases do not cross roots.

## Phase 4 — renderer behavior and permission policy

Retain `app:getInfo.platform` in renderer state. Introduce one primary-modifier
helper: Command on macOS, Ctrl on Windows. Use it for workspace and terminal
shortcuts and render platform-correct shortcut labels from translated pieces.

Conditionally apply the macOS `hiddenInset` title bar and traffic-light spacing.
The first Windows release uses the native frame; a custom Windows frame is not
hidden inside this release because it would also require accessible minimize,
maximize, restore, and close controls.

Normalize real Windows agent approval payloads before permission evaluation.
Cover native equivalents of recursive deletion and history rewriting,
Windows-shaped credential paths, quoting, redirection, and command composition.
Trusted mode remains unavailable on Windows until those cases pass.

**Exit criterion:** documented Windows shortcuts work, the window has usable
native controls at 100–200% display scaling, and every recorded destructive
payload is denied or asks according to the existing profile contract.

## Phase 5 — portable build and unsigned package verification

Remove host-shell assumptions from package scripts and replace the VSIX
packager's external `zip` call with a portable, reproducible ZIP implementation.
Extend icon generation to produce a multi-resolution `icon.ico` from the same
source as the macOS icon.

Add an electron-builder Windows section equivalent to:

```yaml
win:
  target:
    - target: nsis
      arch: [x64]
  icon: build/icon.ico
  requestedExecutionLevel: asInvoker
  signExts:
    - .dll
    - .node

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: false
  createStartMenuShortcut: true
  deleteAppDataOnUninstall: false
  artifactName: Chorus-${version}-windows-${arch}-setup.${ext}
```

Create `verify:package:windows` rather than teaching the macOS verifier to
pretend both bundle layouts are the same. It locates `win-unpacked/Chorus.exe`,
checks every required native file and the VSIX, launches with isolated user
data, opens SQLite, starts a PTY, probes both agents, and quits cleanly.

**Exit criterion:** an unsigned local `win-unpacked` build and NSIS installer
pass the runtime verifier on Windows. This proves packaging layout, not release
trust.

## Phase 6 — signing and installer lifecycle

Choose and validate the legal publisher identity before requesting a production
certificate or Artifact Signing profile. Configure signing only in a protected
release job; pull-request code never receives credentials.

Sign and timestamp:

- the NSIS installer and generated uninstaller;
- `Chorus.exe` and Electron executables;
- node-pty executables and DLLs;
- better-sqlite3 and node-pty `.node` binaries;
- every other shipped PE file discovered recursively.

Production configuration sets `forceCodeSigning: true`. Recursively run
SignTool verification and fail on any unsigned, invalid, or unexpectedly signed
binary. Test the downloaded artifact rather than only the build-directory copy,
so Mark-of-the-Web, SmartScreen, and Smart App Control are part of the evidence.

Drive the installer lifecycle on clean VMs:

1. install as a standard user;
2. launch from the Start Menu;
3. install an upgrade over a seeded previous version;
4. prove SQLite conversations, settings, and open-session state survive;
5. uninstall with the app closed and handle the app-running case cleanly;
6. prove binaries and shortcuts are removed while user data remains;
7. reinstall and launch again.

**Exit criterion:** every shipped PE verifies, the signed downloaded installer
passes the lifecycle, and its displayed publisher matches the documented name.

## Phase 7 — release contract and documentation

Update `CLAUDE.md` so "release" describes a platform matrix rather than only a
DMG. Keep the existing distinction between `verify:package` and the longer e2e
suite: neither platform may claim UI coverage that was not run.

Add `docs/install-windows.md` covering:

- supported Windows versions and x64 scope;
- Codex and Claude installation/authentication prerequisites;
- Git for Windows for native Claude Code;
- optional VS Code integration and `code` PATH troubleshooting;
- install, upgrade, uninstall, data, and log locations;
- publisher name, signature inspection, checksum verification, and expected
  SmartScreen behavior;
- terminal, agent discovery, and named-pipe troubleshooting.

The release job uploads the installer and checksum, then verifies the tag,
asset name, size, version, and checksum through the GitHub API.

**Exit criterion:** another person can follow the release contract from a clean
tag without local knowledge and obtain the same signed artifact and verification
results.

## Final release gate

All items are required unless the release notes explicitly declare the Windows
release a preview and name the missing item:

- `pnpm check` green on macOS and Windows.
- Windows build and `verify:package:windows` green.
- Codex and Claude probe, start, stream, cancel, and shut down from the installed
  app.
- Terminal startup, resize, Unicode, Ctrl+C, detach/reattach, several terminals,
  and cleanup verified under ConPTY.
- VSIX install and named-pipe connection verified for drive-letter and UNC
  workspaces.
- Permission tests use captured Windows payloads and Trusted mode has no known
  native-shell bypass.
- Standard-user install, upgrade, uninstall, and reinstall pass on clean VMs.
- Upgrade preserves SQLite data and workspace state; uninstall preserves user
  data intentionally.
- SignTool verifies the installer and every shipped PE file.
- The browser-downloaded installer is exercised with SmartScreen/Smart App
  Control enabled or in audit mode.
- SHA-256 checksum and GitHub release asset metadata match.
- The release report states whether the separate e2e suite ran; packaged
  verification is never described as proving the whole UI.

## Files expected to change

This list identifies collision risk; it is not permission to edit all files in
one phase.

- `apps/desktop/src/main/{which,shell,terminal,reap,ide-bridge,index}.ts`
- agent probe, Codex/Claude launch, plugin, and IDE-extension installer call sites
- `apps/vscode-extension/src/{discovery,connection,editor-context,document-identity}.ts`
- `packages/workspace/src/path-safety.ts`
- `packages/orchestrator/src/policy/{rules,engine}.ts` and tests
- renderer workspace/terminal shortcuts, platform state, translations, and CSS
- `apps/vscode-extension/package.mjs`
- `apps/desktop/build/make-icon.mjs` and new Windows icon assets
- `apps/desktop/electron-builder.yml` or a Windows release overlay
- desktop/root package scripts
- `.github/workflows/ci.yml` and a protected release workflow
- Windows packaged and installer verification scripts
- `CLAUDE.md`, `CHANGELOG.md` at release time, and `docs/install-windows.md`

## Deliberate non-goals

- Windows ARM64 and ia32 artifacts.
- WSL-owned agent processes or a WSL filesystem bridge.
- Microsoft Store/MSIX distribution.
- Automatic updates and delta packages.
- A custom frameless Windows title bar.
- Bundling either agent CLI into Chorus.
- Replacing NSIS with MSI or Squirrel without a deployment requirement that
  needs it.

## References

- [electron-builder Windows configuration](https://www.electron.build/docs/win/)
- [electron-builder NSIS options](https://www.electron.build/nsis/)
- [electron-builder Windows code signing](https://www.electron.build/docs/features/code-signing/code-signing-win/)
- [Node child-process behavior](https://nodejs.org/api/child_process.html)
- [Node IPC and Windows named pipes](https://nodejs.org/api/net.html)
- [Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
- [Microsoft SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Claude Code Windows setup](https://docs.anthropic.com/en/docs/claude-code/getting-started)
