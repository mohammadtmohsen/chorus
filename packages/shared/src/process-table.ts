import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export interface ProcessIdentity {
  readonly pid: number
  readonly parentPid: number
  readonly groupId: number | null
  readonly startedAt: string | null
  readonly state: string
}

export function parsePosixProcesses(text: string): ProcessIdentity[] {
  const rows: ProcessIdentity[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s*$/.exec(line)
    if (match === null) throw new Error('Could not inspect the owned process table.')
    const [, pid, parentPid, groupId, startedAt, state] = match
    if (startedAt === undefined || state === undefined) {
      throw new Error('Could not inspect owned process identities.')
    }
    rows.push({
      pid: Number(pid),
      parentPid: Number(parentPid),
      groupId: Number(groupId),
      startedAt: startedAt.trim(),
      state,
    })
  }
  return rows
}

export async function inspectProcessTable(platform: NodeJS.Platform): Promise<ProcessIdentity[]> {
  if (platform === 'darwin' || platform === 'linux') {
    const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat='], {
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 2_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return parsePosixProcesses(stdout)
  }
  if (platform !== 'win32')
    throw new Error(`Owned process inspection is unsupported on ${platform}.`)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $started = $null',
    '  if ($null -ne $_.CreationDate) { $started = $_.CreationDate.ToUniversalTime().Ticks.ToString() }',
    "  [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; startedAt = $started; state = 'running' }",
    '} | ConvertTo-Json -Compress',
  ].join('\n')
  const { stdout } = await execute(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeout: 3_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }
  )
  const parsed: unknown = JSON.parse(stdout)
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
  return rows.map((value): ProcessIdentity => {
    if (value === null || typeof value !== 'object') {
      throw new Error('Could not inspect the owned Windows process table.')
    }
    const row = value as Record<string, unknown>
    const pid = row['pid']
    const parentPid = row['parentPid']
    const startedAt = row['startedAt']
    if (
      typeof pid !== 'number' ||
      typeof parentPid !== 'number' ||
      (startedAt !== null && typeof startedAt !== 'string')
    ) {
      throw new Error('Could not inspect owned Windows process identities.')
    }
    return { pid, parentPid, startedAt, groupId: null, state: 'running' }
  })
}

export async function signalOwnedProcess(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
  identity?: ProcessIdentity
): Promise<void> {
  if (platform !== 'win32') {
    try {
      process.kill(pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    return
  }
  const startedAt = identity?.startedAt ?? null
  if (pid <= 0 || startedAt === null || !/^\d+$/.test(startedAt)) {
    throw new Error('Cannot signal a Windows process without an owned birth identity.')
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$ownedPid = ${String(pid)}`,
    `$ownedBirth = [decimal]'${startedAt}'`,
    '$owned = Get-Process -Id $ownedPid -ErrorAction SilentlyContinue',
    'if ($null -ne $owned) {',
    '  $handle = $owned.SafeHandle',
    '  $actualBirth = [decimal]$owned.StartTime.ToUniversalTime().Ticks',
    '  if ([math]::Floor($actualBirth / 10) -eq [math]::Floor($ownedBirth / 10)) {',
    '    $owned.Kill()',
    '  }',
    '  $owned.Dispose()',
    '}',
  ].join('\n')
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 3_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
}
