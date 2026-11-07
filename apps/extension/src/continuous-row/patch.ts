import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BROWSER_VIEW_WHEEL } from './protocol.js'

export const PAGE_SCRIPT = 'chorus-continuous-row.js'
const ANCHOR = '<script src="./workbench.js" type="module"></script>'
const BROWSER_WHEEL_REQUEST = 'vscode:browserView:chorusWheel'
const MAIN_ANCHOR = 'e.ipc.on("vscode:browserView:keydown",o)'
const MAIN_RELAY = `e.ipc.on("${BROWSER_WHEEL_REQUEST}",(s,d)=>{try{const w=this._currentWindow?.win??this._ownerWindow?.win;w&&!w.isDestroyed()&&w.webContents.send("${BROWSER_VIEW_WHEEL}",d)}catch{}}),`
const PRELOAD_ANCHOR =
  'window.addEventListener("keydown",o=>{if(!(o instanceof KeyboardEvent)||!o.isTrusted'
const PRELOAD_LISTENER = `window.addEventListener("wheel",o=>{o.isTrusted&&!o.ctrlKey&&!o.metaKey&&!o.altKey&&!o.shiftKey&&Math.abs(o.deltaX)>Math.abs(o.deltaY)&&require("electron").ipcRenderer.send("${BROWSER_WHEEL_REQUEST}",{deltaX:o.deltaX,deltaY:o.deltaY,deltaMode:o.deltaMode})},{passive:!0,capture:!0});`
const PRELOAD_LISTENER_UNFILTERED = `window.addEventListener("wheel",o=>{o.isTrusted&&Math.abs(o.deltaX)>Math.abs(o.deltaY)&&require("electron").ipcRenderer.send("${BROWSER_WHEEL_REQUEST}",{deltaX:o.deltaX,deltaY:o.deltaY,deltaMode:o.deltaMode})},{passive:!0,capture:!0});`
const ANY_TAG = new RegExp(
  `<script src="\\./${PAGE_SCRIPT.replace(/\./g, '\\.')}(?:\\?v=[0-9a-f]+)?"></script>(?:\\n\\t)?`,
  'g'
)
const UNREADABLE_LOCK_MS = 10_000
const ABANDONED_LOCK_MS = 600_000
const LOCK_WAIT_MS = 10_000
const LOCK_RETRY_MS = 100

export class WorkbenchShapeError extends Error {}
export class WorkbenchBusyError extends Error {}

export interface WorkbenchFiles {
  readonly html: string
  readonly script: string
  readonly main: string
  readonly preload: string
  readonly lock: string
  readonly breaker: string
}

export interface PatchTarget {
  readonly appRoot: string
  readonly bundled: string
  readonly stateFolder: string
}

export type PatchState = 'applied' | 'stale' | 'missing'
export type RestoreOutcome = 'unchanged' | 'restored' | 'removed'

export interface Restored {
  readonly outcome: RestoreOutcome
  readonly relaunch: boolean
}

const UNCHANGED: Restored = { outcome: 'unchanged', relaunch: false }

interface Insertion {
  readonly path: string
  readonly anchor: string
  readonly text: string
  readonly earlier: readonly string[]
}

type InsertionState = 'applied' | 'outdated' | 'missing' | 'unavailable'

interface Wanted {
  readonly appRoot: string
  readonly on: boolean
}

interface LockOwner {
  readonly token: string
  readonly pid: number
  readonly age: number
}

export function workbenchFiles(appRoot: string): WorkbenchFiles {
  const out = join(appRoot, 'out')
  const folder = join(out, 'vs', 'code', 'electron-browser', 'workbench')
  return {
    html: join(folder, 'workbench.html'),
    script: join(folder, PAGE_SCRIPT),
    main: join(out, 'mainImpl.js'),
    preload: join(
      out,
      'vs',
      'platform',
      'browserView',
      'electron-browser',
      'preload-browserView.js'
    ),
    lock: join(folder, 'chorus-continuous-row.lock'),
    breaker: join(folder, 'chorus-continuous-row.lock.break'),
  }
}

export function pageScriptTag(script: string): string {
  const version = createHash('sha256').update(script).digest('hex').slice(0, 12)
  return `<script src="./${PAGE_SCRIPT}?v=${version}"></script>`
}

const withoutTags = (html: string): string => html.replace(ANY_TAG, '')

export function stateFolder(home = homedir()): string {
  return join(home, '.chorus', 'vscode-continuous-row')
}

function stateFile(folder: string, appRoot: string): string {
  return join(folder, `${createHash('sha256').update(appRoot).digest('hex').slice(0, 16)}.json`)
}

const failedWith = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (failedWith(error, 'ENOENT')) return false
    throw error
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return failedWith(error, 'EPERM')
  }
}

function abandoned(owner: LockOwner): boolean {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return owner.age > UNREADABLE_LOCK_MS
  return !processAlive(owner.pid) || owner.age > ABANDONED_LOCK_MS
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

async function replaceAtomically(
  path: string,
  write: (temporary: string) => Promise<void>
): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`
  try {
    await write(temporary)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function tryCreate(path: string, content: string): Promise<boolean> {
  try {
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(content)
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if (failedWith(error, 'EEXIST')) return false
    throw error
  }
}

const ownerToken = (): string => `${String(process.pid)}:${randomUUID()}`

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const [token, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    return { token, pid: Number(token.split(':')[0]), age: Date.now() - info.mtimeMs }
  } catch {
    return null
  }
}

async function breakAbandonedLock(files: WorkbenchFiles, seen: string): Promise<void> {
  const breaker = await readOwner(files.breaker)
  if (breaker !== null && abandoned(breaker)) await rm(files.breaker, { force: true })
  if (!(await tryCreate(files.breaker, ownerToken()))) return
  try {
    const owner = await readOwner(files.lock)
    if (owner !== null && owner.token === seen && abandoned(owner)) {
      await rm(files.lock, { force: true })
    }
  } finally {
    await rm(files.breaker, { force: true })
  }
}

async function withLock<T>(files: WorkbenchFiles, work: () => Promise<T>): Promise<T> {
  const token = ownerToken()
  const deadline = Date.now() + LOCK_WAIT_MS
  while (!(await tryCreate(files.lock, token))) {
    const owner = await readOwner(files.lock)
    if (owner !== null && abandoned(owner)) await breakAbandonedLock(files, owner.token)
    else if (Date.now() > deadline) throw new WorkbenchBusyError()
    else await delay(LOCK_RETRY_MS)
  }
  try {
    return await work()
  } finally {
    if ((await readOwner(files.lock))?.token === token) await rm(files.lock, { force: true })
  }
}

async function readWanted(file: string): Promise<Wanted | null> {
  const parsed: unknown = await readFile(file, 'utf8')
    .then((text): unknown => JSON.parse(text))
    .catch(() => null)
  if (typeof parsed !== 'object' || parsed === null) return null
  const appRoot: unknown = Reflect.get(parsed, 'appRoot')
  const on: unknown = Reflect.get(parsed, 'on')
  return typeof appRoot === 'string' && typeof on === 'boolean' ? { appRoot, on } : null
}

async function writeWanted(folder: string, appRoot: string, on: boolean): Promise<void> {
  await mkdir(folder, { recursive: true })
  await replaceAtomically(stateFile(folder, appRoot), (temporary) =>
    writeFile(temporary, `${JSON.stringify({ appRoot, on }, null, 2)}\n`)
  )
}

function browserRelay(files: WorkbenchFiles): readonly Insertion[] {
  return [
    { path: files.main, anchor: MAIN_ANCHOR, text: MAIN_RELAY, earlier: [] },
    {
      path: files.preload,
      anchor: PRELOAD_ANCHOR,
      text: PRELOAD_LISTENER,
      earlier: [PRELOAD_LISTENER_UNFILTERED],
    },
  ]
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (failedWith(error, 'ENOENT')) return null
    throw error
  }
}

function withoutRelay(source: string, insertion: Insertion): string {
  return [insertion.text, ...insertion.earlier].reduce(
    (rest, text) => rest.split(text).join(''),
    source
  )
}

function withRelay(stock: string, insertion: Insertion): string | null {
  if (stock.split(insertion.anchor).length !== 2) return null
  return stock.replace(insertion.anchor, () => `${insertion.text}${insertion.anchor}`)
}

function insertionState(source: string | null, insertion: Insertion): InsertionState {
  if (source === null) return 'unavailable'
  const stock = withoutRelay(source, insertion)
  const patched = withRelay(stock, insertion)
  if (stock === source) return patched === null ? 'unavailable' : 'missing'
  return patched === source ? 'applied' : 'outdated'
}

async function relayStates(files: WorkbenchFiles): Promise<InsertionState[]> {
  return Promise.all(
    browserRelay(files).map(async (insertion) =>
      insertionState(await readIfPresent(insertion.path), insertion)
    )
  )
}

async function insertRelay(files: WorkbenchFiles): Promise<boolean> {
  let changed = false
  for (const insertion of browserRelay(files)) {
    const source = await readIfPresent(insertion.path)
    if (source === null) continue
    const state = insertionState(source, insertion)
    if (state === 'applied' || state === 'unavailable') continue
    const stock = withoutRelay(source, insertion)
    const patched = withRelay(stock, insertion) ?? stock
    await replaceAtomically(insertion.path, (temporary) => writeFile(temporary, patched))
    changed = true
  }
  return changed
}

async function removeRelay(files: WorkbenchFiles): Promise<boolean> {
  let changed = false
  for (const insertion of browserRelay(files)) {
    const source = await readIfPresent(insertion.path)
    if (source === null) continue
    const stock = withoutRelay(source, insertion)
    if (stock === source) continue
    await replaceAtomically(insertion.path, (temporary) => writeFile(temporary, stock))
    changed = true
  }
  return changed
}

export async function patchState(files: WorkbenchFiles, bundled: string): Promise<PatchState> {
  const html = await readFile(files.html, 'utf8')
  const relay = await relayStates(files)
  const relayed = relay.some((state) => state === 'applied' || state === 'outdated')
  if (withoutTags(html) === html && !relayed) return 'missing'
  const script = await readFile(bundled, 'utf8')
  const installed = await readFile(files.script, 'utf8').catch(() => '')
  const current = installed === script && html.includes(pageScriptTag(script))
  const relayCurrent = relay.every((state) => state === 'applied' || state === 'unavailable')
  return current && relayCurrent ? 'applied' : 'stale'
}

async function checkShape(files: WorkbenchFiles): Promise<string> {
  const html = await readFile(files.html, 'utf8')
  if (!withoutTags(html).includes(ANCHOR)) throw new WorkbenchShapeError()
  return html
}

async function install(files: WorkbenchFiles, bundled: string): Promise<boolean> {
  const html = await checkShape(files)
  const stock = withoutTags(html)
  const script = await readFile(bundled, 'utf8')
  await replaceAtomically(files.script, (temporary) => writeFile(temporary, script))
  const patched = stock.replace(ANCHOR, `${pageScriptTag(script)}\n\t${ANCHOR}`)
  if (patched !== html) {
    await replaceAtomically(files.html, (temporary) => writeFile(temporary, patched))
  }
  return insertRelay(files)
}

async function uninstall(files: WorkbenchFiles): Promise<boolean> {
  const html = await readIfPresent(files.html)
  const stock = html === null ? null : withoutTags(html)
  if (stock !== null && stock !== html) {
    await replaceAtomically(files.html, (temporary) => writeFile(temporary, stock))
  }
  await rm(files.script, { force: true })
  return removeRelay(files)
}

export async function setPatch(target: PatchTarget, on: boolean): Promise<boolean> {
  const files = workbenchFiles(target.appRoot)
  return withLock(files, async () => {
    if (on) await checkShape(files)
    await writeWanted(target.stateFolder, target.appRoot, on)
    return on ? install(files, target.bundled) : uninstall(files)
  })
}

export async function restorePatch(target: PatchTarget): Promise<Restored> {
  const file = stateFile(target.stateFolder, target.appRoot)
  if ((await readWanted(file)) === null) return UNCHANGED
  const files = workbenchFiles(target.appRoot)
  return withLock(files, async (): Promise<Restored> => {
    const wanted = await readWanted(file)
    if (wanted === null) return UNCHANGED
    const state = await patchState(files, target.bundled)
    if (wanted.on) {
      if (state === 'applied') return UNCHANGED
      return { outcome: 'restored', relaunch: await install(files, target.bundled) }
    }
    if (state === 'missing') return UNCHANGED
    return { outcome: 'removed', relaunch: await uninstall(files) }
  })
}

export async function removeEveryPatch(folder: string): Promise<number> {
  const names = await readdir(folder).catch((): string[] => [])
  let failures = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(folder, name)
    const wanted = await readWanted(file)
    if (wanted === null) continue
    const files = workbenchFiles(wanted.appRoot)
    try {
      await writeWanted(folder, wanted.appRoot, false)
      if (!(await exists(join(wanted.appRoot, 'out')))) {
        await rm(file, { force: true })
        continue
      }
      await withLock(files, async () => {
        await uninstall(files)
        await rm(file, { force: true })
      })
    } catch {
      failures += 1
    }
  }
  return failures
}
