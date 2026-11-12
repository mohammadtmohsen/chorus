import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import {
  LANGUAGE_MODEL_CONTRACT,
  LanguageModelCancel,
  LanguageModelRequest,
  LanguageModelResponse,
} from '../../../shared/language-model-ipc.js'

export async function startLanguageModelExtension(): Promise<void> {
  const extension = registerExtension(
    {
      publisher: 'chorus',
      name: 'language-model-bridge',
      version: '1.0.0',
      engines: { vscode: '*' },
    },
    ExtensionHostKind.LocalProcess,
    { system: true }
  )
  const api = await extension.getApi()
  const commands = [
    api.commands.registerCommand('chorus.languageModels.respond', async (raw: unknown) => {
      const request = LanguageModelRequest.parse(raw)
      return LanguageModelResponse.parse(
        await window.chorusWorkbench.generateLanguageModel(request)
      )
    }),
    api.commands.registerCommand('chorus.languageModels.cancel', async (raw: unknown) => {
      const request = LanguageModelCancel.parse(raw)
      return LANGUAGE_MODEL_CONTRACT['lm:cancel'].response.parse(
        await window.chorusWorkbench.cancelLanguageModel(request)
      )
    }),
  ]
  window.addEventListener(
    'pagehide',
    () => {
      for (const command of commands) command.dispose()
    },
    { once: true }
  )
}
