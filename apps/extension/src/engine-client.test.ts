import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { serveEngine } from '../../engine/src/server.js'
import { readDescriptor } from '../../engine/src/descriptor.js'
import { EngineClient } from './engine-client.js'

let engineMain: string
let client: EngineClient | undefined
let previous: Awaited<ReturnType<typeof serveEngine>> | undefined
let dataDirectory: string | undefined

beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chorus-client-fixture-'))
  engineMain = join(directory, 'engine.cjs')
  symlinkSync(
    fileURLToPath(new URL('../../engine/node_modules', import.meta.url)),
    join(directory, 'node_modules'),
    'junction'
  )
  await build({
    entryPoints: [fileURLToPath(new URL('../../engine/src/bootstrap.ts', import.meta.url))],
    outfile: engineMain,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['better-sqlite3', 'node-pty'],
    define: { 'import.meta.url': '__chorus_import_meta_url' },
    banner: {
      js: 'var __chorus_import_meta_url = require("node:url").pathToFileURL(__filename).href;',
    },
  })
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
      engineMain,
      executable: process.execPath,
      clientId: 'upgrade-client',
      workspaceKey: 'upgrade-workspace',
      workspaceFolders: [],
      trusted: true,
      secrets: {
        claude: null,
        codex: null,
        deepseek: null,
        typesafe: null,
        'completion-deepseek': null,
        'completion-codestral': null,
      },
    })
    const states: string[] = []
    client.onState((state) => {
      states.push(state)
    })
    const welcome = await client.connect()
    expect(welcome.generation).not.toBe(previous.descriptor.generation)
    expect(readDescriptor(dataDirectory)?.build).toBe(client.build)
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
