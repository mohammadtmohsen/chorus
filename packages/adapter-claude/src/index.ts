/**
 * AgentAdapter over @anthropic-ai/claude-agent-sdk.
 *
 * M3 lands `query()` with streaming input, the `canUseTool` bridge, and event
 * mapping here. Two settled decisions to build on (plan §2.5, §2.6):
 *
 *   - Install the SDK with `--omit=optional` and set
 *     `options.pathToClaudeCodeExecutable` to the user's installed `claude`.
 *     The bundled binary is ~257 MB and we do not ship it.
 *   - Leave `settingSources` omitted so agents inherit the user's full config
 *     and behave exactly as they do in a terminal.
 */
export {}
