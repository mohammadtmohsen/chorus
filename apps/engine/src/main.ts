import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { createLogger } from '../../desktop/src/main/logging.js'
import { adoptShellPath } from '../../desktop/src/main/which.js'
import { reapOrphanedChildren } from '../../desktop/src/main/reap.js'
import { serveEngine } from './server.js'

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { data: { type: 'string' }, build: { type: 'string' }, 'idle-ms': { type: 'string' } },
  })
  if (values.data === undefined || values.build === undefined)
    throw new Error('engine-arguments-required')
  const dataDirectory = resolve(values.data)
  const log = createLogger(dataDirectory)
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
