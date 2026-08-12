import { z } from 'zod'
import { WorkspaceSnapshot } from './workspace-layout.js'

/**
 * The single source of truth for the IPC surface.
 *
 * Main validates every inbound payload and every outbound result; the preload
 * validates too, so our own bugs surface at the boundary instead of deeper in.
 * A channel that is not in this map does not exist (plan §4.4).
 */

export const AgentProbeResult = z.object({
  id: z.enum(['codex', 'claude']),
  installed: z.boolean(),
  version: z.string().nullable(),
  /** Populated when the CLI is missing or not on PATH. */
  problem: z.string().nullable(),
})
export type AgentProbeResult = z.infer<typeof AgentProbeResult>

export const AppInfo = z.object({
  appVersion: z.string(),
  electronVersion: z.string(),
  nodeVersion: z.string(),
  chromeVersion: z.string(),
  platform: z.string(),
  /*
   * Home, so the renderer can tell "no folder chosen" from "a folder that
   * happens to be home".
   *
   * An empty directory has always meant "start at home" — the runtime resolves
   * it that way on both `startConversation` and `setProjectDirectory`, because
   * a directory is a starting point rather than a boundary. But it resolves it
   * *before* the renderer ever sees it, so a session that was never given a
   * project looked identical to one deliberately pointed at home, and there was
   * no way to say "no particular folder" back.
   */
  home: z.string(),
})
export type AppInfo = z.infer<typeof AppInfo>

/** Mirrors `StoredEvent` from the event store, minus its branded types. */
export const TranscriptEvent = z.object({
  seq: z.number().int(),
  id: z.string(),
  conversationId: z.string(),
  actor: z.enum(['user', 'system', 'codex', 'claude']),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number().int(),
})
export type TranscriptEvent = z.infer<typeof TranscriptEvent>

/** Defaults for a new session. Zoom is not here: it lasts one launch. */
/**
 * The longest a language may be.
 *
 * Not a guess at how long a language name is — a bound on what a free-text field
 * can do to everything downstream. The value reaches a prompt and, if the offer
 * ever names it, a button: unbounded, it makes one enormous and the other wider
 * than the pane, and no amount of measuring rescues a button that cannot fit.
 * Forty is comfortably past "Lebanese Arabic" and nowhere near a paragraph.
 */
export const MAX_EXPLAIN_LANGUAGE = 40

/**
 * What the field accepts, applied wherever it is read or written.
 *
 * Free text is the point — "Lebanese Arabic" and "simple Arabic" are answers a
 * locale list cannot express. Free is not unconstrained, though: a pasted
 * newline would make a one-line control look empty while holding content, and
 * whitespace alone would produce an action that appears to do nothing. Both
 * collapse to the same normalisation rather than being rejected, because a paste
 * should not become an error message.
 */
export function normaliseExplainLanguage(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_EXPLAIN_LANGUAGE)
}

export const SettingsShape = z.object({
  agents: z.array(z.enum(['codex', 'claude'])),
  cwd: z.string(),
  profileId: z.string(),
  /** Empty means the provider's own choice, which is not a model name. */
  model: z.string().default(''),
  effortLevel: z.string().default(''),
  /** Per agent, because the two providers share no model. */
  models: z
    .object({ codex: z.string().default(''), claude: z.string().default('') })
    .default({ codex: '', claude: '' }),
  efforts: z
    .object({ codex: z.string().default(''), claude: z.string().default('') })
    .default({ codex: '', claude: '' }),
  /**
   * The language an explanation comes back in. Empty means the action is not
   * offered — see the plan: there is no sensible guess at someone's own language,
   * and the system locale is a fact about the machine rather than the person.
   */
  explainLanguage: z.string().default('').transform(normaliseExplainLanguage),
})

export const ApprovalChoice = z.object({
  conversationId: z.string(),
  /** Which agent asked — several can have approvals pending at once. */
  agentId: z.enum(['codex', 'claude']),
  approvalId: z.string(),
  outcome: z.enum(['allow', 'deny', 'cancel']),
  /**
   * `always` outlives the app; `session` dies with it.
   *
   * The third is here because the second was a promise Chorus could not keep for
   * an MCP call: those may never be auto-decided, so "allow for this session" was
   * refused and the same tool asked again on every call, forever.
   */
  scope: z.enum(['once', 'session', 'always']),
})
export type ApprovalChoice = z.infer<typeof ApprovalChoice>

/**
 * An answer to a question set, on its way back to the agent that asked.
 *
 * `timeout` is not in the outcome list on purpose. The deadline belongs to the
 * orchestrator, which holds the timer; letting the window send one would let the
 * UI declare a question expired before it was.
 *
 * `values` is an array even for a single choice, because that is Codex's wire
 * format and flattening it here would lose multi-select on the way back.
 */
export const QuestionAnswer = z.object({
  conversationId: z.string(),
  /** Which agent asked — several can be waiting at once in a shared room. */
  agentId: z.enum(['codex', 'claude']),
  userInputId: z.string(),
  outcome: z.enum(['answered', 'cancel']),
  answers: z.array(z.object({ questionId: z.string(), values: z.array(z.string()) })),
})
export type QuestionAnswer = z.infer<typeof QuestionAnswer>

/**
 * One entry per operation, each with its own request/response schema. Adding a
 * channel means adding it here first — `contextBridge` is generated from this.
 */
/**
 * What Chorus can say about a conversation's editor (plan §3).
 *
 * Mirrors the protocol's status list exactly; the renderer gives every member
 * localized text, and `ready` is the only one that draws the card.
 */
export const IdeStatusShape = z.enum([
  'unavailable',
  'unmatched',
  'untrusted',
  'unsupported',
  'ambiguous',
  'tooLarge',
  'ready',
])
export type IdeStatusShape = z.infer<typeof IdeStatusShape>

/**
 * The live frame the renderer sees.
 *
 * Note what is *not* here: no absolute path, no file URL, and no source text.
 * The renderer is given a path already relative to the conversation's own cwd,
 * so a pane cannot display — or leak into a screenshot — where the project sits
 * on disk, and cannot show a byte of code before Send.
 */
export const IdeContextPush = z.object({
  conversationId: z.string(),
  status: IdeStatusShape,
  file: z
    .object({
      relativePath: z.string(),
      /** One-based and inclusive; converted once, at the protocol boundary. */
      startLine: z.number().int(),
      endLine: z.number().int(),
      isEmpty: z.boolean(),
      isDirty: z.boolean(),
      languageId: z.string(),
      selectedBytes: z.number().int(),
    })
    .nullable(),
})
export type IdeContextPush = z.infer<typeof IdeContextPush>

/** The answer to a Send-time snapshot request. */
export const IdeSnapshotResult = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ok'),
    relativePath: z.string(),
    startLine: z.number().int(),
    endLine: z.number().int(),
    isEmpty: z.boolean(),
    isDirty: z.boolean(),
    languageId: z.string(),
    text: z.string(),
  }),
  z.object({ outcome: z.literal('unavailable'), reason: IdeStatusShape }),
  z.object({ outcome: z.literal('tooLarge'), selectedBytes: z.number().int() }),
])
export type IdeSnapshotResult = z.infer<typeof IdeSnapshotResult>

/**
 * Which terminal — a discriminated union, never a nullable conversation id.
 *
 * The global terminal belongs to no conversation. Flattening that to a nullable
 * field, or to a `'global'` sentinel sharing a namespace with real ids, is how
 * it ends up deleted by something iterating conversations. As a union an unknown
 * scope is a parse failure at this boundary rather than a lookup miss three
 * layers in.
 */
export const TerminalRefShape = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global') }),
  z.object({ scope: z.literal('session'), conversationId: z.string() }),
])
export type TerminalRefShape = z.infer<typeof TerminalRefShape>

export const IPC_CONTRACT = {
  'app:getInfo': { request: z.void(), response: AppInfo },
  /**
   * Reads the installed `codex` and `claude` versions. These get recorded on
   * `session.started` so a break after a CLI self-update is visible in the log
   * rather than a guess (plan §2.5).
   */
  'agents:probe': { request: z.void(), response: z.array(AgentProbeResult) },

  'conversation:start': {
    /** Several agents share one conversation — that is the point of Chorus. */
    request: z.object({
      agents: z.array(z.enum(['codex', 'claude'])).min(1),
      /** Empty means "start at home" — a directory is a starting point, not a boundary. */
      cwd: z.string(),
      profileId: z.string().optional(),
    }),
    response: z.object({
      conversationId: z.string(),
      participants: z.array(z.enum(['codex', 'claude'])),
      profileId: z.string(),
      /** Where the session actually started, which may not be what was asked for. */
      cwd: z.string(),
      /** Defaults to the folder's name; the user can rename it. */
      title: z.string(),
    }),
  },
  'conversation:send': {
    request: z.object({ conversationId: z.string(), text: z.string().min(1) }),
    /** Which agents the mention router picked, so the UI can show it. */
    response: z.object({ targets: z.array(z.enum(['codex', 'claude'])) }),
  },
  'conversation:interrupt': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },
  /**
   * Replays from the log rather than from provider history — Codex discards
   * partial assistant output, so the log is the only complete record (S3).
   */
  /**
   * Ends one conversation. Others keep running — the grid holds several at once,
   * and closing one pane must not touch the agents in the next.
   */
  /**
   * Brings an agent in, or takes one out, without ending the conversation.
   * A joining agent reads the whole transcript on the first thing it is asked.
   */
  'conversation:addAgent': {
    request: z.object({ conversationId: z.string(), agentId: z.enum(['codex', 'claude']) }),
    response: z.object({ agentId: z.enum(['codex', 'claude']) }),
  },
  'conversation:removeAgent': {
    request: z.object({ conversationId: z.string(), agentId: z.enum(['codex', 'claude']) }),
    response: z.object({ agentId: z.enum(['codex', 'claude']) }),
  },

  /**
   * Asks for a directory with the system's folder chooser, and applies it.
   *
   * One call rather than "pick" then "set": the chosen path never has to cross
   * back through the renderer, and a cancelled dialog cannot leave the two
   * halves disagreeing about where the conversation is.
   */
  /**
   * Reopens what was on screen when the app last ran.
   *
   * Called once, at startup. Returns an empty list when nothing was open, which
   * is the same shape as a first launch.
   */
  'conversation:restore': {
    request: z.object({}),
    response: z.object({
      sessions: z.array(
        z.object({
          conversationId: z.string(),
          participants: z.array(z.enum(['codex', 'claude'])),
          profileId: z.string(),
          cwd: z.string(),
          title: z.string(),
          /** Counted out of the log against the saved watermark, not remembered. */
          unread: z.number().int().min(0),
          /** A message typed and not sent when the app last closed. */
          draft: z.string().default(''),
          /** Reading and reasoning, executing nothing. Never survives a restart. */
          planning: z.boolean().default(false),
        })
      ),
      workspace: WorkspaceSnapshot.nullable(),
    }),
  },

  /**
   * How the inherited MCP servers are doing.
   *
   * Asked live every time, because a server's health is the thing that changes
   * — it can drop, or come back once authenticated — and a cached answer would
   * be worse than none.
   */
  'agents:mcp': {
    request: z.object({}),
    response: z.object({
      servers: z.array(
        z.object({
          name: z.string(),
          status: z.enum(['connected', 'failed', 'needs-auth', 'pending', 'disabled']),
          error: z.string().optional(),
          tools: z.number().int().optional(),
        })
      ),
    }),
  },

  /**
   * Which account each agent is signed in as.
   *
   * Asked live for the same reason as the servers: signing in somewhere else
   * changes the answer while the app is running. Every field is optional
   * because off the first-party API most of them do not exist — a Bedrock
   * session has credentials, not a plan.
   */
  /**
   * Ends one thing an agent left running.
   *
   * Carries the agent because a task id belongs to the provider that issued it.
   * Answers `ok` once the request is delivered, not once the task is gone — the
   * next push is what reports that.
   */
  'tasks:stop': {
    request: z.object({
      conversationId: z.string(),
      agentId: z.enum(['codex', 'claude']),
      taskId: z.string(),
    }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * The user's installed plugins, and whether they are switched on.
   *
   * Read from the CLI each time rather than cached: a plugin can be enabled or
   * removed while Chorus is running, and the sheet is opened precisely when
   * someone wants to know the current answer.
   */
  'agents:plugins': {
    request: z.object({}),
    response: z.object({
      plugins: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          enabled: z.boolean(),
          scope: z.string(),
          version: z.string().optional(),
        })
      ),
    }),
  },

  'agents:account': {
    request: z.object({}),
    response: z.object({
      accounts: z.array(
        z.object({
          agentId: z.string(),
          email: z.string().optional(),
          organization: z.string().optional(),
          plan: z.string().optional(),
          provider: z.string().optional(),
        })
      ),
    }),
  },

  /**
   * The model lists last reported by each agent, for the settings sheet.
   *
   * A cache rather than a live ask: `supportedModels()` is a control request to
   * a running CLI, and the sheet can be opened with nothing running. The list
   * does not change under an installed CLI, so the one a session already
   * answered with is the right one to remember.
   */
  'agents:models': {
    request: z.object({}),
    response: z.object({
      agents: z.array(
        z.object({
          agentId: z.enum(['codex', 'claude']),
          /**
           * Why the list is what it is. An empty `ready` and an empty `failed`
           * look identical without this, and the sheet has to say different
           * things about them.
           */
          status: z.enum(['unqueried', 'loading', 'ready', 'failed']),
          models: z.array(
            z.object({
              /** The provider's own default, when it names one. See `ModelChoice`. */
              isDefault: z.boolean().optional(),
              value: z.string(),
              label: z.string(),
              effortLevels: z.array(z.string()).default([]),
            })
          ),
        })
      ),
    }),
  },

  /**
   * Every conversation the log holds, most recently active first.
   *
   * A query rather than a push: it is only wanted when someone opens the list,
   * and the answer is a projection read that is cheap to repeat.
   */
  'conversation:list': {
    request: z.object({}),
    response: z.object({
      conversations: z.array(
        z.object({
          conversationId: z.string(),
          title: z.string(),
          cwd: z.string(),
          agents: z.array(z.string()),
          updatedAt: z.number().int(),
          messages: z.number().int(),
          /** Already on screen, so choosing it focuses rather than reopens. */
          open: z.boolean(),
        })
      ),
    }),
  },

  /**
   * Brings a past conversation back with its transcript.
   *
   * Its agents are started rather than resumed — the provider threads died with
   * the session — so they read the history as catch-up on the first thing asked.
   */
  'conversation:reopen': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({
      conversationId: z.string(),
      participants: z.array(z.enum(['codex', 'claude'])),
      profileId: z.string(),
      cwd: z.string(),
      title: z.string(),
      unread: z.number().int().min(0),
    }),
  },

  /**
   * Files in the conversation's project, for the composer's `@` menu.
   *
   * The renderer has no filesystem access and the SDK gives no way to reach the
   * CLI's own matcher, so the search happens here. Asked per keystroke, which
   * is why it is a query rather than a list handed over once.
   */
  /*
   * `state` travels beside the list because an empty list is two different
   * answers. Git saying "nothing matches" is a result; git not running at all is
   * a question still outstanding, and folding both into `[]` is what let a menu
   * go empty and stay empty (C-003). `files` is always present and always empty
   * unless the state is `ready`.
   */
  'files:complete': {
    request: z.object({ conversationId: z.string(), query: z.string() }),
    response: z.object({
      state: z.enum(['ready', 'retryable', 'unavailable']),
      files: z.array(z.string()),
    }),
  },

  /**
   * The slash commands this conversation's agents accept.
   *
   * A query rather than a push: the menu asks when it opens, and the answer is
   * cached in the runtime for the life of each session.
   */
  'conversation:commands': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({
      commands: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          argumentHint: z.string(),
        })
      ),
    }),
  },

  /**
   * Puts a conversation's agents into plan mode, or takes them out.
   *
   * Returns what the mode actually is afterwards, so a control cannot show a
   * state the session did not reach.
   */
  'conversation:planMode': {
    request: z.object({ conversationId: z.string(), on: z.boolean() }),
    response: z.object({ planning: z.boolean() }),
  },

  /**
   * Remembers a message typed and not sent.
   *
   * Renderer-driven and debounced there, because it owns the keystrokes. Losing
   * one costs the last second of typing, which is why it is fire-and-forget.
   */
  'conversation:draft': {
    request: z.object({ conversationId: z.string(), draft: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * Records how far a conversation's card has been read.
   *
   * Renderer-driven because only it knows which tab is in front, and "read"
   * means "was on screen". Fire-and-forget: losing one costs a card that says
   * two unread instead of none after the next launch.
   */
  'conversation:markSeen': {
    request: z.object({ conversationId: z.string(), seq: z.number().int().min(0) }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * Starts the same room again with nothing said in it.
   *
   * Returns a *new* conversation: the old transcript stays in the log rather
   * than being erased, and the agents get fresh sessions rather than a context
   * they were asked to ignore.
   */
  'conversation:restart': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({
      conversationId: z.string(),
      participants: z.array(z.enum(['codex', 'claude'])),
      profileId: z.string(),
      cwd: z.string(),
      title: z.string(),
    }),
  },

  /**
   * Writes pasted bytes down and returns the path.
   *
   * Base64 because the bridge carries JSON; a screenshot is a few megabytes
   * once, which is cheaper than teaching the whole protocol about binaries.
   */
  'files:stash': {
    request: z.object({ name: z.string(), base64: z.string() }),
    response: z.object({ path: z.string() }),
  },

  /** Enough to show an attachment: its name, its size, and a preview if it has one. */
  'files:preview': {
    request: z.object({ path: z.string() }),
    response: z.object({
      name: z.string(),
      bytes: z.number(),
      dataUrl: z.string().nullable(),
    }),
  },

  /**
   * Persists the whole arrangement in one write.
   *
   * `order` is the **sidebar's** order of running conversations, and only that.
   * Each pane's tab order lives inside `workspace`, where it belongs — the two
   * were briefly both called "order", which is exactly how they would have
   * drifted apart.
   */
  /**
   * Asks every live agent to re-read its account's usage windows.
   *
   * The windows otherwise only arrive after a turn, so someone who has just
   * been cut off can only find out they are back by spending something. The
   * answer comes back on the limits push, not here — this only asks.
   */
  'limits:refresh': { request: z.void(), response: z.object({ ok: z.literal(true) }) },

  /**
   * The dock badge, set by the renderer because only it knows how many rooms are
   * blocked on a person. Main owns the API; the count is not main's to compute.
   */
  'app:setBadge': {
    request: z.object({ count: z.number().int().min(0) }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Brings Chorus forward — what clicking a notification has to do first. */
  'app:focus': { request: z.void(), response: z.object({ ok: z.literal(true) }) },

  'conversation:layout': {
    request: z.object({ order: z.array(z.string()), workspace: WorkspaceSnapshot }),
    response: z.object({ ok: z.literal(true) }),
  },

  /** Names a conversation. An empty name asks for the folder's name back. */
  'conversation:rename': {
    request: z.object({ conversationId: z.string(), title: z.string() }),
    response: z.object({ title: z.string() }),
  },

  'conversation:chooseCwd': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({ cwd: z.string(), title: z.string(), changed: z.boolean() }),
  },

  /** Repoints the conversation's project directory while it is open. */
  'conversation:setCwd': {
    request: z.object({ conversationId: z.string(), cwd: z.string() }),
    /** The title comes back because an untouched one follows the folder. */
    response: z.object({ cwd: z.string(), title: z.string() }),
  },
  'conversation:close': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },
  'conversation:history': {
    request: z.object({ conversationId: z.string(), afterSeq: z.number().int().optional() }),
    response: z.array(TranscriptEvent),
  },
  'approval:decide': {
    request: ApprovalChoice,
    response: z.object({ ok: z.literal(true) }),
  },
  'userinput:answer': {
    request: QuestionAnswer,
    response: z.object({ ok: z.literal(true) }),
  },
  /**
   * Builds the packet that would cross to another agent, without sending it.
   * The user edits this before anything moves (plan §4.5).
   */
  'handoff:prepare': {
    request: z.object({
      conversationId: z.string(),
      from: z.enum(['codex', 'claude']),
      to: z.enum(['codex', 'claude']),
      sourceEventIds: z.array(z.string()).min(1),
      includeDiff: z.boolean().optional(),
      intent: z.enum(['implement', 'review', 'discuss']).optional(),
      note: z.string().optional(),
    }),
    response: z.object({
      brief: z.string(),
      intent: z.enum(['implement', 'review', 'discuss']),
      summary: z.string(),
      sourceCount: z.number().int(),
    }),
  },
  'handoff:send': {
    request: z.object({
      conversationId: z.string(),
      from: z.enum(['codex', 'claude']),
      to: z.enum(['codex', 'claude']),
      sourceEventIds: z.array(z.string()),
      brief: z.string().min(1),
    }),
    response: z.object({ handoffId: z.string() }),
  },
  /**
   * A small question about one passage of one reply, asked in a fork.
   *
   * `excerpt` is sent so main can check it against what the log actually holds,
   * not so main can trust it. The renderer is the least trustworthy thing in the
   * process tree — it renders untrusted agent output — and a caller that could
   * name any event and any excerpt could put words in an agent's mouth and have
   * them quoted back as its own.
   *
   * There is no `aside:history`: an aside is a conversation, so
   * `conversation:history` already reads it, and its events reach the renderer
   * on the same push channel as everything else.
   */
  'aside:open': {
    request: z.object({
      conversationId: z.string(),
      sourceEventId: z.string(),
      excerpt: z.string().min(1),
      /**
       * Usually absent. The card opens the aside as soon as it appears so the
       * CLI boots while the user types, and sends the question separately —
       * about two thirds of the measured wait was process startup rather than
       * the agent, and this is what moves it off the critical path.
       */
      question: z.string().min(1).optional(),
      /**
       * `explanation` carries its own first turn — main reads the language and
       * builds the prompt, because prompt content from the renderer is the same
       * class of problem as an unverified source event.
       */
      purpose: z.enum(['question', 'explanation', 'translation']).optional(),
    }),
    /**
     * The language main actually used, echoed back.
     *
     * The renderer keeps its own copy for the button's label, and that copy can
     * be a moment stale — long enough for a card to say Arabic while the prompt
     * and the log say French. Main is authoritative, so it says which it was.
     */
    response: z.object({ asideId: z.string(), language: z.string() }),
  },
  /** A follow-up, which only works while the fork is still alive. */
  'aside:ask': {
    request: z.object({ asideId: z.string(), question: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
  },
  /**
   * Turns an aside into a conversation of its own, able to act.
   *
   * The profile is chosen here rather than inherited: it is the explicit act
   * that makes acting safe, and a room that silently arrived with the parent's
   * permissions would be the thing the aside design refused.
   */
  'aside:promote': {
    request: z.object({ asideId: z.string(), profileId: z.string() }),
    /*
     * The whole session, as `conversation:reopen` returns — not just the id.
     *
     * Promotion decides the room's profile, title and cwd, and a renderer that
     * had to guess any of them would put a tab on screen describing something
     * other than what was opened.
     */
    response: z.object({
      conversationId: z.string(),
      participants: z.array(z.enum(['codex', 'claude'])),
      profileId: z.string(),
      cwd: z.string(),
      title: z.string(),
      unread: z.number().int().min(0),
    }),
  },
  /** Ends the fork. The transcript stays in the log. */
  'aside:close': {
    request: z.object({ asideId: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** What has already been asked about a conversation, or about one reply in it. */
  'aside:list': {
    request: z.object({ conversationId: z.string(), sourceEventId: z.string().optional() }),
    response: z.array(
      z.object({
        id: z.string(),
        sourceEventId: z.string(),
        title: z.string(),
        createdAt: z.number().int(),
      })
    ),
  },
  /**
   * The repository as it stands on disk, not as the log describes it. Those
   * differ after a crash, a manual edit, or a denied approval.
   */
  'workspace:read': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({
      status: z.object({
        branch: z.string().nullable(),
        upstream: z.string().nullable(),
        ahead: z.number().int(),
        behind: z.number().int(),
        clean: z.boolean(),
        files: z.array(
          z.object({
            path: z.string(),
            from: z.string().optional(),
            state: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked', 'conflicted']),
            staged: z.boolean(),
            unstaged: z.boolean(),
          })
        ),
      }),
      diff: z.array(
        z.object({
          path: z.string(),
          oldPath: z.string(),
          added: z.number().int(),
          removed: z.number().int(),
          binary: z.boolean(),
          hunks: z.array(
            z.object({
              header: z.string(),
              lines: z.array(
                z.object({
                  kind: z.enum(['context', 'added', 'removed', 'meta']),
                  text: z.string(),
                  before: z.number().int().optional(),
                  after: z.number().int().optional(),
                })
              ),
            })
          ),
        })
      ),
      problem: z.string().nullable(),
    }),
  },
  /** Recent log entries, already redacted as they were written. */
  /**
   * What a new session starts with. Defaults only — a session still chooses its
   * own agents, directory and profile.
   */
  'settings:read': {
    request: z.object({}),
    response: SettingsShape,
  },
  /**
   * Holds a question's deadline off while someone is answering it.
   *
   * `engaged: true` means a gesture the app cannot manufacture — an option
   * chosen, text typed, a step taken. Focus does not count: the card focuses
   * itself on mount, so a rule that trusted focus would extend the deadline the
   * instant the card appeared, with no person involved.
   *
   * `engaged: false` reads the deadline in force and changes nothing, which is
   * how a card that has just remounted learns the current one instead of
   * replaying the original `expiresAt` from the log.
   */
  'userinput:extend': {
    request: z.object({
      conversationId: z.string(),
      userInputId: z.string(),
      engaged: z.boolean(),
    }),
    /** Null when the question has already been answered or has expired. */
    response: z.object({ expiresAt: z.number().nullable() }),
  },

  /** A patch: sending only what changed keeps one field from clobbering another. */
  'settings:write': {
    /*
     * `.partial()` only reaches the top level, so the per-agent maps would still
     * demand both agents — and a caller setting one agent's model would have to
     * send the other's too, which is how the value gets clobbered in the first
     * place. Their fields are optional here, and main merges a level deeper.
     */
    request: SettingsShape.partial().extend({
      models: z.object({ codex: z.string(), claude: z.string() }).partial().optional(),
      efforts: z.object({ codex: z.string(), claude: z.string() }).partial().optional(),
    }),
    response: SettingsShape,
  },
  'diagnostics:read': {
    request: z.void(),
    response: z.array(
      z.object({
        at: z.number().int(),
        level: z.enum(['debug', 'info', 'warn', 'error']),
        message: z.string(),
        fields: z.record(z.string(), z.unknown()).optional(),
      })
    ),
  },
  /** Writes a bundle to disk and returns where it landed. */
  'diagnostics:export': {
    request: z.void(),
    response: z.object({ path: z.string() }),
  },
  /** The permission profiles a conversation can be started under. */
  /** Changes what agents may do without asking, in a conversation already open. */
  'policy:set': {
    request: z.object({ conversationId: z.string(), profileId: z.string() }),
    response: z.object({ profileId: z.string() }),
  },
  'policy:profiles': {
    request: z.void(),
    response: z.array(z.object({ id: z.string(), name: z.string(), summary: z.string() })),
  },

  /**
   * The selected text, asked for at Send (plan §5).
   *
   * Separate from the live push because it is the only moment source code
   * crosses into Chorus, and it happens because the user pressed a button.
   */
  /**
   * Whether the companion extension is installed and current.
   *
   * Answered even when VS Code is absent: the renderer needs to know the
   * difference between "no `code` command" and "not installed yet" in order to
   * offer the right thing, or nothing at all.
   */
  'ide:extensionStatus': {
    request: z.object({}),
    response: z.object({
      cliAvailable: z.boolean(),
      installedVersion: z.string().nullable(),
      bundledVersion: z.string().nullable(),
      need: z.enum(['none', 'install', 'update']),
    }),
  },

  'ide:installExtension': {
    request: z.object({}),
    response: z.object({ ok: z.boolean(), reason: z.string().nullable() }),
  },

  /** Open this conversation's folder in VS Code. */
  'ide:openProject': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({ ok: z.boolean(), reason: z.string().nullable() }),
  },

  'ide:snapshot': {
    request: z.object({ conversationId: z.string() }),
    response: IdeSnapshotResult,
  },

  /**
   * Mount a terminal view, spawning its shell if nothing has yet.
   *
   * Returns the screen as escape sequences rather than a suffix of raw output,
   * because VT state is cumulative and a trimmed byte ring loses the
   * alternate-screen entry and the colour that came before it — `vim` remounts
   * blank. The `epoch` supersedes any previous attachment and stamps everything
   * after it.
   */
  'terminal:attach': {
    request: z.object({
      ref: TerminalRefShape,
      cols: z.number().int().min(1).optional(),
      rows: z.number().int().min(1).optional(),
    }),
    response: z.object({
      epoch: z.number().int(),
      snapshot: z.string(),
      seq: z.number().int(),
      cols: z.number().int(),
      rows: z.number().int(),
    }),
  },

  /**
   * Unmount a view. **This is not a kill** — the shell keeps running.
   *
   * React effect cleanup calls this, and only this. If it disposed, backgrounding
   * a tab would kill a running build, which is the whole reason the PTY lives in
   * main rather than beside the component.
   */
  'terminal:detach': {
    request: z.object({ ref: TerminalRefShape, epoch: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /** Kill the shell. A conversation ending, or the user asking explicitly. */
  'terminal:dispose': {
    request: z.object({ ref: TerminalRefShape, epoch: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
  },

  'terminal:write': {
    request: z.object({ ref: TerminalRefShape, epoch: z.number().int(), data: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /** New geometry, so `SIGWINCH` fires and `vim` reflows. */
  'terminal:resize': {
    request: z.object({
      ref: TerminalRefShape,
      epoch: z.number().int(),
      cols: z.number().int().min(1),
      rows: z.number().int().min(1),
    }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * The view has consumed output up to `seq`.
   *
   * The wire half of flow control. Without it the watermark can only see the
   * headless mirror in main, and a renderer that cannot keep up accumulates an
   * unbounded queue in the process that must not stall.
   */
  'terminal:ack': {
    request: z.object({ ref: TerminalRefShape, epoch: z.number().int(), seq: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * Throw away the scrollback, as `⌘K` does in Terminal.app.
   *
   * Goes through main because the snapshot a remount restores from lives there:
   * clearing only the view would put every cleared line back on the next tab
   * switch. The shell is not told — `⌘K` is a display action, and a half-typed
   * command survives it.
   */
  'terminal:clear': {
    request: z.object({ ref: TerminalRefShape, epoch: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /** Whether killing this would lose work, for a confirmation to decide on. */
  'terminal:describe': {
    request: z.object({ ref: TerminalRefShape }),
    response: z
      .object({ running: z.boolean(), foreground: z.string(), busy: z.boolean() })
      .nullable(),
  },
} as const

/**
 * Main-to-renderer push. Separate from the request/response contract because it
 * flows the other way and has no reply.
 */
export const EVENTS_PUSH_CHANNEL = 'conversation:events'

/**
 * The editor context for each open conversation, pushed as it changes.
 *
 * A push rather than a query because the whole point is that it follows what
 * the user is doing in another application; polling would show them where they
 * were.
 */
export const IDE_PUSH_CHANNEL = 'ide:context'

/**
 * The window's zoom factor, pushed whenever it changes.
 *
 * Zoom is owned by the menu, so the renderer has no other way to learn it — and
 * it needs to, in order to say what just happened.
 */
export const SCALE_PUSH_CHANNEL = 'settings:scale'

/**
 * Account usage windows, pushed as providers report them.
 *
 * A push rather than a query because nothing asks: the numbers arrive when an
 * agent happens to talk to its provider, and a header that only updated when you
 * opened something would be showing you yesterday.
 */
export const LIMITS_PUSH_CHANNEL = 'agents:limits'

export const UsageWindowShape = z.object({
  id: z.string(),
  usedPercent: z.number().nullable(),
  windowMinutes: z.number().nullable(),
  resetsAt: z.number().nullable(),
})
export type UsageWindowShape = z.infer<typeof UsageWindowShape>

export const LimitsPush = z.object({
  agentId: z.enum(['codex', 'claude']),
  windows: z.array(UsageWindowShape),
})
export type LimitsPush = z.infer<typeof LimitsPush>

/**
 * How full each agent's context window is, pushed at the end of a turn.
 *
 * A push for the same reason limits are, and a separate channel from them
 * because the scope differs: a plan window belongs to the account and reads the
 * same from anywhere, while this belongs to one conversation's agent. Folding
 * them together would mean a number that is only true for the pane you happen
 * to be looking at arriving on a channel that is not about panes.
 */
export const CONTEXT_PUSH_CHANNEL = 'agents:context'

export const ContextUsagePush = z.object({
  conversationId: z.string(),
  agentId: z.enum(['codex', 'claude']),
  usedTokens: z.number().int(),
  maxTokens: z.number().int(),
  percentUsed: z.number(),
})
export type ContextUsagePush = z.infer<typeof ContextUsagePush>

/**
 * What an agent has left running, for one conversation.
 *
 * A push and never a log row, for the reason on `TasksChanged`: it is a
 * snapshot of live processes, and they stop existing when the session does.
 * Scoped like the context window rather than like limits — tasks belong to one
 * conversation's agent, not to the account.
 *
 * The list replaces whatever came before, including when it is empty. An empty
 * push is the only thing that can say the last task finished.
 */
export const TASKS_PUSH_CHANNEL = 'agents:tasks'

export const TasksPush = z.object({
  conversationId: z.string(),
  agentId: z.enum(['codex', 'claude']),
  tasks: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      description: z.string(),
    })
  ),
})
export type TasksPush = z.infer<typeof TasksPush>

/**
 * Terminal output, and the shell's exit.
 *
 * A push and **never a log event**. The log records the conversation, a shell is
 * a second stream that happens to share a pane, and the global terminal has no
 * `conversationId` to file one under at all. It is also the sharpest instance of
 * the unsolved half of C-021 — `cat .env`, `env`, a pasted token — and nothing
 * scrubs a shell.
 *
 * `seq` is monotonic per terminal so a view can align a snapshot against the
 * live stream; `epoch` lets main's pushes be ignored by a view that has since
 * been superseded. One push carries a frame's worth of chunks, so `seq` is the
 * last one it contains.
 */
export const TERMINAL_PUSH_CHANNEL = 'terminal:output'

export const TerminalPush = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('data'),
    ref: TerminalRefShape,
    epoch: z.number().int(),
    seq: z.number().int(),
    data: z.string(),
  }),
  z.object({
    kind: z.literal('exit'),
    ref: TerminalRefShape,
    epoch: z.number().int(),
    code: z.number().int(),
  }),
])
export type TerminalPush = z.infer<typeof TerminalPush>

export const EventsPush = z.array(TranscriptEvent)
export type EventsPush = z.infer<typeof EventsPush>

export type IpcContract = typeof IPC_CONTRACT
export type IpcChannel = keyof IpcContract

export type IpcRequest<C extends IpcChannel> = z.infer<IpcContract[C]['request']>
export type IpcResponse<C extends IpcChannel> = z.infer<IpcContract[C]['response']>

export const IPC_CHANNELS = Object.keys(IPC_CONTRACT) as IpcChannel[]

export function isIpcChannel(value: string): value is IpcChannel {
  return Object.hasOwn(IPC_CONTRACT, value)
}

/**
 * The shape exposed on `window.chorus`. It lives here rather than in the preload
 * so the renderer never has to import a module that pulls in Electron — the
 * renderer is sandboxed and that import would typecheck but fail at runtime.
 */
export interface ChorusApi {
  readonly getAppInfo: () => Promise<AppInfo>
  /** Asks; the answer arrives on `onLimits`. */
  readonly refreshLimits: () => Promise<{ ok: true }>
  readonly setBadge: (request: { count: number }) => Promise<{ ok: true }>
  readonly focusWindow: () => Promise<{ ok: true }>
  readonly probeAgents: () => Promise<AgentProbeResult[]>
  readonly startConversation: (
    request: IpcRequest<'conversation:start'>
  ) => Promise<IpcResponse<'conversation:start'>>
  readonly sendMessage: (
    request: IpcRequest<'conversation:send'>
  ) => Promise<IpcResponse<'conversation:send'>>
  readonly interrupt: (request: IpcRequest<'conversation:interrupt'>) => Promise<{ ok: true }>
  readonly closeConversation: (request: IpcRequest<'conversation:close'>) => Promise<{ ok: true }>
  readonly addAgent: (
    request: IpcRequest<'conversation:addAgent'>
  ) => Promise<IpcResponse<'conversation:addAgent'>>
  readonly removeAgent: (
    request: IpcRequest<'conversation:removeAgent'>
  ) => Promise<IpcResponse<'conversation:removeAgent'>>
  readonly restoreConversations: () => Promise<IpcResponse<'conversation:restore'>>
  readonly markSeen: (request: IpcRequest<'conversation:markSeen'>) => Promise<{ ok: true }>
  readonly rememberDraft: (request: IpcRequest<'conversation:draft'>) => Promise<{ ok: true }>
  readonly setPlanMode: (
    request: IpcRequest<'conversation:planMode'>
  ) => Promise<IpcResponse<'conversation:planMode'>>
  readonly completeFiles: (
    request: IpcRequest<'files:complete'>
  ) => Promise<IpcResponse<'files:complete'>>
  readonly listCommands: (
    request: IpcRequest<'conversation:commands'>
  ) => Promise<IpcResponse<'conversation:commands'>>
  readonly listConversations: () => Promise<IpcResponse<'conversation:list'>>
  readonly reopenConversation: (
    request: IpcRequest<'conversation:reopen'>
  ) => Promise<IpcResponse<'conversation:reopen'>>
  readonly restartConversation: (
    request: IpcRequest<'conversation:restart'>
  ) => Promise<IpcResponse<'conversation:restart'>>
  readonly previewFile: (
    request: IpcRequest<'files:preview'>
  ) => Promise<IpcResponse<'files:preview'>>
  readonly stashFile: (request: IpcRequest<'files:stash'>) => Promise<IpcResponse<'files:stash'>>
  /** The real path of a dropped file; `File.path` was removed in Electron 32. */
  readonly pathForFile: (file: File) => string
  readonly writeConversationLayout: (
    request: IpcRequest<'conversation:layout'>
  ) => Promise<{ ok: true }>
  readonly renameConversation: (
    request: IpcRequest<'conversation:rename'>
  ) => Promise<IpcResponse<'conversation:rename'>>
  readonly chooseProjectDirectory: (
    request: IpcRequest<'conversation:chooseCwd'>
  ) => Promise<IpcResponse<'conversation:chooseCwd'>>
  readonly setProjectDirectory: (
    request: IpcRequest<'conversation:setCwd'>
  ) => Promise<IpcResponse<'conversation:setCwd'>>
  readonly onScale: (listener: (scale: number) => void) => () => void
  readonly onLimits: (listener: (limits: LimitsPush) => void) => () => void
  readonly onContextUsage: (listener: (usage: ContextUsagePush) => void) => () => void
  readonly onTasks: (listener: (tasks: TasksPush) => void) => () => void

  /**
   * Subscribe **before** attaching, not after.
   *
   * `attach` returns a snapshot taken at a sequence number; anything the shell
   * writes between that snapshot being taken and a subscription going live would
   * otherwise be lost. Subscribing first and discarding pushes at or below the
   * snapshot's `seq` closes it from this side — the alternative, buffering
   * per-attachment in main, puts an unbounded queue in the process that must not
   * stall.
   */
  readonly onTerminalOutput: (listener: (push: TerminalPush) => void) => () => void
  readonly attachTerminal: (
    request: IpcRequest<'terminal:attach'>
  ) => Promise<IpcResponse<'terminal:attach'>>
  readonly detachTerminal: (
    request: IpcRequest<'terminal:detach'>
  ) => Promise<IpcResponse<'terminal:detach'>>
  readonly disposeTerminal: (
    request: IpcRequest<'terminal:dispose'>
  ) => Promise<IpcResponse<'terminal:dispose'>>
  readonly writeTerminal: (
    request: IpcRequest<'terminal:write'>
  ) => Promise<IpcResponse<'terminal:write'>>
  readonly resizeTerminal: (
    request: IpcRequest<'terminal:resize'>
  ) => Promise<IpcResponse<'terminal:resize'>>
  readonly ackTerminal: (
    request: IpcRequest<'terminal:ack'>
  ) => Promise<IpcResponse<'terminal:ack'>>
  readonly clearTerminal: (
    request: IpcRequest<'terminal:clear'>
  ) => Promise<IpcResponse<'terminal:clear'>>
  readonly describeTerminal: (
    request: IpcRequest<'terminal:describe'>
  ) => Promise<IpcResponse<'terminal:describe'>>

  readonly knownModels: () => Promise<IpcResponse<'agents:models'>>
  readonly mcpServers: () => Promise<IpcResponse<'agents:mcp'>>
  readonly accounts: () => Promise<IpcResponse<'agents:account'>>
  readonly plugins: () => Promise<IpcResponse<'agents:plugins'>>
  readonly stopTask: (request: IpcRequest<'tasks:stop'>) => Promise<IpcResponse<'tasks:stop'>>
  readonly readSettings: () => Promise<IpcResponse<'settings:read'>>
  readonly writeSettings: (
    request: IpcRequest<'settings:write'>
  ) => Promise<IpcResponse<'settings:write'>>
  readonly history: (
    request: IpcRequest<'conversation:history'>
  ) => Promise<IpcResponse<'conversation:history'>>
  readonly decideApproval: (request: ApprovalChoice) => Promise<{ ok: true }>
  readonly extendQuestion: (
    request: IpcRequest<'userinput:extend'>
  ) => Promise<IpcResponse<'userinput:extend'>>
  readonly answerQuestion: (request: QuestionAnswer) => Promise<{ ok: true }>
  readonly profiles: () => Promise<IpcResponse<'policy:profiles'>>
  readonly setProfile: (request: IpcRequest<'policy:set'>) => Promise<IpcResponse<'policy:set'>>
  readonly readDiagnostics: () => Promise<IpcResponse<'diagnostics:read'>>
  readonly exportDiagnostics: () => Promise<IpcResponse<'diagnostics:export'>>
  readonly readWorkspace: (
    request: IpcRequest<'workspace:read'>
  ) => Promise<IpcResponse<'workspace:read'>>
  readonly ideExtensionStatus: () => Promise<IpcResponse<'ide:extensionStatus'>>
  readonly ideInstallExtension: () => Promise<IpcResponse<'ide:installExtension'>>
  readonly ideOpenProject: (
    request: IpcRequest<'ide:openProject'>
  ) => Promise<IpcResponse<'ide:openProject'>>
  readonly ideSnapshot: (
    request: IpcRequest<'ide:snapshot'>
  ) => Promise<IpcResponse<'ide:snapshot'>>
  readonly onIdeContext: (listener: (payload: IdeContextPush) => void) => () => void
  readonly prepareHandoff: (
    request: IpcRequest<'handoff:prepare'>
  ) => Promise<IpcResponse<'handoff:prepare'>>
  readonly sendHandoff: (
    request: IpcRequest<'handoff:send'>
  ) => Promise<IpcResponse<'handoff:send'>>
  readonly openAside: (request: IpcRequest<'aside:open'>) => Promise<IpcResponse<'aside:open'>>
  readonly askAside: (request: IpcRequest<'aside:ask'>) => Promise<IpcResponse<'aside:ask'>>
  readonly promoteAside: (
    request: IpcRequest<'aside:promote'>
  ) => Promise<IpcResponse<'aside:promote'>>
  readonly closeAside: (request: IpcRequest<'aside:close'>) => Promise<IpcResponse<'aside:close'>>
  readonly listAsides: (request: IpcRequest<'aside:list'>) => Promise<IpcResponse<'aside:list'>>
  /** Returns an unsubscribe function. */
  readonly onEvents: (listener: (events: TranscriptEvent[]) => void) => () => void
}
