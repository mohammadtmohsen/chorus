import { prepareChildEnvironment } from './child-environment.js'
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

prepareChildEnvironment(process.env)
const requireNative = createRequire(import.meta.url)
const nativeRoot = dirname(requireNative.resolve('node-pty/package.json'))
const helper = join(nativeRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
if (process.platform !== 'win32' && existsSync(helper)) chmodSync(helper, 0o755)
void import('./main.js')
  .then(({ main }) => main())
  .catch((error: unknown) => {
    process.stderr.write(
      (error instanceof Error ? (error.stack ?? error.message) : String(error)) + '\n'
    )
    process.exitCode = 1
  })
