import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { app, dialog } from 'electron'
import { z } from 'zod'
import { ownProcessTree, type OwnedProcessTree } from '@chorus/shared/process-tree'
import { prepareWorkbenchProcessOwner } from './workbench-process-owner.js'
import { mainT } from './i18n.js'
import { stopAllTunnels } from './remote-tunnel.js'
import { hashBytes, hashFile, publishServer, sweepQuarantine } from './workbench-extract.js'

/** `reap.ts`'s shape: the process table is read off the main thread. */
const runCommand = promisify(execFile)

/**
 * The one shared remote extension host — preflight §4.1a, §4.2's
 * `workbench-host.ts` row, and §5.4's three lifetimes.
 *
 * One server serves every open project. That is upstream's own design rather
 * than a Chorus invention: the REH holds its connections in maps keyed by
 * reconnection token and forks an extension host per connection, so several
 * workspaces at once is what it is built for — and it is the arrangement with the
 * lower marginal cost per project, one connection and one forked host rather than
 * a second server, a second watcher set and a second host. **R7 still decides
 * whether that passes**; the topology is chosen on architecture and licence and
 * the number is still owed.
 *
 * **The refcount is over open projects, never over visible views.** With a
 * four-pane cap and no cap on open projects, a count over mounted surfaces
 * reaches zero while projects are still open, and the observable result is that
 * switching to a fifth project kills the build running in the first one's
 * terminal. This is `CLAUDE.md`'s terminal rule with a server in place of a PTY:
 * unmounting a view calls neither `acquire` nor `release`.
 *
 * **What the lease cannot do, stated because it is the load-bearing unknown.** It
 * keeps a *process* running; it does not hold a socket open, because the client
 * connections belong to the surface's `WebContents` and go when it does. So if
 * server-side retention does not hold, refcounting alone cannot preserve the
 * promise that an inactive project keeps its terminals — that is a Phase 1 exit
 * decision and it is not settled here.
 */

const ArtifactSchema = z.object({
  name: z.string().min(1),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

/**
 * The manifest of §3.5, and the two regexes are the check that catches the
 * `34.1.3` corruption — a `config.vscode.commit` reading `"1.124.2"`, a version
 * string where a SHA belongs. Anything that reads such a field must reject a
 * value that is not 40 hex characters, or it silently pins a server to a string
 * that can never match.
 */
export const WorkbenchManifest = z.object({
  client: z.object({
    package: z.string().min(1),
    version: z.string().min(1),
    vscodeVersion: z.string().min(1),
    vscodeCommit: z.string().regex(/^[0-9a-f]{40}$/),
    quality: z.string().min(1),
  }),
  server: z.object({
    vendor: z.string().min(1),
    release: z.string().min(1),
    upstreamTag: z.string().min(1),
    upstreamCommit: z.string().regex(/^[0-9a-f]{40}$/),
    artifacts: z.record(z.string(), ArtifactSchema),
  }),
})
export type WorkbenchManifest = z.infer<typeof WorkbenchManifest>

export interface LoadedManifest {
  readonly manifest: WorkbenchManifest
  /** Of the exact bytes read, not of a re-serialisation. The receipt records this. */
  readonly sha256: string
}

/**
 * The one equality that makes client and server a single fact.
 *
 * §2.4 is blunt about why this and not the handshake is the real gate: VSCodium's
 * shipped `commit` is a sha1 of its own version string, so a VSCodium server can
 * never satisfy the server-side check unpatched at *any* version — and the patch
 * that fixes a correct pairing would equally make an incorrect one connect. The
 * server-side check is a second line of defence that has been deliberately
 * satisfied; this is the first.
 */
export function assertMatchedPair(manifest: WorkbenchManifest): void {
  if (manifest.client.vscodeCommit !== manifest.server.upstreamCommit) {
    throw new Error(
      `The workbench manifest is not a matched pair: client ${manifest.client.package}@${manifest.client.version} is VS Code ${manifest.client.vscodeCommit}, ${manifest.server.vendor} ${manifest.server.release} is ${manifest.server.upstreamCommit}. Refusing to patch product.json.`
    )
  }
}

export function loadManifest(path: string): LoadedManifest {
  const bytes = readFileSync(path)
  const manifest = WorkbenchManifest.parse(JSON.parse(bytes.toString('utf8')))
  assertMatchedPair(manifest)
  return { manifest, sha256: hashBytes(bytes) }
}

export function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

/**
 * Where this module says what it is doing, and it had nowhere before.
 *
 * The server's lifecycle is the slowest thing in the app — a 76 MB download, a
 * checksum, a 257 MB extraction, a spawn, a port wait — and none of it appeared
 * in the log. So "the editor is a black rectangle" was indistinguishable from
 * "the editor was never asked for", and telling them apart meant reading process
 * tables and stat-ing directories from outside the app.
 *
 * Injected rather than imported because this module is free functions with
 * module state and no owner to hand it one; main sets it once at startup. The
 * default is a no-op so the unit tests, which import these functions directly,
 * neither need a logger nor write files.
 */
export interface WorkbenchHostLog {
  info: (message: string, fields?: Record<string, unknown>) => void
  warn: (message: string, fields?: Record<string, unknown>) => void
}

const SILENT: WorkbenchHostLog = { info: () => undefined, warn: () => undefined }
let log: WorkbenchHostLog = SILENT

export function setWorkbenchHostLog(next: WorkbenchHostLog): void {
  log = next
}

export function workbenchHostLog(): WorkbenchHostLog {
  return log
}

function manifestPath(): string {
  return join(app.getAppPath(), 'build', 'workbench-runtime.json')
}

/**
 * Where the downloaded tarball is kept, and it is deliberately **not** under
 * `userData`.
 *
 * It is a re-fetchable, checksum-addressed artifact rather than anything of the
 * person's, and `userData` is redirected per-profile — by `CHORUS_USER_DATA`, and
 * by the containment gate, which points it at a temporary directory it deletes.
 * Keyed off `appData` instead, a second profile and every gate run reuse one
 * 76 MB download. Overridable in development so a checkout that has already
 * fetched the artifact does not fetch it again; ignored when packaged, because
 * the argument is about a harness.
 */
function cacheDir(): string {
  const override = process.env['CHORUS_WORKBENCH_CACHE']
  if (!app.isPackaged && override !== undefined && override !== '') return override
  return join(app.getPath('appData'), 'chorus-workbench-runtime')
}

/**
 * The packaged app's `Resources` directory, or nothing outside one.
 *
 * **A function, and that is the point rather than a style.** Electron's types
 * declare `process.resourcesPath` as `string`; under plain Node — which is what
 * this module is unit tested in — it does not exist. Read directly it made
 * `join` throw `ERR_INVALID_ARG_TYPE` before any of this module's own logic ran,
 * and fifteen tests failed for a reason none of them was about.
 *
 * A local annotation does not fix it: TypeScript narrows a variable by what is
 * assigned to it, so `const p: string | undefined = process.resourcesPath` is
 * narrowed straight back to `string` and the guard reads as dead code. A
 * function's *declared return type* is not narrowed at the call site, so this is
 * the honest type arriving where it is used — no cast, and nothing silenced.
 */
function resourcesPath(): string | undefined {
  return process.resourcesPath
}

/** `<userData>/workbench`, per §3.5 — every temporary and quarantine sibling lives here. */
function extractionRoot(): string {
  return join(app.getPath('userData'), 'workbench')
}

/** Chorus's own server data, and the path `reap.ts` would match on: no other server has it. */
export function serverDataDir(): string {
  return join(app.getPath('userData'), 'workbench-server')
}

/**
 * The port this profile uses, chosen once and kept — Phase 1.
 *
 * **Why a fixed port at all.** The authority is `127.0.0.1:<port>`, and it is
 * written into every `vscode-remote://` URI the workbench builds. Anything the
 * editor stores *inside* a workspace that names a resource therefore names a
 * port, and anything keyed by such a name stops matching on the next launch. The
 * storage identity was pinned by hand (`remote-authority.ts`, `workspaceIdFor`);
 * the SCM view's repository keys were not, and the symptom was a Source Control
 * panel that listed the change while the status bar showed no branch at all —
 * `getProviderStorageKey` embeds the `rootUri`, the stored key never matches, and
 * `scmViewService.js:293` returns before the auto-focus at `:333-335`.
 *
 * **The range, and why it is reasoned rather than copied.** Chromium restricts
 * a set of ports a browser refuses to connect to, and VS Code vendors that list
 * as `BROWSER_RESTRICTED_PORTS` — but `@codingame/monaco-vscode-api` does not
 * ship `vs/base/node`, so it cannot be imported here and is not reproduced as 80
 * lines that would drift. It does not need to be: the list runs from 1 to
 * **10080**, so any range above that avoids every entry by construction. Below
 * **49152**, this machine's `net.inet.ip.portrange.first`, so the choice never
 * competes with the ports the kernel hands to outbound connections — which is
 * what a `bind(0)` pick would have done. And clear of the ports a developer
 * already has running: 3000, 5173, 8080, and this machine's own 30000–30040 from
 * `~/bin/tpaDevPort.zsh`. Hence 47500–47999, five hundred wide, which is far more
 * than one profile needs and still a single short range to reason about.
 */
const PORT_RANGE_FIRST = 47_500
const PORT_RANGE_LAST = 47_999

export interface PortRange {
  readonly first: number
  readonly last: number
  readonly purpose: string
}

const WORKBENCH_PORTS: PortRange = {
  first: PORT_RANGE_FIRST,
  last: PORT_RANGE_LAST,
  purpose: 'the workbench server',
}

export const TUNNEL_PORTS: PortRange = { first: 48_000, last: 48_499, purpose: 'a remote tunnel' }

function chosenPortFile(): string {
  return join(serverDataDir(), 'chosen-port')
}

/** Whether `127.0.0.1:<port>` can be bound here and now. */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => {
      resolve(false)
    })
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => {
        resolve(true)
      })
    })
  })
}

/**
 * The persisted port, choosing one only when there is not one already.
 *
 * **Probed once and then never again.** The first free port in the range is
 * written down and reused for every later launch, which is the property the whole
 * phase exists for: a port that moves is a name that moves. Re-probing on each
 * start would return the same number only by luck, and the storage keys that name
 * it would churn exactly as before.
 *
 * **A persisted port that is later taken is not re-probed here.** Failing closed
 * is the decision (see `start`), and silently choosing a new one would restore the
 * churn this removes — a workbench that works today and has forgotten everything
 * tomorrow, which is worse than one that says why it will not start.
 *
 * `file` and `probe` are parameters so the choice can be tested without a real
 * filesystem or a real kernel, in the same spirit as `readServerPort` and
 * `serverLauncher` above.
 */
export async function chooseWorkbenchPort(
  file: string = chosenPortFile(),
  probe: (port: number) => Promise<boolean> = canBind,
  ports: PortRange = WORKBENCH_PORTS
): Promise<number> {
  /*
   * Absent is the ordinary first run, not an error — so it is read through the
   * same `catch` that treats any other unreadable file as "no port recorded yet",
   * because the answer to both is the same probe.
   */
  let recorded: string
  try {
    recorded = readFileSync(file, 'utf8').trim()
  } catch {
    recorded = ''
  }
  /*
   * **Digits and nothing else, before the range is even considered.** The value
   * this file is written with is always `String(port)`, so a string that is not
   * purely digits is a value this code did not write — and `parseInt` would accept
   * one anyway: `parseInt('47510abc', 10)` is `47510`, and `'4751.5'` is `4751`.
   * Both would be handed to `--port` as a number this code never chose — which is
   * the whole of what this check is for.
   *
   * Anything rejected here is not an error. The range is about to be probed and
   * the file overwritten, so a truncated or hand-edited file costs one probe
   * rather than a refusal to start.
   */
  const held = /^\d+$/.test(recorded) ? Number.parseInt(recorded, 10) : Number.NaN
  if (Number.isInteger(held) && held >= ports.first && held <= ports.last) {
    return held
  }
  for (let port = ports.first; port <= ports.last; port += 1) {
    if (!(await probe(port))) continue
    writeFileSync(file, String(port), { mode: 0o600 })
    return port
  }
  throw new Error(
    `Chorus could not find a free port between ${String(ports.first)} and ${String(ports.last)} for ${ports.purpose}. Something is holding all of them.`
  )
}

export function chooseTunnelPort(
  file: string,
  probe: (port: number) => Promise<boolean> = canBind
): Promise<number> {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  return chooseWorkbenchPort(file, probe, TUNNEL_PORTS)
}

async function download(
  url: string,
  into: string,
  expectedSize: number,
  signal: AbortSignal
): Promise<void> {
  mkdirSync(join(into, '..'), { recursive: true })
  const partial = `${into}.part`
  /*
   * The signal reaches `fetch`, because this is the step that can stall for as
   * long as the network cares to. Without it, quitting Chorus mid-download meant
   * waiting for a 76 MB transfer to finish or time out on its own — and once
   * `SIGTERM` stopped being handled by Electron's default termination, that was
   * an app that appeared to hang on quit.
   */
  const response = await fetch(url, { signal })
  if (!response.ok || response.body === null) {
    throw new Error(
      `Could not fetch the workbench server: ${String(response.status)} ${response.statusText}`
    )
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== expectedSize) {
    throw new Error(
      `The workbench server download is ${String(bytes.length)} B where the manifest says ${String(expectedSize)} B`
    )
  }
  writeFileSync(partial, bytes)
  // Renamed only once whole, so an interrupted download cannot be found by name
  // and mistaken for a complete one. The checksum would catch it either way; this
  // keeps the failure from costing an extraction first.
  renameSync(partial, into)
}

function serverArchiveUrl(manifest: WorkbenchManifest, artifactName: string): string {
  return `https://github.com/VSCodium/vscodium/releases/download/${manifest.server.release}/${artifactName}`
}

export async function cachedServerArchive(key: string, signal: AbortSignal): Promise<string> {
  const { manifest } = loadManifest(manifestPath())
  const artifact = manifest.server.artifacts[key]
  if (artifact === undefined) {
    throw new Error(`No ${manifest.server.vendor} server is published for ${key}`)
  }
  const archive = join(cacheDir(), artifact.name)
  const url = serverArchiveUrl(manifest, artifact.name)
  if (!existsSync(archive) || statSync(archive).size !== artifact.size) {
    await download(url, archive, artifact.size, signal)
  }
  if ((await hashFile(archive)) === artifact.sha256) return archive
  rmSync(archive, { force: true })
  await download(url, archive, artifact.size, signal)
  if ((await hashFile(archive)) === artifact.sha256) return archive
  rmSync(archive, { force: true })
  throw new Error(`The downloaded ${artifact.name} does not match the manifest checksum`)
}

export interface WorkbenchRuntime {
  readonly remoteAuthority: string
  readonly connectionToken: string
  readonly commit: string
  readonly quality: string
}

export function loadWorkbenchManifest(): LoadedManifest {
  return loadManifest(manifestPath())
}

interface RunningHost {
  readonly child: ChildProcess
  readonly runtime: WorkbenchRuntime
  /** Kept until the server stops, because the server reads it per connection. */
  readonly tokenFile: string
}

let host: RunningHost | null = null
let starting: Promise<WorkbenchRuntime> | null = null
/** The lease, by project. Never by view, never by connection. */
const leases = new Set<string>()

/**
 * Every server process this main has spawned and not yet seen exit — and it is a
 * set rather than a single reference because that is what makes "no orphan" a
 * property instead of a race analysis.
 *
 * A child exists from the moment `spawn` returns, which is well before it becomes
 * `host`: it has to report a port first, and that wait can time out, throw, or be
 * overtaken by a shutdown. Tracking only the *successful* one leaves three ways to
 * strand a 257 MB server — a start that failed after spawning, a start still in
 * flight when the app quits, and a start that completes after shutdown has already
 * decided there was nothing to stop. Shutdown kills whatever is in here, so all
 * three collapse into one case.
 */
const spawned = new Set<ChildProcess>()
const ownedTrees = new Map<ChildProcess, OwnedProcessTree>()
let idleStopping: Promise<void> | null = null

/**
 * Set once shutdown has begun, and never cleared: an app that is quitting does not
 * start a remote extension host, whatever arrives on the IPC channel afterwards.
 */
let shuttingDown = false
/**
 * What a shutdown actually achieved, rather than what it attempted.
 *
 * `survivors` exists because the alternative is a function that always reports
 * success: a caller that logs "stopped 1" when a group is still running has been
 * told something false by a design that made it impossible to tell the truth.
 */
export interface ShutdownResult {
  readonly stopped: number
  readonly survivors: readonly number[]
}

/** Memoised, so quit, `SIGTERM` and `SIGINT` are one shutdown rather than three. */
let stopping: Promise<ShutdownResult> | null = null
/**
 * The in-flight start's cancellation, held here because shutdown has to reach it.
 *
 * A promise can be awaited but not stopped, and awaiting was the whole defect: a
 * shutdown that arrived during a 76 MB download waited for the download.
 */
let startAbort: AbortController | null = null

/**
 * Why the server is gone, when it went without being asked — and the reason this
 * is a dead end rather than a restart.
 *
 * Re-spawning would hand the next project a **new connection token**, and every
 * surface already open holds the old one in the descriptor it was given at
 * creation. A second server mints a fresh token, so those surfaces would open,
 * connect, fail to authenticate, and render an empty tree — the same
 * indistinguishable failure the connection-token bug produced.
 *
 * **That reason used to be the port**, and Phase 1 is what changed it: the
 * session's CSP was built once, with the first authority baked into it, so a
 * re-spawn used to be refused by a `connect-src` naming a port the new server
 * would not have. A fixed port means the authority now survives a restart, and
 * the token is what does not.
 * The conclusion is unchanged and this is still a dead end; what it is a dead end
 * *for* is worth having right, because it is the difference between two fixes
 * that look equally plausible from here. Surface recreation and a dynamic
 * authority have to be designed together; until they are, this fails closed and
 * says so.
 */
let hostFailure: string | null = null

const CANNOT_FORK = /Error: spawn (?:EBADF|EMFILE|ENFILE)\b/

const degradedChildren = new WeakSet<ChildProcess>()
const retiredChildren = new WeakSet<ChildProcess>()

function noteDegradedServer(child: ChildProcess, output: string): void {
  if (retiredChildren.has(child) || degradedChildren.has(child)) return
  if (!CANNOT_FORK.test(output)) return
  degradedChildren.add(child)
  log.warn('workbench server can no longer start child processes', {
    pid: child.pid ?? null,
    consequence: 'extension hosts, file watching and source control can no longer start',
  })
  void dialog
    .showMessageBox({
      type: 'warning',
      buttons: ['OK'],
      message: mainT('workbench.serverDegradedTitle'),
      detail: mainT('workbench.serverDegradedDetail'),
    })
    .catch(() => undefined)
}

function refuseDegradedHost(): void {
  if (host !== null && degradedChildren.has(host.child)) {
    throw new Error(mainT('workbench.serverDegradedRefusal'))
  }
}

/**
 * The port, read back out of the child's own stdout — **requested now, but still
 * never assumed**.
 *
 * It used to read "never chosen, never scanned, never assumed", and the first of
 * those three stopped being true when Phase 1 gave the profile a fixed port. The
 * other two are untouched, and the sentence below is the one that matters.
 *
 * This is `CLAUDE.md`'s e2e-harness rule one level out: attaching to a stale REH
 * from a previous run, possibly at a *different commit*, presents as a workbench
 * that works and is wrong, which is exactly what attaching to whatever owned port
 * 9800 produced. Never attach to a port Chorus did not open.
 *
 * **The line is not the one preflight §5.4 predicted, and that is a correction
 * worth carrying.** §5.4 says to parse `Web UI available at
 * http://localhost:<port>?tkn=<token>`. That line belongs to the `reh-web`
 * artifact, which bundles a web workbench; the plain `reh` — the one §2.1
 * correctly chose, because Chorus supplies its own workbench — never prints it.
 * Observed on `vscodium-reh-darwin-arm64-1.121.03429`, the whole of what it says
 * is:
 *
 *     Server bound to 127.0.0.1:50751 (IPv4)
 *     Extension host agent listening on 50751
 *
 * A reader waiting for the predicted line would have hung forever on a server
 * that had started perfectly. Both forms are accepted so a future artifact that
 * prints the other still works.
 */
export function readServerPort(text: string): number | null {
  const listening = /Extension host agent listening on (\d+)/.exec(text)?.[1]
  if (listening !== undefined) return Number.parseInt(listening, 10)
  const bound = /Server bound to \S+?:(\d+)/.exec(text)?.[1]
  if (bound !== undefined) return Number.parseInt(bound, 10)
  const web = /Web UI available at https?:\/\/[^:]+:(\d+)/.exec(text)?.[1]
  return web === undefined ? null : Number.parseInt(web, 10)
}

/** `tkn=` never reaches a log, even though this artifact turns out not to print one. */
export function redactToken(line: string): string {
  return line.replace(/([?&]tkn=)[^&\s]+/g, '$1REDACTED')
}

/**
 * The server's own Node and its entry script — **never the shipped launcher**,
 * and the reason is the leak rather than tidiness.
 *
 * `bin/codium-server` is a bash script, and its last line is
 * `"$ROOT/node" ${INSPECT:-} "$ROOT/out/server-main.js" "$@"` — **without `exec`**.
 * So bash stays alive as the server's parent, Chorus's child is the *wrapper*, and
 * `child.kill()` kills a shell while the 257 MB Node process it started carries on
 * holding the port. That is exactly what was measured: of the two PIDs matching a
 * run's `--server-data-dir`, the wrapper died and the node process survived a clean
 * `code=0` app exit.
 *
 * On Windows the same file is `bin/codium-server.cmd`, and Node's own
 * documentation is explicit that `.cmd` cannot be executed by `spawn` without a
 * shell — so the previous code selected a path that could not run at all. The two
 * problems have one answer: skip the launcher and run what the launcher runs. That
 * is shell-free on every platform, needs no quoting, and makes Chorus's direct
 * child the actual server.
 *
 * **The Windows half is inferred from the artifact layout and has not been
 * observed**: no `win32-x64` tarball has been downloaded, so `node.exe` at the
 * tree root is upstream's convention rather than something seen here. Both paths
 * are checked before spawning, so an artifact that disagrees fails with the name
 * of the missing file rather than as a spawn error nobody can read.
 */
export interface ServerPaths {
  readonly script: string
  readonly port: number
  readonly tokenFile: string
  readonly serverDataDir: string
  readonly extensionsDir: string
  readonly userDataDir: string
}

export function serverArguments(paths: ServerPaths): readonly string[] {
  return [
    paths.script,
    '--host',
    '127.0.0.1',
    '--port',
    `${String(paths.port)}-${String(paths.port)}`,
    '--connection-token-file',
    paths.tokenFile,
    '--server-data-dir',
    paths.serverDataDir,
    '--extensions-dir',
    paths.extensionsDir,
    '--user-data-dir',
    paths.userDataDir,
    '--accept-server-license-terms',
    /*
     * C-065. The server forks an extension host per connection and hands it the
     * socket; from then on that process decides when to die. It has two paths,
     * and they are three hours apart. A graceful protocol `Disconnect` disposes
     * it at once — "the client has disconnected gracefully". A socket that
     * merely closes arms a timer instead, because a dropped connection is
     * supposed to mean a flaky network and a client that will come back.
     *
     * The default for that timer is `ReconnectionGraceTime`, 3 hours. Ten
     * open/close cycles left two extension hosts alive, which read like a
     * missing teardown and is not one: it is the graceful frame losing a race
     * with the view being destroyed. When it wins the host goes immediately,
     * when it loses the host waits three hours, and R11's 60 s settle window
     * can never see the difference.
     *
     * Three hours is the wrong default *here* specifically. It is sized for a
     * laptop that slept on a train; our client is a `WebContentsView` on the
     * other end of a loopback socket that main itself owns, and the only
     * reconnect that can genuinely happen is a renderer crash-reload. Thirty
     * seconds covers that with room to spare, and bounds a leaked host to
     * thirty seconds instead of a working day.
     *
     * Seconds, not milliseconds — the server multiplies by 1000. It also
     * exports the result as `VSCODE_RECONNECTION_GRACE_TIME` into the forked
     * host's environment, which is the only reason setting it on the server
     * reaches the process that actually leaks.
     *
     * This bounds the damage; it does not remove the race. Closing a project
     * still usually reaps at once and sometimes takes thirty seconds.
     */
    '--reconnection-grace-time',
    '30',
    '--telemetry-level',
    'off',
    // Never `trace`: full request URLs, token included, are logged at that level.
    '--log',
    'info',
  ]
}

export function serverLauncher(dir: string): { readonly node: string; readonly script: string } {
  return {
    node: join(dir, process.platform === 'win32' ? 'node.exe' : 'node'),
    script: join(dir, 'out', 'server-main.js'),
  }
}

/** How long a `SIGTERM`ed tree gets before it is killed outright. */
const TERM_GRACE_MS = 5_000
/** And how long the force-kill itself gets before we stop waiting for the kernel. */
const KILL_GRACE_MS = 2_000
/**
 * How long shutdown will wait for a start that is still in flight, and it is
 * short on purpose.
 *
 * Awaiting the start *unboundedly* is what the first version did, and it made the
 * app hang on a stalled download — for as long as the network took, or sixty
 * seconds on the port wait. That became a new failure the moment `SIGTERM` was
 * handled rather than left to Electron's default termination: quitting Chorus
 * could simply stop responding. The start is **cancelled** rather than waited out,
 * and this budget is only how long its unwinding is given before shutdown stops
 * caring and kills whatever is in `spawned` anyway.
 */
const START_ABORT_MS = 2_000

/**
 * Signals the server **and everything it forked**, which is the whole point of
 * spawning it detached.
 *
 * The REH forks an extension host per connection and a file watcher, and those are
 * children of the server rather than of Chorus — so signalling one PID leaves a
 * fan of processes that nothing will ever reap. `detached: true` on POSIX puts the
 * server in its own process group, and a negative PID signals that group, so one
 * call reaches the tree.
 *
 * The negative PID is why `detached` and this function must stay in step: with a
 * non-detached child, `-pid` would name **Chorus's own group** and the app would
 * signal itself. The guard is that this is the only place a negative pid is used
 * and it is written beside the spawn that earns it.
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    /*
     * Windows has no process groups to signal. `taskkill /T` walks the tree and
     * `/F` is unconditional — there is no graceful equivalent, so the two phases
     * below collapse into one here. Unproven, like the rest of the Windows path.
     */
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already gone, or never started: both are the state we wanted */
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: the group is already empty, which is success. Any other failure is
    // not actionable here either — the caller's job is to observe, not to insist.
    try {
      child.kill(signal)
    } catch {
      /* the direct child is gone too */
    }
  }
}

/**
 * Whether **any** process in the server's group is still alive.
 *
 * Signal 0 asks the kernel and sends nothing, and asking it of a negative pid asks
 * about the whole group — so this answers "is the tree dead?" rather than "is the
 * process I spawned dead?", which is the question that matters and the one a
 * single `exitCode` check gets wrong.
 */
function treeAlive(child: ChildProcess): boolean {
  const pid = child.pid
  if (pid === undefined) return false
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForTreeToDie(child: ChildProcess, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!treeAlive(child)) return true
    await new Promise((settle) => setTimeout(settle, 100))
  }
  return !treeAlive(child)
}

/**
 * Ends one server's whole tree: ask, wait, force, wait — then stop tracking it.
 *
 * Shared by shutdown and by the **unexpected-exit** path, and that second caller
 * is why it exists. The exit listener used to drop the child from `spawned` the
 * moment the root process died, which reads as "cleaned up" and is not: the root
 * is the server, and the extension hosts and file watchers it forked are its
 * children. A server that crashes therefore left exactly the fan of processes this
 * whole item is about, arriving by a different route from the one that was fixed.
 * The root being gone says nothing about the group, so the group is what gets
 * asked.
 */
async function reapTree(child: ChildProcess): Promise<boolean> {
  const owned = ownedTrees.get(child)
  if (owned !== undefined) {
    try {
      await owned.stop()
      ownedTrees.delete(child)
      spawned.delete(child)
      return true
    } catch (error) {
      log.warn('workbench process exit could not be confirmed', {
        pid: child.pid ?? null,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }
  if (treeAlive(child)) {
    signalTree(child, 'SIGTERM')
    if (!(await waitForTreeToDie(child, TERM_GRACE_MS))) {
      signalTree(child, 'SIGKILL')
      await waitForTreeToDie(child, KILL_GRACE_MS)
    }
  }
  /*
   * **The answer is read, and a survivor is kept.**
   *
   * This used to delete the child unconditionally and return nothing, so every
   * caller could say "reaped" and none of them could be wrong — a measurement that
   * cannot fail, which is the same shape as signalling an `npx` wrapper and
   * reporting on the app, or supplying a port by hand and reporting on a start.
   * A process group can outlive `SIGKILL`: uninterruptible sleep in a syscall, a
   * stuck filesystem, a zombie whose parent never reaps it. Dropping it from
   * `spawned` at that point loses the only handle anything has on it, and the next
   * shutdown would not know to try again.
   */
  const dead = !treeAlive(child)
  if (dead) spawned.delete(child)
  return dead
}

/**
 * A backstop for servers left behind by a **force-quit** — the case no handler can
 * cover, and one this change made more likely rather than less.
 *
 * Every ordered shutdown now stops the tree, but `SIGKILL` and a hard power-off run
 * no handler at all, and the server is spawned **detached** so that shutdown can
 * signal its process group. Detaching makes it a session leader, which is exactly
 * what stops it dying with its parent — the property that makes the ordered path
 * work makes the disordered one worse. So the next launch has to clean up.
 *
 * **Identified by this profile's own `--server-data-dir`, never by executable
 * name.** Matching on `node`, or on `server-main.js`, would put Chorus in the
 * business of killing processes because they look like a code server — including
 * somebody's own editor, or a second Chorus profile's live server. The data
 * directory is a path only this profile passes.
 *
 * **And only when reparented to init.** A candidate whose parent is still alive
 * belongs to a running Chorus — a second window, a second profile sharing this one
 * by accident — and killing it would take down a live session. PPID 1 is a fact
 * about the process as it is now, where a recorded pid file goes stale the instant
 * the app it described crashed. This is `reap.ts`'s rule, applied to a second kind
 * of child.
 *
 * The whole **group** is killed, because the orphan leads one.
 */
/**
 * The reap, run **once** and awaited by anything that would start a server.
 *
 * `index.ts` kicks this off at `whenReady` so the wait is normally already over,
 * but starting it there is not the same as depending on it: the call was
 * fire-and-forget, and opening a project is a renderer request that can arrive in
 * the same tick the window finishes loading. A new server would then be spawned
 * **while the orphan still owned this profile's server-data directory and token
 * file** — two servers, one data directory, and the newer one writing a token the
 * older one is still reading.
 *
 * Memoised rather than re-run per start, because the answer cannot change: after
 * the first pass there are no orphans of a *previous* launch left to find.
 */
let reapBarrier: Promise<ReapResult> | null = null

export function reapedOrphanedServers(
  platform: NodeJS.Platform = process.platform
): Promise<ReapResult> {
  reapBarrier ??= reapOrphanedWorkbenchServers(platform)
  return reapBarrier
}

/** One server still carrying this profile's marker when the sweep gave up. */
export interface Survivor {
  readonly pid: number
  /** Its parent at listing time. `1` means an orphan; anything else is a live owner. */
  readonly parent: number
}

export interface ReapResult {
  /** Confirmed dead — signalled **and** observed to have gone, never merely asked. */
  readonly killed: number
  /** Every candidate carrying this profile's marker, killed or deliberately left. */
  readonly inspected: number
  /**
   * Still alive when the sweep gave up, and the reason this field exists.
   *
   * `killed` used to be `signalled.length`: the count of `SIGKILL`s **sent**. A
   * signal is a request, and a process group can refuse one — uninterruptible
   * sleep in a syscall, a stuck NFS mount, a zombie whose parent never reaps it. So
   * the old result reported success for having asked, which is the same defect as
   * a shutdown that signalled an `npx` wrapper and reported on the app, and the
   * same one `reapTree` had on the other side of this module. A reaper that cannot
   * fail is a reaper that tells you nothing.
   *
   * Anything in here **owns this profile's server-data directory and token file**,
   * so `start` refuses to spawn beside it.
   *
   * Each one carries its **parent**, and the parent is what the refusal needs to
   * say something true. A survivor whose parent is `1` is an orphan that outlived
   * its Chorus and refused `SIGKILL`; a survivor with a live parent belongs to
   * another running Chorus on this profile. The instruction for the person is
   * opposite in the two cases — quit the other app, or kill a stray process — and
   * one string covering both is how this refusal came to tell somebody to do
   * something that could not work.
   */
  readonly survivors: readonly Survivor[]
  /**
   * Why the sweep did not run, or `null` when it did — and the two reasons are
   * kept apart because a caller has to treat them oppositely.
   *
   * This was a boolean, and that made "the platform has no strategy" and "the
   * process table could not be read" the same value. `start` then read an empty
   * `survivors` from a sweep that had **never happened** and spawned anyway: the
   * unanswered question treated as a clean answer, which is the fail-open shape
   * this module keeps producing. `'unsupported-platform'` is a decision already
   * taken and is allowed through; `'sweep-failed'` means Chorus does not know what
   * is running on this profile, and not knowing is a refusal.
   */
  readonly skipped: 'unsupported-platform' | 'sweep-failed' | null
}

/** Signal 0 asks the kernel and sends nothing. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function reapOrphanedWorkbenchServers(
  platform: NodeJS.Platform = process.platform
): Promise<ReapResult> {
  /*
   * Off on Windows, visibly rather than by accident — the same decision `reap.ts`
   * records for agents, for the same reasons. There is no PPID-1 reparenting
   * convention to identify an orphan by, `SIGKILL` is not a Windows signal, and a
   * command-line match without the parent check is precisely the "kill it because
   * it looks like a code server" mistake. Reporting `skipped` is at least true;
   * a confident `killed: 0` would be indistinguishable in the log from a clean
   * machine.
   */
  if (platform === 'win32')
    return { killed: 0, inspected: 0, survivors: [], skipped: 'unsupported-platform' }

  const marker = `--server-data-dir ${join(serverDataDir(), 'server')}`
  let listing: string
  try {
    // Asynchronous, because this runs at boot and walking the whole process table
    // is not something to do on the main thread while a window is being built.
    ;({ stdout: listing } = await runCommand('ps', ['-Awwo', 'pid=,ppid=,command='], {
      timeout: 5_000,
    }))
  } catch {
    // The process table could not be read. That is not "nothing is running" — it
    // is "Chorus cannot tell", and the difference is the whole of this field.
    return { killed: 0, inspected: 0, survivors: [], skipped: 'sweep-failed' }
  }

  const candidates: { pid: number; ppid: number; orphaned: boolean }[] = []
  for (const line of listing.split('\n')) {
    // A substring match rather than a pattern: the data directory is a real path
    // and `pgrep -f` would read its punctuation as a regular expression.
    if (!line.includes(marker)) continue
    const [pid, ppid] = line.trim().split(/\s+/, 2).map(Number)
    if (pid === undefined || !Number.isInteger(pid) || pid === process.pid) continue
    /*
     * The parent is checked the same way the pid is, and for a reason the refusal
     * made concrete: it is now printed. A `ps` line this could not parse used to
     * cost nothing, because `orphaned` was simply false and the process was left
     * alone. It would now reach the person as `pid NaN`, which is worse than
     * saying nothing — so a malformed line is skipped rather than reported.
     */
    if (ppid === undefined || !Number.isInteger(ppid)) continue
    candidates.push({ pid, ppid, orphaned: ppid === 1 })
  }

  const signalled: number[] = []
  for (const { pid, orphaned } of candidates) {
    if (!orphaned) continue
    try {
      process.kill(-pid, 'SIGKILL')
      signalled.push(pid)
    } catch {
      /* gone between the listing and the signal, which is the state we wanted */
    }
  }
  /*
   * **The token a force-quit left behind, and only once nothing is using it.**
   *
   * The killing above leaves `<server-data>/connection-token` on disk: it is
   * removed by paths that hang off a *running* child, and the orphan's child
   * belonged to a process that is gone. Nothing came back for it — it sat there
   * until some later server happened to overwrite the same path, which is a
   * credential outliving every process that could have used it.
   *
   * The condition is what makes it safe. A candidate whose parent is alive belongs
   * to a **running** Chorus on this profile, and that server reads this file on
   * every connection — deleting it would refuse its handshakes silently, which is
   * §5.3's failure inflicted on somebody else's session. So: nothing alive for this
   * profile, or the file stays.
   *
   * The one exception is a child of *this* process that `host` does not hold, and
   * it is named rather than handled: it is not reachable by any path this file
   * knows of — every failure after the spawn reaps — and treating it as an orphan
   * to kill would be a behaviour change nothing here has evidence for. If it ever
   * is reachable, this condition would delete a token that child is still reading,
   * which is the failure the paragraph above exists to prevent.
   */
  /*
   * Waited for, because a process that has just been `SIGKILL`ed still answers.
   *
   * The kernel tears a process down asynchronously and leaves a zombie until its
   * parent reaps it, so `kill(pid, 0)` sampled in the statement after the signal
   * reports the orphan alive — and the token then stayed on disk on exactly the
   * run that had just cleaned up. Caught end to end by the relaunch gate while the
   * unit test passed, because the fake kernel kills synchronously and nothing in
   * it can be a zombie. It is the same error this work keeps finding in its own
   * measurements: reading the answer before the thing has happened.
   */
  const settleBy = Date.now() + 3_000
  // Only the ones **we signalled**. A candidate with a live parent belongs to a
  // running session and is supposed to still be there — waiting on it would be
  // waiting for something that must not happen, for the full budget, every time.
  while (signalled.some((pid) => processAlive(pid)) && Date.now() < settleBy) {
    await new Promise((settle) => setTimeout(settle, 100))
  }

  /*
   * Counted from what the kernel says now, not from what was asked for. `killed`
   * is the signalled set that actually went; `survivors` is everything carrying
   * this profile's marker that is still there — the orphan that ignored `SIGKILL`
   * and the live session's server alike, because for the purpose of "may a new
   * server start here?" they are the same fact.
   *
   * They are **not** the same fact for the sentence the refusal prints, which is
   * why each one keeps the parent it was listed with. "May a new server start
   * here" is answered by liveness alone; "what should the person do about it" is
   * not, and only the parent can tell the two apart.
   */
  const survivors = candidates
    .filter(({ pid }) => processAlive(pid))
    .map(({ pid, ppid }) => ({ pid, parent: ppid }))
  const killed = signalled.filter((pid) => !processAlive(pid)).length

  if (survivors.length === 0) rmSync(join(serverDataDir(), 'connection-token'), { force: true })

  /*
   * `inspected` counts **every** candidate carrying this profile's marker, not just
   * the ones killed — so `inspected > killed` is visible and means "some of these
   * belong to a live session and were deliberately left". Counting only the
   * orphans would make the two numbers agree by construction, which is a log line
   * that cannot report anything.
   */
  return { killed, inspected: candidates.length, survivors, skipped: null }
}

async function start(): Promise<WorkbenchRuntime> {
  /*
   * The start is **cancellable**, not merely awaitable — which is the difference
   * between a shutdown that is bounded and one that hopes.
   *
   * Everything above the spawn can block for a long time on someone else's
   * schedule: a 76 MB download on a bad connection, a checksum over it, a 257 MB
   * extraction. Shutdown used to `await starting` with no bound, so quitting
   * during any of that waited for it to finish. Aborting is what turns those into
   * steps that stop when asked.
   */
  const abort = new AbortController()
  startAbort = abort
  const abortedError = (): Error => new Error('The workbench server start was cancelled.')
  /*
   * Read through a call rather than as `abort.signal.aborted`, and the reason is a
   * checker artefact worth naming: TypeScript narrows the property of a freshly
   * constructed controller to `false`, so every check against it reads as dead code
   * and the linter says so. The value plainly does change — that is what an
   * `AbortController` is — so the fix is to stop the narrowing rather than to
   * silence the rule.
   */
  const cancelled = (): boolean => abort.signal.aborted

  const { manifest, sha256: manifestSha256 } = loadManifest(manifestPath())
  const key = platformKey()
  const artifact = manifest.server.artifacts[key]
  if (artifact === undefined) {
    /*
     * A missing manifest entry is an unsupported target, stated in the manifest
     * rather than discovered here — which is where `win32-arm64` lives, since
     * VSCodium has never published one, in the current release or in any of the
     * last thirty.
     */
    throw new Error(`No ${manifest.server.vendor} server is published for ${key}`)
  }

  /*
   * The copy shipped inside the app, if there is one.
   *
   * Preferred over the cache and over the network, because it is the only one
   * that makes a first launch work with no connection — which is the whole
   * point of carrying 72.7 MB in the installer. Size only here; the archive is
   * hashed against the manifest by `publishServer` a few lines below, exactly as
   * a downloaded one is, so a truncated or substituted resource is caught by the
   * same check rather than a weaker one.
   *
   * `CHORUS_SKIP_REH_BUNDLE=1` builds stage an empty placeholder, which fails
   * the size test and falls through to the old path. That is deliberate: a build
   * that opted out must behave exactly like one from before bundling existed.
   */
  const resources = resourcesPath()
  const bundled = resources === undefined ? null : join(resources, 'workbench-server.tar.gz')
  const hasBundled =
    bundled !== null && existsSync(bundled) && statSync(bundled).size === artifact.size
  const archive = hasBundled ? bundled : join(cacheDir(), artifact.name)
  const cached = hasBundled || (existsSync(archive) && statSync(archive).size === artifact.size)
  /*
   * Announced *before* the wait, not after it. A line that arrives when the
   * download finishes cannot explain a blank region while it is still running,
   * which is the only time anybody goes looking.
   */
  log.info('workbench server starting', {
    release: manifest.server.release,
    platform: key,
    source: hasBundled ? 'bundled' : cached ? 'cache' : 'download',
    ...(cached ? {} : { willDownloadBytes: artifact.size }),
  })
  const startedAt = Date.now()
  if (!cached) {
    await download(serverArchiveUrl(manifest, artifact.name), archive, artifact.size, abort.signal)
    log.info('workbench server downloaded', {
      bytes: artifact.size,
      ms: Date.now() - startedAt,
    })
  }
  if (cancelled()) throw abortedError()

  const root = extractionRoot()
  const dir = await publishServer({
    root,
    finalName: `${manifest.server.release}-${key}`,
    archive,
    expectedSha256: artifact.sha256,
    clientCommit: manifest.client.vscodeCommit,
    receipt: {
      artifact: artifact.name,
      manifestSha256,
      vendor: manifest.server.vendor,
      release: manifest.server.release,
      upstreamTag: manifest.server.upstreamTag,
      upstreamCommit: manifest.server.upstreamCommit,
    },
  })

  // Extraction is the step most likely to be the one you are waiting on: the
  // archive is usually cached and unpacking 257 MB is not quick.
  log.info('workbench server unpacked', { dir, ms: Date.now() - startedAt })

  // Checked either side of the slow steps rather than only at the top: an abort
  // that arrives during a 257 MB extraction should not be discovered after a spawn.
  if (cancelled()) throw abortedError()

  // After the new tree is serving its first spawn, not before it: a sweep is
  // restartable and costs disk, where doing it first would delay every open.
  try {
    sweepQuarantine(root, readdirSync(root))
  } catch {
    /* garbage nothing reads; a failed sweep is not a failed open */
  }

  const data = serverDataDir()
  mkdirSync(data, { recursive: true })
  // 0700, because §5.3's own advice for the token file is to put it in one.
  chmodSync(data, 0o700)
  const processDirectory = prepareWorkbenchProcessOwner(data, (path, error) => {
    log.warn('workbench extension registration file could not be read', {
      path,
      error: error instanceof Error ? error.message : String(error),
    })
  })

  /*
   * Generated per launch, and by Chorus rather than by the server.
   *
   * Left to itself the server generates a UUID **once**, writes it to
   * `<user-data-dir>/token` and reuses it on every subsequent launch — a
   * long-lived secret on disk, which is not what "a random connection token per
   * launch" means. The charset is `[0-9A-Za-z_-]+`, which a UUID satisfies and
   * plain base64 does not: `+`, `/` and `=` are all rejected and the server exits
   * at startup rather than failing at connection time.
   *
   * Passed as a **file**, never on the argv. An inline token is visible in `ps`
   * to every user on the machine for the process's whole life — CVE-2024-26165 —
   * and Microsoft's own CLI now refuses the inline form outright.
   */
  /*
   * The launcher is validated **before** the token is written, and the ordering is
   * the fix rather than tidiness.
   *
   * Written first, a throw here — a Windows artifact whose layout is not the one
   * inferred, an extraction that lost a file — left a live connection token on
   * disk with no process that would ever remove it, because every path that does
   * remove one hangs off a child that in this case was never spawned. Nothing
   * comes back for it until some later server happens to overwrite the same path.
   * Checking first means the credential does not exist until there is something to
   * use it.
   */
  /*
   * The barrier, awaited here rather than trusted to have finished — and **its
   * answer is read**, which is the half that was missing.
   *
   * Awaiting a promise that resolves successfully while an orphan is still running
   * is a barrier in name only: the sweep sends `SIGKILL`, waits three seconds, and
   * a group that ignored the signal is still sitting on this profile's
   * `--server-data-dir`. Spawning beside it means two servers with one data
   * directory, one extensions lock and one token file, the newer one overwriting a
   * credential the older one is still reading — and neither of them wrong from its
   * own point of view.
   *
   * **So the survivors are re-checked now, and that takes two sweeps rather than
   * one.** This used to read the memoised boot promise — `index.ts` starts it at
   * `whenReady` — and a list frozen at boot cannot contain a server that appeared
   * afterwards, while the refusal below prints it in the present tense. What the
   * barrier guarantees is about *previous launches*; what the refusal reports is
   * about *now*, and only a second sweep can answer that.
   *
   * The two are serialised rather than run together, and it is not politeness: the
   * sweep removes the connection token when nothing is left alive for this profile,
   * and a boot sweep still in flight could land that removal *after* the token is
   * written below — leaving a running server reading a file that is not there.
   *
   * This cannot weaken the barrier. The fresh sweep still runs before anything is
   * spawned and still refuses on a live survivor; all it adds is a survivor that
   * appeared between boot and now, which is the one case the memo could not see.
   * Refusing happens **before the token is written and before anything is spawned**,
   * so a refused start leaves the profile exactly as it found it.
   */
  await reapedOrphanedServers()
  const reaped = await reapOrphanedWorkbenchServers()
  if (cancelled()) throw abortedError()
  /*
   * **A sweep that did not run is a refusal, not a clean bill of health.**
   *
   * `skipped` used to be a boolean and this code read only `survivors`, so a `ps`
   * that failed produced an empty list and a server was spawned having checked
   * nothing — the same fail-open shape as counting signals sent, one level up. If
   * Chorus cannot read the process table it cannot know whether a previous
   * session's server still owns this profile's data directory, and the honest
   * answer to "may I start one?" is no.
   *
   * Windows is exempt because the sweep is *deliberately* absent there rather than
   * broken — see the reaper's own note — and that exemption is as unverified as
   * everything else about Windows.
   */
  if (reaped.skipped === 'sweep-failed') {
    throw new Error(
      'Chorus could not check for a workbench server left by an earlier session, so it will not start one. Restart Chorus and try again.'
    )
  }
  const stillOwning = reaped.survivors.filter((survivor) => processAlive(survivor.pid))
  if (stillOwning.length > 0) {
    const listed = stillOwning.map((survivor) => `pid ${String(survivor.pid)}`).join(', ')
    /*
     * **Two facts, two sentences, because the instruction is opposite in each.**
     *
     * A survivor with a live parent belongs to another Chorus, and the only thing
     * that helps is quitting *that* one. The old message said "Quit that process,
     * or restart Chorus" — and restarting the Chorus showing the dialog is exactly
     * the one action that cannot work, because the owner is the other app. That is
     * not a wording problem: it sent somebody to the one remedy that was certain
     * not to help, and the process table those words came from already knew which
     * case it was.
     *
     * A survivor whose parent is `1` is an orphan that refused `SIGKILL`. Nothing
     * here can name a different action for it, so the message says only what is
     * true and leaves the remedy to the person.
     */
    const ownedByAnother = stillOwning.filter((survivor) => survivor.parent !== 1)
    if (ownedByAnother.length > 0) {
      const owners = [...new Set(ownedByAnother.map((survivor) => survivor.parent))]
      throw new Error(
        `Another Chorus is using this profile's workbench server (${listed}, belonging to pid ${owners.map(String).join(', ')}) and owns this profile's data directory. Quit that Chorus before opening a project here — restarting this one cannot help, because it does not own the server.`
      )
    }
    throw new Error(
      `A workbench server from an earlier session is still running (${listed}) and owns this profile's data directory. It did not stop when asked, so quit that process before opening a project.`
    )
  }

  const { node, script } = serverLauncher(dir)
  for (const required of [node, script]) {
    if (!existsSync(required)) {
      throw new Error(`The workbench server is missing ${required}; the extraction is unusable.`)
    }
  }

  /*
   * **Requested rather than assigned, and confirmed either way.**
   *
   * `--port 0` asked the child to pick, so the authority was whatever it happened
   * to get and every launch produced a different one. This asks for a number this
   * profile has used before, which is what makes the authority — and every URI and
   * storage key built from it — survive a relaunch.
   *
   * It does **not** weaken the readback below, which is the invariant this file's
   * `:327-334` states: the authority is still built from what the child prints,
   * never from what was requested. A port this process did not cause the child to
   * open cannot become an authority, because the child would have to name it and
   * it names only its own.
   *
   * **`<n>-<n>`, a one-element range, and not a plain `<n>`.** A plain integer is
   * returned verbatim by the server's own `parsePort`, and on `EADDRINUSE` the
   * server only logs — no fallback and no exit — so a taken port would leave a
   * live, silent child and cost the full sixty-second port wait. The range form
   * reaches `findFreePort`, which prints `--port: Could not find free port in
   * range` on stderr and exits 1, landing on the exit arm below in seconds with
   * the reason in hand.
   */
  const requestedPort = await chooseWorkbenchPort()
  const connectionToken = randomUUID()
  const tokenFile = join(data, 'connection-token')
  writeFileSync(tokenFile, connectionToken, { mode: 0o600 })
  const child = spawn(
    node,
    serverArguments({
      script,
      port: requestedPort,
      tokenFile,
      serverDataDir: join(data, 'server'),
      extensionsDir: join(data, 'extensions'),
      userDataDir: join(data, 'data'),
    }),
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        CHORUS_WORKBENCH_PROCESS_DIRECTORY: processDirectory,
      },
      /*
       * Its own process group, so shutdown can signal the tree rather than the
       * root of it — see `signalTree`. Never `unref`ed: detaching is about
       * *addressing* the group, not about letting it outlive us, and unreferencing
       * would do exactly the harm this change exists to undo.
       */
      detached: process.platform !== 'win32',
      windowsHide: true,
    }
  )
  spawned.add(child)
  if (child.pid !== undefined) {
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve()
      })
      child.once('error', () => {
        resolve()
      })
    })
    ownedTrees.set(
      child,
      ownProcessTree(child.pid, {
        processGroup: process.platform !== 'win32',
        rootExited: exited,
        expectedAncestorPid: process.pid,
      })
    )
  }

  /*
   * The one listener that outlives startup, and it answers a defect the old code
   * could not: `host` was never cleared when the server died on its own.
   *
   * The exit handler inside the port race below is scoped to the race — after it
   * resolves, nothing was watching. So a server that crashed, was OOM-killed, or
   * was stopped from a terminal left `host` holding a runtime whose port belonged
   * to nothing, and every later `acquireWorkbenchRuntime` handed that dead
   * authority to a new surface. The workbench then opened, failed to connect, and
   * rendered an empty tree — indistinguishable from an empty project.
   *
   * It fails **closed**: no re-spawn, and the next open is refused with a reason.
   * A new server means a new port, and the workbench session's CSP was built with
   * the first authority in it, so a silent restart would trade a legible error for
   * a surface that connects to nothing.
   */
  child.on('exit', (code, signal) => {
    retiredChildren.add(child)
    const wasHost = host?.child === child
    if (wasHost) {
      host = null
      hostFailure = `The workbench server stopped unexpectedly (code ${String(code)}, signal ${String(signal)}). Restart Chorus to open a project again.`
    }
    /*
     * **The group, not just the process that exited.** Dropping the child from
     * `spawned` here is what the first version did, and it reads as cleanup while
     * leaving the extension hosts and file watchers the server forked still
     * running — the original leak arriving by a different route. `reapTree` is what
     * removes it from `spawned`, once there is nothing left in its group.
     *
     * The token goes with it: the process that needed it is gone, and on every
     * exit — expected or not, before startup finished or long after — a per-launch
     * credential for a server that no longer exists is one file too many.
     */
    void reapTree(child).then((dead) => {
      if (dead) rmSync(tokenFile, { force: true })
    })
  })

  /*
   * `error` as well as `exit`, because they are different failures and only one of
   * them was handled. `spawn` reports ENOENT, EACCES and EAGAIN here and **never
   * emits `exit`** — so a server binary that is present but not executable used to
   * leave the port wait running for its full sixty seconds before failing with
   * "did not report a port", which describes the symptom of a permissions error
   * rather than the error. An unhandled `error` on a `ChildProcess` is also a
   * throw at the top level, which in main is a crash.
   */
  let spawnError: Error | null = null
  child.on('error', (error: Error) => {
    spawnError = error
  })

  /*
   * The server's own output, kept — and it is not a debugging leftover.
   *
   * Everything interesting about a remote extension host happens *after* the
   * port is up: a refused handshake, a rejected token, an extension host that
   * forked and died. None of that reaches Chorus's UI, and once the port has been
   * parsed there is nothing else reading this pipe, so without a sink the process
   * runs blind and a workbench that fails to connect looks identical to one whose
   * project is empty. Redacted on the way in rather than at the call site, so a
   * `tkn=` cannot arrive here by a route nobody thought about.
   */
  const logFile = join(app.getPath('userData'), 'logs', 'workbench-server.log')
  /*
   * **The one unguarded throw between the spawn and `host`, and it is wrapped for
   * that reason rather than for its own.**
   *
   * A read-only home, a full disk, an `app.getPath` that does not exist — any of
   * those throws here, in the window where a child is already running and nothing
   * holds it. Every other failure below reaps what it spawned; this one would have
   * returned the failure with the server still holding the port and the tree, which
   * is the orphan shape the two `reapTree` calls below exist to prevent, reached by
   * the one line nobody thought to wrap.
   *
   * Degrading rather than throwing: the log file is a diagnostic, and a workbench
   * that cannot write one is still a workbench. `record` already swallows its own
   * `appendFileSync` failure for the same reason.
   */
  let loggable = true
  try {
    mkdirSync(join(app.getPath('userData'), 'logs'), { recursive: true })
  } catch {
    loggable = false
  }
  const record = (chunk: Buffer): void => {
    const output = chunk.toString()
    noteDegradedServer(child, output)
    /*
     * Skipped rather than attempted-and-caught, because this runs per stdout chunk
     * and a server that has lost its log directory would otherwise pay a failing
     * `open` on every one of them — a syscall that always throws, on the hot path,
     * for a result already known.
     */
    if (!loggable) return
    try {
      appendFileSync(logFile, redactToken(output))
    } catch {
      /* a log that cannot be written must not take the server down with it */
    }
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)

  let output = ''
  /*
   * Wrapped, because a start that fails **after** the spawn used to leave the
   * server running. The port wait can time out at sixty seconds on a machine under
   * load, and the old code let that rejection propagate with the child still
   * holding its port — an orphan created by the very path that reports failure.
   */
  const portWait = awaitPort(
    child,
    (chunk) => (output += chunk),
    abort.signal,
    () => spawnError
  ).catch(async (error: unknown) => {
    await reapTree(child)
    rmSync(tokenFile, { force: true })
    throw error
  })
  const [port] = await Promise.all([portWait, ownedTrees.get(child)?.capture()]).catch(
    async (error: unknown) => {
      await reapTree(child)
      throw error
    }
  )

  /*
   * **A disagreement is a fact to record, never an assumption to act on.**
   *
   * The child is asked for one port and could in principle bind another — a range
   * of one leaves it nowhere to go but this is a fact about *this* build, not a
   * promise `server-main.ts` makes. So it is logged rather than enforced: the
   * authority is what the child reported in both cases, because that is the only
   * value anything has confirmed is listening. Enforcing the requested number
   * instead would be the "attach to a port Chorus did not open" failure with extra
   * steps.
   *
   * It is not expected to fire. If it ever does, the persisted port is wrong for
   * this profile and the log line is the only place that would say so.
   */
  if (port !== requestedPort) {
    log.warn('the workbench server bound a different port than requested', {
      requested: requestedPort,
      bound: port,
    })
  }

  /*
   * The window between the port being read and `host` being assigned, which was
   * open and is now closed.
   *
   * `awaitPort` resolves on a line of stdout; the process can die in the next
   * millisecond — a token the server rejects, an extensions directory it cannot
   * lock. The exit listener fires, finds `host` still `null`, and correctly
   * concludes this is not the running host; then the line below assigned that dead
   * child to `host` anyway. The result was the exact failure the listener exists to
   * prevent, reached by winning a race instead of by nobody watching.
   */
  if (child.exitCode !== null || child.signalCode !== null) {
    await reapTree(child)
    rmSync(tokenFile, { force: true })
    throw new Error(
      `The workbench server exited immediately after reporting its port:\n${redactToken(output)}`
    )
  }

  /*
   * And a shutdown that began while this start was in flight wins. `stopWorkbenchHost`
   * waits for `starting` before it decides what to kill, so this cannot strand a
   * child — but it can still hand a *runtime* to a caller after the app has decided
   * to quit, which would open a surface onto a server that is about to be signalled.
   * Refusing here keeps "shutting down" a one-way door.
   */
  if (shuttingDown || cancelled()) {
    await reapTree(child)
    rmSync(tokenFile, { force: true })
    throw new Error('Chorus is shutting down; the workbench server was not started.')
  }

  const runtime: WorkbenchRuntime = {
    remoteAuthority: `127.0.0.1:${String(port)}`,
    connectionToken,
    commit: manifest.client.vscodeCommit,
    quality: manifest.client.quality,
  }
  host = { child, runtime, tokenFile }
  /*
   * The line that says the wait is over, and the one worth having: everything
   * after this is the surface's own boot rather than the server's. `pid` because
   * `reap.ts` and every orphan question start from it, and no token or authority
   * — the port is harmless, the token is the secret the shell may never hold.
   */
  log.info('workbench server ready', {
    pid: child.pid ?? null,
    port,
    ms: Date.now() - startedAt,
  })
  return runtime
}

/**
 * The port race — and every listener it adds, it removes.
 *
 * The `data` handlers were left attached after the promise settled, so for the
 * life of the server every line it printed was still being appended to a string
 * nobody would read again: a slow leak whose size is however chatty the extension
 * hosts are. `off` in one `settle` closure is also what makes the four ways out of
 * here symmetrical — port, exit, spawn error, cancellation — rather than three
 * that clean up and one that does not.
 */
function awaitPort(
  child: ChildProcess,
  append: (chunk: string) => string,
  signal: AbortSignal,
  spawnError: () => Error | null
): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    let seen = ''
    const settle = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error): void => {
      settle()
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error(`The workbench server did not report a port:\n${redactToken(seen)}`))
    }, 60_000)
    const onData = (chunk: Buffer): void => {
      seen = append(chunk.toString())
      const found = readServerPort(seen)
      if (found === null) return
      settle()
      resolvePort(found)
    }
    const onExit = (code: number | null): void => {
      // A malformed or conflicting token argument is fatal rather than a
      // warning: the server warns and exits 1, so a bad token file shows up
      // exactly here, as a child that never opened a port. `spawnError` is
      // preferred when there is one, because ENOENT explains an exit that
      // "exited with null" does not.
      const failure = spawnError()
      /*
       * The saved port is taken, and the remedy is a file, so the message names it.
       * `--port <n>-<n>` makes the server print this and exit rather than log
       * silently, and failing closed is the decision: picking a new port here would
       * silently move the authority and lose the editor's state for that launch.
       */
      const taken = /Could not find free port in range:\s*(\d+)/.exec(seen)?.[1]
      if (failure === null && taken !== undefined) {
        fail(
          new Error(
            `The workbench server could not use port ${taken}, because something else is holding it. Chorus keeps one port per profile so the editor remembers its state across relaunches, and it will not choose another one silently. Quit whatever is using that port, or delete ${chosenPortFile()} to let Chorus choose a new port the next time it starts.`
          )
        )
        return
      }
      fail(
        failure ??
          new Error(`The workbench server exited with ${String(code)}:\n${redactToken(seen)}`)
      )
    }
    const onError = (error: Error): void => {
      /*
       * `spawn` reports ENOENT, EACCES and EAGAIN here and emits **no** `exit`, so
       * without this arm a server binary that is present but not executable waited
       * out the full sixty seconds and then reported "did not report a port" — the
       * symptom rather than the cause. It is also the arm that keeps an unhandled
       * `error` on a `ChildProcess` from becoming a main-process crash.
       */
      fail(error)
    }
    const onAbort = (): void => {
      fail(new Error('The workbench server start was cancelled.'))
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', onExit)
    child.on('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/**
 * The lease. Acquired on project **open**, released on project **close**, and
 * unmounting a surface calls neither.
 *
 * Resolved and verified when a project is opened rather than at app boot, which
 * is `terminal.ts`'s discipline for the native module one level out: an app that
 * will not start because a 76 MB artifact is missing is worse than a project that
 * will not open.
 */
export async function acquireWorkbenchRuntime(projectRoot: string): Promise<WorkbenchRuntime> {
  /*
   * Two refusals before anything is leased, and both are one-way doors.
   *
   * A quitting app does not start a server: the IPC channel is still live while
   * windows are closing, so an `openWorkbench` can arrive after shutdown has begun
   * and would otherwise spawn the orphan the whole change exists to prevent.
   *
   * And a server that died on its own is not replaced. Re-spawning would mean a new
   * port behind a CSP built for the old one, so the surface would open and connect
   * to nothing — a legible refusal now beats an empty tree with no cause on screen.
   */
  if (idleStopping !== null) await idleStopping
  if (shuttingDown) throw new Error('Chorus is shutting down; no workbench project can open.')
  if (hostFailure !== null) throw new Error(hostFailure)
  refuseDegradedHost()

  leases.add(projectRoot)
  if (host !== null) return host.runtime
  // One start, however many projects arrive while it is in flight.
  starting ??= start().finally(() => {
    starting = null
  })
  try {
    const runtime = await starting
    refuseDegradedHost()
    return runtime
  } catch (error) {
    leases.delete(projectRoot)
    throw error
  }
}

export function releaseWorkbenchRuntime(projectRoot: string): void {
  leases.delete(projectRoot)
}

export function workbenchServerPid(): number | null {
  return host?.child.pid ?? null
}

function holdsLease(): boolean {
  return leases.size !== 0
}

export function stopIdleWorkbenchHost(): Promise<void> {
  if (idleStopping !== null) return idleStopping
  const stopping = (async () => {
    if (leases.size !== 0) return
    startAbort?.abort()
    const inFlight = starting
    if (inFlight !== null) {
      await Promise.race([
        inFlight.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, START_ABORT_MS)),
      ])
      if (starting !== null)
        throw new Error('The editor server is still starting; retry closing this project.')
    }
    if (holdsLease()) return
    const running = host
    host = null
    for (const child of spawned) retiredChildren.add(child)
    const outcomes = await Promise.all([...spawned].map((child) => reapTree(child)))
    if (outcomes.some((dead) => !dead)) {
      throw new Error(
        'Editor server process exit could not be confirmed; retry closing this project.'
      )
    }
    if (running !== null) rmSync(running.tokenFile, { force: true })
  })()
  idleStopping = stopping.finally(() => {
    idleStopping = null
  })
  return idleStopping
}

/**
 * `stopAll()` — §5.4, and now one shutdown rather than three.
 *
 * **Asynchronous**, because the only honest version of "the server is stopped" is
 * one that waited to see it. **Idempotent**, because normal quit, `SIGTERM` and
 * `SIGINT` all arrive here and two of them can arrive together — a memoised
 * promise makes the second caller wait for the first shutdown instead of starting
 * a second one against a tree that is already dying. **Shared**, because three
 * shutdown paths are three chances for one of them to be the wrong one.
 *
 * It was none of those. It sent `SIGTERM` to a bash wrapper, unlinked the token in
 * the next statement and returned — so the app exited while the real server was
 * still alive, holding its port, its extensions directory and a 257 MB tree. Two
 * consecutive gate runs measured exactly that: Electron exiting `code=0` with the
 * node process still alive fifteen seconds later.
 */
export function stopWorkbenchHost(): Promise<ShutdownResult> {
  stopping ??= shutdown()
  return stopping
}

async function shutdown(): Promise<ShutdownResult> {
  shuttingDown = true

  /*
   * **Cancel the start, then give it a bounded moment to unwind — never wait it
   * out.**
   *
   * The first version awaited `starting` with no bound, reasoning that a spawn
   * must not land after shutdown had decided there was nothing to kill. The
   * reasoning was right and the implementation made the app hang: a stalled
   * download or the sixty-second port wait became the time Chorus took to quit,
   * and once `SIGTERM` was handled here rather than by Electron's default
   * termination, that was a quit that appeared to do nothing.
   *
   * Two things make the bound safe rather than a gamble. The abort actually stops
   * the start at its next step, so the wait is normally over immediately. And the
   * guarantee never depended on the wait anyway: every child is in `spawned` from
   * the moment `spawn` returns, and a start that completes after this point finds
   * `shuttingDown` set and reaps its own child. The wait is a courtesy that lets
   * the start clean up its own mess first; it is not what makes the mess
   * impossible.
   */
  startAbort?.abort()
  const inFlight = starting
  if (inFlight !== null) {
    await Promise.race([
      inFlight.catch(() => undefined),
      new Promise((settle) => setTimeout(settle, START_ABORT_MS)),
    ])
  }

  await stopAllTunnels()

  const running = host
  host = null
  for (const child of spawned) retiredChildren.add(child)

  /*
   * Everything spawned, not just the one that became `host` — the set is what
   * makes this exhaustive rather than a list of the cases somebody thought of.
   * In parallel, because three trees taking their grace period one after another
   * is three times the delay for no gain.
   */
  const outcomes = await Promise.all(
    [...spawned].map(async (child) => ({ child, dead: await reapTree(child) }))
  )
  const survivors = outcomes
    .filter((outcome) => !outcome.dead)
    .map((outcome) => outcome.child.pid)
    .filter((pid): pid is number => pid !== undefined)

  /*
   * **The token goes last, and only now that the tree is gone.**
   *
   * Preflight §5.3 said to delete it "as soon as the server reports ready", on the
   * reasoning that it is read once at startup. It is not: the server reads it again
   * on **every** connection, so deleting it early made every handshake fail with
   * `Unable to read the connection token file` — and silently, because a refused
   * handshake registers no `vscode-remote` provider and therefore raises no error.
   * "The folder looks empty" and "the server refused us" are the same picture.
   *
   * The same mistake one step along the timeline is deleting it beside the signal:
   * `SIGTERM` is a request, and between the request and the exit the server is
   * still accepting sockets. So the unlink waits for the tree to be *dead*. What
   * remains protecting the secret is what was always doing the work — per-launch,
   * never on the argv (CVE-2024-26165), `0600` inside a `0700` directory.
   */
  /*
   * And the token only if nothing survived. A group that outlived `SIGKILL` may
   * still be serving, and it reads this file on every connection — so removing it
   * while a survivor holds the port is the §5.3 mistake once more, applied to the
   * case where the kill did not work rather than to the case where it had not
   * happened yet.
   */
  if (running !== null && survivors.length === 0) rmSync(running.tokenFile, { force: true })
  return { stopped: outcomes.length - survivors.length, survivors }
}

/** For the tests and for a future `describe`: the observed state, not the intended one. */
export function workbenchShuttingDown(): boolean {
  return shuttingDown
}

export function workbenchHostState(): {
  readonly running: boolean
  readonly leases: number
  /** Non-null once the server has gone without being asked. Never cleared. */
  readonly failure: string | null
  /** Spawned and not yet seen to exit — zero is the property shutdown promises. */
  readonly spawned: number
} {
  return {
    running: host !== null,
    leases: leases.size,
    failure: hostFailure,
    spawned: spawned.size,
  }
}
