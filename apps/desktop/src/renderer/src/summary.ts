import type { TranscriptEvent } from '../../shared/ipc.js'
import type { Spend } from './transcript.js'

/**
 * What actually happened in a session, counted from the log.
 *
 * A pure reduction like `transcript.ts`, and for the same reason: the log is the
 * source of truth (S3), so replaying `conversation:history` after a restart has
 * to produce the same answer as watching it live.
 *
 * The honest boundary of this file is worth stating, because the question people
 * ask of a summary is wider than it can answer. The log records **what was
 * done** — turns taken, commands run, files proposed, approvals decided, errors
 * raised, tokens spent. It does not record what any of that was *for*, whether
 * it worked, what is still missing, or what should happen next. Those are
 * judgements, and inventing them here would mean guessing in the one place the
 * user is entitled to facts. So this counts, and the panel offers to ask an
 * agent for the judgement separately.
 */

/** One thing that went wrong, in the log's own terms. */
export interface Problem {
  readonly kind: 'error' | 'commandFailed' | 'approvalDenied' | 'turnFailed'
  /** Who it happened to. */
  readonly actor: TranscriptEvent['actor']
  readonly detail: string
  /** The event it came from, so the panel can point at it. */
  readonly eventId: string
}

/** What one agent did. */
export interface AgentWork {
  readonly actor: TranscriptEvent['actor']
  readonly turns: number
  readonly commands: number
  readonly commandsFailed: number
  readonly filesTouched: readonly string[]
  readonly approvalsAllowed: number
  readonly approvalsDenied: number
  readonly handoffsSent: number
  readonly errors: number
  readonly spend: Spend
}

export interface SessionSummary {
  readonly agents: readonly AgentWork[]
  readonly userMessages: number
  readonly problems: readonly Problem[]
  /** Every distinct path any agent proposed a change to. */
  readonly filesTouched: readonly string[]
  readonly spend: Spend
  /** False when the log holds nothing worth showing yet. */
  readonly anything: boolean
}

const NO_SPEND: Spend = { inputTokens: 0, outputTokens: 0, costUsd: null }

export const EMPTY_SUMMARY: SessionSummary = {
  agents: [],
  userMessages: 0,
  problems: [],
  filesTouched: [],
  spend: NO_SPEND,
  anything: false,
}

interface MutableWork {
  actor: TranscriptEvent['actor']
  turns: number
  commands: number
  commandsFailed: number
  files: Set<string>
  approvalsAllowed: number
  approvalsDenied: number
  handoffsSent: number
  errors: number
  spend: Spend
}

export function summariseSession(events: readonly TranscriptEvent[]): SessionSummary {
  const work = new Map<string, MutableWork>()
  const problems: Problem[] = []
  const files = new Set<string>()
  let userMessages = 0

  /*
   * A command is attributed by its `itemRef`, not by whoever the exit event
   * happens to be attributed to. `command.started` and `command.completed`
   * arrive as separate events and only the first carries the command line, so
   * without this the failures could not be counted against the agent that ran
   * them.
   */
  const commandActor = new Map<string, TranscriptEvent['actor']>()
  const commandLine = new Map<string, string>()

  const of = (actor: TranscriptEvent['actor']): MutableWork => {
    const found = work.get(actor)
    if (found !== undefined) return found
    const made: MutableWork = {
      actor,
      turns: 0,
      commands: 0,
      commandsFailed: 0,
      files: new Set(),
      approvalsAllowed: 0,
      approvalsDenied: 0,
      handoffsSent: 0,
      errors: 0,
      spend: NO_SPEND,
    }
    work.set(actor, made)
    return made
  }

  for (const event of events) {
    const p = event.payload
    switch (event.type) {
      case 'user.message':
        userMessages += 1
        break

      case 'turn.completed': {
        const status = typeof p['status'] === 'string' ? p['status'] : 'completed'
        const w = of(event.actor)
        w.turns += 1
        // An interrupt is the user's own doing, so it is not a problem to report
        // back to them. A failure is.
        if (status === 'failed') {
          problems.push({
            kind: 'turnFailed',
            actor: event.actor,
            detail: 'A turn ended in failure.',
            eventId: event.id,
          })
        }
        break
      }

      case 'command.started': {
        const w = of(event.actor)
        w.commands += 1
        commandActor.set(refOf(p), event.actor)
        commandLine.set(refOf(p), lineOf(p))
        break
      }

      case 'command.completed': {
        const code = p['exitCode']
        if (typeof code === 'number' && code !== 0) {
          const ref = refOf(p)
          const actor = commandActor.get(ref) ?? event.actor
          of(actor).commandsFailed += 1
          const line = commandLine.get(ref)
          problems.push({
            kind: 'commandFailed',
            actor,
            detail:
              line === undefined || line === ''
                ? `A command exited ${String(code)}.`
                : `${line} — exited ${String(code)}`,
            eventId: event.id,
          })
        }
        break
      }

      case 'file.change.proposed': {
        const w = of(event.actor)
        for (const path of pathsOf(p)) {
          w.files.add(path)
          files.add(path)
        }
        break
      }

      case 'approval.decided': {
        const outcome = typeof p['outcome'] === 'string' ? p['outcome'] : ''
        const actor = event.actor
        if (outcome === 'allow') of(actor).approvalsAllowed += 1
        if (outcome === 'deny' || outcome === 'timeout') {
          of(actor).approvalsDenied += 1
          const rule = typeof p['policyRuleId'] === 'string' ? p['policyRuleId'] : null
          problems.push({
            kind: 'approvalDenied',
            actor,
            detail:
              outcome === 'timeout'
                ? 'An approval expired before it was decided.'
                : rule === null
                  ? 'An approval was denied.'
                  : `Denied by ${rule}.`,
            eventId: event.id,
          })
        }
        break
      }

      case 'handoff.created':
        of(event.actor).handoffsSent += 1
        break

      case 'error.raised': {
        of(event.actor).errors += 1
        problems.push({
          kind: 'error',
          actor: event.actor,
          detail: typeof p['message'] === 'string' ? p['message'] : 'An error was raised.',
          eventId: event.id,
        })
        break
      }

      case 'usage.updated': {
        // The latest total per agent, not a delta — the same reading
        // `transcript.ts` takes, so the two never disagree.
        of(event.actor).spend = {
          inputTokens: numberOf(p['inputTokens']),
          outputTokens: numberOf(p['outputTokens']),
          costUsd: typeof p['costUsd'] === 'number' ? p['costUsd'] : null,
        }
        break
      }

      default:
        break
    }
  }

  const agents = [...work.values()]
    // Only the agents. The user and the system take turns in the log too, but
    // "what each agent did" is the question being asked.
    .filter((w) => w.actor === 'codex' || w.actor === 'claude')
    .map((w): AgentWork => ({
      actor: w.actor,
      turns: w.turns,
      commands: w.commands,
      commandsFailed: w.commandsFailed,
      filesTouched: [...w.files].sort(),
      approvalsAllowed: w.approvalsAllowed,
      approvalsDenied: w.approvalsDenied,
      handoffsSent: w.handoffsSent,
      errors: w.errors,
      spend: w.spend,
    }))
    .sort((a, b) => a.actor.localeCompare(b.actor))

  const priced = agents.some((a) => a.spend.costUsd !== null)
  const spend: Spend = {
    inputTokens: agents.reduce((n, a) => n + a.spend.inputTokens, 0),
    outputTokens: agents.reduce((n, a) => n + a.spend.outputTokens, 0),
    // A zero would be a claim we cannot make when nobody priced.
    costUsd: priced ? agents.reduce((n, a) => n + (a.spend.costUsd ?? 0), 0) : null,
  }

  return {
    agents,
    userMessages,
    problems,
    filesTouched: [...files].sort(),
    spend,
    anything: agents.length > 0 || problems.length > 0 || userMessages > 0,
  }
}

function refOf(payload: Record<string, unknown>): string {
  return typeof payload['itemRef'] === 'string' ? payload['itemRef'] : ''
}

function lineOf(payload: Record<string, unknown>): string {
  const command = payload['command']
  if (!Array.isArray(command)) return ''
  return command.filter((part): part is string => typeof part === 'string').join(' ')
}

function pathsOf(payload: Record<string, unknown>): string[] {
  const list = payload['files']
  if (!Array.isArray(list)) return []
  const paths: string[] = []
  for (const entry of list) {
    if (entry !== null && typeof entry === 'object' && 'path' in entry) {
      const path = (entry as { path: unknown }).path
      if (typeof path === 'string' && path !== '') paths.push(path)
    }
  }
  return paths
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * The prompt behind "Ask an agent".
 *
 * Built from the counted facts rather than left to the agent to rediscover: it
 * already has the transcript, but the log holds decisions the transcript does
 * not spell out — which approvals were denied and by which rule, which commands
 * exited non-zero — and those are exactly what a useful "what is missing" turns
 * on. The questions are asked in the user's own words from the request that
 * prompted this feature.
 */
export function summaryPrompt(summary: SessionSummary): string {
  const lines: string[] = [
    'Summarise this session for me. Answer these five questions, briefly, with a heading each:',
    '',
    '1. What issues were found?',
    '2. What did each agent do to fix them?',
    "3. What's still missing?",
    '4. What new issues surfaced along the way?',
    "5. What's next?",
    '',
    'Here is what the event log records, so you do not have to infer it:',
  ]

  for (const a of summary.agents) {
    lines.push(
      `- ${a.actor}: ${String(a.turns)} turns, ${String(a.commands)} commands ` +
        `(${String(a.commandsFailed)} failed), ${String(a.filesTouched.length)} files touched, ` +
        `${String(a.approvalsAllowed)} approvals allowed, ${String(a.approvalsDenied)} denied.`
    )
  }
  if (summary.filesTouched.length > 0) {
    lines.push(`- Files touched: ${summary.filesTouched.join(', ')}`)
  }
  if (summary.problems.length > 0) {
    lines.push('- Problems recorded:')
    for (const p of summary.problems) lines.push(`  - [${p.actor}] ${p.detail}`)
  }
  lines.push('', 'Be concrete. If you do not know something, say so rather than guessing.')
  return lines.join('\n')
}
