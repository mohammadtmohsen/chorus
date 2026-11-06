import { hostPlatformKey } from './remote-host-check.js'
export {
  hostPlatformKey,
  QUOTE_PROBE,
  REMOTE_CHECK_DEADLINE_MS,
  checkRemoteHost,
  powerShellQuotingHolds,
  type RemoteHostCheck,
} from './remote-host-check.js'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { app } from 'electron'
import {
  encodedPowerShell,
  powerShellLiteral,
  type RemoteHost,
  type RemoteResult,
  SshRemoteHost,
  windowsArgument,
} from './remote-host.js'
import { acquireTunnel, releaseTunnel, SSH_TUNNEL } from './remote-tunnel.js'
import {
  cachedServerArchive,
  chooseTunnelPort,
  loadWorkbenchManifest,
  readServerPort,
  redactToken,
  serverArguments,
  workbenchHostLog,
  workbenchShuttingDown,
  type WorkbenchHostLog,
  type WorkbenchManifest,
  type WorkbenchRuntime,
} from './workbench-host.js'

export interface RemoteServerDeadlines {
  readonly command: number
  readonly upload: number
  readonly install: number
}

export interface ProvisionOptions {
  readonly host: RemoteHost
  readonly manifest: WorkbenchManifest
  readonly localArchive: (platformKey: string) => Promise<string>
  readonly deadlines: RemoteServerDeadlines
  readonly log?: WorkbenchHostLog
}

const PROBE_SCRIPT = [
  "$base = Join-Path $env:LOCALAPPDATA 'chorus-reh'",
  'New-Item -ItemType Directory -Force -Path $base | Out-Null',
  'Write-Output $base',
  'Write-Output $env:PROCESSOR_ARCHITECTURE',
].join('\n')

const PATCH_COMMIT_JS = [
  "const fs = require('fs')",
  'const [, , file, commit] = process.argv',
  "const product = JSON.parse(fs.readFileSync(file, 'utf8'))",
  "fs.writeFileSync(file, JSON.stringify({ ...product, commit }, null, 2) + '\\n')",
].join('\n')

function withoutSshWarnings(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('**'))
    .join('\n')
    .trim()
}

function succeeded(result: RemoteResult, step: string): string {
  if (result.exitCode !== 0) {
    const stderr = withoutSshWarnings(result.stderr)
    const said = stderr === '' ? withoutSshWarnings(result.stdout) : stderr
    throw new Error(`${step} failed on the remote host: ${said}`)
  }
  return result.stdout
}

const RECEIPT_NAME = 'chorus-receipt.txt'

function presenceScript(finalDir: string, sha256: string): string {
  return [
    `$receipt = Join-Path ${powerShellLiteral(finalDir)} '${RECEIPT_NAME}'`,
    '$installed = if (Test-Path -LiteralPath $receipt) { (Get-Content -Raw -LiteralPath $receipt).Trim() }',
    `if ($installed -eq ${powerShellLiteral(sha256)}) { 'present' } else { 'absent' }`,
  ].join('\n')
}

function installScript(input: {
  readonly archive: string
  readonly finalDir: string
  readonly sha256: string
  readonly commit: string
}): string {
  return [
    `$archive = ${powerShellLiteral(input.archive)}`,
    `$final = ${powerShellLiteral(input.finalDir)}`,
    `$partial = ${powerShellLiteral(`${input.finalDir}.partial`)}`,
    '$holding = @(Get-CimInstance -ClassName Win32_Process | Where-Object {',
    "  $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($final)",
    '}).Count',
    "if ($holding -gt 0) { throw 'A running workbench server still uses the tree to replace' }",
    '$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()',
    `if ($hash -ne ${powerShellLiteral(input.sha256)}) {`,
    '  Remove-Item -LiteralPath $archive -Force',
    "  throw 'The uploaded server archive does not match its checksum'",
    '}',
    'if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Recurse -Force }',
    'New-Item -ItemType Directory -Path $partial | Out-Null',
    "& (Join-Path $env:SystemRoot 'System32\\tar.exe') -xzf $archive -C $partial",
    "if ($LASTEXITCODE -ne 0) { throw 'tar.exe could not extract the server archive' }",
    "$node = Join-Path $partial 'node.exe'",
    "$product = Join-Path $partial 'product.json'",
    'if (-not ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $product))) {',
    "  throw 'The extracted server has no node.exe or product.json'",
    '}',
    "$patch = Join-Path $partial 'chorus-patch-commit.cjs'",
    `Set-Content -LiteralPath $patch -Encoding ASCII -Value ${powerShellLiteral(PATCH_COMMIT_JS)}`,
    `& $node $patch $product ${powerShellLiteral(input.commit)}`,
    "if ($LASTEXITCODE -ne 0) { throw 'The server product.json could not be patched' }",
    'Remove-Item -LiteralPath $patch -Force',
    `Set-Content -LiteralPath (Join-Path $partial '${RECEIPT_NAME}') -Encoding ASCII -Value $hash`,
    'if (Test-Path -LiteralPath $final) { Remove-Item -LiteralPath $final -Recurse -Force }',
    'Rename-Item -LiteralPath $partial -NewName (Split-Path -Leaf $final)',
    'Remove-Item -LiteralPath $archive -Force',
  ].join('\n')
}

export async function provisionRemoteServer(options: ProvisionOptions): Promise<string> {
  const { host, manifest, deadlines } = options
  const probe = succeeded(
    await host.runPowerShell(PROBE_SCRIPT, deadlines.command),
    'Probing the host'
  )
  const [base, architecture] = probe.trim().split(/\r?\n/)
  if (base === undefined || architecture === undefined) {
    throw new Error(`The remote host's probe was not understood: ${probe}`)
  }
  const key = hostPlatformKey(architecture.trim())
  const artifact = manifest.server.artifacts[key]
  if (artifact === undefined) {
    throw new Error(`No ${manifest.server.vendor} server is published for ${key}`)
  }

  const finalDir = win32.join(base.trim(), `${manifest.server.release}-${key}`)
  options.log?.info('remote server probed', { platform: key, finalDir })
  const presence = succeeded(
    await host.runPowerShell(presenceScript(finalDir, artifact.sha256), deadlines.command),
    'Checking for the server'
  )
  if (presence.trim() === 'present') {
    options.log?.info('remote server already installed', { finalDir })
    return finalDir
  }

  const remoteArchive = win32.join(base.trim(), artifact.name)
  const localArchive = await options.localArchive(key)
  options.log?.info('remote server uploading', { artifact: artifact.name, bytes: artifact.size })
  await host.upload(localArchive, remoteArchive, deadlines.upload)
  options.log?.info('remote server uploaded', { remoteArchive })
  const install = installScript({
    archive: remoteArchive,
    finalDir,
    sha256: artifact.sha256,
    commit: manifest.client.vscodeCommit,
  })
  succeeded(await host.runPowerShell(install, deadlines.install), 'Installing the server')
  options.log?.info('remote server installed', { finalDir })
  return finalDir
}

export const REMOTE_SERVER_TASK = 'Chorus Workbench Server'

export interface RemoteServerLayout {
  readonly serverDir: string
  readonly tokenFile: string
  readonly serverDataDir: string
  readonly extensionsDir: string
  readonly userDataDir: string
  readonly stdoutLog: string
  readonly stderrLog: string
  readonly reapLog: string
}

export function remoteServerLayout(serverDir: string): RemoteServerLayout {
  const base = win32.dirname(serverDir)
  const data = win32.join(base, 'data')
  return {
    serverDir,
    tokenFile: win32.join(base, 'connection-token'),
    serverDataDir: win32.join(data, 'server'),
    extensionsDir: win32.join(data, 'extensions'),
    userDataDir: win32.join(data, 'data'),
    stdoutLog: win32.join(base, 'server.out.log'),
    stderrLog: win32.join(base, 'server.err.log'),
    reapLog: win32.join(base, 'server.reap.log'),
  }
}

export const REMOTE_RECONNECTION_GRACE_SECONDS = 120

export function remoteServerArguments(layout: RemoteServerLayout, port: number): readonly string[] {
  const local = serverArguments({
    script: win32.join(layout.serverDir, 'out', 'server-main.js'),
    port,
    tokenFile: layout.tokenFile,
    serverDataDir: layout.serverDataDir,
    extensionsDir: layout.extensionsDir,
    userDataDir: layout.userDataDir,
  })
  const grace = local.indexOf('--reconnection-grace-time')
  if (grace === -1) {
    throw new Error('The server arguments no longer set a reconnection grace time')
  }
  return [
    ...local.slice(0, grace + 1),
    String(REMOTE_RECONNECTION_GRACE_SECONDS),
    ...local.slice(grace + 2),
    '--enable-remote-auto-shutdown',
  ]
}

export function ensureLocalToken(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (!existsSync(path)) writeFileSync(path, randomUUID(), { mode: 0o600 })
  chmodSync(path, 0o600)
}

export interface StartDeadlines {
  readonly command: number
  readonly upload: number
  readonly serverStart: number
}

export interface StartOptions {
  readonly host: RemoteHost
  readonly serverDir: string
  readonly localTokenFile: string
  readonly port: number
  readonly deadlines: StartDeadlines
  readonly log?: WorkbenchHostLog
}

export interface StartedServer {
  readonly port: number
  readonly reattached: boolean
}

export type ReapKind = 'server' | 'descendant' | 'tree'

export interface ReapCandidate {
  readonly pid: number
  readonly parentPid: number
  readonly kind: ReapKind
}

const REAP_PRECEDENCE: readonly ReapKind[] = ['server', 'descendant', 'tree']

const DESCENDANTS_OF = [
  'function descendantsOf($roots, $children) {',
  '  $found = @()',
  '  $seen = @{}',
  '  $pending = @($roots)',
  '  while ($pending.Count -gt 0) {',
  '    $next = @()',
  '    foreach ($parent in $pending) {',
  '      if ($null -eq $children -or -not $children.ContainsKey($parent)) { continue }',
  '      foreach ($child in @($children[$parent])) {',
  '        $id = [string]$child.ProcessId',
  '        if ($seen.ContainsKey($id)) { continue }',
  '        $seen[$id] = $true',
  '        $found += $child',
  '        $next += $id',
  '      }',
  '    }',
  '    $pending = $next',
  '  }',
  '  return $found',
  '}',
].join('\n')

function processTableScript(layout: RemoteServerLayout): string {
  return [
    DESCENDANTS_OF,
    `$dataDir = ${powerShellLiteral(layout.serverDataDir)}`,
    `$tree = ${powerShellLiteral(layout.serverDir)}`,
    '$all = @(Get-CimInstance -ClassName Win32_Process)',
    '$children = $all | Group-Object -Property ParentProcessId -AsHashTable -AsString',
    '$servers = @($all | Where-Object {',
    "  $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($dataDir)",
    '})',
    '$serverIds = @($servers | ForEach-Object { [string]$_.ProcessId })',
    '$inTree = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($tree) })',
  ].join('\n')
}

export function reapCandidatesScript(layout: RemoteServerLayout): string {
  return [
    processTableScript(layout),
    "foreach ($s in $servers) { Write-Output ('server ' + $s.ProcessId + ' ' + $s.ParentProcessId) }",
    'foreach ($child in @(descendantsOf $serverIds $children)) {',
    "  Write-Output ('descendant ' + $child.ProcessId + ' ' + $child.ParentProcessId)",
    '}',
    "foreach ($p in $inTree) { Write-Output ('tree ' + $p.ProcessId + ' ' + $p.ParentProcessId) }",
  ].join('\n')
}

export function clearHostScript(layout: RemoteServerLayout, killServers: boolean): string {
  return [
    processTableScript(layout),
    `$killServers = ${killServers ? '$true' : '$false'}`,
    "if (-not $killServers -and $servers.Count -gt 0) { Write-Output 'live'; exit 0 }",
    '$doomed = @($servers) + @(descendantsOf $serverIds $children) + $inTree',
    '$reaped = @()',
    'foreach ($process in $doomed) {',
    '  $id = [string]$process.ProcessId',
    '  if ($reaped -contains $id) { continue }',
    '  Stop-Process -Id ([int]$id) -Force -ErrorAction SilentlyContinue',
    '  $reaped += $id',
    '}',
    "Write-Output ('cleared ' + ($reaped -join ','))",
  ].join('\n')
}

export function parseReapCandidates(stdout: string): readonly ReapCandidate[] {
  const byPid = new Map<number, ReapCandidate>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(server|descendant|tree) (\d+) (\d+)$/.exec(line.trim())
    const [, kindText, pidText, parentText] = match ?? []
    if (kindText === undefined || pidText === undefined || parentText === undefined) continue
    const kind = kindText as ReapKind
    const candidate = { pid: Number(pidText), parentPid: Number(parentText), kind }
    const held = byPid.get(candidate.pid)
    if (held === undefined || REAP_PRECEDENCE.indexOf(kind) < REAP_PRECEDENCE.indexOf(held.kind)) {
      byPid.set(candidate.pid, candidate)
    }
  }
  return [...byPid.values()]
}

export async function remoteReapCandidates(
  host: RemoteHost,
  layout: RemoteServerLayout,
  deadlineMs: number
): Promise<readonly ReapCandidate[]> {
  const found = succeeded(
    await host.runPowerShell(reapCandidatesScript(layout), deadlineMs),
    'Finding the server processes'
  )
  return parseReapCandidates(found)
}

function statusScript(layout: RemoteServerLayout, port: number): string {
  return [
    `$dataDir = ${powerShellLiteral(layout.serverDataDir)}`,
    `$tree = ${powerShellLiteral(layout.serverDir)}`,
    `$tokenFile = ${powerShellLiteral(layout.tokenFile)}`,
    '$servers = @(Get-CimInstance -ClassName Win32_Process | Where-Object {',
    "  $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($dataDir)",
    '})',
    '$running = $servers.Count',
    '$onTree = @($servers | Where-Object { $_.CommandLine.Contains($tree) }).Count',
    "$tokenHash = ''",
    'if (Test-Path -LiteralPath $tokenFile) {',
    '  $tokenHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tokenFile).Hash.ToLowerInvariant()',
    '}',
    '$client = New-Object System.Net.Sockets.TcpClient',
    '$listening = $false',
    `try { $listening = $client.ConnectAsync('127.0.0.1', ${String(port)}).Wait(1000) }`,
    'catch { $listening = $false }',
    'finally { $client.Close() }',
    'Write-Output $running',
    'Write-Output $tokenHash',
    'Write-Output $listening',
    'Write-Output $onTree',
  ].join('\n')
}

function launcherScript(layout: RemoteServerLayout, port: number): string {
  const commandLine = remoteServerArguments(layout, port).map(windowsArgument).join(' ')
  const node = win32.join(layout.serverDir, 'node.exe')
  return [
    `$out = ${powerShellLiteral(layout.stdoutLog)}`,
    `$err = ${powerShellLiteral(layout.stderrLog)}`,
    `$server = Start-Process -WindowStyle Hidden -WorkingDirectory ${powerShellLiteral(layout.serverDir)} \``,
    `  -FilePath ${powerShellLiteral(node)} -ArgumentList ${powerShellLiteral(commandLine)} \``,
    '  -RedirectStandardOutput $out -RedirectStandardError $err -PassThru',
    '$server.WaitForExit()',
    '$reaped = @()',
    "$outcome = ''",
    'try {',
    processTableScript(layout),
    '$keep = @{}',
    'foreach ($id in $serverIds) { $keep[$id] = $true }',
    'foreach ($child in @(descendantsOf $serverIds $children)) { $keep[[string]$child.ProcessId] = $true }',
    '$doomed = @(descendantsOf @([string]$server.Id) $children) + $inTree',
    'foreach ($process in $doomed) {',
    '  $id = [string]$process.ProcessId',
    '  if ($keep.ContainsKey($id) -or $reaped -contains $id) { continue }',
    '  Stop-Process -Id ([int]$id) -Force -ErrorAction SilentlyContinue',
    '  $reaped += $id',
    '}',
    "$outcome = 'reaped ' + ($reaped -join ',')",
    '} catch {',
    "  $outcome = 'reap failed: ' + $_.Exception.Message + '; reaped ' + ($reaped -join ',')",
    '}',
    "$stamp = (Get-Date).ToString('o')",
    "$line = $stamp + ' server ' + $server.Id + ' exited; ' + $outcome",
    `Add-Content -LiteralPath ${powerShellLiteral(layout.reapLog)} -Value $line`,
  ].join('\n')
}

function registerScript(layout: RemoteServerLayout, launcher: string): string {
  const task = powerShellLiteral(REMOTE_SERVER_TASK)
  const logs = `${powerShellLiteral(layout.stdoutLog)}, ${powerShellLiteral(layout.stderrLog)}`
  return [
    `Remove-Item -LiteralPath ${logs} -Force -ErrorAction SilentlyContinue`,
    `$launcher = ${powerShellLiteral(encodedPowerShell(launcher))}`,
    "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $launcher"',
    '$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments',
    '$me = (whoami).Trim()',
    '$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive',
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `',
    '  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances Parallel',
    `Register-ScheduledTask -TaskName ${task} -Action $action -Principal $principal \``,
    '  -Settings $settings -Force | Out-Null',
    `Start-ScheduledTask -TaskName ${task}`,
  ].join('\n')
}

function waitScript(layout: RemoteServerLayout, seconds: number): string {
  return [
    `$out = ${powerShellLiteral(layout.stdoutLog)}`,
    `$err = ${powerShellLiteral(layout.stderrLog)}`,
    `$until = (Get-Date).AddSeconds(${String(seconds)})`,
    'while ((Get-Date) -lt $until) {',
    '  if (Test-Path -LiteralPath $out) {',
    '    $text = Get-Content -Raw -LiteralPath $out',
    "    if ($text -match 'listening on \\d+|Server bound to|Web UI available at') {",
    "      Write-Output 'started'",
    '      Write-Output $text',
    '      exit 0',
    '    }',
    '  }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    "Write-Output 'timed-out'",
    `$task = Get-ScheduledTaskInfo -TaskName ${powerShellLiteral(REMOTE_SERVER_TASK)}`,
    "Write-Output ('LastTaskResult: ' + $task.LastTaskResult)",
    'if (Test-Path -LiteralPath $err) { Get-Content -Tail 20 -LiteralPath $err }',
  ].join('\n')
}

export async function startRemoteServer(options: StartOptions): Promise<StartedServer> {
  const { host, port, deadlines } = options
  const layout = remoteServerLayout(options.serverDir)
  const localHash = createHash('sha256').update(readFileSync(options.localTokenFile)).digest('hex')

  const status = succeeded(
    await host.runPowerShell(statusScript(layout, port), deadlines.command),
    'Checking the server'
  )
  const [running, tokenHash, listening, onTree] = status
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
  const count = Number(running)
  if (running === '' || !Number.isInteger(count)) {
    throw new Error(`The server check on the host was not understood: ${status}`)
  }
  const tokenMatches = tokenHash === localHash
  const thisRelease = Number(onTree) > 0
  options.log?.info('remote server status', {
    running: count,
    tokenMatches,
    listening,
    thisRelease,
  })
  if (count > 0 && tokenMatches && listening === 'True' && thisRelease) {
    options.log?.info('remote server reattached', { port })
    return { port, reattached: true }
  }
  if (count > 0 && !tokenMatches) {
    throw new Error(
      'A Chorus workbench server is already running on the host under another token or port, ' +
        'from another machine or another Chorus profile on this one. It stops itself five ' +
        'minutes after its last editor closes.'
    )
  }

  const replacing = count > 0
  const cleared = succeeded(
    await host.runPowerShell(clearHostScript(layout, replacing), deadlines.command),
    'Clearing the host'
  ).trim()
  if (cleared === 'live') {
    throw new Error(
      'A Chorus workbench server started on the host while this one was preparing. ' +
        'Open the project again.'
    )
  }
  options.log?.info('remote host cleared', {
    replacing,
    reaped: cleared.replace(/^cleared ?/, ''),
  })

  await host.upload(options.localTokenFile, layout.tokenFile, deadlines.upload)
  const register = registerScript(layout, launcherScript(layout, port))
  succeeded(await host.runPowerShell(register, deadlines.command), 'Starting the server')
  options.log?.info('remote server task started', { task: REMOTE_SERVER_TASK, port })
  const seconds = Math.ceil(deadlines.serverStart / 1000)
  const waitDeadline = deadlines.command + deadlines.serverStart
  const waited = succeeded(
    await host.runPowerShell(waitScript(layout, seconds), waitDeadline),
    'Waiting for the server'
  )
  const [outcome, ...rest] = waited.split(/\r?\n/)
  const said = redactToken(rest.join('\n')).trim()
  if (outcome?.trim() !== 'started') {
    throw new Error(`The workbench server on the host did not start: ${said}`)
  }
  const bound = readServerPort(said)
  if (bound !== port) {
    throw new Error(`The server on the host bound ${String(bound)}, not ${String(port)}`)
  }
  options.log?.info('remote server started', { port })
  return { port, reattached: false }
}

export const REMOTE_SERVER_PORT = 47_500
export const TUNNEL_UP_DEADLINE_MS = 60_000

const PROVISION_DEADLINES: RemoteServerDeadlines = {
  command: 30_000,
  upload: 600_000,
  install: 600_000,
}

const START_DEADLINES: StartDeadlines = { command: 30_000, upload: 30_000, serverStart: 60_000 }

interface PreparedServer {
  readonly tokenFile: string
  readonly localPort: number
  readonly commit: string
  readonly quality: string
}

const preparing = new Map<string, Promise<PreparedServer>>()

function remoteHostDir(host: string): string {
  return join(app.getPath('userData'), 'remote-hosts', host)
}

async function prepareRemoteServer(host: string): Promise<PreparedServer> {
  const log = workbenchHostLog()
  const hostLog: WorkbenchHostLog = {
    info: (message, fields) => {
      log.info(message, { host, ...fields })
    },
    warn: (message, fields) => {
      log.warn(message, { host, ...fields })
    },
  }
  const { manifest } = loadWorkbenchManifest()
  const tokenFile = join(remoteHostDir(host), 'connection-token')
  ensureLocalToken(tokenFile)
  const remote = new SshRemoteHost(host)
  const download = new AbortController().signal
  const serverDir = await provisionRemoteServer({
    host: remote,
    manifest,
    localArchive: (key) => cachedServerArchive(key, download),
    deadlines: PROVISION_DEADLINES,
    log: hostLog,
  })
  await startRemoteServer({
    host: remote,
    serverDir,
    localTokenFile: tokenFile,
    port: REMOTE_SERVER_PORT,
    deadlines: START_DEADLINES,
    log: hostLog,
  })
  const localPort = await chooseTunnelPort(join(remoteHostDir(host), 'tunnel-port'))
  hostLog.info('remote tunnel port chosen', { localPort })
  return {
    tokenFile,
    localPort,
    commit: manifest.client.vscodeCommit,
    quality: manifest.client.quality,
  }
}

function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false)
    }, ms)
    void promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export async function acquireRemoteWorkbenchRuntime(
  host: string,
  holder: string
): Promise<WorkbenchRuntime> {
  if (workbenchShuttingDown()) {
    throw new Error('Chorus is shutting down; no workbench project can open.')
  }
  const log = workbenchHostLog()
  log.info('remote workbench opening', { host, root: holder })
  const inFlight =
    preparing.get(host) ??
    prepareRemoteServer(host).finally(() => {
      preparing.delete(host)
    })
  preparing.set(host, inFlight)
  let prepared: PreparedServer
  try {
    prepared = await inFlight
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('remote workbench could not be prepared', { host, root: holder, message })
    throw error
  }

  const { localPort } = prepared
  const tunnel = acquireTunnel(
    { host, localPort, remotePort: REMOTE_SERVER_PORT },
    holder,
    SSH_TUNNEL,
    (state, detail) => {
      log.info('remote tunnel', { host, localPort, state, detail })
    }
  )
  if (!(await settlesWithin(tunnel.firstUp, TUNNEL_UP_DEADLINE_MS))) {
    const reason = tunnel.lastFailure === '' ? 'ssh gave no reason' : tunnel.lastFailure
    log.warn('remote tunnel did not come up', { host, root: holder, localPort, reason })
    await releaseTunnel(host, holder)
    throw new Error(
      `The tunnel to ${host} did not come up within ${String(TUNNEL_UP_DEADLINE_MS / 1000)} s: ${reason}`
    )
  }
  log.info('remote workbench ready', { host, root: holder, localPort })
  return {
    remoteAuthority: `127.0.0.1:${String(localPort)}`,
    connectionToken: readFileSync(prepared.tokenFile, 'utf8').trim(),
    commit: prepared.commit,
    quality: prepared.quality,
  }
}

export function releaseRemoteWorkbenchRuntime(host: string, holder: string): Promise<void> {
  return releaseTunnel(host, holder)
}
