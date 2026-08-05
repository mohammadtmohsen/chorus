import type { Inline } from './markdown.js'

/**
 * Turning issue keys an agent mentions into links you can open.
 *
 * Agents cite tickets constantly — "ACME-383 has the wrong parent" — and until
 * now that was a dead string you retyped into a browser. It is a link now, and
 * `MarkdownView` already renders links with `target="_blank"`, which
 * `security.ts` turns into `shell.openExternal`. So nothing new is trusted: the
 * href goes through the same https-only path every other link in a transcript
 * already takes.
 *
 * **Why a key list rather than a pattern.** The obvious rule — two or more
 * capitals, a hyphen, digits — is wrong in exactly this app. `UTF-8`, `ISO-8601`,
 * `SHA-256` and `RFC-2119` all match it, and a transcript full of coding agents
 * is the single most likely place on earth to contain all four. Linkifying those
 * would send you to a 404 and, worse, make the real ticket links untrustworthy.
 * Matching only keys that are known to exist costs one line of configuration and
 * removes the whole class of error.
 */

export interface Tracker {
  /** No trailing slash; `issueHref` adds the path. */
  readonly baseUrl: string
  /** Uppercase project keys. Only these become links. */
  readonly keys: readonly string[]
}

/**
 * The tracker this workspace's agents talk about.
 *
 * A constant rather than a setting, for now: one workspace, one tracker, and a
 * settings field plus the UI to edit it is more surface than the fact deserves
 * until there is a second. `linkifyIssues` takes the tracker as an argument, so
 * moving it into `SettingsShape` later changes this file's callers and nothing
 * about its logic.
 */
export const TRACKER: Tracker = {
  baseUrl: 'https://acme.example',
  keys: ['ACME'],
}

export function issueHref(key: string, tracker: Tracker = TRACKER): string {
  return `${tracker.baseUrl}/browse/${key}`
}

/** Escaped, so a key is never read as a pattern. */
function keyPattern(tracker: Tracker): RegExp | null {
  const keys = tracker.keys
    .filter((k) => k !== '')
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (keys.length === 0) return null
  /*
   * Case-sensitive, and bounded at both ends.
   *
   * Upper case because that is what a key is; lower case would match ordinary
   * words. The leading boundary stops `XTPA-1` matching, and the trailing one
   * keeps the full number rather than a prefix of it — while still letting the
   * sentence's own full stop fall outside the link.
   */
  return new RegExp(String.raw`\b(?:${keys.join('|')})-\d+\b`, 'g')
}

/**
 * Splits text nodes around issue keys, leaving every other node alone.
 *
 * Runs on the output of the inline parser rather than on raw source, which is
 * what keeps it out of code spans: by this point `` `ACME-383` `` is a `code`
 * node, and a fenced block never reaches here at all. A key inside an explicit
 * markdown link is likewise already a `link` node and is not touched.
 */
export function linkifyIssues(nodes: readonly Inline[], tracker: Tracker = TRACKER): Inline[] {
  const pattern = keyPattern(tracker)
  if (pattern === null) return [...nodes]

  const out: Inline[] = []
  for (const node of nodes) {
    if (node.kind !== 'text') {
      out.push(node)
      continue
    }

    let last = 0
    pattern.lastIndex = 0
    for (let m = pattern.exec(node.text); m !== null; m = pattern.exec(node.text)) {
      if (m.index > last) out.push({ kind: 'text', text: node.text.slice(last, m.index) })
      out.push({ kind: 'link', text: m[0], href: issueHref(m[0], tracker) })
      last = m.index + m[0].length
    }
    if (last === 0) out.push(node)
    else if (last < node.text.length) out.push({ kind: 'text', text: node.text.slice(last) })
  }
  return out
}
