# Security

Chorus runs coding agents with real permissions on a real machine. It holds a
durable log of what they did, brokers approvals for commands that touch files,
and gives you a shell. That is a larger surface than a chat client, so this file
says where the sharp edges are rather than pretending there are none.

## Reporting a vulnerability

**Use [private vulnerability reporting](https://github.com/mohammadtmohsen/chorus/security/advisories/new).**
Not a public issue, not a pull request, not a discussion — a public report is a
working exploit handed to everyone running a build.

Say what you did, what happened, and what you expected. A proof of concept is
welcome; a crash trace on its own usually is not enough to act on. If you are
not sure whether something counts, report it — deciding that is the maintainer's
job, not yours.

There is no bounty. There is no SLA either, because this is one person's
project; expect a first response in days rather than hours, and say in your
report if you have a disclosure deadline in mind so it can be planned around
rather than missed.

## What is in scope

Anything that lets code or content you did not approve reach your machine, or
lets something private leave it:

- **The permission engine** (`packages/orchestrator/src/policy/engine.ts`) —
  a command that runs without the approval its kind requires, or a deny that can
  be walked around. The ordering in that file is the design: deny is absolute
  and nothing later un-denies it.
- **Redaction** (`packages/shared/src/redact.ts`) — a credential shape that
  reaches SQLite or a log sink unscrubbed. The patterns are deliberately anchored
  to unambiguous prefixes, so a _missed_ secret is a bug worth reporting and a
  _false positive_ is a different, milder one.
- **Renderer injection.** Agent output is untrusted and is built into a typed
  tree, never HTML — there is no `dangerouslySetInnerHTML` anywhere and adding
  one would be the bug. The hand-written markdown parser and syntax highlighter
  are the interesting targets.
- **Link handling.** `security.ts` only hands `https` to `shell.openExternal`;
  anything that gets another scheme past it is in scope.
- **The VS Code extension bridge**, which is a local socket. It is supposed to
  send metadata for the open folder only — a path escaping that boundary is a
  real finding.
- **Electron hardening** — a renderer reaching Node, a preload leaking more than
  its declared surface, a window opening content it should not.

## What is already known, and is not a report

These are documented gaps, not discoveries. Reporting them costs you time and
tells us nothing new.

- **Neither installer is signed the way its platform wants.** The macOS DMG is
  ad-hoc signed and not notarized, so Gatekeeper warns on every download; the
  Windows `.exe` has no certificate and meets SmartScreen. Tracked as C-002 in
  [BOARD.md](BOARD.md), and repeated in every release's notes.
- **The event log stores what agents did, including file diffs.** That is the
  whole design — a transcript cannot be rebuilt from the providers, so it is made
  durable as it arrives. `redactPayload` scrubs credential shapes on the way to
  disk, but a diff of a file full of secrets is still a diff of a file full of
  secrets. C-021 is the open half of this.
- **Terminal scrollback is deliberately not logged.** It lives in a bounded
  in-memory mirror and dies with the app, precisely because nothing scrubs a
  shell. Its absence from the log is the mitigation, not an oversight.
- **Agents inherit your full CLI configuration.** `settingSources` is omitted on
  purpose, so an agent's hooks, skills, MCP servers and slash commands all load.
  A hostile MCP server you installed yourself is your trust decision — which is
  why `mcpToolCall` can never be auto-approved.

## Supported versions

The latest release only. This is a single-maintainer desktop app with no
backport branch; a fix ships in the next version rather than as a patch to an
old one.
