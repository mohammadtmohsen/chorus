# Chorus

Chorus is a local-first workspace where a developer can collaborate with multiple coding agents in one shared conversation.

## Install

Apple Silicon Mac, macOS 12 or later, with the `claude` and `codex` CLIs installed and logged in. Chorus is not notarized yet, so macOS blocks the downloaded build on first launch — [Installing Chorus on macOS](docs/install-macos.md) covers first install, updates, and every dialog you might hit, including the one that means something is actually wrong.

Building it yourself avoids the warnings entirely, since they apply to downloads:

```bash
pnpm install
pnpm app:install
```

## VS Code

Chorus can follow the file and lines you have selected in VS Code, so a question can carry
an exact reference instead of a description. Open **Settings → Install VS Code Extension**
once, then open the same project folder in VS Code — the ⧉ button beside a conversation's
path does that for you.

While you work the extension sends metadata only: the file, the line range, and whether
the buffer is unsaved. Source code crosses once, when you press Send, and only for the
selection named in the composer. Nothing is reported for a folder Chorus does not have
open, so a file from another project never leaves the editor — not even as a path.

## Vision

Coding agents are most useful when they can specialize, exchange findings, and remain under clear human control. Chorus provides one place to ask an agent for analysis, hand the result to another agent for implementation, and send the finished work back for review.

## Core workflow

1. Ask Codex to inspect a project and recommend an approach without editing files.
2. Review and discuss the recommendation in the shared conversation.
3. Hand the approved recommendation to Claude for implementation.
4. Approve commands and file changes through structured confirmation cards.
5. Ask Codex to review Claude's changes and report actionable findings.

## Product principles

- **Human controlled:** consequential commands and edits require visible approval.
- **Local first:** projects, transcripts, and agent processes stay on the developer's Mac by default.
- **Explicit context sharing:** agents keep separate contexts, while Chorus forwards selected messages and handoffs.
- **Reliable integrations:** use supported programmatic interfaces instead of parsing terminal graphics.
- **Agent independent:** adapters keep the shared conversation separate from any single model provider.

## Proposed architecture

- **Desktop client:** Electron, React, and TypeScript.
- **Local orchestrator:** routes messages, approvals, tasks, and agent events.
- **Codex adapter:** communicates with `codex app-server` over standard input/output.
- **Claude adapter:** uses Claude's streaming CLI for the private local version, with the Agent SDK available for distributed products.
- **Event store:** SQLite stores conversations, handoffs, approvals, and project metadata.
- **Workspace service:** manages project directories, Git status, diffs, and optional worktree isolation.

## MVP

- Shared conversation for the developer, Claude, and Codex.
- `@claude` and `@codex` mentions.
- Direct handoff buttons between agents.
- Streaming responses and agent status indicators.
- Approval cards for commands and file changes.
- Per-project working directories and permission profiles.
- Git diff and review view.
- A slash menu, `@` mentions for agents and files, and drafts that survive a quit.
- Plan mode: read and reason, change nothing until the plan is approved.
- What the agents are doing — hooks, tool calls, subagents, background tasks,
  and how full each context window is.
- What this machine gives them — MCP server health, plugins, and which account
  each agent is signed in as.

## Status

Working software, used daily on real projects. `0.7.0` runs both CLIs headless,
holds several conversations at once, and keeps an append-only log that a
transcript is rebuilt from. See the [changelog](CHANGELOG.md) for what each
version added, and [the board](BOARD.md) for what is open, what is parked, and
what needs a person.

Not a Claude Code replacement in full, and deliberately so: most of that tool's
commands exist only inside its terminal UI and have no API. What is reachable
through the SDK is reached, and each thing that is not has a written reason in
`docs/plans/`.
