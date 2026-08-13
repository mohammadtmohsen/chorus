import type { IdeStatus } from '@chorus/ide-protocol'
import type { RootReport } from './editor-context.js'

/**
 * What this window is allowed to say about its own decisions.
 *
 * Pure, and free of any `vscode` import, for the same reason `editor-context.ts`
 * is: the interesting part is what gets left out. A diagnosis exists to be
 * pasted into a bug report, so this module may emit reason codes, URI schemes,
 * booleans and counts — never a path, a token, or source text. A root is named
 * by its index in the list Chorus published, which says *which* root failed
 * without saying where it is on disk.
 *
 * It exists because "sometimes it does not see my selection" had no evidence
 * trail at all: `unsupported`, a root that did not match, and a handshake
 * refused before the socket ever opened all looked identical from the outside.
 */

/** How one Chorus connection is doing, for the status bar and the dump. */
export type ConnectionState = 'dialing' | 'connected' | 'extensionOutdated' | 'chorusOutdated'

export interface ConnectionCounts {
  readonly found: number
  readonly connected: number
  readonly dialing: number
  /** Chorus speaks a protocol newer than this extension's. */
  readonly extensionOutdated: number
  /** This extension speaks a protocol newer than that Chorus's. */
  readonly chorusOutdated: number
}

export function countStates(states: readonly ConnectionState[]): ConnectionCounts {
  const of = (want: ConnectionState): number => states.filter((s) => s === want).length
  return {
    found: states.length,
    connected: of('connected'),
    dialing: of('dialing'),
    extensionOutdated: of('extensionOutdated'),
    chorusOutdated: of('chorusOutdated'),
  }
}

/** Everything about the window that is safe to write down. */
export interface WindowDiagnostics {
  /** The active document's URI scheme, or null when there is no active editor. */
  readonly scheme: string | null
  readonly trusted: boolean
  readonly folderCount: number
  readonly connections: ConnectionCounts
  readonly extensionVersion: string
  readonly protocolVersion: number
}

/**
 * Where the selection in this frame came from.
 *
 * `cached` is the state the pill cannot currently show — `toPushFile` drops
 * `source` on the way to the renderer — so until that changes this is the only
 * place a remembered selection is visible at all.
 */
export function frameSource(reports: readonly RootReport[]): 'current' | 'cached' | 'none' {
  for (const report of reports) {
    if (report.editor !== null) return report.editor.source
  }
  return 'none'
}

/**
 * One frame's fields, for `chorus.trace`.
 *
 * Fields rather than a formatted string, so the caller's existing
 * `log(message, fields)` does the writing and a test can assert on values
 * instead of parsing prose.
 */
export function frameFields(
  reports: readonly RootReport[],
  window: WindowDiagnostics
): Record<string, unknown> {
  return {
    scheme: window.scheme ?? 'none',
    trusted: window.trusted,
    folders: window.folderCount,
    connected: window.connections.connected,
    source: frameSource(reports),
    roots: reports.map((report, index) => `${String(index)}:${report.status}`),
  }
}

/**
 * Why each status happens, in the user's terms.
 *
 * A `Record` over the whole union rather than a lookup with a fallback: a
 * status added later has to be explained here, and the compiler is what says
 * so. `ambiguous` is decided by Chorus rather than by this window, and is
 * listed because a dump may be reading a status this extension cannot produce.
 */
const EXPLANATION: Record<IdeStatus, string> = {
  unavailable: 'no Chorus process is connected to this window',
  unmatched:
    'no workspace folder here is exactly that root, or the active document is not inside it',
  untrusted: 'this workspace is restricted in VS Code',
  unsupported: 'the active document is not one this extension can reference',
  ambiguous: 'more than one VS Code window has that project open',
  tooLarge: 'the selection is over the size cap',
  ready: 'reporting a file and a range',
}

const yesNo = (value: boolean): string => (value ? 'yes' : 'no')

/**
 * One connected Chorus, and what this window would tell it.
 *
 * Per process rather than per window: a window can serve several Chorus
 * instances, each having named its own roots, and a dump that flattened them
 * would describe a set of projects no single Chorus asked about.
 */
export interface ChorusDiagnostics {
  readonly pid: number
  readonly state: ConnectionState
  readonly reports: readonly RootReport[]
}

/** The `Chorus: Diagnose editor context` dump, one line per element. */
export function diagnosticLines(
  chorus: readonly ChorusDiagnostics[],
  window: WindowDiagnostics
): string[] {
  const { connections: c } = window
  const lines = [
    'Chorus editor context',
    `  extension ${window.extensionVersion}, protocol ${String(window.protocolVersion)}`,
    `  workspace trusted: ${yesNo(window.trusted)}`,
    `  workspace folders: ${String(window.folderCount)}`,
    `  active document: ${window.scheme ?? 'none — no active text editor'}`,
    `  Chorus processes: ${String(c.found)} found, ${String(c.connected)} connected, ${String(c.dialing)} dialing`,
  ]

  for (const one of chorus) {
    lines.push(`  pid ${String(one.pid)} (${one.state}): ${String(one.reports.length)} root(s)`)
    for (const [index, report] of one.reports.entries()) {
      lines.push(`    #${String(index)} ${report.status} — ${EXPLANATION[report.status]}`)
    }
    lines.push(`    selection reported: ${frameSource(one.reports)}`)
  }

  // The one failure the rest of the dump cannot describe: a refused handshake
  // means no roots were ever published, so every line above reads as if
  // nothing were wrong.
  if (c.extensionOutdated > 0) {
    lines.push(
      `  ${String(c.extensionOutdated)} Chorus process(es) speak a newer protocol — update this extension from Chorus's settings`
    )
  }
  if (c.chorusOutdated > 0) {
    lines.push(
      `  ${String(c.chorusOutdated)} Chorus process(es) speak an older protocol — update Chorus`
    )
  }
  return lines
}
