import { z } from 'zod'
import { boundFailure, type ProjectToolResult } from './project-tools.js'

export const BROWSER_TOOL_NAMESPACE = 'chorus_browser'
export const BROWSER_READ_TOOL_NAME = 'read_console'
export const BROWSER_RUN_TOOL_NAME = 'run_javascript'

export type BrowserToolName = typeof BROWSER_READ_TOOL_NAME | typeof BROWSER_RUN_TOOL_NAME

export const BROWSER_TOOL_NAMES: readonly BrowserToolName[] = [
  BROWSER_READ_TOOL_NAME,
  BROWSER_RUN_TOOL_NAME,
]

export const BROWSER_CONSOLE_LEVELS = ['error', 'warning', 'info', 'log', 'debug'] as const
export type BrowserConsoleLevel = (typeof BROWSER_CONSOLE_LEVELS)[number]

export const BROWSER_READ_COUNT = { min: 1, max: 200, fallback: 50 } as const
export const BROWSER_READ_SKIP = { min: 0, max: 1_000, fallback: 0 } as const
export const BROWSER_EXPRESSION_MAX = 65_536
export const BROWSER_RUN_TIMEOUT_MS = { min: 100, max: 30_000, fallback: 5_000 } as const
export const BROWSER_OUTPUT_BYTES = 65_536

export interface BrowserConsoleRead {
  readonly count: number
  readonly skip: number
  readonly levels?: readonly BrowserConsoleLevel[]
}

export interface BrowserConsoleRun {
  readonly expression: string
  readonly timeoutMs: number
}

export interface BrowserConsoleAccess {
  readonly read: (request: BrowserConsoleRead) => Promise<string>
  readonly run?: (request: BrowserConsoleRun) => Promise<string>
}

const COUNT_TEXT = `How many of the newest entries to return. Defaults to ${String(BROWSER_READ_COUNT.fallback)}, at most ${String(BROWSER_READ_COUNT.max)}.`
const SKIP_TEXT = `How many of the newest matching entries to skip, to page back. Defaults to 0, at most ${String(BROWSER_READ_SKIP.max)}.`
const LEVELS_TEXT =
  'Only entries at these levels. Omit to read every level: error, warning, info, log, debug.'
const EXPRESSION_TEXT = `The JavaScript to run in the page. Top-level await and declarations are allowed. At most ${String(BROWSER_EXPRESSION_MAX)} characters.`
const TIMEOUT_TEXT = `How long to wait for the result, in milliseconds. Defaults to ${String(BROWSER_RUN_TIMEOUT_MS.fallback)}, from ${String(BROWSER_RUN_TIMEOUT_MS.min)} to ${String(BROWSER_RUN_TIMEOUT_MS.max)}.`

export const BROWSER_TOOL_SHAPES = {
  read_console: {
    count: z
      .number()
      .int()
      .min(BROWSER_READ_COUNT.min)
      .max(BROWSER_READ_COUNT.max)
      .optional()
      .describe(COUNT_TEXT),
    skip: z
      .number()
      .int()
      .min(BROWSER_READ_SKIP.min)
      .max(BROWSER_READ_SKIP.max)
      .optional()
      .describe(SKIP_TEXT),
    levels: z
      .array(z.enum(BROWSER_CONSOLE_LEVELS))
      .min(1)
      .max(BROWSER_CONSOLE_LEVELS.length)
      .optional()
      .describe(LEVELS_TEXT),
  },
  run_javascript: {
    expression: z.string().min(1).max(BROWSER_EXPRESSION_MAX).describe(EXPRESSION_TEXT),
    timeoutMs: z
      .number()
      .int()
      .min(BROWSER_RUN_TIMEOUT_MS.min)
      .max(BROWSER_RUN_TIMEOUT_MS.max)
      .optional()
      .describe(TIMEOUT_TEXT),
  },
} as const

export const BROWSER_NAMESPACE_DESCRIPTION =
  'This conversation’s project Browser in Chorus: read its Console, and, where the session and project allow changes, run JavaScript in its current page. Running JavaScript acts as the page, with its signed-in session. Nothing here opens a page.'

export const BROWSER_TOOL_DESCRIPTIONS: Readonly<Record<BrowserToolName, string>> = {
  read_console: [
    'Read the newest entries of this project’s Browser Console, newest first: page logs, warnings, uncaught errors, browser messages, and commands the user or an agent ran, with their results.',
    'Each row has its level, kind, who ran it, text, source location and, for errors, the first stack frames. A row or the whole answer marks cut when something was shortened or left out.',
    'Returns the page URL and Console state. Raise skip to page back, and pass levels to filter.',
  ].join('\n'),
  run_javascript: [
    'Run JavaScript in the current page of this project’s Browser, in the page’s own context with window and document. Top-level await and declarations work, and declarations persist between runs.',
    'The command and its result also appear in the user’s Console. Returns a result preview, or a thrown error with its location, or a status: timeout, no-page, connecting, paused (DevTools holds the debugger), unavailable, busy or interrupted (the page navigated).',
    'A timeout stops waiting but does not undo work the page already started. The user must already have the project Browser open; this never opens one.',
  ].join('\n'),
}

const integer = (
  bounds: { readonly min: number; readonly max: number },
  description: string
): Readonly<Record<string, unknown>> => ({
  type: 'integer',
  minimum: bounds.min,
  maximum: bounds.max,
  description,
})

export const BROWSER_TOOL_INPUT_SCHEMAS: Readonly<
  Record<BrowserToolName, Readonly<Record<string, unknown>>>
> = {
  read_console: {
    type: 'object',
    properties: {
      count: integer(BROWSER_READ_COUNT, COUNT_TEXT),
      skip: integer(BROWSER_READ_SKIP, SKIP_TEXT),
      levels: {
        type: 'array',
        items: { type: 'string', enum: [...BROWSER_CONSOLE_LEVELS] },
        minItems: 1,
        maxItems: BROWSER_CONSOLE_LEVELS.length,
        description: LEVELS_TEXT,
      },
    },
    required: [],
    additionalProperties: false,
  },
  run_javascript: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        minLength: 1,
        maxLength: BROWSER_EXPRESSION_MAX,
        description: EXPRESSION_TEXT,
      },
      timeoutMs: integer(BROWSER_RUN_TIMEOUT_MS, TIMEOUT_TEXT),
    },
    required: ['expression'],
    additionalProperties: false,
  },
}

const ARGUMENTS = {
  read_console: z.object(BROWSER_TOOL_SHAPES.read_console).strict(),
  run_javascript: z.object(BROWSER_TOOL_SHAPES.run_javascript).strict(),
}

export const NO_BROWSER_ACCESS = 'The project Browser Console is not available in this session.'

export const BROWSER_READ_ONLY =
  'JavaScript cannot run in this session: the project Browser Console is read-only here. Nothing was run.'

export const BROWSER_OUTPUT_WITHHELD =
  'The Console answer exceeded 64 KiB and was withheld. Ask for fewer entries or a smaller result.'

export function isBrowserTool(name: string): name is BrowserToolName {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(name)
}

export function browserToolNames(access: BrowserConsoleAccess): readonly BrowserToolName[] {
  return access.run === undefined ? [BROWSER_READ_TOOL_NAME] : BROWSER_TOOL_NAMES
}

export function readOnlyBrowser(access: BrowserConsoleAccess): BrowserConsoleAccess {
  return { read: access.read }
}

const failed = (text: string): ProjectToolResult => ({ ok: false, text: boundFailure(text) })

const invalid = (error: z.ZodError): ProjectToolResult =>
  failed(
    `Invalid arguments: ${error.issues
      .map((issue) => {
        const where = issue.path.map(String).join('.')
        return where === '' ? issue.message : `${where}: ${issue.message}`
      })
      .join('; ')}`
  )

const utf8Bytes = (text: string): number => {
  let total = 0
  for (const point of text) {
    const code = point.codePointAt(0) ?? 0
    total += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return total
}

const bounded = (text: string): ProjectToolResult =>
  utf8Bytes(text) > BROWSER_OUTPUT_BYTES ? failed(BROWSER_OUTPUT_WITHHELD) : { ok: true, text }

export async function runBrowserTool(
  access: BrowserConsoleAccess | undefined,
  tool: string,
  args: unknown
): Promise<ProjectToolResult> {
  if (access === undefined) return failed(NO_BROWSER_ACCESS)
  if (!isBrowserTool(tool)) return failed(`Unknown browser tool: ${tool}`)
  const input = args ?? {}
  try {
    switch (tool) {
      case 'read_console': {
        const parsed = ARGUMENTS.read_console.safeParse(input)
        if (!parsed.success) return invalid(parsed.error)
        return bounded(
          await access.read({
            count: parsed.data.count ?? BROWSER_READ_COUNT.fallback,
            skip: parsed.data.skip ?? BROWSER_READ_SKIP.fallback,
            ...(parsed.data.levels === undefined ? {} : { levels: parsed.data.levels }),
          })
        )
      }
      case 'run_javascript': {
        const run = access.run
        if (run === undefined) return failed(BROWSER_READ_ONLY)
        const parsed = ARGUMENTS.run_javascript.safeParse(input)
        if (!parsed.success) return invalid(parsed.error)
        return bounded(
          await run({
            expression: parsed.data.expression,
            timeoutMs: parsed.data.timeoutMs ?? BROWSER_RUN_TIMEOUT_MS.fallback,
          })
        )
      }
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}
