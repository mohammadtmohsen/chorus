import type { AgentAdapter, AgentSession, SessionOpts } from './adapter.js'
import type { AgentEvent } from './events.js'

/**
 * The contract every adapter must satisfy, expressed once and run against all of
 * them.
 *
 * Plan §8 calls this out as what keeps "agent independent" true rather than
 * aspirational: if the real adapters cannot pass the same suite the in-memory
 * fake passes, they are not interchangeable and the `AgentAdapter` port is a
 * fiction.
 *
 * It lives in `agent-protocol` rather than in a test folder because it is part
 * of the port's definition — a new adapter should be able to import it on day
 * one, before it has any tests of its own.
 */

export interface ConformanceHarness {
  readonly name: string
  /** A ready-to-drive adapter plus whatever drives its underlying provider. */
  readonly create: () => Promise<ConformanceTarget>
}

export interface ConformanceTarget {
  readonly adapter: AgentAdapter
  /** Makes the provider emit a short assistant message on the active session. */
  readonly emitMessage: (session: AgentSession, text: string) => void | Promise<void>
  /** Makes the provider ask for a command approval. */
  readonly emitApprovalRequest?: (session: AgentSession) => void | Promise<void>
  /** Ends the provider's stream *without* a clean close, as a crash would. */
  readonly killProvider: (session: AgentSession) => void | Promise<void>
  readonly dispose?: () => Promise<void>
}

export const CONFORMANCE_OPTS: SessionOpts = {
  cwd: '/tmp/conformance',
  sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
}

/**
 * Collects up to `max` events, stopping early when the stream ends.
 *
 * Deliberately timer-free: this package stays environment-agnostic (no Node
 * types, no DOM), and a caller that wants a deadline should end the stream
 * itself — which is what every conformance case does anyway.
 */
export async function collectEvents(session: AgentSession, max: number): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  for await (const event of session.events) {
    seen.push(event)
    if (seen.length >= max) break
  }
  return seen
}

/**
 * The invariants themselves, as plain assertions so any runner can host them.
 * Each returns a failure message, or null when it holds.
 */
export const CONFORMANCE_CHECKS = {
  /** Capabilities must be declared, because the UI branches on them (§4.1). */
  declaresCapabilities(adapter: AgentAdapter): string | null {
    const c = adapter.capabilities
    const required = [
      'interrupt',
      'steer',
      'fork',
      'reasoningStream',
      'planStream',
      'aggregateDiff',
      'modelSwitchMidSession',
    ] as const
    for (const key of required) {
      if (typeof c[key] !== 'boolean') return `capabilities.${key} must be a boolean`
    }
    if (!['native', 'emulated', 'none'].includes(c.sandboxPolicy)) {
      return `capabilities.sandboxPolicy is "${c.sandboxPolicy}"`
    }
    return null
  },

  /** A session must expose a provider-native reference so it can be resumed. */
  exposesSessionRef(session: AgentSession): string | null {
    return typeof session.sessionRef === 'string' ? null : 'sessionRef must be a string'
  },

  /** Sequence numbers must be strictly increasing — the log's ordering leans on it. */
  monotonicSeq(events: readonly AgentEvent[]): string | null {
    for (let i = 1; i < events.length; i++) {
      const previous = events[i - 1]
      const current = events[i]
      if (previous === undefined || current === undefined) continue
      if (current.seq <= previous.seq) {
        return `seq went ${String(previous.seq)} -> ${String(current.seq)} at index ${String(i)}`
      }
    }
    return null
  },

  /** Every event must name the agent that produced it. */
  stampsAgentId(adapter: AgentAdapter, events: readonly AgentEvent[]): string | null {
    const wrong = events.find((e) => e.agentId !== adapter.id)
    return wrong === undefined ? null : `event ${wrong.type} carried agentId "${wrong.agentId}"`
  },

  /**
   * A dead provider must end the stream. The supervisor's crash detection keys
   * on exactly this, and an adapter that keeps a stream open after the process
   * dies looks alive while silently doing nothing — the M2 bug this exists to
   * prevent recurring.
   */
  endsStreamWhenProviderDies(ended: boolean): string | null {
    return ended ? null : 'event stream stayed open after the provider died'
  },
} as const
