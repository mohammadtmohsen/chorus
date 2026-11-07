import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PAGE_SCRIPT,
  WorkbenchShapeError,
  pageScriptTag,
  patchState,
  removeEveryPatch,
  restorePatch,
  setPatch,
  workbenchFiles,
} from './patch.js'

const STOCK = `<html>\n\t<body aria-label="">\n\t</body>\n\t<script src="./workbench.js" type="module"></script>\n</html>\n`
const UNVERSIONED_TAG = `<script src="./${PAGE_SCRIPT}"></script>`
const WORKBENCH_SCRIPT = '<script src="./workbench.js"'
const STOCK_MAIN = 'let o=()=>{};e.ipc.on("vscode:browserView:keydown",o),e.on("blur",()=>{});\n'
const STOCK_PRELOAD =
  'function F(){window.addEventListener("keydown",o=>{if(!(o instanceof KeyboardEvent)||!o.isTrusted)return})}\n'

async function install(root: string, html = STOCK, main = STOCK_MAIN) {
  const appRoot = join(root, `app-${String(Math.random()).slice(2)}`)
  const files = workbenchFiles(appRoot)
  await mkdir(join(appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench'), {
    recursive: true,
  })
  await mkdir(join(appRoot, 'out', 'vs', 'platform', 'browserView', 'electron-browser'), {
    recursive: true,
  })
  await writeFile(files.html, html)
  await writeFile(files.main, main)
  await writeFile(files.preload, STOCK_PRELOAD)
  const bundled = join(appRoot, 'continuous-row.js')
  await writeFile(bundled, 'window.chorus = 1')
  return { files, target: { appRoot, bundled, stateFolder: join(root, 'state') } }
}

async function fixture(html = STOCK, main = STOCK_MAIN) {
  return install(await mkdtemp(join(tmpdir(), 'chorus-patch-')), html, main)
}

describe('patching workbench.html', () => {
  it('adds the script once, before workbench.js, even when two windows race', async () => {
    const { files, target } = await fixture()
    await Promise.all([setPatch(target, true), setPatch(target, true)])
    const html = await readFile(files.html, 'utf8')
    expect(html.match(/chorus-continuous-row\.js/g)).toHaveLength(1)
    expect(html.indexOf('chorus-continuous-row.js')).toBeLessThan(html.indexOf('workbench.js'))
    expect(await patchState(files, target.bundled)).toBe('applied')
  })

  it('restores the stock files byte for byte', async () => {
    const { files, target } = await fixture()
    await setPatch(target, true)
    await setPatch(target, false)
    expect(await readFile(files.html, 'utf8')).toBe(STOCK)
    expect(await readFile(files.main, 'utf8')).toBe(STOCK_MAIN)
    expect(await readFile(files.preload, 'utf8')).toBe(STOCK_PRELOAD)
    await expect(readFile(files.script, 'utf8')).rejects.toThrow()
  })

  it('adds the browser relay once, and asks for a full restart only when it changed', async () => {
    const { files, target } = await fixture()
    expect(await setPatch(target, true)).toBe(true)
    expect(await setPatch(target, true)).toBe(false)
    const main = await readFile(files.main, 'utf8')
    const preload = await readFile(files.preload, 'utf8')
    expect(main.match(/chorusWheel/g)).toHaveLength(1)
    expect(main.indexOf('chorusWheel')).toBeLessThan(main.indexOf('browserView:keydown'))
    expect(preload.match(/addEventListener\("wheel"/g)).toHaveLength(1)
    expect(preload.indexOf('"wheel"')).toBeLessThan(preload.indexOf('"keydown"'))
    expect(await patchState(files, target.bundled)).toBe('applied')
    expect(await setPatch(target, false)).toBe(true)
  })

  it('skips the browser relay when VS Code changed that file, and still patches the page', async () => {
    const changed = 'n.ipc.on("vscode:browserView:keydown",r);\n'
    const { files, target } = await fixture(STOCK, changed)
    await setPatch(target, true)
    expect(await readFile(files.main, 'utf8')).toBe(changed)
    expect(await readFile(files.html, 'utf8')).toContain(pageScriptTag('window.chorus = 1'))
    expect(await patchState(files, target.bundled)).toBe('applied')
  })

  it('puts the patch back after a VS Code update, and only when it was wanted', async () => {
    const { files, target } = await fixture()
    expect(await restorePatch(target)).toEqual({ outcome: 'unchanged', relaunch: false })
    await setPatch(target, true)
    await writeFile(files.html, STOCK)
    expect(await restorePatch(target)).toEqual({ outcome: 'restored', relaunch: false })
    expect(await patchState(files, target.bundled)).toBe('applied')
  })

  it('puts the browser relay back after a VS Code update, and asks for a full restart', async () => {
    const { files, target } = await fixture()
    await setPatch(target, true)
    await writeFile(files.main, STOCK_MAIN)
    expect(await patchState(files, target.bundled)).toBe('stale')
    expect(await restorePatch(target)).toEqual({ outcome: 'restored', relaunch: true })
    expect((await readFile(files.main, 'utf8')).match(/chorusWheel/g)).toHaveLength(1)
  })

  it('swaps a stale script after a Chorus update', async () => {
    const { files, target } = await fixture()
    await setPatch(target, true)
    await writeFile(target.bundled, 'window.chorus = 2')
    expect(await patchState(files, target.bundled)).toBe('stale')
    expect(await restorePatch(target)).toEqual({ outcome: 'restored', relaunch: false })
    expect(await readFile(files.script, 'utf8')).toBe('window.chorus = 2')
    const html = await readFile(files.html, 'utf8')
    expect(html).toContain(pageScriptTag('window.chorus = 2'))
    expect(html).not.toContain(pageScriptTag('window.chorus = 1'))
    expect(html.match(/chorus-continuous-row\.js/g)).toHaveLength(1)
  })

  it('upgrades the unversioned tag an earlier Chorus wrote', async () => {
    const { files, target } = await fixture()
    await setPatch(target, true)
    const earlier = STOCK.replace(WORKBENCH_SCRIPT, `${UNVERSIONED_TAG}\n\t${WORKBENCH_SCRIPT}`)
    await writeFile(files.html, earlier)
    expect(await patchState(files, target.bundled)).toBe('stale')
    expect(await restorePatch(target)).toEqual({ outcome: 'restored', relaunch: false })
    const html = await readFile(files.html, 'utf8')
    expect(html).toContain(pageScriptTag('window.chorus = 1'))
    expect(html.match(/chorus-continuous-row\.js/g)).toHaveLength(1)
    expect(await patchState(files, target.bundled)).toBe('applied')
  })

  it('removes a leftover patch at startup once it is no longer wanted', async () => {
    const { files, target } = await fixture()
    await setPatch(target, true)
    await setPatch(target, false)
    const leftover = STOCK.replace(WORKBENCH_SCRIPT, `${UNVERSIONED_TAG}\n\t${WORKBENCH_SCRIPT}`)
    await writeFile(files.html, leftover)
    expect(await restorePatch(target)).toEqual({ outcome: 'removed', relaunch: false })
    expect(await readFile(files.html, 'utf8')).toBe(STOCK)
  })

  it('lets exactly one of two waiting windows break a lock left by a crash', async () => {
    const { files, target } = await fixture()
    await writeFile(files.lock, 'crashed-window')
    const old = new Date(Date.now() - 60_000)
    await utimes(files.lock, old, old)
    await Promise.all([setPatch(target, true), setPatch(target, true)])
    expect((await readFile(files.html, 'utf8')).match(/chorus-continuous-row\.js/g)).toHaveLength(1)
    await expect(readFile(files.lock, 'utf8')).rejects.toThrow()
  })

  it('breaks a lock at once when the window holding it has exited', async () => {
    const { files, target } = await fixture()
    const exited = spawnSync(process.execPath, ['-e', '']).pid
    await writeFile(files.lock, `${String(exited)}:gone`)
    await setPatch(target, true)
    expect(await patchState(files, target.bundled)).toBe('applied')
  })

  it('keeps a separate record per VS Code installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chorus-patch-'))
    const stable = await install(root)
    const insiders = await install(root)
    await Promise.all([setPatch(stable.target, true), setPatch(insiders.target, true)])
    expect(await removeEveryPatch(stable.target.stateFolder)).toBe(0)
    expect(await readFile(stable.files.html, 'utf8')).toBe(STOCK)
    expect(await readFile(insiders.files.html, 'utf8')).toBe(STOCK)
    expect(await readFile(stable.files.main, 'utf8')).toBe(STOCK_MAIN)
    expect(await readFile(insiders.files.preload, 'utf8')).toBe(STOCK_PRELOAD)
    expect(await readdir(stable.target.stateFolder)).toEqual([])
  })

  it('keeps the record of a patch it could not remove on uninstall', async () => {
    const { files, target } = await fixture()
    await setPatch(target, true)
    await rm(files.html)
    await mkdir(files.html)
    expect(await removeEveryPatch(target.stateFolder)).toBe(1)
    const [record] = await readdir(target.stateFolder)
    expect(record).toBeDefined()
    const kept: unknown = JSON.parse(
      await readFile(join(target.stateFolder, String(record)), 'utf8')
    )
    expect(kept).toEqual({ appRoot: target.appRoot, on: false })
  })

  it('forgets an installation that no longer exists', async () => {
    const { target } = await fixture()
    await setPatch(target, true)
    await rm(target.appRoot, { recursive: true, force: true })
    expect(await removeEveryPatch(target.stateFolder)).toBe(0)
    expect(await readdir(target.stateFolder)).toEqual([])
  })

  it('removes the browser relay on uninstall even when workbench.html is gone', async () => {
    const { files, target } = await fixture()
    await setPatch(target, true)
    await rm(files.html)
    expect(await removeEveryPatch(target.stateFolder)).toBe(0)
    expect(await readFile(files.main, 'utf8')).toBe(STOCK_MAIN)
    expect(await readFile(files.preload, 'utf8')).toBe(STOCK_PRELOAD)
    expect(await readdir(target.stateFolder)).toEqual([])
  })

  it('records the intent before writing, so a failed write is retried', async () => {
    const { files, target } = await fixture()
    await rm(files.preload)
    await mkdir(files.preload)
    await expect(setPatch(target, true)).rejects.toThrow()
    const [record] = await readdir(target.stateFolder)
    const kept: unknown = JSON.parse(
      await readFile(join(target.stateFolder, String(record)), 'utf8')
    )
    expect(kept).toEqual({ appRoot: target.appRoot, on: true })
    await rm(files.preload, { recursive: true })
    await writeFile(files.preload, STOCK_PRELOAD)
    expect(await restorePatch(target)).toEqual({ outcome: 'restored', relaunch: true })
    expect(await patchState(files, target.bundled)).toBe('applied')
  })

  it('replaces the earlier browser listener instead of adding a second', async () => {
    const earlier =
      'window.addEventListener("wheel",o=>{o.isTrusted&&Math.abs(o.deltaX)>Math.abs(o.deltaY)&&require("electron").ipcRenderer.send("vscode:browserView:chorusWheel",{deltaX:o.deltaX,deltaY:o.deltaY,deltaMode:o.deltaMode})},{passive:!0,capture:!0});'
    const { files, target } = await fixture()
    await setPatch(target, true)
    await writeFile(
      files.preload,
      STOCK_PRELOAD.replace(
        'window.addEventListener("keydown"',
        `${earlier}window.addEventListener("keydown"`
      )
    )
    expect(await patchState(files, target.bundled)).toBe('stale')
    expect(await restorePatch(target)).toEqual({ outcome: 'restored', relaunch: true })
    const preload = await readFile(files.preload, 'utf8')
    expect(preload.match(/addEventListener\("wheel"/g)).toHaveLength(1)
    expect(preload).toContain('!o.shiftKey')
    await setPatch(target, false)
    expect(await readFile(files.preload, 'utf8')).toBe(STOCK_PRELOAD)
  })

  it('leaves an unexpected file untouched, and records nothing', async () => {
    const { files, target } = await fixture('<html></html>')
    await expect(setPatch(target, true)).rejects.toBeInstanceOf(WorkbenchShapeError)
    expect(await readFile(files.html, 'utf8')).toBe('<html></html>')
    expect(await readFile(files.main, 'utf8')).toBe(STOCK_MAIN)
    expect(await readdir(target.stateFolder).catch((): string[] => [])).toEqual([])
  })
})
