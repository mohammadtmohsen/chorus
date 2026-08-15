# Installing Chorus on Windows

Chorus drives the `claude` and `codex` CLIs you already have. It does not bundle
them, and it will not install them for you — so most of what follows is about
getting those two working first, because a Chorus that cannot find them looks
broken in a way that has nothing to do with Chorus.

> **Status: not yet released.** The Windows build exists in the repository and
> has not been produced, signed, or run on a Windows machine. Everything below
> describes the intended install; the sections marked **unverified** have never
> been executed by anyone. See `docs/plans/windows-installer-2026-08-15/STATUS.md`
> for what is actually done.

## What is supported

|               |                                                                 |
| ------------- | --------------------------------------------------------------- |
| Windows       | 10 and 11, 64-bit                                               |
| Architecture  | x64 only — ARM64 waits for native hardware to verify it on      |
| Install scope | Per-user by default; per-machine is offered on the install page |
| Shortcuts     | Start Menu. No desktop shortcut unless you ask for one          |
| Updates       | Download and run the new installer over the old one             |
| WSL           | Not supported. Agents run as native Windows processes           |

## Before you install

### Codex

```powershell
npm install -g @openai/codex
codex --version
```

### Claude Code

```powershell
npm install -g @anthropic-ai/claude-code
claude --version
```

**Claude Code on native Windows needs Git for Windows**, for the POSIX tools it
shells out to. Install it from <https://git-scm.com/download/win> before running
`claude` for the first time. Without it, `claude` starts and then fails partway
through a turn with an error that names a missing binary rather than the missing
dependency.

Authenticate both by running them once in a terminal and following the prompts.
Chorus inherits whatever credentials they store; it never asks for them itself
and has nowhere to put them.

### Both CLIs must be on PATH

`npm install -g` writes to `%APPDATA%\npm`, which npm adds to PATH at install
time. If you installed Node through a version manager, or PATH predates the npm
install, Chorus may not find them. It looks in `%APPDATA%\npm` explicitly for
this reason, but the reliable check is:

```powershell
where.exe codex
where.exe claude
```

If those print nothing, neither will Chorus.

## Installing

1. Download `Chorus-<version>-windows-x64-setup.exe` from the release page.
2. **Expect a SmartScreen warning.** Choose "More info" then "Run anyway". This
   is not a sign that anything is wrong — see below.
3. Choose per-user (default) or per-machine. Per-machine needs an administrator.
4. Launch from the Start Menu.

Chorus itself never needs administrator rights. It runs `asInvoker` and does
everything under your own profile.

### About the SmartScreen warning

A valid signature and a good reputation are different things. SmartScreen scores
by how many people have downloaded a given signed binary, so a newly issued
certificate has no reputation and every download is warned about — for weeks,
sometimes months, regardless of the signature being correct.

To check the signature yourself rather than trusting the dialog:

```powershell
Get-AuthenticodeSignature .\Chorus-<version>-windows-x64-setup.exe |
  Format-List Status, SignerCertificate
```

`Status` must be `Valid`, and the certificate's subject must match the publisher
named on the release page. Verify the checksum too:

```powershell
Get-FileHash .\Chorus-<version>-windows-x64-setup.exe -Algorithm SHA256
```

against the `.sha256` file published beside the installer.

## Where things go

|             |                                             |
| ----------- | ------------------------------------------- |
| Application | `%LOCALAPPDATA%\Programs\Chorus` (per-user) |
| Your data   | `%APPDATA%\Chorus`                          |
| Event log   | `%APPDATA%\Chorus\chorus.db`                |
| Logs        | `%APPDATA%\Chorus\logs`                     |

**The event log is every conversation you have had.** It is the source of truth
and it is append-only. Uninstalling deliberately leaves `%APPDATA%\Chorus`
alone — removing it is a decision an uninstaller should not make for you. To
remove your data, delete that folder by hand after uninstalling.

Upgrading installs over the previous version and does not touch it.

## VS Code integration

Optional. It gives Chorus your current file and selection as context.

Chorus ships the extension and installs it through the `code` CLI, so `code`
must be on PATH:

```powershell
where.exe code
```

If it prints nothing, open VS Code, run **Shell Command: Install 'code' command
in PATH** from the command palette, and restart Chorus. Chorus also looks in
VS Code's default install location, so this is a fallback rather than a
requirement.

## Troubleshooting

**"Could not find the codex CLI" / "the claude CLI"** — `where.exe` the one it
names. If the CLI is there but Chorus is not finding it, the likely cause is
that Chorus resolved an npm `.cmd` shim it could not read; the log in
`%APPDATA%\Chorus\logs` names the path it tried.

**A terminal will not open** — Chorus uses `%COMSPEC%`, falling back to
`cmd.exe`. Check that `%COMSPEC%` points at a file that exists:
`Test-Path $env:COMSPEC`.

**The VS Code pill says "not running"** — the editor bridge is a named pipe
(`\\.\pipe\chorus-ide-<pid>`) advertised through a descriptor in
`%TEMP%\chorus-ide`. Check that the folder exists and holds a `.json` per
running Chorus. If it does and the pill is still empty, the extension is not
installed or is a different protocol version — Settings shows both.

**An agent's own terminal behaves differently from Chorus's** — expected.
`Ctrl+J` opens a real shell that is yours; the agents run headless over stdio
and never see a terminal.

**A shortcut does nothing** — Chorus uses Ctrl on Windows where the macOS build
uses Command, so every shortcut documented with `⌘` is `Ctrl` here. `Ctrl+Shift+J`
opens the global terminal, `Ctrl+Shift+\`` a new one in the current panel.

## Known gaps on Windows

These are real and deliberate, not oversights:

- **The orphan-process backstop does not run.** On macOS Chorus reaps agent
  processes left by a crash. The Windows strategy has not been written, because
  the Unix one relies on `PPID 1` and `SIGKILL`, neither of which exists here.
  A crash may leave a `codex` or `claude` process behind; Task Manager will show
  it.
- **A terminal never reports as busy.** The kill confirmation cannot warn you
  that a build is running, because node-pty does not expose the foreground
  process on Windows. It asks before closing regardless.
- **The editor bridge relies on its handshake token alone.** On macOS the socket
  is also `0600`. Node offers no way to set a security descriptor on a named
  pipe, so on Windows the token in the descriptor file is the only guard.
- **Trusted mode is newer here.** The universal denies cover cmd and PowerShell
  recursive deletion, force-push and history rewriting. They have unit coverage
  and have not been exercised against a real Windows agent.
