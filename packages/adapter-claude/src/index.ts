/**
 * AgentAdapter over @anthropic-ai/claude-agent-sdk.
 *
 * Two settled decisions this package is built on (plan §2.5, §2.6):
 *
 *   - The SDK's per-platform binary (~257 MB) is excluded via
 *     `ignoredOptionalDependencies`; `pathToClaudeCodeExecutable` points at the
 *     user's installed `claude` instead.
 *   - `settingSources` is omitted, so agents inherit the user's full config and
 *     behave exactly as they do in a terminal. The cost is inherited MCP
 *     servers, which is why `mcpToolCall` is never auto-allowed.
 */
export * from './claude-adapter.js'
export * from './mapping.js'
