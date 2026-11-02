import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

export const WORKBENCH_PROCESS_OWNER_COMMAND = 'chorus.internal.processOwner'

const Report = z.object({
  nonce: z.uuid(),
  pid: z.number().int().positive(),
  root: z.string().min(1),
})

type RegistrationWarning = (path: string, error: unknown) => void

function readRegistrationFile<T>(
  path: string,
  schema: z.ZodType<T>,
  warn: RegistrationWarning
): T | null {
  let contents: unknown
  try {
    contents = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    warn(path, error)
    return null
  }
  const parsed = schema.safeParse(contents)
  if (parsed.success) return parsed.data
  warn(path, parsed.error)
  return null
}

export function prepareWorkbenchProcessOwner(
  dataDirectory: string,
  warn: RegistrationWarning
): string {
  const reports = join(dataDirectory, 'process-owners')
  const extensions = join(dataDirectory, 'extensions')
  const relativeLocation = 'chorus.workbench-process-owner-1.0.0'
  const extension = join(extensions, relativeLocation)
  const registryPath = join(extensions, 'extensions.json')
  const obsoletePath = join(extensions, '.obsolete')
  const registry = existsSync(registryPath)
    ? readRegistrationFile(
        registryPath,
        z.array(z.looseObject({ identifier: z.looseObject({ id: z.string() }) })),
        warn
      )
    : []
  const obsolete = existsSync(obsoletePath)
    ? readRegistrationFile(obsoletePath, z.record(z.string(), z.unknown()), warn)
    : null
  const id = 'chorus.workbench-process-owner'
  const previous = registry?.find((entry) => entry.identifier.id.toLowerCase() === id)
  const metadata = z.record(z.string(), z.unknown()).safeParse(previous?.['metadata'])
  const location = pathToFileURL(extension)
  mkdirSync(reports, { recursive: true, mode: 0o700 })
  chmodSync(reports, 0o700)
  mkdirSync(extension, { recursive: true })
  writeFileSync(
    join(extension, 'package.json'),
    JSON.stringify({
      name: 'workbench-process-owner',
      publisher: 'chorus',
      version: '1.0.0',
      engines: { vscode: '^1.75.0' },
      main: 'extension.cjs',
      extensionKind: ['workspace'],
      capabilities: { untrustedWorkspaces: { supported: true } },
      activationEvents: [`onCommand:${WORKBENCH_PROCESS_OWNER_COMMAND}`],
    })
  )
  writeFileSync(
    join(extension, 'extension.cjs'),
    `const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')
exports.activate = (context) => {
  context.subscriptions.push(vscode.commands.registerCommand('${WORKBENCH_PROCESS_OWNER_COMMAND}', (nonce) => {
    if (typeof nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nonce)) throw new Error('Invalid ownership nonce')
    const directory = process.env.CHORUS_WORKBENCH_PROCESS_DIRECTORY
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!directory || !folder) throw new Error('Editor ownership is unavailable')
    const reportPath = path.join(directory, nonce + '.json')
    let root
    try {
      root = fs.realpathSync(folder.uri.fsPath)
    } catch (error) {
      let previous
      try { previous = JSON.parse(fs.readFileSync(reportPath, 'utf8')) } catch { throw error }
      if (previous.nonce !== nonce || previous.pid !== process.pid || typeof previous.root !== 'string') throw error
      root = previous.root
    }
    const report = { nonce, pid: process.pid, root }
    fs.writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 })
  }))
}
`
  )
  if (registry !== null) {
    writeFileSync(
      registryPath,
      JSON.stringify([
        ...registry.filter((entry) => entry.identifier.id.toLowerCase() !== id),
        {
          ...previous,
          identifier: { id },
          version: '1.0.0',
          location: {
            $mid: 1,
            scheme: 'file',
            path: decodeURIComponent(location.pathname),
            ...(location.hostname ? { authority: location.hostname } : {}),
          },
          relativeLocation,
          metadata: {
            ...(metadata.success ? metadata.data : {}),
            installedTimestamp:
              metadata.success && typeof metadata.data['installedTimestamp'] === 'number'
                ? metadata.data['installedTimestamp']
                : Date.now(),
            source: 'vsix',
            pinned: true,
            isMachineScoped: true,
            isApplicationScoped: true,
          },
        },
      ])
    )
  }
  if (obsolete !== null && Object.hasOwn(obsolete, relativeLocation)) {
    const remaining = Object.entries(obsolete).filter(([key]) => key !== relativeLocation)
    writeFileSync(obsoletePath, JSON.stringify(Object.fromEntries(remaining)))
  }
  return reports
}

export function readWorkbenchProcessOwner(
  dataDirectory: string,
  nonce: string
): z.infer<typeof Report> {
  const parsedNonce = z.uuid().parse(nonce)
  return Report.parse(
    JSON.parse(readFileSync(join(dataDirectory, 'process-owners', `${parsedNonce}.json`), 'utf8'))
  )
}

export function forgetWorkbenchProcessOwner(dataDirectory: string, nonce: string): void {
  const parsedNonce = z.uuid().parse(nonce)
  rmSync(join(dataDirectory, 'process-owners', `${parsedNonce}.json`), { force: true })
}
