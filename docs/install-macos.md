# Installing Chorus on macOS

Chorus is not yet signed with an Apple Developer ID, so macOS will stop you the
first time you open it. That is expected, it is not a sign anything is wrong,
and this page tells you exactly what to click.

If you would rather not click past a security warning at all — a reasonable
position — [build it from source](#option-b-build-it-yourself) instead. That
path produces no warnings, because the warning is about downloads.

## Before you start

- **An Apple Silicon Mac** (M1 or newer). There is no Intel build.
- **macOS 12 Monterey or later.**
- **The `claude` and `codex` command-line tools, installed and logged in.**
  Chorus drives the ones already on your machine rather than shipping its own,
  so if `claude` and `codex` work in your terminal, Chorus will find them.

## Option A: install the download

### 1. Install

1. Download `Chorus-<version>-arm64.dmg`.
2. Open the `.dmg` and drag **Chorus** into **Applications**.
3. Eject the disk image.

### 2. Open it the first time

Double-click Chorus. macOS will show this:

> **"Chorus.app" Not Opened**
> Apple could not verify "Chorus.app" is free of malware that may harm your Mac
> or compromise your privacy.
> **[ Move to Trash ] [ Done ]**

Click **Done**. Do not click Move to Trash. Then:

**On macOS 15 Sequoia or later**

1. Open **System Settings → Privacy & Security**.
2. Scroll down to the Security section. You will see
   _""Chorus" was blocked to protect your Mac."_
3. Click **Open Anyway** and confirm with Touch ID or your password.

**On macOS 12 to 14**

Right-click (or Control-click) Chorus in Applications and choose **Open**, then
**Open** again in the dialog. The same option is in System Settings → Privacy &
Security if you prefer.

Either way, Chorus opens, and that version keeps opening normally from then on.

### 3. Approve the prompts on first run

Two more dialogs are normal on first launch, and both are Chorus asking for
things it genuinely needs:

- **Keychain access** — Chorus reads the credentials `claude` and `codex`
  already stored when you logged into them. Without this, agents report that you
  are not logged in.
- **Files and folders** — Chorus reads the project directories you point it at.
  Grant access to the folders your projects live in.

## Updating

1. **Quit Chorus** before replacing it. Replacing a running app leaves it
   reading files that are no longer there.
2. Download the new `.dmg`, open it, and drag Chorus into Applications,
   choosing **Replace** when asked.
3. **Expect the security dialog again.** Each download is marked separately by
   your browser, so approving version 0.2.0 does not carry over to 0.3.0. Repeat
   the [Open Anyway](#2-open-it-the-first-time) steps.

Your conversations, settings, and projects live outside the app bundle and are
not touched by an update.

## Option B: build it yourself

No security dialogs on this path, ever — macOS only applies the quarantine flag
to files that arrive over the network, and a locally built app never has one.
You need [Node.js](https://nodejs.org) 22.13 or later and
[pnpm](https://pnpm.io).

```bash
git clone <repository-url> chorus
cd chorus
pnpm install
pnpm app:install
```

That builds Chorus and installs it into `/Applications`. Run it again any time
to update. It quits a running copy for you, refuses to overwrite anything that
is not Chorus, and verifies the result.

## When you see a dialog

| What you see                                                         | What it means                                                                                                        | What to do                                                                                                      |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **"Apple could not verify… is free of malware"**                     | Normal. Chorus is not notarized yet. Apple is saying it has not checked this app, not that it found something wrong. | Click **Done**, then [Open Anyway](#2-open-it-the-first-time).                                                  |
| **""Chorus.app" is damaged and can't be opened"**                    | Not normal. The download did not finish, or it is a build from before 0.1.1.                                         | Delete it and download again. If it repeats on a fresh download, report it.                                     |
| **""Chorus" is an app downloaded from the Internet. Are you sure?"** | Routine macOS confirmation.                                                                                          | Click **Open**.                                                                                                 |
| **""Chorus" wants to use your confidential information"**            | The Keychain prompt. Chorus is reading the logins `claude` and `codex` already saved.                                | Click **Always Allow**. Denying it makes agents report you are not logged in.                                   |
| **Chorus wants access to Documents / Desktop / a folder**            | Chorus needs to read the project you opened.                                                                         | Click **Allow** for folders holding your projects.                                                              |
| **No dialog, but an agent says it is not installed**                 | Chorus could not find `claude` or `codex`. Apps launched from Finder get a smaller `PATH` than your terminal does.   | Confirm both run in Terminal. If they do and Chorus still cannot see them, report it — Chorus should find them. |

### Doing it from the terminal instead

If you prefer one command to the System Settings walk, this does the same thing
— it removes the "downloaded from the internet" mark:

```bash
xattr -dr com.apple.quarantine /Applications/Chorus.app
```

Worth understanding what you are doing: that mark is what makes macOS check an
app before its first run, and removing it skips the check. It is a reasonable
thing to run on software you chose to install from a source you trust. It is not
a reasonable habit to apply to every download.

## Why the warning exists

Signing Chorus so this warning never appears requires a paid Apple Developer ID
and Apple's notarization service, which is planned but not yet done. Until then
Chorus is ad-hoc signed: enough that macOS can confirm the app has not been
tampered with since it was built, not enough for Apple to vouch for who built
it. The warning you see is the honest description of that gap.

## The VS Code extension

Chorus ships a small companion extension that tells it which file and lines you have
selected. It is installed on request, never automatically.

1. In Chorus, open **Settings**.
2. Under **VS Code extension**, press **Install VS Code Extension**.
3. Reload the VS Code window (`Cmd+Shift+P` → "Developer: Reload Window").

The status bar in VS Code then reads `Chorus: linked` while Chorus is running, and
`Chorus: not running` otherwise.

**If the button is missing**, the `code` command is not on your `PATH`. In VS Code, run
`Cmd+Shift+P` → **Shell Command: Install 'code' command in PATH**, then reopen Chorus
Settings.

Each Chorus release ships the matching extension, so **update it when you update Chorus** —
the button says _Update VS Code Extension_ when the two have drifted apart. They speak a
versioned protocol and refuse to talk across a mismatch rather than misbehave.

To remove it: `code --uninstall-extension chorus.chorus-vscode`.

## Uninstalling

```bash
rm -rf /Applications/Chorus.app
rm -rf ~/Library/Application\ Support/@chorus
```

The second line deletes your conversations, settings, and project list. Leave it
out to keep them for a future install. Chorus never touches the projects
themselves, and removing it does not affect `claude` or `codex`.
