# Testing Chorus on Windows — the first time anyone has

Nobody has run this application on Windows. The test suite passes there and CI
builds an installer that launches far enough to serve its renderer — which says
the code is portable and the packaging is sound, not that the app works. You are
the first person to find out.

Nothing below has been tested by installing: not the install itself, not an
agent starting, not a terminal. That is the whole point of asking you.

This is a brief for that, not an install guide — `docs/install-windows.md` is
the install guide, and it covers the dialogs, the file locations and the
troubleshooting in more detail than you probably need on a first run.

**Machine:** Windows 10 or 11, x64. Everything here is on `main`.

---

## The one thing worth doing first

Before installing Chorus, before building anything:

```powershell
where.exe claude
where.exe codex
```

Then open the `.cmd` file each one names and **send back its contents**:

```powershell
Get-Content (where.exe claude | Select-Object -First 1)
```

That file is the single largest open question on this branch. Chorus reads npm's
shim to find the JavaScript behind it, and the parser was written from cmd-shim's
_documented_ output rather than from a shim off a real install. If the format
does not match, Claude reports as not installed and nothing else works. Ten
seconds of your time answers it whether or not the rest of the test goes well.

## Setup

```powershell
# Chorus drives these; it does not bundle them
npm install -g @openai/codex @anthropic-ai/claude-code
# Git for Windows — Claude Code shells out to POSIX tools and fails without it
winget install Git.Git

# Authenticate both once, in a terminal, before Chorus sees them
codex
claude
```

## Get Chorus

**Download the installer** from the
[releases page](https://github.com/mohammadtmohsen/chorus/releases) —
`Chorus-<version>-windows-x64-setup.exe`, with a `.sha256` beside it. CI builds
it on `windows-latest` and a verifier confirms the app launches from that exact
bundle, so it is a real artifact rather than a hopeful one.

**SmartScreen will block it.** Choose **More info → Run anyway**. The installer
is unsigned; that is expected and is not a finding.

Building from source works too, if you would rather:

```powershell
git clone https://github.com/mohammadtmohsen/chorus.git
cd chorus
pnpm install     # proven on Windows — CI does exactly this
pnpm dev         # fastest path to a window, and skips the installer entirely
```

`pnpm dev` is worth knowing about for a second reason: if the _installed_ app
misbehaves, running from source separates "the installer did something wrong"
from "the app does something wrong", and those need different fixes.

## What to test, hardest question first

Each of these is unverified. They are ordered by how likely they are to be
broken and how much depends on them.

**1. Do the agents start?** Open a session, pick Claude, send "hello". Then the
same for Codex. This exercises the whole command-resolution path — the shim
parser, the `node <script>` launch, the SDK handoff. If Settings says an agent is
not installed while `where.exe` finds it, that is the shim parser and it is the
headline result.

**2. Does a terminal open?** `Ctrl+J` in a session, and the activity bar for the
global one. Type `dir`, run something long like `pnpm check`, press `Ctrl+C`,
resize the window, switch tabs and come back. This is ConPTY plus `winpty.dll`
plus a forked helper process, none of which has ever been loaded.

**3. Do the shortcuts work?** They are Ctrl on Windows where macOS uses Command.
`Ctrl+J`, `Ctrl+W`, `Ctrl+1`–`4`, `Ctrl+\`, `Ctrl+Shift+[` / `]`. And
`Ctrl+Shift+` `` ` `` for a new terminal, which is Ctrl on both platforms.
Check that `Ctrl+C` inside a terminal still interrupts rather than being eaten.

**4. Does the window look right?** There should be **one** title bar, the
native one. If you see the OS title bar plus a second row plus a wide empty gap
on the left, the macOS frame guard failed. Try it at 100%, 150% and 200% display
scaling.

**5. Does VS Code integration connect?** Install the extension from Settings,
open the same project in VS Code, select some code. The pill in Chorus should
name the file. This is a named pipe that has never been dialled.

**6. Does your data survive?** Have a conversation, quit, reopen. The transcript
lives in `%APPDATA%\Chorus\chorus.db` and is the source of truth — if it does not
come back, stop and say so.

**7. Does an upgrade keep it?** Only if a second version is available: install
over the top and check the same conversation is still there. Uninstall
deliberately leaves `%APPDATA%\Chorus` alone, so a wipe would be a real bug.

## Known-degraded, so please do not report these

- **A terminal never says it is busy.** The kill dialog cannot warn that a build
  is running. node-pty does not expose the foreground process on Windows.
- **Crashed agents may be left behind.** The orphan reaper does not run here;
  Task Manager will show a stray `claude` or `codex` after a crash.
- **"Open in VS Code" refuses paths containing `&`, `%`, `!`, `(` or `|`** with
  an explicit error. That is a security fix failing closed, not a bug — but do
  tell me if your normal project path hits it, because then the trade is wrong.
- **SmartScreen blocks the installer.** There is no signing certificate yet.

## What to send back

Useful, in rough order:

1. The contents of `claude.cmd` and `codex.cmd`, whatever else happens.
2. For anything broken: what you did, what happened, and
   `%APPDATA%\Chorus\logs` — the log names the paths Chorus tried, which is
   usually the whole answer for a discovery failure.
3. A screenshot of the window, for the title-bar question.
4. Anything that felt wrong but is not on this list. The list is what I know to
   doubt; it is not the set of things that can be wrong.

Negative results are the point. "The terminal never opened and here is the log"
is a better outcome than a cautious "seems fine" — this has never run, and the
first honest failure is worth more than a pass.
