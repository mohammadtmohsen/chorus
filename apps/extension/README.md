# Chorus for VS Code

The whole of Chorus in one VS Code tab: projects, chats with several agents at once, split and
forwarded chats, approvals, notes, terminals, Run and HTTP Traffic. VS Code provides the editor,
Git, the debugger, extensions, Remote-SSH and the browser.

It drives the `claude` and `codex` CLIs you already have installed and signed in. It does not
replace them, and it does not send your account through anyone's server.

## Install

Chorus is a private VSIX on GitHub Releases, not on the Marketplace, because its browser tools use a
VS Code API that is still marked as proposed.

1. Download the VSIX for your machine, then install it:

   ```bash
   code --install-extension chorus-<version>-darwin-arm64.vsix
   ```

2. Run **Chorus: Enable Browser Tools** once, then quit VS Code completely and open it again.
   Everything except the browser tools works without this step.

A VSIX does not update itself. To update, install the newer VSIX the same way.

## Start

1. Open VS Code at any folder. The root of your disk is fine.
2. Run **Chorus: Open**.
3. Add a project with the rail's add button, or right-click a folder in Explorer and choose
   **Add to Chorus as Project**. Opening a window never creates a project.

One window can hold any number of projects. Each project's agents run in that project's own folder,
whatever folder VS Code opened.

## How it fits into VS Code

| In Chorus                | In VS Code                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| The file you have open   | Your chats see it only if it is inside that chat's project. A file from another project never reaches them        |
| An agent's proposed edit | A native diff. Approved edits land in the live buffer, unsaved and undoable                                       |
| Waiting on you           | A notification with **Allow** and **Deny**, a badge on the Chorus icon, and the status bar                        |
| A project's Browser box  | The page opens in VS Code's browser tab. The Console stays in Chorus, and agents read that project's console only |
| Terminals and Run        | These stay inside the project in Chorus. VS Code's own terminal is still there for everything else                |
| Remote projects          | Open a Remote-SSH window. Agents run on this machine, in a local folder you pick. The editor is remote            |

While the Chorus tab has focus, its shortcuts work as they do in the desktop app. VS Code does not also
act on them.

Chats keep running if you reload the window or close it. The engine stops by itself five minutes after
the last window closes, once nothing is running and nothing is waiting on you.

## What differs from the desktop app

- There is no browser downloads panel, saved passwords or swipe navigation.
- There is no dock badge, and no banner over other apps when VS Code is not focused.
- Selecting text in VS Code's built-in Markdown preview does not reach your chats. Use
  **Chorus: Open Markdown Preview**, which does.
- Dragging a folder in from Finder has no path. Use the `+` menu. Files work.
- A plain VS Code terminal does not get a project's Traffic variable. A project terminal does.
- API keys stored by the desktop app are not readable here, so enter them again in Settings.
- If the same project's terminal is open in two windows, the newest window controls it.

## Opening at the disk root

Chorus stays off until you trust the window's folder, and VS Code keeps that trust for every window on
the machine. Trusting `/` therefore trusts every folder on the disk, so opening your home folder is the
safer choice. It gives Chorus the same projects, because projects do not depend on the window's folder.

VS Code watches the folder it opens, so a whole disk costs more than one project. On a test Mac it idled
at 2 to 5% CPU. A project's own `.vscode` settings, tasks and launch configurations apply only when the
project is a workspace folder, so add it to the window as one if you need them. Chorus does not depend
on what the window opened, so opening `~/code` instead changes nothing here.

## Privacy and safety

- Your history stays in a local SQLite log in this extension's storage. It starts empty and never touches
  the desktop app's data.
- The engine listens on a private per-user socket, and the webview never sees its token.
- Every command and edit goes through Chorus's permission profiles. Projects start read only, and a deny
  list covers actions that nothing can override.
- In an untrusted window, Chorus stays disabled.
