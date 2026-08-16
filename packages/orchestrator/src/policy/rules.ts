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
  /**
   * Disqualifies the rule when it matches, checked against the same line.
   *
   * For the arguments that turn a reader into a writer. `find` is a safe read
   * until `-delete`, `git branch` until `-D`, and a rule that can only say what
   * a command *starts with* cannot tell those apart.
   */
  readonly commandExcludePattern?: string
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
 *
 * The test for belonging here is that the *action* is irreversible, not that
 * the subject looks sensitive. Anything decided by pattern-matching a filename
 * belongs in `UNIVERSAL_ASKS` below, because a wall the user cannot open is
 * only correct when no answer they could give would make the action safe.
 */
/**
 * `\.exe` after the verb, optionally.
 *
 * A Windows agent runs `git.exe push --force` as readily as `git push --force`,
 * and `\bgit\s+push` does not match the first: `\bgit` matches, then `\s+`
 * meets `.exe`. Every deny below carries this, because a universal deny that a
 * four-character suffix walks through is not universal.
 */
const EXE = String.raw`(?:\.exe)?`

export const UNIVERSAL_DENIES: readonly Rule[] = [
  {
    id: 'deny-recursive-delete',
    describe: 'Recursive delete',
    match: {
      kind: 'command',
      commandPattern: String.raw`\brm${EXE}\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s|-[a-zA-Z]*f[a-zA-Z]*\s)`,
    },
    effect: 'deny',
  },
  {
    /*
     * The same irreversible action, in the three shells Windows actually has.
     *
     * Separate from the `rm` rule rather than bolted onto it, because the flag
     * grammars have nothing in common: cmd takes `/s /q` on `del` and `rd`,
     * PowerShell takes `-Recurse -Force` on `Remove-Item` — and PowerShell
     * accepts any unambiguous prefix of a parameter name, so `-Rec`, `-recurse`
     * and `-r` are all the same switch. `ri`, `rm`, `rmdir`, `erase` and `del`
     * are all aliases of Remove-Item or its cmd equivalents.
     *
     * This is an action, not a name: recursive deletion is irreversible on any
     * platform, which is what qualifies it for a universal deny at all.
     */
    id: 'deny-recursive-delete-windows',
    describe: 'Recursive delete',
    match: {
      kind: 'command',
      commandPattern: String.raw`\b(?:(?:del|erase|rd|rmdir)${EXE}\s+(?:[^|&;\n]*\s)?/[sS]\b|(?:Remove-Item|ri)\b[^|&;\n]*\s-[rR](?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\b)`,
    },
    effect: 'deny',
  },
  {
    id: 'deny-force-push',
    describe: 'Force push',
    match: {
      kind: 'command',
      commandPattern: String.raw`\bgit${EXE}\s+push\b.*(--force|-f\b)`,
    },
    effect: 'deny',
  },
  {
    id: 'deny-history-rewrite',
    describe: 'History rewrite',
    match: {
      kind: 'command',
      commandPattern: String.raw`\bgit${EXE}\s+(reset\s+--hard|filter-branch|reflog\s+expire)\b`,
    },
    effect: 'deny',
  },
]

/**
 * Rules that always reach a person, in every profile.
 *
 * These are *heuristics about a name*, not proven danger, and that difference
 * is why they are not denies. A deny is absolute — `evaluate` step 2 puts it
 * ahead of profiles, session grants and everything else — so a heuristic
 * expressed as a deny is a wall with no door: the agent stops, the card never
 * appears, and switching to Trusted cannot help because these apply there too.
 *
 * That is not "human controlled". It is the opposite: the one person who can
 * tell a secret from a filename is the one who never gets asked.
 *
 * Expressed as an `ask` the rule keeps its teeth. `evaluate` checks asks before
 * the profile's own allowances, so this still outranks Trusted's `allow-commands`
 * — it simply gives the decision back.
 */
export const UNIVERSAL_ASKS: readonly Rule[] = [
  {
    id: 'ask-credential-files',
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
      // Deliberately broad, which is the other half of why this asks rather
      // than denies: `\.env\b` matches `.env.e2e` as readily as `.env`, and a
      // test fixture is not a secret. Over-matching is the right failure for a
      // question and the wrong one for a wall.
      // `_netrc` is the Windows spelling of `.netrc` and was missed entirely;
      // `.pfx`/`.pem` are where Windows keeps keys, and `cmdkey` is the
      // Credential Manager CLI — reading it out is the same act as reading
      // `~/.aws`. Still an ask rather than a deny: only the user can tell a
      // secret from a fixture, which is the whole argument in the comment above.
      pathPattern: String.raw`(\.env\b|\.ssh\b|\.aws\b|id_rsa|\.netrc\b|_netrc\b|\.pfx\b|\.pem\b|\bcmdkey\b|credentials\.json)`,
    },
    effect: 'ask',
  },
]

/** Read-only inspection that cannot change anything, in any profile. */
const SAFE_READS: Rule = {
  id: 'allow-read-only-inspection',
  describe: 'Read-only inspection',
  match: {
    kind: 'command',
    /*
     * `sed`, `echo`, `sort` and `uniq` earn their place from the log rather
     * than from taste: the commonest shape by far is
     * `cat a; echo "=== b ==="; sed -n '1,40p' c`, and without them a reader
     * asks. `sed` is also the command C-017's one real refusal tripped on.
     *
     * `awk` is deliberately absent — it writes files from inside its own
     * program text, where no rule here can see it. So is `xargs`, which runs
     * whatever it is given.
     */
    commandPattern: String.raw`^(git\s+(status|diff|log|show|branch)|ls|pwd|cat|head|tail|wc|file|which|grep|rg|find|sed|echo|sort|uniq)\b`,
    /*
     * The arguments that turn these readers into writers.
     *
     * `find` runs arbitrary commands (`-exec`, `-ok`), deletes (`-delete`) and
     * writes files (`-fprint`); `git branch` deletes and renames. Without this
     * the rule allowed `find . -delete` outright, because it only ever read the
     * first word (C-020).
     */
    commandExcludePattern: String.raw`(\s-(delete|exec|execdir|ok|okdir|fls|fprint|fprintf)\b)|(^git\s+branch\b.*(-D|-d|-m|-M|--delete|--move|--force)\b)|(^sed\b.*(\s-[a-zA-Z]*i|--in-place))`,
  },
  effect: 'allow',
  scope: 'session',
}

export const PROFILES: readonly PermissionProfile[] = [
  {
    id: 'read-only',
    name: 'Read only',
    summary: 'Agents may look. Anything that changes the machine needs a decision.',
    rules: [...UNIVERSAL_DENIES, ...UNIVERSAL_ASKS, SAFE_READS],
  },
  {
    id: 'workspace-write',
    name: 'Workspace write',
    summary: 'Edits and ordinary git are automatic. Commands and anything reaching out still ask.',
    rules: [
      ...UNIVERSAL_DENIES,
      ...UNIVERSAL_ASKS,
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
      ...UNIVERSAL_ASKS,
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
  const flags = flagsFor(rule.effect)

  if (match.kind !== undefined) {
    const kinds = Array.isArray(match.kind) ? match.kind : [match.kind]
    if (!kinds.includes(request.kind)) return false
  }

  if (match.requiresNetwork === true && !requestNeedsNetwork(request)) return false

  if (match.commandPattern !== undefined) {
    if (command === '' || !safeTest(match.commandPattern, command, flags)) return false
    if (
      match.commandExcludePattern !== undefined &&
      safeTest(match.commandExcludePattern, command, flags)
    ) {
      return false
    }
    /*
     * An `allow` may never match a command line that is more than one command.
     *
     * `commandPattern` is anchored at the start of the *whole line* — Claude's
     * Bash tool hands over one shell string — so `^cat\b` matched
     * `cat evil > ~/.zshrc`, and the read-only profile allowed an arbitrary
     * write. Measured against the real engine, `find . -delete`,
     * `git branch -D`, `cat a > b` and `rg x . | xargs touch y` were all
     * allowed outright, with no card and no record of a person deciding (C-020).
     *
     * Only for `allow`. A deny must still match inside a composition — the whole
     * point of `rm -rf` being universal is that hiding it behind `&&` does not
     * help — and an `ask` that stops matching would silently become an allow
     * from some later rule.
     */
    if (rule.effect === 'allow' && !everySegmentMatches(match, command, flags)) return false
  }

  if (match.pathPattern !== undefined) {
    const haystack = paths.length > 0 ? paths : [command]
    if (!haystack.some((p) => safeTest(match.pathPattern ?? '', p, flags))) return false
  }

  // A rule that matches on nothing would apply to everything, which is never
  // what someone meant to write.
  return Object.keys(match).length > 0
}

/**
 * Redirections that discard output rather than writing a file.
 *
 * `2>/dev/null` and `2>&1` are how a reader stays quiet, and they are all over
 * the log. Removing them first lets the redirect check below be absolute about
 * everything that remains.
 */
const DISCARDS = /\d?>\s*&?\s*(\/dev\/null|NUL\b|\$null\b|\d)/gi

/**
 * Whether an `allow` rule covers every command on the line.
 *
 * Substitution and file redirection are refused outright: `$(…)` and backticks
 * run something the rule never sees, and `>` writes. What is left is split on
 * the sequencing operators, and each part must satisfy the same rule — so a
 * pipeline of readers is still a read, and one whose second half is `curl` is
 * not.
 *
 * Splitting on operators without parsing quotes is deliberately naive, and it
 * fails **closed**: `cat "a|b"` splits into parts that do not both match and so
 * asks, and `cat "; anything"` asks for the same reason. A card nobody needed is
 * the acceptable error here; a silent allow is not.
 */
function everySegmentMatches(match: RuleMatch, command: string, flags = ''): boolean {
  const withoutDiscards = command.replace(DISCARDS, ' ')
  if (/[`<>]|\$\(/.test(withoutDiscards)) return false

  const segments = withoutDiscards
    .split(/\|\||&&|[|;&\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (segments.length === 0) return false

  return segments.every(
    (segment) =>
      safeTest(match.commandPattern ?? '', segment, flags) &&
      (match.commandExcludePattern === undefined ||
        !safeTest(match.commandExcludePattern, segment, flags))
  )
}

function safeTest(pattern: string, value: string, flags = ''): boolean {
  try {
    return new RegExp(pattern, flags).test(value)
  } catch {
    // A malformed pattern must not decide anything. Failing to match means the
    // request falls through to `ask` rather than being silently allowed.
    return false
  }
}

/**
 * Denies match case-insensitively; nothing else does.
 *
 * cmd and PowerShell are case-insensitive, so `DEL /S`, `Remove-item -Recurse`
 * and `Git Push --Force` are all real invocations that the case-sensitive
 * patterns walked straight past. Applying `i` to a deny can only ever deny
 * more, and the cost of that on unix is denying `RM -rf` — a command that does
 * not exist and would have failed anyway.
 *
 * Deliberately **not** applied to allow rules. There the same change runs the
 * other way: `i` on `SAFE_READS` would allow `LS` and `CAT`, widening an
 * allowlist on a platform where those are distinct from the real commands. An
 * allow that is too narrow costs a prompt; an allow that is too wide costs the
 * thing the allowlist exists for.
 */
function flagsFor(effect: RuleEffect): string {
  return effect === 'deny' ? 'i' : ''
}
