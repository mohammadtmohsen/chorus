/**
 * AgentAdapter over `codex app-server` (JSON-RPC 2.0, newline-delimited on stdio).
 *
 * M2 lands the RPC client and event mapping here. Before writing any of it, run:
 *
 *   codex app-server generate-ts --out packages/adapter-codex/src/generated
 *
 * The output is committed on purpose and CI fails on diff — the app-server is
 * marked [experimental] and will move under us (plan §6.1).
 */
export {}
