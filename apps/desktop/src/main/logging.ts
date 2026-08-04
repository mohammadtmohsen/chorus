import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Logger, type LogSink } from '@chorus/shared'

/**
 * The log file, and the app's single logger.
 *
 * One rotation only: `chorus.log` becomes `chorus.log.1`, and the previous `.1`
 * is dropped. Two files is enough to explain a crash and its lead-up, and an
 * unbounded pile of logs on a personal machine is litter rather than diagnostics.
 */

function fileSink(directory: string): LogSink {
  const path = join(directory, 'chorus.log')
  mkdirSync(directory, { recursive: true })

  return {
    write: (line) => {
      appendFileSync(path, line, 'utf8')
    },
    size: () => {
      try {
        return statSync(path).size
      } catch {
        // Not created yet, which is the same as empty.
        return 0
      }
    },
    rotate: () => {
      try {
        renameSync(path, `${path}.1`)
      } catch {
        // A failed rotation must not stop logging; the file simply keeps growing
        // until the next attempt.
      }
    },
  }
}

export function createLogger(userDataPath: string): Logger {
  return new Logger({
    sink: fileSink(join(userDataPath, 'logs')),
    minLevel: process.env['CHORUS_DEBUG'] === '1' ? 'debug' : 'info',
  })
}

export function logPath(userDataPath: string): string {
  return join(userDataPath, 'logs', 'chorus.log')
}
