import type { ShellHostMessage } from './shared/webview-protocol.js'

const LATEST = new Set([
  'agents:limits',
  'agents:context',
  'agents:tasks',
  'ide:context',
  'conversation:note',
  'conversation:activity',
  'conversations:changed',
])

function latestKey(message: ShellHostMessage): string | null {
  if (message.kind === 'state' || message.kind === 'boot') return message.kind
  if (message.kind !== 'push' || !LATEST.has(message.channel)) return null
  const payload = message.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return message.channel
  const record = payload as Record<string, unknown>
  const part = (key: string): string => (typeof record[key] === 'string' ? record[key] : '')
  return `${message.channel}:${part('conversationId')}:${part('agentId')}:${part('projectId')}`
}

export class ShellMessageQueue {
  private readonly messages = new Map<string, { message: ShellHostMessage; bytes: number }>()
  private nextId = 0
  private bytes = 0
  recover = false

  constructor(
    private readonly limit = 512,
    private readonly byteLimit = 8 * 1024 * 1024
  ) {}

  add(message: ShellHostMessage): void {
    if (this.recover) return
    const key = latestKey(message) ?? `message:${String(++this.nextId)}`
    const previous = this.messages.get(key)
    const bytes = Buffer.byteLength(JSON.stringify(message))
    this.bytes += bytes - (previous?.bytes ?? 0)
    this.messages.set(key, { message, bytes })
    if (this.messages.size > this.limit || this.bytes > this.byteLimit) {
      this.messages.clear()
      this.bytes = 0
      this.recover = true
    }
  }

  take(): ShellHostMessage[] {
    const messages = [...this.messages.values()].map((item) => item.message)
    this.messages.clear()
    this.bytes = 0
    return messages
  }

  clear(): void {
    this.messages.clear()
    this.bytes = 0
    this.recover = false
  }
}
