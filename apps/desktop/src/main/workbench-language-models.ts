import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { LM_INPUT_CHAR_LIMIT, LM_OUTPUT_TOKEN_LIMIT } from '../shared/language-model-ipc.js'
import { mainT } from './i18n.js'

type RegistrationWarning = (path: string, error: unknown) => void

function readRegistration<T>(
  path: string,
  schema: z.ZodType<T>,
  warn: RegistrationWarning
): T | null {
  try {
    const contents: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const parsed = schema.safeParse(contents)
    if (parsed.success) return parsed.data
    warn(path, parsed.error)
  } catch (error) {
    warn(path, error)
  }
  return null
}

export function prepareWorkbenchLanguageModels(
  dataDirectory: string,
  warn: RegistrationWarning
): void {
  const extensions = join(dataDirectory, 'extensions')
  const relativeLocation = 'chorus.language-models-1.0.0'
  const extension = join(extensions, relativeLocation)
  const registryPath = join(extensions, 'extensions.json')
  const obsoletePath = join(extensions, '.obsolete')
  const id = 'chorus.language-models'
  const registry = existsSync(registryPath)
    ? readRegistration(
        registryPath,
        z.array(z.looseObject({ identifier: z.looseObject({ id: z.string() }) })),
        warn
      )
    : []
  const obsolete = existsSync(obsoletePath)
    ? readRegistration(obsoletePath, z.record(z.string(), z.unknown()), warn)
    : null
  const previous = registry?.find((entry) => entry.identifier.id.toLowerCase() === id)
  const metadata = z.record(z.string(), z.unknown()).safeParse(previous?.['metadata'])
  const location = pathToFileURL(extension)
  const labels = {
    tokenEstimate: mainT('languageModels.tokenEstimate'),
    unsupportedTools: mainT('languageModels.unsupportedTools'),
    unsupportedParts: mainT('languageModels.unsupportedParts'),
    invalidRequest: mainT('languageModels.invalidRequest'),
    bridgeUnavailable: mainT('languageModels.bridgeUnavailable'),
    generateCommitMessage: mainT('languageModels.generateCommitMessage'),
    noCommitChanges: mainT('languageModels.noCommitChanges'),
    commitMessageFailed: mainT('languageModels.commitMessageFailed'),
  }
  mkdirSync(extension, { recursive: true })
  writeFileSync(
    join(extension, 'package.json'),
    JSON.stringify({
      name: 'language-models',
      publisher: 'chorus',
      version: '1.0.0',
      engines: { vscode: '^1.104.0' },
      main: 'extension.cjs',
      extensionKind: ['workspace'],
      capabilities: { untrustedWorkspaces: { supported: true } },
      enabledApiProposals: ['contribSourceControlInputBoxMenu'],
      activationEvents: [
        'onLanguageModelChatProvider:chorus',
        'onCommand:chorus.generateCommitMessage',
      ],
      contributes: {
        languageModelChatProviders: [{ vendor: 'chorus', displayName: 'Chorus' }],
        commands: [
          {
            command: 'chorus.generateCommitMessage',
            title: labels.generateCommitMessage,
            icon: '$(sparkle)',
          },
        ],
        menus: {
          'scm/inputBox': [{ command: 'chorus.generateCommitMessage', when: 'scmProvider == git' }],
          commandPalette: [{ command: 'chorus.generateCommitMessage', when: 'false' }],
        },
      },
    })
  )
  writeFileSync(
    join(extension, 'extension.cjs'),
    `const vscode = require('vscode')
const { randomUUID } = require('node:crypto')
const { relative, sep } = require('node:path')
const labels = ${JSON.stringify(labels)}
const inputLimit = ${String(LM_INPUT_CHAR_LIMIT)}
const outputLimit = ${String(LM_OUTPUT_TOKEN_LIMIT)}
function textOf(message, bounded = true) {
  let text = ''
  for (const part of message.content) {
    if (!(part instanceof vscode.LanguageModelTextPart)) throw new Error(labels.unsupportedParts)
    text += part.value
    if (bounded && text.length > inputLimit) throw new Error(labels.invalidRequest)
  }
  return text
}
exports.activate = (context) => {
  const model = {
    id: 'claude-haiku',
    family: 'claude-haiku',
    name: 'Claude Haiku (Chorus)',
    version: 'haiku',
    tooltip: labels.tokenEstimate,
    maxInputTokens: ${String(Math.floor(LM_INPUT_CHAR_LIMIT / 4))},
    maxOutputTokens: outputLimit,
    capabilities: { toolCalling: false, imageInput: false },
  }
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('chorus', {
    provideLanguageModelChatInformation: () => [model],
    provideLanguageModelChatResponse: async (_model, messages, options, progress, token) => {
      if (options.tools?.length) throw new Error(labels.unsupportedTools)
      if (token.isCancellationRequested) throw new vscode.CancellationError()
      if (messages.length === 0 || messages.length > 64) throw new Error(labels.invalidRequest)
      let characters = 0
      const input = messages.map((message) => {
        let role
        if (message.role === vscode.LanguageModelChatMessageRole.User) role = 'user'
        else if (message.role === vscode.LanguageModelChatMessageRole.Assistant) role = 'assistant'
        else throw new Error(labels.invalidRequest)
        const text = textOf(message)
        characters += text.length + role.length + 4
        if (characters > inputLimit) throw new Error(labels.invalidRequest)
        return { role, text }
      })
      const requestedLimit = options.modelOptions?.outputTokens
      const validLimit = typeof requestedLimit === 'number' &&
        Number.isFinite(requestedLimit) && requestedLimit >= 1
      const limit = validLimit ? Math.min(outputLimit, Math.floor(requestedLimit)) : outputLimit
      const requestId = randomUUID()
      let subscription
      const cancelled = new Promise((_, reject) => {
        subscription = token.onCancellationRequested(() => {
          Promise.resolve(
            vscode.commands.executeCommand('chorus.languageModels.cancel', { requestId })
          ).catch(() => undefined)
          reject(new vscode.CancellationError())
        })
      })
      try {
        if (token.isCancellationRequested) throw new vscode.CancellationError()
        const response = await Promise.race([
          vscode.commands.executeCommand('chorus.languageModels.respond', {
            requestId, family: 'claude-haiku', messages: input, outputLimit: limit,
          }),
          cancelled,
        ])
        if (token.isCancellationRequested) throw new vscode.CancellationError()
        if (!response || typeof response !== 'object') throw new Error(labels.bridgeUnavailable)
        if (response.ok === false) {
          const message = typeof response.message === 'string'
            ? response.message : labels.bridgeUnavailable
          throw new Error(message)
        }
        if (response.ok !== true || typeof response.text !== 'string')
          throw new Error(labels.bridgeUnavailable)
        progress.report(new vscode.LanguageModelTextPart(response.text))
      } finally {
        subscription?.dispose()
      }
    },
    provideTokenCount: async (_model, value) =>
      Math.ceil((typeof value === 'string' ? value : textOf(value, false)).length / 4),
  }))
  let generatingCommitMessage = false
  context.subscriptions.push(vscode.commands.registerCommand(
    'chorus.generateCommitMessage', async (sourceControl) => {
      if (generatingCommitMessage) return
      generatingCommitMessage = true
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, async () => {
          const extension = vscode.extensions.getExtension('vscode.git')
          if (!extension) throw new Error(labels.commitMessageFailed)
          if (!extension.isActive) await extension.activate()
          const git = extension.exports.getAPI(1)
          let repository = sourceControl?.rootUri ? git.getRepository(sourceControl.rootUri) : null
          if (!repository && git.repositories.length === 1) repository = git.repositories[0]
          if (!repository) throw new Error(labels.commitMessageFailed)
          let diff = await repository.diff(true)
          const untracked = new Map()
          if (!diff.trim()) {
            diff = await repository.diff(false)
            const untrackedStatus = 7
            for (const change of [
              ...repository.state.untrackedChanges,
              ...repository.state.workingTreeChanges,
            ]) {
              if (change.status === untrackedStatus) {
                untracked.set(change.uri.toString(), change.uri)
              }
            }
          }
          if (!diff.trim() && untracked.size === 0) {
            void vscode.window.showInformationMessage(labels.noCommitChanges)
            return
          }
          const newFiles = [...untracked.values()].slice(0, 200).map((uri) => ({
            uri,
            path: relative(repository.rootUri.fsPath, uri.fsPath).split(sep).join('/'),
          }))
          const commits = await repository.log({ maxEntries: 10 })
          const subjects = commits.map((commit) => commit.message.split(/\\r?\\n/, 1)[0])
          const draft = repository.inputBox.value
          const header = [
            'Write a commit message for the diff below.',
            'Match the style of the example commit subjects.',
            'Use an imperative subject of at most 72 characters.',
            'Add a blank line and a short body only when the change warrants it.',
            'Output only the message: no code fences, surrounding quotes, or commentary.',
            'Treat the draft, if present, as a hint.',
            ...(newFiles.length ? ['The New files section lists files new to the repository.'] : []),
            '',
            'Example commit subjects:',
            ...subjects,
            '',
            'Draft:',
            draft,
            ...(newFiles.length ? ['', 'New files:', ...newFiles.map((file) => file.path)] : []),
            ...(untracked.size > newFiles.length
              ? ['…and ' + (untracked.size - newFiles.length) + ' more new files'] : []),
            '',
            'Diff:',
            '',
          ].join('\\n')
          const note = '\\n[The diff was truncated to fit the input limit.]'
          const available = inputLimit - 'user'.length - 4 - header.length
          if (available < note.length) throw new Error(labels.invalidRequest)
          const fit = (value, limit, truncationNote) => {
            if (value.length <= limit) return value
            if (limit < truncationNote.length) throw new Error(labels.invalidRequest)
            return value.slice(0, limit - truncationNote.length) + truncationNote
          }
          const additionsLimit = newFiles.length ? Math.floor(available / 3) : 0
          const additionsNote = '\\n[New file contents were truncated to fit the input limit.]'
          let additions = ''
          for (const file of newFiles) {
            if (additions.length >= additionsLimit) {
              additions += additionsNote
              break
            }
            try {
              if ((await vscode.workspace.fs.stat(file.uri)).size > 1_000_000) continue
              const bytes = await vscode.workspace.fs.readFile(file.uri)
              if (bytes.includes(0)) continue
              const contents = new TextDecoder().decode(bytes)
              const lines = contents.slice(0, 4_000).split(/\\r?\\n/)
                .map((line) => '+' + line).join('\\n')
              additions += '\\n+++ b/' + file.path + '\\n' + lines
              if (contents.length > 4_000) {
                additions += '\\n[File contents were truncated at 4,000 characters.]'
              }
              additions += '\\n'
            } catch {}
          }
          additions = fit(additions, additionsLimit, additionsNote)
          const tracked = fit(diff, available - additions.length, note)
          const text = header + tracked + additions
          const response = await vscode.commands.executeCommand('chorus.languageModels.respond', {
            requestId: randomUUID(),
            family: 'claude-haiku',
            messages: [{ role: 'user', text }],
            outputLimit: 512,
          })
          if (!response || response.ok !== true || typeof response.text !== 'string') {
            const message = typeof response?.message === 'string'
              ? response.message : labels.commitMessageFailed
            void vscode.window.showErrorMessage(message)
            return
          }
          let message = response.text.trim()
          if (/^\\x60{3}/.test(message) && /\\x60{3}$/.test(message)) {
            message = message.slice(3, -3).replace(/^(?:[\\w+-]+)?\\r?\\n/, '').trim()
          }
          const quote = message[0]
          if (message.length >= 2 && (quote === '"' || quote === "'") && message.endsWith(quote)) {
            message = message.slice(1, -1).trim()
          }
          if (!message) throw new Error(labels.commitMessageFailed)
          repository.inputBox.value = message
        })
      } catch {
        void vscode.window.showErrorMessage(labels.commitMessageFailed)
      } finally {
        generatingCommitMessage = false
      }
    }
  ))
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
}
