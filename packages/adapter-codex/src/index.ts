/**
 * AgentAdapter over `codex app-server` (JSON-RPC 2.0, newline-delimited stdio).
 *
 * `src/generated/` holds the protocol bindings emitted by
 * `codex app-server generate-ts`. They are committed on purpose and diffed in
 * CI: the app-server is marked [experimental], and the generated types already
 * contradicted the published prose docs in six places (plan §2.1, §6.1).
 * Regenerate with:
 *
 *   codex app-server generate-ts --out packages/adapter-codex/src/generated
 */
export * from './codex-adapter.js'
export * from './mapping.js'
export * from './rpc.js'
export * from './transport.js'
