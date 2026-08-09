import type { AgentId, ApprovalId, UserInputId } from '@chorus/shared'
import type { ApprovalDecision } from './approval.js'
import type { UserInputResponse } from './user-input.js'
import type { AgentEvent } from './events.js'

/**
 * Declared, never assumed. The UI hides a Steer button for an agent that cannot
 * steer rather than discovering it at runtime (plan §4.1).
 */
export interface AgentCapabilities {
  readonly interrupt: boolean
  readonly steer: boolean
  readonly fork: boolean
  readonly reasoningStream: boolean
  readonly planStream: boolean
  /** True when the provider emits an aggregate turn diff; false means we derive it from git. */
  readonly aggregateDiff: boolean
  readonly modelSwitchMidSession: boolean
  readonly sandboxPolicy: 'native' | 'emulated' | 'none'
}

export interface SandboxPolicy {
  readonly mode: 'readOnly' | 'workspaceWrite' | 'fullAccess'
  readonly writableRoots: readonly string[]
  readonly networkAccess: boolean
}

/**
 * How the provider decides about file edits, when it can be told.
 *
 * `acceptEdits` is a real handover, not a shortcut: the CLI stops calling the
 * permission callback for edits, so nothing Chorus knows about them applies
 * until the session ends. It is only ever reached by the user saying "always"
 * to an edit, never by a default.
 *
 * `plan` is the opposite kind of thing — a narrowing. The agent reads and
 * reasons and executes nothing, and says it is finished by calling
 * `ExitPlanMode`, which arrives as an ordinary permission request. Approving
 * that is what returns the session to `default`, so the plan and the licence to
 * carry it out are one decision rather than two.
 */
export type ProviderPermissionMode = 'default' | 'acceptEdits' | 'plan'

/**
 * One command a session accepts.
 *
 * Deliberately not a promise about *how* it runs. The CLI knows which of its
 * commands a non-terminal client can invoke and does not say so here — but what
 * `supportedCommands` returns is already the useful set: the project's own
 * commands, its skills, and the built-ins that take text.
 */
export interface SlashCommandInfo {
  readonly name: string
  readonly description: string
  readonly argumentHint: string
}

/**
 * One MCP server, and whether it is any use right now.
 *
 * `needs-auth` is the one that matters: it is not an error, nothing retries it,
 * and the only symptom is an agent quietly lacking a capability you believe it
 * has.
 */
export interface McpServerHealth {
  readonly name: string
  readonly status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  /** Present when it failed, in the provider's words. */
  readonly error?: string
  /** How many tools it is contributing, when it is connected. */
  readonly tools?: number
}

/**
 * Which account the provider is actually signed in as.
 *
 * Every field is optional because most of them do not exist off the first-party
 * API: a Bedrock or Vertex session authenticates against the cloud provider's
 * own credentials, so there is no email and no plan to report. Absent is a
 * normal answer here, not a degraded one.
 */
export interface AccountSummary {
  /** Who is signed in. */
  readonly email?: string
  readonly organization?: string
  /** The plan, in the provider's words — "Claude Max" and the like. */
  readonly plan?: string
  /** Which backend the CLI is talking to: `firstParty`, `bedrock`, `vertex`… */
  readonly provider?: string
}

/** One entry in a model picker: what to send, and what to show. */
export interface ModelChoice {
  readonly value: string
  readonly label: string
  /**
   * Reasoning-effort levels this model accepts, in the provider's own order.
   *
   * Empty for a model with no such control. Per model rather than global
   * because the provider reports it that way — the levels a model supports are
   * a property of the model, and a fixed list would offer `max` on something
   * that silently downgrades it.
   */
  readonly effortLevels?: readonly string[]
}

export interface SessionOpts {
  readonly cwd: string
  readonly model?: string
  readonly sandbox: SandboxPolicy
}

/**
 * A copy of a session, taken to be asked something and then thrown away.
 *
 * A fork is not a resume. Resuming *continues* a session — the provider keeps
 * writing to the same stored transcript, and whatever is said next is part of it
 * forever. A fork branches: it starts knowing everything the original knows, and
 * nothing said in it reaches the original's context or its stored history.
 *
 * That difference is the whole reason asides can be cheap. Measured on both CLIs
 * (see `docs/plans/ask-on-the-fly-2026-08-09/STATUS.md`), forking a session
 * holding ~26k tokens and asking one question cost **two** uncached input tokens,
 * because prompt caching absorbs the inherited context.
 *
 * **Always ephemeral**, rather than a flag: nothing wants a fork that outlives
 * its question, and a persisted one would litter the user's own session history
 * with fragments they never started.
 *
 * **One measured constraint.** A fork inherits the session *as persisted*, so a
 * fork taken while a turn is in flight cannot see that turn — asked about a reply
 * still streaming, it answers that no such reply exists. Fork about what has
 * finished, not about what is arriving.
 */
export interface ForkOpts extends SessionOpts {
  /**
   * What the copy inherits of the user's configuration — hooks, MCP servers,
   * skills, project instructions.
   *
   * An explicit choice at the call site rather than a default buried in an
   * adapter, because it trades two things against each other and neither answer
   * is free: `inherit` keeps the fork faithful to the session it copies, while
   * `none` is faster to first token and makes "this cannot act" a property of
   * the process rather than a promise about it.
   */
  readonly inherits: 'config' | 'nothing'
}

export interface AgentInput {
  readonly text: string
  readonly attachments?: readonly { readonly path: string }[]
}

export type HealthStatus =
  | { readonly state: 'ready'; readonly version: string }
  | { readonly state: 'unauthenticated'; readonly hint: string }
  | { readonly state: 'unavailable'; readonly reason: string }

export interface AgentSession {
  /** Provider-native id — a Codex threadId or a Claude sessionId. */
  readonly sessionRef: string
  /** Starts a turn, or steers the in-flight one when the agent supports it. */
  send(input: AgentInput): Promise<void>
  interrupt(): Promise<void>
  /** Normalized, ordered, at-least-once. */
  readonly events: AsyncIterable<AgentEvent>
  respondToApproval(id: ApprovalId, decision: ApprovalDecision): Promise<void>
  /**
   * Answers a question set. Separate from `respondToApproval` because the two
   * are different acts: an approval is settled by a verdict, a question by
   * content. Sharing one method would mean a decision type that is a verdict
   * *or* a payload, and every caller branching on which.
   */
  respondToUserInput(id: UserInputId, response: UserInputResponse): Promise<void>
  setModel?(model: string): Promise<void>
  /**
   * The models this provider will accept, for a picker that is not guesswork.
   *
   * Optional and allowed to answer empty: the list comes from the running CLI,
   * so a provider that cannot be asked simply offers no choice rather than
   * offering a hardcoded one that may be wrong.
   */
  supportedModels?(): Promise<readonly ModelChoice[]>
  /**
   * The commands this session accepts, as the provider reports them.
   *
   * Per session rather than per machine: the list is built from the project's
   * own `.claude/commands`, its skills and its plugins, so two conversations in
   * two repositories offer different things.
   */
  supportedCommands?(): Promise<readonly SlashCommandInfo[]>
  /**
   * How the MCP servers this session inherited are actually doing.
   *
   * Worth asking because the failures are silent: a server that needs
   * authenticating, or that failed to start, simply has no tools — and an agent
   * with no tools does not complain, it just cannot do the thing.
   */
  mcpServerStatus?(): Promise<readonly McpServerHealth[]>
  /**
   * Which account this session is signed in as.
   *
   * Worth asking in a room that runs several projects at once: the plan window
   * that fills up belongs to an account, and "which one is this?" is otherwise
   * unanswerable from inside Chorus. Returns null when the provider cannot say.
   */
  accountInfo?(): Promise<AccountSummary | null>
  /**
   * Ends one thing the agent left running.
   *
   * Per task rather than "stop everything", because that is the shape the
   * providers offer and the shape the question takes: a backgrounded command is
   * stopped because *that* command is no longer wanted, and the subagent running
   * beside it usually still is.
   */
  stopTask?(taskId: string): Promise<void>
  /**
   * How hard the model should think, for providers that expose the control.
   *
   * Separate from `setModel` because it outlives a model change: the level is a
   * preference about answers, not about which model gives them.
   */
  setEffort?(level: string): Promise<void>
  /**
   * Hands the decision for file edits to the provider itself.
   *
   * Narrower than the provider's own set of modes on purpose: these are the only
   * two Chorus has a meaning for. `default` routes every tool through the
   * permission callback so the policy engine decides; `acceptEdits` lets the CLI
   * accept edits without asking, which is faster and — the part that must never
   * be set quietly — puts them beyond every `fileChange` rule.
   */
  setPermissionMode?(mode: ProviderPermissionMode): Promise<void>
  /**
   * Re-reads the account's usage windows, for providers that can be asked.
   *
   * Optional because not every provider answers: the windows otherwise only
   * arrive after a turn, so a user who has just been cut off has no way to find
   * out they are back without spending something to ask.
   */
  readLimits?(): Promise<void>
  close(): Promise<void>
}

/**
 * The port every provider difference is absorbed behind. If this is right,
 * adding a third agent is a package rather than a refactor.
 */
export interface AgentAdapter {
  readonly id: AgentId
  readonly capabilities: AgentCapabilities
  start(opts: SessionOpts): Promise<AgentSession>
  resume(sessionRef: string, opts: SessionOpts): Promise<AgentSession>
  /**
   * Branches a session rather than continuing it — see `ForkOpts`.
   *
   * Optional, and paired with `capabilities.fork`, the way `setModel` is paired
   * with `modelSwitchMidSession`: the flag is the promise, this is the
   * implementation, and a provider that cannot branch declares false and omits
   * the method rather than throwing when called.
   */
  fork?(sessionRef: string, opts: ForkOpts): Promise<AgentSession>
  /** Also reports the underlying CLI version, which is recorded on session.started (plan §2.5). */
  health(): Promise<HealthStatus>
  dispose(): Promise<void>
  /**
   * Gives a provider's own record of a session the name the user chose.
   *
   * On the adapter rather than the session, deliberately: a conversation can be
   * renamed long after its agents have stopped, and the thing being retitled is
   * the provider's stored session rather than a running one.
   *
   * Chorus's log stays authoritative for Chorus's own history — this exists so
   * that a room named here is recognisable if the same session is later resumed
   * in the provider's own client, rather than sitting under an auto-generated
   * summary of its first prompt.
   *
   * Optional, and best-effort by contract: a provider with no such concept
   * simply does not implement it, and a session the provider has forgotten is
   * not an error worth surfacing.
   */
  renameSession?(sessionRef: string, title: string, cwd: string): Promise<void>
}
