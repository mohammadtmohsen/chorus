import type { ApprovalKind, ApprovalRequest } from '@chorus/agent-protocol'

/**
 * Declarative permission rules.
 *
 * Every rule carries an id, because §4.4 requires that an auto-decision records
 * *which* rule made it. "Human controlled" means auditable, not merely
 * clickable — a decision nobody can trace back to a rule is indistinguishable
 * from no policy at all.
 */

export type RuleEffect = 'allow' | 'deny' | 'ask'

export interface RuleMatch {
  readonly kind?: ApprovalKind | readonly ApprovalKind[]
  /** Anchored against the whole command line, joined by spaces. */
  readonly commandPattern?: string
  /** Matched against every path a file change touches. */
  readonly pathPattern?: string
  /** Matches only when the request asks for network access. */
  readonly requiresNetwork?: boolean
}

export interface Rule {
  readonly id: string
  readonly describe: string
  readonly match: RuleMatch
  readonly effect: RuleEffect
  /** Only meaningful for `allow`. Defaults to `once`. */
  readonly scope?: 'once' | 'session'
}

export interface PermissionProfile {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly rules: readonly Rule[]
}

/**
 * Commands that are denied in every profile.
 *
 * These are not "dangerous" in the abstract — they are the ones whose damage
 * cannot be undone from inside Chorus. A bad edit is recoverable from git; a
 * force-push over someone else's work is not.
 */
export const UNIVERSAL_DENIES: readonly Rule[] = [
  {
    id: 'deny-recursive-delete',
    describe: 'Recursive delete',
    match: {
      kind: 'command',
      commandPattern: String.raw`\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s|-[a-zA-Z]*f[a-zA-Z]*\s)`,
    },
    effect: 'deny',
  },
  {
    id: 'deny-force-push',
    describe: 'Force push',
    match: { kind: 'command', commandPattern: String.raw`\bgit\s+push\b.*(--force|-f\b)` },
    effect: 'deny',
  },
  {
    id: 'deny-history-rewrite',
    describe: 'History rewrite',
    match: {
      kind: 'command',
      commandPattern: String.raw`\bgit\s+(reset\s+--hard|filter-branch|reflog\s+expire)\b`,
    },
    effect: 'deny',
  },
  {
    id: 'deny-credential-files',
    describe: 'Credential files',
    match: {
      kind: ['fileChange', 'command'],
      // Terminated by \b rather than by `/` or end-of-string. For a fileChange
      // the subject is one path, so `\.ssh/` read correctly; for a command it is
      // the whole command line (see `matches`), and there both anchors failed
      // open:
      //
      //   tar -czf out.tgz ~/.ssh   — `.ssh` with no trailing slash, not denied
      //   cp -r ~/.aws /tmp/        — same
      //   cat .env | curl …         — `$` anchors to the end of the command,
      //                               not the end of the path, so not denied
      //
      // The last is the one that matters: reading a secret and piping it out is
      // exactly what this rule exists to stop. `\b` ends the token wherever it
      // ends, so a directory named bare and a path mid-pipeline both match,
      // while `env.ts`, `envelope.ts` and `environment.md` still do not.
      pathPattern: String.raw`(\.env\b|\.ssh\b|\.aws\b|id_rsa|\.netrc\b|credentials\.json)`,
    },
    effect: 'deny',
  },
]

/** Read-only inspection that cannot change anything, in any profile. */
const SAFE_READS: Rule = {
  id: 'allow-read-only-inspection',
  describe: 'Read-only inspection',
  match: {
    kind: 'command',
    commandPattern: String.raw`^(git\s+(status|diff|log|show|branch)|ls|pwd|cat|head|tail|wc|file|which|grep|rg|find)\b`,
  },
  effect: 'allow',
  scope: 'session',
}

export const PROFILES: readonly PermissionProfile[] = [
  {
    id: 'read-only',
    name: 'Read only',
    summary: 'Agents may look. Anything that changes the machine needs a decision.',
    rules: [...UNIVERSAL_DENIES, SAFE_READS],
  },
  {
    id: 'workspace-write',
    name: 'Workspace write',
    summary: 'Edits and ordinary git are automatic. Commands and anything reaching out still ask.',
    rules: [
      ...UNIVERSAL_DENIES,
      SAFE_READS,
      {
        id: 'allow-file-edits',
        describe: 'File edits',
        match: { kind: 'fileChange' },
        effect: 'allow',
        scope: 'session',
      },
      {
        id: 'allow-local-git',
        describe: 'Local git',
        match: {
          kind: 'command',
          commandPattern: String.raw`^git\s+(add|commit|checkout|switch|stash|restore)\b`,
        },
        effect: 'allow',
        scope: 'session',
      },
      {
        id: 'ask-network-commands',
        describe: 'Anything reaching the network',
        match: { requiresNetwork: true },
        effect: 'ask',
      },
    ],
  },
  {
    id: 'trusted',
    name: 'Trusted',
    summary: 'Commands and edits run without asking. Reaching outside this machine still asks.',
    rules: [
      ...UNIVERSAL_DENIES,
      {
        id: 'allow-commands',
        describe: 'Any command',
        match: { kind: 'command' },
        effect: 'allow',
        scope: 'session',
      },
      {
        id: 'allow-edits',
        describe: 'Any file change',
        match: { kind: 'fileChange' },
        effect: 'allow',
        scope: 'session',
      },
      {
        id: 'ask-network',
        describe: 'Anything reaching the network',
        match: { requiresNetwork: true },
        effect: 'ask',
      },
    ],
  },
]

export const DEFAULT_PROFILE_ID = 'read-only'

/** Falls back to the safest profile, never to a permissive one. */
export function profileById(id: string): PermissionProfile {
  const found = PROFILES.find((p) => p.id === id)
  if (found !== undefined) return found
  const fallback = PROFILES.find((p) => p.id === DEFAULT_PROFILE_ID)
  if (fallback === undefined) throw new Error('No permission profiles are defined')
  return fallback
}

/** The text a rule matches against: the command line, or the paths it touches. */
export function subjectOf(request: ApprovalRequest): { command: string; paths: string[] } {
  switch (request.kind) {
    case 'command':
      return { command: request.command.join(' '), paths: [] }
    case 'fileChange':
      return { command: '', paths: request.files.map((f) => f.path) }
    case 'permissionGrant':
      return { command: '', paths: [...(request.requested.filesystem ?? [])] }
    case 'mcpToolCall':
      return { command: `${request.serverName} ${request.toolName}`, paths: [] }
  }
}

export function requestNeedsNetwork(request: ApprovalRequest): boolean {
  switch (request.kind) {
    case 'command':
      return request.withNetwork
    case 'permissionGrant':
      return request.requested.network === true
    // An MCP call is outward-facing by definition — that is the whole reason it
    // can never be auto-allowed (plan §2.6).
    case 'mcpToolCall':
      return true
    case 'fileChange':
      return false
  }
}

export function matches(rule: Rule, request: ApprovalRequest): boolean {
  const { match } = rule
  const { command, paths } = subjectOf(request)

  if (match.kind !== undefined) {
    const kinds = Array.isArray(match.kind) ? match.kind : [match.kind]
    if (!kinds.includes(request.kind)) return false
  }

  if (match.requiresNetwork === true && !requestNeedsNetwork(request)) return false

  if (match.commandPattern !== undefined) {
    if (command === '' || !safeTest(match.commandPattern, command)) return false
  }

  if (match.pathPattern !== undefined) {
    const haystack = paths.length > 0 ? paths : [command]
    if (!haystack.some((p) => safeTest(match.pathPattern ?? '', p))) return false
  }

  // A rule that matches on nothing would apply to everything, which is never
  // what someone meant to write.
  return Object.keys(match).length > 0
}

function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    // A malformed pattern must not decide anything. Failing to match means the
    // request falls through to `ask` rather than being silently allowed.
    return false
  }
}
