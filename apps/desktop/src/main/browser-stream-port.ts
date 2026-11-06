import type { ShellClient } from './shell-client.js'
import type { BrowserInputEvent, BrowserStreamRequest } from '../shared/browser-ipc.js'

export interface BrowserStreamPort {
  stream(owner: ShellClient, request: BrowserStreamRequest): void
  ack(owner: ShellClient, browserId: string, instance: string, generation: number, serial: number): void
  input(owner: ShellClient, browserId: string, event: BrowserInputEvent): Promise<void>
  selection(owner: ShellClient, browserId: string): Promise<string>
  release(owner: ShellClient): void
}
