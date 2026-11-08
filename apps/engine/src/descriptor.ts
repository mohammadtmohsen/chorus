import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { EngineDescriptor } from './protocol.js'

export const EngineInstall = z.object({
  version: z.string(),
  executable: z.string(),
  shipped: z.string(),
})
export type EngineInstall = z.infer<typeof EngineInstall>

export const RuntimeManifest = z.object({
  version: z.string(),
  platform: z.string(),
  arch: z.string(),
  engine: z.string(),
  electron: z.string(),
  natives: z.record(z.string(), z.object({ version: z.string(), sha256: z.string() })),
})
export type RuntimeManifest = z.infer<typeof RuntimeManifest>

export function readEngineInstall(dataDirectory: string): EngineInstall | null {
  try {
    return EngineInstall.parse(
      JSON.parse(readFileSync(join(dataDirectory, 'engine-install.json'), 'utf8')) as unknown
    )
  } catch {
    return null
  }
}

export function writeEngineInstall(dataDirectory: string, install: EngineInstall): void {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  const target = join(dataDirectory, 'engine-install.json')
  const temporary = `${target}.${String(process.pid)}.tmp`
  writeFileSync(temporary, JSON.stringify(EngineInstall.parse(install)), { mode: 0o600 })
  renameSync(temporary, target)
}

export function readRuntimeManifest(runtimeDirectory: string): RuntimeManifest | null {
  try {
    return RuntimeManifest.parse(
      JSON.parse(readFileSync(join(runtimeDirectory, 'runtime.json'), 'utf8')) as unknown
    )
  } catch {
    return null
  }
}

export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] =>
    version.split(/[.+-]/).map((part) => Number(part) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

export function buildOf(runtimeDirectory: string): string {
  return createHash('sha256')
    .update(readFileSync(join(runtimeDirectory, 'runtime.json')))
    .digest('hex')
}

export function runtimeCopy(
  dataDirectory: string,
  shipped: string
): { build: string; main: string } {
  const build = buildOf(shipped)
  const copies = join(dataDirectory, 'engine-runtime')
  const target = join(copies, build)
  if (!existsSync(join(target, 'runtime.json'))) {
    mkdirSync(copies, { recursive: true, mode: 0o700 })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      cpSync(shipped, temporary, { recursive: true, verbatimSymlinks: true })
      renameSync(temporary, target)
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true })
      if (!existsSync(join(target, 'runtime.json'))) throw error
    }
  }
  return { build, main: join(target, 'engine.cjs') }
}

export function desktopDataDirectory(development: boolean): string {
  const name = development ? '@chorus/desktop-dev' : '@chorus/desktop'
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name)
  if (process.platform === 'win32')
    return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), name)
  return join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), name)
}

export function readDescriptor(dataDirectory: string): EngineDescriptor | null {
  try {
    return EngineDescriptor.parse(
      JSON.parse(readFileSync(join(dataDirectory, 'engine.json'), 'utf8')) as unknown
    )
  } catch {
    return null
  }
}
export function writeDescriptor(dataDirectory: string, descriptor: EngineDescriptor): void {
  const target = join(dataDirectory, 'engine.json')
  const temporary = `${target}.${descriptor.generation}.tmp`
  writeFileSync(temporary, JSON.stringify(descriptor), { mode: 0o600 })
  renameSync(temporary, target)
}
export function removeDescriptor(dataDirectory: string, generation: string): void {
  if (
    readDescriptor(dataDirectory)?.generation === generation &&
    existsSync(join(dataDirectory, 'engine.json'))
  )
    unlinkSync(join(dataDirectory, 'engine.json'))
}
