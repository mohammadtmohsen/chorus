import { parseArgs } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { z } from 'zod'
import { createLogger } from '../../desktop/src/main/logging.js'
import { adoptShellPath } from '../../desktop/src/main/which.js'
import { reapOrphanedChildren } from '../../desktop/src/main/reap.js'
import { serveEngine } from './server.js'
import { buildOf, readRuntimeManifest } from './descriptor.js'
import { ENGINE_VERSION } from './version.js'
import { acquireDirectoryLock } from './lock.js'

function identityProblem(directory: string, build: string): string | null {
  const manifest = readRuntimeManifest(directory)
  const versions: Readonly<Record<string, string | undefined>> = process.versions
  if (manifest === null) return 'runtime-manifest-unreadable'
  if (buildOf(directory) !== build) return 'runtime-build-mismatch'
  if (manifest.version !== ENGINE_VERSION) return 'runtime-version-mismatch'
  if (manifest.platform !== process.platform) return 'runtime-platform-mismatch'
  if (manifest.arch !== process.arch) return 'runtime-architecture-mismatch'
  if (manifest.electron !== (versions['electron'] ?? '')) return 'runtime-electron-mismatch'
  const hash = (path: string): string =>
    createHash('sha256').update(readFileSync(path)).digest('hex')
  if (hash(join(directory, 'engine.cjs')) !== manifest.engine) return 'runtime-engine-mismatch'
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
  for (const [name, root, path] of [
    ['better-sqlite3', sqliteRoot, sqlite],
    ['node-pty', ptyRoot, pty],
  ] as const) {
    const expected = manifest.natives[name]
    if (expected === undefined || path === undefined) return `runtime-native-missing:${name}`
    const installed = z
      .object({ version: z.string() })
      .parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as unknown)
    if (installed.version !== expected.version) return `runtime-native-version-mismatch:${name}`
    if (hash(path) !== expected.sha256) return `runtime-native-hash-mismatch:${name}`
  }
  return null
}

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      data: { type: 'string' },
      build: { type: 'string' },
      'idle-ms': { type: 'string' },
      'probe-lock': { type: 'boolean' },
    },
  })
  if (values.data === undefined || values.build === undefined)
    throw new Error('engine-arguments-required')
  const dataDirectory = resolve(values.data)
  const log = createLogger(join(dataDirectory, 'engine'))
  try {
    const problem = identityProblem(dirname(__filename), values.build)
    if (problem !== null) {
      log.error('engine identity rejected', { reason: problem })
      process.exitCode = 1
      return
    }
  } catch (error) {
    log.error('engine identity could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    })
    process.exitCode = 1
    return
  }
  if (values['probe-lock'] === true) {
    try {
      const lock = acquireDirectoryLock(dataDirectory)
      if (lock === null) process.exitCode = 2
      else lock.release()
    } catch (error) {
      log.error('engine lock probe failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
      process.exitCode = 1
    }
    return
  }
  let engine: Awaited<ReturnType<typeof serveEngine>>
  try {
    engine = await serveEngine({
      dataDirectory,
      build: values.build,
      log,
      ...(values['idle-ms'] === undefined ? {} : { idleTimeoutMs: Number(values['idle-ms']) }),
      beforeOpen: async () => {
        await adoptShellPath()
        const reaped = await reapOrphanedChildren()
        log.info('orphan sweep finished', { ...reaped })
      },
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'engine-lock-held') return
    throw error
  }
  const stop = (): void => {
    void engine.close().then(() => {
      process.exit(0)
    })
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  log.info('engine ready', { pid: process.pid, generation: engine.descriptor.generation })
}
