import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openSqlite } from '@chorus/event-store'

export function socketPathFor(dataDirectory: string): string {
  const key = createHash('sha256').update(dataDirectory).digest('hex').slice(0, 20)
  const user = String(process.getuid?.() ?? process.env['USERNAME'] ?? 'user')
  if (process.platform === 'win32') return `\\\\.\\pipe\\chorus-${user}-${key}`
  const directory = join('/tmp', `chorus-engine-${user}`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const facts = lstatSync(directory)
  if (!facts.isDirectory() || facts.isSymbolicLink() || facts.uid !== process.getuid?.())
    throw new Error('unsafe-socket-directory')
  chmodSync(directory, 0o700)
  return join(directory, `${key}.sock`)
}
export interface DirectoryLock {
  readonly generation: string
  release(): void
}
export function acquireDirectoryLock(dataDirectory: string): DirectoryLock | null {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  const path = join(dataDirectory, 'engine-lock.sqlite')
  const database = openSqlite({ path })
  try {
    database.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE')
    chmodSync(path, 0o600)
  } catch (error) {
    database.close()
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'SQLITE_BUSY'
    )
      return null
    throw error
  }
  let released = false
  return {
    generation: randomUUID(),
    release: () => {
      if (released) return
      released = true
      database.close()
    },
  }
}
