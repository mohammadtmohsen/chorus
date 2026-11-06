export interface ShellClient {
  readonly id: string
  send(channel: string, payload: unknown): void
  isGone(): boolean
  onGone(listener: () => void): () => void
}

export interface ShellRequest {
  readonly sender: ShellClient
  readonly isMainFrame: boolean
}

export interface IpcRegistrar {
  handle(channel: string, handler: (event: ShellRequest, raw: unknown) => Promise<unknown>): void
  removeHandler(channel: string): void
}
