# Chorus Build — Status

Plan: [plan.md](./plan.md)

| Milestone                          | State                                         |
| ---------------------------------- | --------------------------------------------- |
| M0 Foundations & spikes            | Infrastructure done; spikes S3–S5 remain      |
| M1 Event store & orchestrator      | Not started                                   |
| M2 Codex adapter                   | Not started                                   |
| M3 Claude adapter                  | Not started                                   |
| M4 Shared conversation UI          | Not started                                   |
| M5 Approvals & permission profiles | Not started                                   |
| M6 Handoffs                        | Not started                                   |
| M7 Workspace & review              | Not started                                   |
| M8 Hardening                       | Not started                                   |
| M9 Distribution                    | Deferred — decision point after M8 dogfooding |

## Log

- **2026-08-03** — Plan drafted from live research (Codex app-server protocol reference,
  Claude Agent SDK 0.3.220 docs, Electron security/packaging guidance). Awaiting approval.
- **2026-08-03** — Scope decided: personal tool now / product later, macOS only for v1.0,
  reuse existing `codex` + `claude` CLI logins (Chorus stores no credentials). M9 deferred;
  the one-native-module budget stays enforced so it can be picked up cheaply later.
- **2026-08-03** — Partial S1/S2 completed early (plan §2.5). Live `codex app-server`
  handshake succeeded against the installed CLI using existing `~/.codex` auth. Claude SDK
  `sdk.d.ts@0.3.220` read directly: real `CanUseTool` signature captured (published prose
  docs are wrong), `pathToClaudeCodeExecutable` confirmed, and the 257 MB bundled-binary
  optional dependency identified. Decision: drive both installed CLIs, install the SDK with
  `--omit=optional`. New requirement found: neither provider times out an approval, so
  Chorus must own approval deadlines.
- **2026-08-03** — Version-drift mitigations cut to a single version field on
  `session.started`; the banner/onboarding/bundling-contingency work was product scope and
  §10 defers product. Config decided: **inherit full user config** (`settingSources`
  omitted) so agents behave as they do in a terminal. Consequence captured in plan §2.6 —
  inherited MCP servers make `mcpToolCall` a first-class approval kind that a permission
  profile may never auto-allow.
- **2026-08-03 — M0 infrastructure done.** pnpm + Turborepo monorepo, 7 packages per plan
  §3.2, hardened Electron shell, CI. All gates green (typecheck, lint, format, 23 tests);
  app verified booting in both dev and production, with a live IPC round-trip returning the
  real installed CLI versions. Toolchain pinned: TypeScript **6.0.3**, not 7.0.2 — no stable
  `typescript-eslint` supports TS 7 yet (peer range caps at `<6.1.0`), and dropping to TS 7
  would mean losing type-aware linting, which is what actually enforces the no-`any` rule.
  Revisit when typescript-eslint ships TS 7 support.

  Four things the build surfaced that the plan had not anticipated:
  1. **A sandboxed preload must be CJS**, and Electron's main cannot take named imports from
     the CJS `electron` module under ESM. `apps/desktop` is therefore deliberately not
     `"type": "module"`; only the renderer is ESM.
  2. **The strict production CSP breaks React Fast Refresh** — `script-src 'self'` rejects
     the inline preamble `@vitejs/plugin-react` injects. CSP is now split: the hard policy
     ships, a dev-only policy allows the inline preamble and the HMR websocket, selected by
     the presence of the dev-server URL rather than a build flag that could drift.
  3. **VS Code's extension host exports `ELECTRON_RUN_AS_NODE=1`**, which makes the Electron
     binary run as plain Node — `require('electron')` returns a path string and the app dies
     on `app.whenReady()`. The `dev` and `preview` scripts now run under
     `env -u ELECTRON_RUN_AS_NODE`.
  4. Typed linting needs test files inside a tsconfig, but the build must exclude them, so
     every package carries `tsconfig.json` (lint/editor, includes tests, emits nothing) plus
     `tsconfig.build.json` (emits, excludes tests).
