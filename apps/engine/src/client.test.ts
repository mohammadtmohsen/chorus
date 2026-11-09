import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { serveEngine } from './server.js'
import { buildOf, readDescriptor, type RuntimeManifest } from './descriptor.js'
import { EngineClient } from './client.js'
import { ENGINE_VERSION } from './version.js'

let engineMain: string
let shipped: string
let client: EngineClient | undefined
let previous: Awaited<ReturnType<typeof serveEngine>> | undefined
let dataDirectory: string | undefined

beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chorus-client-fixture-'))
  shipped = directory
  engineMain = join(directory, 'engine.cjs')
  symlinkSync(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(directory, 'node_modules'),
    'junction'
  )
  await build({
    entryPoints: [fileURLToPath(new URL('./bootstrap.ts', import.meta.url))],
    outfile: engineMain,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['better-sqlite3', 'node-pty'],
    define: {
      'import.meta.url': '__chorus_import_meta_url',
      __CHORUS_APP_VERSION__: JSON.stringify(ENGINE_VERSION),
    },
    banner: {
      js: 'var __chorus_import_meta_url = require("node:url").pathToFileURL(__filename).href;',
    },
  })
  const hash = (path: string): string =>
    createHash('sha256').update(readFileSync(path)).digest('hex')
  const nativeRequire = createRequire(import.meta.url)
  const sqliteRoot = dirname(nativeRequire.resolve('better-sqlite3/package.json'))
  const ptyRoot = dirname(nativeRequire.resolve('node-pty/package.json'))
  const binding = nativeRequire(join(sqliteRoot, 'lib', 'binding.js')) as {
    getPrebuildPath(): string | null
  }
  const sqlite =
    binding.getPrebuildPath() ??
    [join(sqliteRoot, 'build', 'Debug'), join(sqliteRoot, 'build', 'Release')]
      .map((path) => join(path, 'better_sqlite3.node'))
      .find((path) => existsSync(path))
  const module = process.platform === 'win32' ? 'conpty.node' : 'pty.node'
  const pty = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`]
    .map((path) => join(ptyRoot, path, module))
    .find((path) => existsSync(path))
  const natives: RuntimeManifest['natives'] = {}
  for (const [name, root, path] of [
    ['better-sqlite3', sqliteRoot, sqlite],
    ['node-pty', ptyRoot, pty],
  ] as const) {
    if (path === undefined) throw new Error(`missing fixture native: ${name}`)
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version: string
    }
    natives[name] = { version: metadata.version, sha256: hash(path) }
  }
  const versions: Readonly<Record<string, string | undefined>> = process.versions
  const manifest: RuntimeManifest = {
    version: ENGINE_VERSION,
    platform: process.platform,
    arch: process.arch,
    engine: hash(engineMain),
    electron: versions['electron'] ?? '',
    natives,
  }
  writeFileSync(join(directory, 'runtime.json'), JSON.stringify(manifest))
})

afterAll(async () => {
  client?.dispose()
  const directory = dataDirectory
  if (directory !== undefined) {
    const descriptor = readDescriptor(directory)
    if (descriptor !== null && descriptor.pid !== process.pid) {
      try {
        process.kill(descriptor.pid, 'SIGTERM')
      } catch {
        return
      }
      await vi.waitFor(
        () => {
          expect(readDescriptor(directory)).toBeNull()
        },
        { timeout: 5000 }
      )
    }
  }
  await previous?.close()
  vi.restoreAllMocks()
})

describe('engine replacement', () => {
  it('replaces an idle build and reconnects after the replacement is killed', async () => {
    dataDirectory = mkdtempSync(join(tmpdir(), 'chorus-client-upgrade-'))
    previous = await serveEngine({ dataDirectory, build: 'previous-build', adapters: new Map() })
    const closeRuntime = previous.runtime.close.bind(previous.runtime)
    vi.spyOn(previous.runtime, 'close').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await closeRuntime()
    })
    client = new EngineClient({
      dataDirectory,
      install: () => ({ version: ENGINE_VERSION, shipped, executable: process.execPath }),
      appVersion: ENGINE_VERSION,
      client: { kind: 'vscode' },
      role: { kind: 'main' },
      clientId: 'upgrade-client',
      workspaceKey: 'upgrade-workspace',
      workspaceFolders: [],
      trusted: true,
      secrets: () => ({
        claude: { value: null, revision: 0 },
        codex: { value: null, revision: 0 },
        deepseek: { value: null, revision: 0 },
        gitlab: { value: null, revision: 0 },
        typesafe: { value: null, revision: 0 },
        'completion-deepseek': { value: null, revision: 0 },
        'completion-codestral': { value: null, revision: 0 },
      }),
    })
    const states: string[] = []
    client.onState((state) => {
      states.push(state)
    })
    const welcome = await client.connect()
    expect(welcome.generation).not.toBe(previous.descriptor.generation)
    expect(readDescriptor(dataDirectory)?.build).toBe(buildOf(shipped))
    expect(readDescriptor(dataDirectory)?.pid).not.toBe(process.pid)
    expect(await client.invoke('project:list', {})).toMatchObject({ projects: [] })
    expect(await client.invoke('policy:profiles', undefined)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'read-only' })])
    )
    expect(states).toContain('restart-required')
    expect(states.at(-1)).toBe('connected')
    const projectRoot = join(dataDirectory, 'project')
    mkdirSync(projectRoot)
    await client.request({ kind: 'adoptFolder', path: projectRoot })
    const killed = readDescriptor(dataDirectory)
    if (killed === null) throw new Error('missing child descriptor')
    process.kill(killed.pid, 'SIGKILL')
    const currentClient = client
    const directory = dataDirectory
    await vi.waitFor(
      () => {
        const replacement = readDescriptor(directory)
        expect(replacement).not.toBeNull()
        expect(replacement?.generation).not.toBe(killed.generation)
      },
      { timeout: 15_000 }
    )
    expect(await currentClient.invoke('project:list', {})).toMatchObject({
      projects: [{ name: 'project' }],
    })
    expect(states).toContain('reconnecting')
  }, 25_000)
})
