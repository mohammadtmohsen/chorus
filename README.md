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

## Why

Coding agents are most useful when they can specialize, exchange findings, and
stay under clear human control. Today that means several terminals, copying an
answer out of one and pasting it into another, and losing the thread of who said
what. Chorus is one place to ask an agent for analysis, hand the result to
another agent to implement, and send the finished work back for review — with
the whole exchange in a single transcript you can read afterwards.

It **drives** the `claude` and `codex` CLIs you already have installed and signed
in. It does not reimplement them and it does not proxy your account through
anyone's server.

## A typical session

1. Ask Codex to inspect the project and recommend an approach, changing nothing.
2. Read the recommendation and argue with it, in the shared conversation.
3. Hand it to Claude to implement.
4. Approve each command and file change on a card that shows what will happen.
5. Ask Codex to review what Claude did and report what it finds.

Both agents see the same conversation. Neither sees the other's context window.

## What it does

- **One conversation, several agents.** `@claude` and `@codex` to address
  someone; handoff buttons to move a reply from one to the other.
- **Approval cards** for commands and edits, with per-project permission
  profiles and a deny list that nothing can override.
- **Plan mode** — read and reason, change nothing, until the plan is approved.
- **A real diff view.** Every edit an agent makes, per turn and per agent, plus
  the cumulative working-tree diff.
- **Several conversations at once**, in a splittable pane layout, with agents
  still running in the ones you are not looking at.
- **A real shell** — `⌘J` per session, or a global one. Chorus retires the
  terminal as an _agent interface_, not as a tool.
- **What the agents are doing** — hooks, tool calls, subagents, background tasks,
  how full each context window is, MCP server health, plugins, and which account
  each agent is signed in as.
- **VS Code selection**, so a question can carry an exact reference instead of a
  description.

Everything an agent streams is written to an append-only SQLite log as it
arrives, because Codex discards partial output when a turn is interrupted — a
transcript cannot be rebuilt from the providers, so it is made durable here.

## How it is put together

- **Desktop client** — Electron, React, TypeScript, hand-written CSS.
- **Orchestrator** — routes messages, approvals and agent events; owns the
  permission engine and catch-up.
- **Two adapters** — `codex app-server` over JSON-RPC on stdio, and the Claude
  Agent SDK. Both project onto one normalized `AgentEvent` union, and nothing
  provider-specific leaks past an adapter.
- **Event store** — SQLite. An append and every projection it updates land in
  one transaction, so a projection can never be ahead of the log.

## Status

Working software, used daily on real projects — `0.15.0` is the current release.
See the [changelog](CHANGELOG.md) for what each version added, and
[the board](BOARD.md) for what is open, what is parked, and what needs a person
rather than a commit.

Two honest caveats. **macOS is the tested platform** — Apple Silicon, macOS 12 or
later. A Windows installer exists and the test suite passes on Windows in CI, but
installing, upgrading and uninstalling on a real Windows machine has not been
verified. **Neither installer is signed the way its platform wants**, so a
download meets Gatekeeper or SmartScreen; building from source avoids both.

Not a Claude Code replacement in full, and deliberately so: most of that tool's
commands exist only inside its terminal UI and have no API. What is reachable
through the SDK is reached, and each thing that is not has a written reason in
`docs/plans/`.

## Building from source

Node 22.13 or later and pnpm 11. Chorus drives the `claude` and `codex` CLIs
rather than reimplementing them, so both need to be installed and logged in
before a conversation will do anything — the app starts without them, but every
agent will fail to join.

```bash
pnpm install     # postinstall repairs node-pty's spawn-helper permissions
pnpm dev         # electron-vite, restarts the main process on its own sources
pnpm check       # typecheck + lint + format + test. ~40s warm.
```

`pnpm check` is the gate and it is expected to be green before anything is
merged. `pnpm e2e` builds the desktop app and drives it with Playwright; it is
macOS-only, takes about five minutes, and passes roughly six runs in ten
(tracked as C-029), so it is run deliberately rather than on every change.

### Where things live

| Path                        | What it is                                                    |
| --------------------------- | ------------------------------------------------------------- |
| `packages/agent-protocol`   | the normalized `AgentEvent` union both providers project onto |
| `packages/adapter-claude`   | Claude SDK → `AgentEvent`; the mapping is pure                |
| `packages/adapter-codex`    | `codex app-server` JSON-RPC → `AgentEvent`                    |
| `packages/orchestrator`     | conversation service, policy engine, catch-up, supervisor     |
| `packages/event-store`      | SQLite, migrations, projections                               |
| `packages/workspace`        | read-only git status and diff                                 |
| `apps/desktop/src/main`     | Electron main: runtime, IPC, windows, terminal                |
| `apps/desktop/src/renderer` | transcript reduction and UI                                   |

Nothing provider-specific may leak past an adapter except `raw`, which exists
only for debugging.

## Contributing

Read [CLAUDE.md](CLAUDE.md) first. It is written for coding agents, but it is the
real architecture document — the one rule everything follows from (the event log
is append-only and is the source of truth), why adding an event type touches five
files, and a list of traps that have actually bitten someone here. Most review
comments a first pull request would attract are already answered in it.

Two conventions worth knowing before you write anything:

- **Work of any size goes through a plan first**, in `docs/plans/`. Plans are
  prose that argues — what the problem is, what the shape of the answer is, and
  what you are deliberately _not_ doing. When the code contradicts the plan, the
  plan gets corrected and the reason recorded, because several phases here
  shipped differently from how they were designed and that record is worth more
  than a plan pretending it was right.
- **Comments explain why, not what.** Most comments in this codebase record a
  decision or a bug that was actually hit. Match that.

[BOARD.md](BOARD.md) is where anything that belongs to no plan lives, including
an honest list of what is broken, what is unproven, and what needs a person
rather than a commit. It is a reasonable place to look for a first task.

## Security

Chorus runs agents with real permissions and keeps a durable log of what they
did. If you find a vulnerability, please report it privately — see
[SECURITY.md](SECURITY.md), which also lists the gaps that are already known and
are not worth reporting.

## License

[MIT](LICENSE).

The installers are a separate matter from the source: neither is signed the way
its platform wants, so a downloaded build meets Gatekeeper on macOS and
SmartScreen on Windows. Building it yourself, as above, avoids both.
