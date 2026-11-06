import { powerShellLiteral, type RemoteHost, type RemoteResult } from './remote-host.js'
import { lastMeaningfulLine } from './remote-tunnel.js'

export const QUOTE_PROBE = "'‘’‚‛"

export function hostPlatformKey(processorArchitecture: string): string {
  if (processorArchitecture === 'AMD64') return 'win32-x64'
  if (processorArchitecture === 'ARM64') return 'win32-arm64'
  throw new Error(`Unsupported remote processor architecture: ${processorArchitecture}`)
}

export const REMOTE_CHECK_DEADLINE_MS = 20_000

const SSH_CONNECTION_FAILED = 255

const CHECK_SCRIPT = 'Write-Output $env:PROCESSOR_ARCHITECTURE'

export interface RemoteHostCheck {
  readonly reachable: boolean
  readonly platform: string | null
  readonly quotingHolds: boolean
  readonly detail: string
}

function knownPlatform(processorArchitecture: string): string | null {
  try {
    return hostPlatformKey(processorArchitecture)
  } catch {
    return null
  }
}

export async function checkRemoteHost(
  host: RemoteHost,
  deadlineMs: number
): Promise<RemoteHostCheck> {
  let result: RemoteResult
  try {
    result = await host.runPowerShell(CHECK_SCRIPT, deadlineMs)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { reachable: false, platform: null, quotingHolds: false, detail }
  }
  const detail = lastMeaningfulLine(result.stderr)
  if (result.exitCode === SSH_CONNECTION_FAILED) {
    return { reachable: false, platform: null, quotingHolds: false, detail }
  }
  if (result.exitCode !== 0) {
    return { reachable: true, platform: null, quotingHolds: false, detail }
  }
  const architecture = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? ''
  const quotingHolds = await powerShellQuotingHolds(host, deadlineMs).catch(() => false)
  return { reachable: true, platform: knownPlatform(architecture), quotingHolds, detail }
}

export async function powerShellQuotingHolds(
  host: RemoteHost,
  deadlineMs: number
): Promise<boolean> {
  const script = `[Console]::Out.Write(${powerShellLiteral(QUOTE_PROBE)})`
  const result = await host.runPowerShell(script, deadlineMs)
  return result.exitCode === 0 && result.stdout === QUOTE_PROBE
}
