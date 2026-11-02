import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import {
  BROWSER_NAMESPACE_DESCRIPTION,
  BROWSER_READ_TOOL_NAME,
  BROWSER_RUN_TOOL_NAME,
  BROWSER_TOOL_DESCRIPTIONS,
  BROWSER_TOOL_NAMES,
  BROWSER_TOOL_NAMESPACE,
  BROWSER_TOOL_SHAPES,
  runBrowserTool,
  type BrowserConsoleAccess,
  type BrowserToolName,
} from '@chorus/agent-protocol'

const answer = async (
  access: BrowserConsoleAccess,
  name: BrowserToolName,
  args: unknown
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> => {
  const result = await runBrowserTool(access, name, args)
  return {
    content: [{ type: 'text', text: result.text }],
    ...(result.ok ? {} : { isError: true }),
  }
}

export function browserTools(access: BrowserConsoleAccess) {
  const read = tool(
    BROWSER_READ_TOOL_NAME,
    BROWSER_TOOL_DESCRIPTIONS.read_console,
    BROWSER_TOOL_SHAPES.read_console,
    (args) => answer(access, BROWSER_READ_TOOL_NAME, args)
  )
  if (access.run === undefined) return [read]
  return [
    read,
    tool(
      BROWSER_RUN_TOOL_NAME,
      BROWSER_TOOL_DESCRIPTIONS.run_javascript,
      BROWSER_TOOL_SHAPES.run_javascript,
      (args) => answer(access, BROWSER_RUN_TOOL_NAME, args)
    ),
  ]
}

export function browserMcpServer(
  access: BrowserConsoleAccess | undefined
): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
  if (access === undefined) return undefined
  return {
    [BROWSER_TOOL_NAMESPACE]: createSdkMcpServer({
      name: BROWSER_TOOL_NAMESPACE,
      version: '1.0.0',
      instructions: BROWSER_NAMESPACE_DESCRIPTION,
      tools: browserTools(access),
    }),
  }
}

export const READ_CONSOLE_TOOL = `mcp__${BROWSER_TOOL_NAMESPACE}__${BROWSER_READ_TOOL_NAME}`

export const BROWSER_TOOL_IDS: ReadonlySet<string> = new Set(
  BROWSER_TOOL_NAMES.map((name) => `mcp__${BROWSER_TOOL_NAMESPACE}__${name}`)
)
