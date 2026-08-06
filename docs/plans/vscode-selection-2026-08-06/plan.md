# VS Code editor context in Chorus

Status: **awaiting approval.** This document is the merged plan; no product code has
been written.

You open a project folder in Chorus and the same project in VS Code. Chorus then follows
the active file and primary selection live, but only for that conversation's project, so
a question can carry an exact file-and-line reference without the user describing it.

Two independent research passes reached the same core architecture. This plan keeps the
parts supported by the VS Code API and proven in Copilot Chat and Claude Code, resolves
the disagreements between the passes, and closes the packaging, security, stale-context,
and test gaps found during repository review.

---

## 1. Final decision

Build a **first-party Chorus VS Code extension**. The extension dials outward to an
authenticated Unix domain socket owned by the Chorus Electron main process.

- Live events carry metadata only: matching project, file, primary range, language,
  dirty state, and window focus.
- Source text is captured only when Send is pressed.
- The Electron main process revalidates every file against the conversation `cwd`.
- A visible, reversible context pill tells the user exactly what will be sent.
- The extension ships as a version-matched `.vsix` inside Chorus for v1. Marketplace and
  Open VSX publishing are later distribution work, not a prerequisite.

The connection and data flow is:

```text
VS Code stable APIs
       │ metadata notifications / fresh snapshot
       ▼
Chorus VS Code extension (client)
       │ authenticated JSON-RPC over a Unix socket
       ▼
Electron main IDE broker
       │ exact project matching + validated Electron IPC
       ▼
visible composer context pill
       │ snapshot again when Send is pressed
       ▼
path:line reference + exact selected text in the user message
       ▼
the addressed Claude/Codex agent(s)
```

### Non-negotiable invariants

1. A canonical VS Code workspace folder must equal the canonical conversation `cwd`.
2. The active file must resolve inside that same root; a sibling, parent workspace, or
   similarly prefixed directory never qualifies.
3. No selected source text crosses the bridge until the user sends a message.
4. If a visible context cannot be refreshed at send time, Chorus preserves the draft and
   asks the user to retry or exclude the context. It never silently sends stale context.
5. Context is visible in the composed user message, so both agents and transcript replay
   see the same explicit evidence.
6. No dependency on Claude Code, Copilot Chat, or any other vendor extension or private
   protocol.

---

## 2. Research reconciliation

### What both passes proved

- VS Code's stable extension API exposes `activeTextEditor`, the primary selection,
  `onDidChangeActiveTextEditor`, `onDidChangeTextEditorSelection`, workspace folders,
  document dirty/version state, and window focus.
- Anthropic's Claude Code and Microsoft's Copilot Chat independently use an extension,
  a local authenticated RPC channel, per-window workspace metadata, debounced selection
  updates, and a send-time/current-selection request.
- Their editor payload converges on the same useful shape:

  ```ts
  {
    text,
    filePath,
    fileUrl,
    selection: {
      start: { line, character },
      end: { line, character },
      isEmpty,
    },
  }
  ```

- VS Code positions are zero-based. Chorus converts them to one-based display lines at
  one named boundary and nowhere else.
- Non-`file:` documents cannot safely map to the local project filesystem and must be
  excluded in v1.

### Corrections incorporated into the final design

**Do not reuse Claude Code's server.** Its current server has one client slot, so Chorus
would evict a live Claude Code connection. Its documented security-disclosure protocol
is also not a supported third-party integration contract. Editor context belongs to the
Chorus conversation, which can address either provider.

**Live follow is not continuous source streaming.** Live events update the pill with
metadata. A request at Send captures the authoritative text. This avoids passive source
leakage and eliminates stale content between selection and send.

**Keep a narrowly defined last-known cache.** When VS Code focus moves to its terminal,
sidebar, or Chorus itself, there may be no current text editor. The extension may use the
last eligible editor snapshot from that exact project. If there is a current editor and
it is outside the project or unsupported, the cache is cleared; an unrelated current
editor never falls back to an older in-project selection.

**Use exact text, not `asQuote()`.** `quote.ts` trims the selection and line endings for
prose. That is correct for transcript quotations but wrong for code, where indentation
and trailing content can matter. Editor context gets a dedicated formatter with a safe
Markdown fence. It still leads with the relative path and range, following `attach.ts`'s
principle that agents receive paths they can open.

**Never silently truncate.** A truncated dirty selection can mean something different
from what is on disk. The snapshot limit is 64 KiB. Above it, the pill reports that the
selection is too large and Send is blocked until the user selects less or excludes the
context.

**Retain proven discovery and authentication metadata.** A UDS removes the
browser-reachable localhost attack class, but an extension still needs to discover a
Chorus process started before or after it. Per-process descriptors solve this without
forcing Chorus to become single-instance.

### Rejected approaches

| Approach                                      | Reason rejected                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Claude Code IDE server                        | One-client eviction, vendor coupling, no stability contract                                                  |
| `state.vscdb`                                 | Persisted editor state can be stale by about a minute and is not a live API                                  |
| Accessibility / AppleScript / simulated copy  | Requires invasive permission, degrades Monaco behavior, loses reliable path/range, can clobber the clipboard |
| VS Code CLI or URI handler as state transport | Useful for opening/focusing, but inbound-only and not a state source                                         |
| Chrome DevTools Protocol                      | Requires unsafe debug exposure and a special launch                                                          |
| MCP as the bridge                             | Adds per-agent configuration to context owned by the shared conversation                                     |
| Loopback HTTP/WebSocket                       | Works with auth, but retains browser/DNS-rebinding exposure that a UDS structurally avoids                   |

---

## 3. Project matching and window selection

Project scoping is enforced twice: first in the extension to minimize disclosure, then in
Electron main as the security boundary.

### Eligibility

- Chorus sends each connected extension the canonical roots of its currently open
  conversations.
- A VS Code window is eligible for a root only when one of its `file:` workspace folders
  has the same canonical real path as that root.
- An editor is eligible only when its `file:` path resolves inside the matched root using
  the same segment-aware, symlink-aware rules as
  `packages/workspace/src/path-safety.ts`.
- Opening `/code` in VS Code does not match a Chorus conversation at `/code/project`.
  Opening `/code/project/src` also does not match. The project root itself must be open.
- In a multi-root VS Code window, the one workspace folder exactly equal to `cwd` is the
  match; active files in the other roots clear the context.
- Untitled files, notebooks, output panes, virtual documents, Remote SSH, containers,
  Codespaces, and every non-`file:` URI are out of scope for v1.

### Choosing among windows

1. Prefer an eligible VS Code window currently focused.
2. Once focus moves to Chorus, retain the most recently focused eligible window.
3. If several eligible windows connect with no focus history, report `ambiguous` until
   the user focuses one; do not choose by connection order.
4. A disconnect, workspace-root change, trust loss, or active editor outside the root
   immediately clears that window's candidate state.
5. Several Chorus conversations with the same `cwd` may deliberately share the same
   editor context.

The Electron broker returns exactly one scoped status per conversation. This list is
authoritative: §6 must give every member localized text, and no other status name may
appear elsewhere in the plan or the code.

| Status        | Meaning                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| `unavailable` | No extension is connected to this Chorus process                                         |
| `unmatched`   | Connected, but no window has this conversation's `cwd` as a root                         |
| `untrusted`   | A matching window exists, but `workspace.isTrusted` is false                             |
| `unsupported` | Matching window, but the active editor is non-`file:`, a notebook, or a virtual document |
| `ambiguous`   | Several eligible windows and no focus history to choose between them                     |
| `tooLarge`    | Eligible editor, but the selection exceeds the 64 KiB cap                                |
| `ready`       | Eligible editor with usable context                                                      |

`connected` is deliberately absent: a live socket with no eligible editor is already
described by `unmatched`, `untrusted`, or `unsupported`, and a separate `connected` state
would overlap all three without telling the user anything actionable.

The renderer never receives editor metadata for unrelated projects.

---

## 4. Transport and threat model

### Discovery

For the current macOS-only product, each Chorus process creates:

```text
/tmp/chorus-ide-<uid>/                 mode 0700, owned by the current uid
  <pid>.sock                           Unix domain socket, mode 0600
  <pid>.json                           descriptor, mode 0600
```

The descriptor is written atomically and contains only:

```ts
{
  pid: number
  socketPath: string
  token: string // 256 random bits, rotated each Chorus launch
  protocolVersion: 1
  chorusVersion: string
}
```

The short `/tmp` path stays below macOS's Unix-socket path limit. Before using the
directory, both sides verify that it is a real directory, owned by the current uid, with
no group/other permissions. The extension scans immediately, watches the directory, and
performs a low-frequency reconciliation scan so missed filesystem events recover. It
connects to every valid live Chorus descriptor, allowing multiple Chorus processes.
Neither side deletes another process's files.

Mode `0600` is not protection from malicious code already running as the same user; that
code can also read the project. It prevents cross-user and accidental access. The token
provides pairing, version-error reporting, and rejection of unintended local clients.

### Protocol

Use newline-delimited JSON-RPC 2.0 over the byte stream, with every request,
notification, and response parsed by zod schemas from a new `@chorus/ide-protocol`
package. `JSON.stringify` escapes source newlines, so each frame remains one wire line.

Known methods only:

```text
extension -> Chorus   initialize       token, protocol/client versions, window id,
                                      trust, focus; no workspace paths
Chorus   -> extension setRoots          canonical conversation roots
extension -> Chorus   stateChanged      per-root match/status and eligible editor
                                      metadata only; no selected text or unrelated path
Chorus   -> extension currentContext    fresh snapshot request for one canonical root
extension -> Chorus   currentContext result | unavailable | tooLarge
```

- `initialize` must be the first request and complete within two seconds.
- Compare tokens without logging them; reject protocol-version mismatch explicitly.
- Limit the primary selected text to 64 KiB of UTF-8 and any complete frame to 512 KiB,
  leaving room for worst-case JSON escaping without weakening the source-text cap.
- Selection/editor notifications are debounced at 200ms and coalesced to latest state.
- A send-time request times out after 750ms. A timeout blocks only the message that had
  visible IDE context attached; ordinary Chorus sending remains unaffected.
- No token, source text, file path, or root is written to diagnostics. Logs contain only
  connection counts, version numbers, and reason codes.
- The socket exists only in Electron main. The sandboxed renderer receives validated,
  conversation-scoped IPC data through the existing preload allowlist.
- Workspace Trust is declared as `limited`: the extension may report that the correct
  workspace exists, but it sends no file/range/text until `workspace.isTrusted` is true.

The full snapshot is transient until Send. Once sent, its path/range/text becomes part of
the visible user message and is persisted exactly like any other user-authored context.

---

## 5. Editor snapshot and agent message

Two frames, not one. The live frame and the send-time frame differ by exactly one field,
and that difference is the §4 invariant that no source text crosses the bridge before
Send. Expressing it as two types makes the invariant structural rather than a convention
reviewers have to remember:

```ts
/** Live frame. Emitted on every debounced change. Carries no source text. */
type EditorMetadata = {
  source: 'current' | 'cached'
  filePath: string
  fileUrl: string
  languageId: string
  documentVersion: number
  isDirty: boolean
  selection: {
    start: { line: number; character: number }
    end: { line: number; character: number }
    isEmpty: boolean
    selectedBytes: number
  }
}

/** Send-time frame. Returned only for a `currentContext` request. */
type EditorSnapshot = EditorMetadata & {
  selection: EditorMetadata['selection'] & { text: string }
}
```

Both get their own zod schema in `@chorus/ide-protocol`. The schema for the live frame
uses `.strict()`, so a frame carrying `text` on the metadata channel fails validation in
the broker instead of being silently accepted.

- When the range is non-empty, `EditorSnapshot.selection.text` is the exact
  editor-buffer text.
- `selectedBytes` is computed inside VS Code and travels on the live frame, so an
  oversized selection is visible before Send without the text ever leaving the editor.
- When it is empty, Chorus sends the relative file path and cursor line only; the agent
  reads the file from disk.
- If the empty-selection document is dirty, the message explicitly says the on-disk file
  may differ. Chorus does not stream the entire dirty document automatically.
- The Electron main process rechecks root equality and file containment after receiving
  the response, closing the race between live metadata and Send.
- The path becomes relative to `cwd` only after successful validation.

Example materialized into the visible user message:

````markdown
VS Code context: `apps/desktop/src/renderer/src/Session.tsx:412-418` (unsaved buffer)

```tsx
const selection = window.getSelection()
if (selection === null || selection.isCollapsed) setSelected(null)
```
````

The formatter chooses a fence longer than any backtick run in the selected text, keeps
the selected bytes intact, sanitizes the language identifier, and centralizes the
zero-based-to-one-based range conversion. User-facing labels come from i18n resources.

Live metadata and snapshot text are not automatically handed to every agent as hidden
context. They are appended to the user's message, then the existing mention router
decides which agent or agents receive it.

---

## 6. User experience

### In Chorus

- Add a small VS Code state/action beside the project path.
- Above the textarea, show a live context card such as
  `Session.tsx · lines 412–418 · VS Code` or `Session.tsx · cursor 412`.
- The card updates as the eligible VS Code file/selection changes.
- An eye toggle controls inclusion. It **defaults on** for a matching trusted project.
  Once the user turns it **off**, it stays off for that conversation until the user turns
  it back on — a live selection change, a reconnect, or a new eligible window must never
  silently re-enable excluded context.
- Give every status in the §3 table localized text — `unavailable`, `unmatched`,
  `untrusted`, `unsupported`, `ambiguous`, `tooLarge`, `ready` — instead of showing an
  unexplained blank. `ready` is the only one that renders the file-and-range card.
- If no matching extension/context exists, the existing composer works exactly as today.
- While a send-time snapshot is pending, disable duplicate Send actions. If refresh fails,
  leave the draft and attachments untouched and focus the explanation/retry path.

### In VS Code

- A right-side status-bar item shows the extension's own socket state — `Chorus: linked`,
  `Chorus: paused`, or `Chorus: not running`. This is a separate vocabulary from the §3
  per-conversation status table on purpose: the extension knows whether it reached a
  Chorus process, but not which conversation is asking or whether that conversation's
  root matched. Reusing `connected` or `ready` here would imply it knows both.
- Command Palette commands: reconnect, pause/resume live context, and show connection
  diagnostics. No sidebar or webview is needed.
- All contribution strings use `package.nls.json`; runtime strings use VS Code's
  localization API.

### Installation and opening

- Add `apps/vscode-extension` as a pnpm workspace app and build a VSIX.
- Package the matching VSIX under Electron `extraResources`.
- Chorus offers an explicit **Install/Update VS Code Extension** action. It runs the
  resolved VS Code CLI with argument arrays, never through a shell string.
- Resolve `code` through the adopted shell path and the standard macOS application
  location; if unavailable, show the official “Shell Command: Install 'code' command in
  PATH” guidance.
- Add an explicit **Open project in VS Code** action that runs `code <cwd>` and lets VS
  Code honor the user's normal window-opening preference. Selecting a Chorus directory
  alone does not unexpectedly launch another application.
- The app and extension exchange protocol/client versions and visibly request an update
  when incompatible.

The bundled VSIX is the v1 distribution decision. Marketplace/Open VSX publication is a
separate release decision requiring publisher credentials and external review; it is not
silently included in implementation.

---

## 7. Implementation phases

Every completed phase adds `Phase N done: ...` to `STATUS.md` and ends with targeted
tests plus `pnpm run typecheck`, `pnpm run lint`, and `pnpm run format:check`. No phase is
committed or pushed without separate explicit approval.

### Phase 1 — Shared contract and project matching

Create `packages/ide-protocol` for the JSON-RPC method names and zod wire schemas. Keep
filesystem policy out of this package so it remains a pure protocol boundary.

Extend `@chorus/workspace` with named canonical-root equality and containment helpers,
building on `path-safety.ts` rather than duplicating path-prefix logic.

**Canonicalize roots once, not per event.** `resolveWithinRoot` calls `realpathSync` on
the root on every invocation, which is correct for its existing one-shot callers and wrong
for a 200ms-debounced stream across N windows × M roots — it would put repeated
filesystem syscalls on the Electron main thread. `project-match.ts` exposes a
`CanonicalRoot` produced once when `setRoots` is computed, and a containment check that
takes that pre-resolved root. The candidate path is still realpath'd every time, because
that is the part an attacker controls.

Files:

- `packages/ide-protocol/package.json`
- `packages/ide-protocol/tsconfig*.json`
- `packages/ide-protocol/src/index.ts`
- `packages/ide-protocol/src/protocol.ts`
- `packages/ide-protocol/src/protocol.test.ts`
- `packages/workspace/src/project-match.ts`
- `packages/workspace/src/project-match.test.ts`
- `packages/workspace/src/index.ts`

Exit criteria: malformed/oversize/version-mismatched frames fail closed; canonical
matching handles symlinks, `/tmp` vs `/private/tmp`, sibling-prefix attacks, exact roots,
multi-root inputs, and out-of-root files.

### Phase 2 — Electron IDE broker

Implement descriptor/socket lifecycle, authenticated connections, root synchronization,
the in-memory window registry, focus arbitration, metadata coalescing, send-time requests,
timeouts, and cleanup. Start it after `app.whenReady()` and close it before the existing
runtime shutdown completes.

The broker receives active roots from `runtime.openConversations()`. Conversation start,
restore, restart, close, and `cwd` changes resynchronize roots and scoped renderer state.
Every snapshot is revalidated against `runtime.projectDirectory(conversationId)`.

Files:

- `apps/desktop/src/main/ide-bridge.ts`
- `apps/desktop/src/main/ide-bridge.test.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/electron.vite.config.ts`
- `apps/desktop/package.json`

Exit criteria: authenticated fake clients connect concurrently; wrong token/version is
rejected; focus chooses the correct exact-root window; ambiguity is explicit; abrupt
disconnect clears state; stale descriptors do not affect live processes; no secret or
path appears in logs.

### Phase 3 — First-party VS Code extension

Create a UI extension activated by `onStartupFinished`. It discovers every live broker,
connects with bounded exponential backoff, accepts per-connection root sets, observes the
stable editor/workspace/trust/focus APIs, keeps the narrow last-known cache, and emits
metadata after a 200ms debounce. `deactivate()` disposes listeners and sockets promptly.

**Repo-wide tooling must be extended in this phase, not discovered failing in it.**
`pnpm lint` runs `eslint .` across the whole repo and `vitest` resolves
`projects: ['packages/*', 'apps/*']`, so a new app under `apps/` is immediately in scope
for both:

- `eslint.config.mjs` has explicit per-area blocks (`packages/orchestrator/**`,
  `apps/desktop/src/renderer/**`, `apps/desktop/e2e/**`). Add one for
  `apps/vscode-extension/**` declaring Node globals and the ambient `vscode` module, or
  the base config will fail on both.
- The extension needs its own `vitest.config.mts` (the `apps/desktop` one is the
  precedent) with an alias mapping `vscode` to a local test double. The real module is
  injected by the extension host and cannot resolve under vitest, so without the alias
  every test file fails at import.
- `turbo.json` gains the extension's `build` and `typecheck` tasks so `pnpm check` and
  `pnpm build` cover it like any other workspace member.

Files:

- `apps/vscode-extension/package.json`
- `apps/vscode-extension/package.nls.json`
- `apps/vscode-extension/tsconfig.json`
- `apps/vscode-extension/vitest.config.mts`
- `apps/vscode-extension/esbuild.mjs`
- `apps/vscode-extension/src/extension.ts`
- `apps/vscode-extension/src/connection.ts`
- `apps/vscode-extension/src/editor-context.ts`
- `apps/vscode-extension/src/test/vscode-stub.ts`
- `apps/vscode-extension/src/*.test.ts`
- `eslint.config.mjs`
- `turbo.json`

Exit criteria: in-root primary selection metadata arrives; selected text appears only in
a requested snapshot; exact-root mismatch/non-file/untrusted states disclose no editor
path or text; terminal/sidebar focus uses only the eligible cache; reconnect works when
either app starts first.

### Phase 4 — Scoped IPC, live pill, and send-time composition

Add validated request/response and push shapes to the existing IPC contract. Main sends
only conversation-scoped metadata. Preload exposes named methods/listeners. `Session`
renders the live card, inclusion toggle, and failure states. A pure formatter materializes
the path/range and exact text at Send.

Files:

- `apps/desktop/src/shared/ipc.ts`
- `apps/desktop/src/shared/ipc.test.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/Session.tsx`
- `apps/desktop/src/renderer/src/editor-context.ts`
- `apps/desktop/src/renderer/src/editor-context.test.ts`
- `apps/desktop/src/renderer/src/i18n/en.json`
- `apps/desktop/src/renderer/src/styles.css`

Exit criteria: each pane follows only its exact `cwd`; selection/cursor/dirty state is
truthful; exclusion persists; fresh context is visible in the sent transcript; a timeout,
disconnect, mismatch, or oversized selection preserves the draft and never sends stale
context.

### Phase 5 — VSIX distribution and project opening

Build/package the extension before desktop packaging, include the VSIX as an app resource,
detect installed/version state, add explicit install/update and open-project actions, and
document uninstall/update behavior.

Files:

- `package.json`
- `turbo.json` if task ordering needs an explicit dependency
- `apps/desktop/electron-builder.yml`
- `apps/desktop/src/main/ide-extension.ts`
- `apps/desktop/src/main/ide-extension.test.ts`
- `apps/desktop/src/shared/ipc.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/Session.tsx`
- `README.md`
- `docs/install-macos.md`

**Re-verify the code seal.** `extraResources` places the VSIX outside the asar, inside the
signed bundle, so it changes what ad-hoc signing seals. Every release to date has been
verified at `Sealed Resources version=2 rules=13 files=76`; adding a resource moves that
count. `build/sign-adhoc.cjs` already throws on a failed verify from `afterPack`, so the
risk is not a silent break — but this phase must confirm
`codesign --verify --deep --strict` still passes on the packaged app and record the new
sealed-resource figures, because that check has gated every release so far.

Exit criteria: a clean package contains the correct VSIX; `codesign --verify --deep
--strict` passes and the new sealed-resource count is recorded; explicit install/update
works; `code <cwd>` opens the selected project; missing CLI and version mismatch have
actionable localized states; ordinary Chorus installation still works without VS Code.

### Phase 6 — End-to-end verification and hardening

Extend the existing custom Chrome DevTools Protocol harness with a fake IDE client that
speaks the real socket protocol. Do not describe this suite as Playwright; it drives the
shipped Electron build directly.

Automated scenarios:

1. Two conversations and two fake VS Code windows never cross project context.
2. A parent, child, sibling-prefix, symlink escape, non-file URI, and unrelated multi-root
   selection are rejected.
3. Last-focused arbitration works after focus moves into Chorus; ambiguous windows do not
   resolve by arrival order.
4. The live metadata says lines A-B, the editor changes before Send, and the transcript
   contains the fresh lines C-D.
5. Selected dirty-buffer text is exact; empty dirty context warns; Markdown backticks and
   indentation survive formatting.
6. Exclusion sends the draft without IDE context; a snapshot timeout or oversize response
   preserves it.
7. Closing/restarting VS Code or Chorus reconnects and clears stale UI state.
8. Tokens, source text, and project paths are absent from diagnostics.
9. Narrow-width composer layout, keyboard sending, attachments, transcript quoting, and
   both agent mention routes regress cleanly.

Live verification with a real VS Code installation and the packaged VSIX:

- saved selection, empty selection/cursor, dirty selection, terminal/sidebar focus;
- exact project, unrelated project, multi-root project, and two VS Code windows;
- pause/resume, exclude/include, VS Code restart, Chorus restart, and version mismatch;
- one question to Codex and one to Claude, confirming each can open the referenced file
  and reason about the selected lines;
- packaged `.app`, not only `pnpm dev`.

Final gates: `pnpm run check`, `pnpm run build`, the full Electron e2e suite, extension
tests, `pnpm run package`, VSIX presence/version inspection, and a visual pass at normal
and narrow widths.

---

## 8. Deliberate v1 boundaries

- macOS and desktop VS Code only; named pipes and remote workspaces come later.
- Primary selection only, matching both production reference payloads. Multiple cursor
  selections can be added by versioning the protocol without changing the transport.
- Text editors only; notebooks and custom/virtual editors are unsupported.
- No automatic full dirty-file upload.
- No automatic VS Code launch when a Chorus path changes.
- No Marketplace/Open VSX publication or credentials work.
- No hidden agent context and no changes to Claude/Codex adapters.
- **One Chorus process is the supported configuration.** The per-process descriptor
  directory in §4 stays as designed — assuming a single fixed socket path would break
  the moment a second Chorus launched, and failing loudly is worse than tolerating it —
  so the extension still connects to every valid live descriptor. But v1 verification
  covers one Chorus process against multiple VS Code windows. Arbitration across several
  simultaneous Chorus processes is neither tested nor guaranteed, and the N×M state
  matrix is out of scope for a personal tool.

---

## 9. Definition of done

The feature is complete only when all of the following are true:

- The matching VS Code file/range follows live in the correct Chorus pane.
- No pane ever displays or sends another project's editor context.
- Send captures a fresh, exact selection or fails visibly without losing the draft.
- The user can exclude/pause context and can see what was included afterward.
- Both agents receive a normal, replayable user message containing an actionable relative
  path/range and exact selected code.
- Install, update, open-project, reconnect, packaging, and unsupported states work without
  manual repository setup.
- Automated, live, packaged-app, and visual verification are green.

After approval, implementation begins with Phase 1 only and pauses at the documented UI
verification gate before any commit.

---

## 10. Evidence reviewed

- VS Code API reference: <https://code.visualstudio.com/api/references/vscode-api>
- VS Code extension-host architecture:
  <https://code.visualstudio.com/api/advanced-topics/extension-host>
- VS Code Workspace Trust:
  <https://code.visualstudio.com/api/extension-guides/workspace-trust>
- VS Code CLI: <https://code.visualstudio.com/docs/configure/command-line>
- Claude Code IDE integration: <https://code.claude.com/docs/en/ide-integrations>
- Node IPC/Unix socket support: <https://nodejs.org/api/net.html>
- Electron security guidance: <https://www.electronjs.org/docs/latest/tutorial/security>
- Installed Claude Code extension and `~/.claude/ide/*.lock` on this machine
- Microsoft `vscode-copilot-chat` selection, lock-file, and in-process-server sources
- `coder/claudecode.nvim` protocol/lock-file interoperability documentation
- Local Chorus seams: `attach.ts`, `quote.ts`, `Session.tsx`, `ipc.ts`, preload bridge,
  workspace path safety, Electron packaging, and the custom CDP e2e harness
