import {
  LANGUAGE_MODEL_CONTRACT,
  LanguageModelCancel,
  LanguageModelRequest,
  LanguageModelResponse,
} from '../shared/language-model-ipc.js'
import type { GenerationService } from './generation-service.js'
import type { IpcRegistrar, ShellClient, ShellRequest } from './shell-client.js'

export class GenerationIpc {
  private readonly shells = new Map<string, ShellClient>()

  constructor(
    private readonly service: GenerationService,
    private readonly registrar: IpcRegistrar
  ) {
    registrar.handle('lm:generate', async (event, raw) => {
      this.requireShell(event)
      const request = LanguageModelRequest.parse(raw)
      return LanguageModelResponse.parse(await service.generate(event.sender.id, request))
    })
    registrar.handle('lm:cancel', (event, raw) => {
      this.requireShell(event)
      const request = LanguageModelCancel.parse(raw)
      service.cancel(event.sender.id, request.requestId)
      return Promise.resolve(LANGUAGE_MODEL_CONTRACT['lm:cancel'].response.parse({ ok: true }))
    })
  }

  registerShell(shell: ShellClient): void {
    this.shells.set(shell.id, shell)
  }

  releaseShell(shell: ShellClient): void {
    this.shells.delete(shell.id)
    this.service.releaseOwner(shell.id)
  }

  close(): void {
    for (const shell of this.shells.values()) this.releaseShell(shell)
    this.registrar.removeHandler('lm:generate')
    this.registrar.removeHandler('lm:cancel')
  }

  private requireShell(event: ShellRequest): void {
    const shell = this.shells.get(event.sender.id)
    if (!event.isMainFrame || shell === undefined || shell.isGone())
      throw new Error('language-model-caller-refused')
  }
}
