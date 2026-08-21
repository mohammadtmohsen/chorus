/**
 * Removing secrets before anything reaches disk.
 *
 * Lives in `shared` because two things need it: the event log and the
 * diagnostics bundle. A secret scrubbed from one and left in the other is not
 * scrubbed.
 *
 * Plan §4.4 requires this and, until now, nothing did it. Agents read `.env`
 * files, print environment variables, and paste tokens into commands; every one
 * of those flows through `command.output` or `agent.message.delta` straight into
 * the log. A local-first app still writes a durable file that gets backed up,
 * synced, and attached to bug reports.
 *
 * Applied on **write**, not on read (§4.4). Redacting on read would leave the
 * secret in the file, which is the thing that matters.
 *
 * The bias is deliberate: patterns are anchored to shapes that are unambiguous
 * (a `sk-ant-` prefix, a PEM header), because a false positive silently destroys
 * content a user needed. Where a shape is ambiguous, the value is left alone.
 */

export interface RedactionRule {
  readonly id: string
  readonly pattern: RegExp
  /**
   * When set, the pattern must capture exactly two groups: the prefix to keep
   * and the value to remove. Keeping the prefix is what leaves the line
   * readable — "GITHUB_TOKEN=[redacted]" still tells you what was there.
   */
  readonly keepPrefix?: boolean
  /** Lets a rule decline a match that is not actually a secret. */
  readonly skip?: (value: string) => boolean
}

const RULES: readonly RedactionRule[] = [
  // Private key blocks. The body is the secret; the header identifies it.
  {
    id: 'private-key',
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { id: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // A JWT is three base64url segments; the shape is distinctive enough.
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    id: 'bearer-token',
    pattern: /((?:Authorization:\s*)?Bearer\s+)([A-Za-z0-9._~+/=-]{20,})/gi,
    keepPrefix: true,
  },
  /*
   * Assignments whose *name* claims to be a secret. Keyed on the name rather
   * than the value, because a password has no distinctive shape — this is the
   * only rule here that could plausibly over-match, so it requires the name to
   * be explicit about what it holds.
   */
  {
    id: 'secret-assignment',
    pattern:
      /\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*)["']?([^\s"'&]{6,})["']?/gi,
    keepPrefix: true,
    skip: isCodeReference,
  },
]

export interface RedactionResult {
  readonly text: string
  /** Rule ids that fired, for the diagnostics export to report honestly. */
  readonly redacted: readonly string[]
}

export function redactText(text: string): RedactionResult {
  if (text === '') return { text, redacted: [] }

  let output = text
  const fired: string[] = []

  for (const rule of RULES) {
    // `lastIndex` is shared state on a global regex; reset it or alternating
    // calls silently skip matches.
    rule.pattern.lastIndex = 0
    if (!rule.pattern.test(output)) continue
    fired.push(rule.id)

    rule.pattern.lastIndex = 0
    const before = output
    output = output.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
      if (rule.keepPrefix !== true) return marker(rule.id)

      const prefix = typeof groups[0] === 'string' ? groups[0] : ''
      const value = typeof groups[1] === 'string' ? groups[1] : ''
      if (rule.skip?.(value) === true) return match
      return `${prefix}${marker(rule.id)}`
    })
    // A rule can match and then decline every match — it redacted nothing, and
    // reporting it would overstate what was removed.
    if (output === before) fired.pop()
  }

  return { text: output, redacted: fired }
}

function marker(id: string): string {
  return `[redacted:${id}]`
}

/**
 * True for values that are code rather than credentials.
 *
 * `const apiKey = config.apiKey` is a property access, not a secret, and
 * redacting it destroys source the user was reading. Real secrets are opaque
 * strings; identifier paths and template placeholders are not.
 */
function isCodeReference(value: string): boolean {
  if (/^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(value)) return true
  if (/^\$\{?[A-Za-z_][\w]*\}?$/.test(value)) return true
  if (/^(?:undefined|null|true|false|process\b)/.test(value)) return true
  return false
}

/**
 * Fields that can carry text an agent produced or a command printed.
 *
 * `detail` was missing until a review found it, and it was the worst omission on
 * the list: it is the field that carries **hook output** — whatever a
 * `SessionStart` hook printed, which is arbitrary shell output and routinely
 * includes `env`, a token a script echoed, or the contents of a file it read. A
 * notice is durable, so an unredacted `detail` is a credential written to the
 * log forever.
 *
 * The walk below is structural but this list is not, which is the standing
 * weakness: a new text-bearing field is unredacted until somebody adds it here.
 * Prefer reusing a name already on this list when adding a payload.
 */
const TEXT_FIELDS = ['text', 'chunk', 'brief', 'message', 'unifiedDiff', 'patch', 'detail'] as const

/**
 * Walks an event payload and redacts every text-bearing field.
 *
 * Structural rather than field-by-field so a payload type added later is covered
 * by default. Failing open — leaving a new field unredacted because nobody
 * remembered to list it — is the failure mode worth designing against.
 */
export function redactPayload<T>(payload: T): { payload: T; redacted: string[] } {
  const fired = new Set<string>()

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(walk)
    if (typeof value !== 'object' || value === null) return value

    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'string' && (TEXT_FIELDS as readonly string[]).includes(key)) {
        const result = redactText(child)
        for (const id of result.redacted) fired.add(id)
        out[key] = result.text
      } else {
        out[key] = walk(child)
      }
    }
    return out
  }

  return { payload: walk(payload) as T, redacted: [...fired] }
}
