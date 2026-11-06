import type { DiagnosticPush } from '../../shared/ipc.js'

export class DiagnosticStaging {
  private readonly waiting = new Map<string, DiagnosticPush[]>()
  private readonly listeners = new Map<string, Set<(diagnostic: DiagnosticPush) => void>>()

  stage(diagnostic: DiagnosticPush): void {
    const listeners = this.listeners.get(diagnostic.conversationId)
    if (listeners !== undefined && listeners.size > 0) {
      for (const listener of listeners) listener(diagnostic)
      return
    }
    const held = this.waiting.get(diagnostic.conversationId) ?? []
    this.waiting.set(diagnostic.conversationId, [...held, diagnostic].slice(-64))
  }

  subscribe(conversationId: string, listener: (diagnostic: DiagnosticPush) => void): () => void {
    const listeners = this.listeners.get(conversationId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(conversationId, listeners)
    const pending = this.waiting.get(conversationId) ?? []
    this.waiting.delete(conversationId)
    for (const diagnostic of pending) listener(diagnostic)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(conversationId)
    }
  }
}

export const diagnosticStaging = new DiagnosticStaging()
