import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EngineDescriptor } from './protocol.js'

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
