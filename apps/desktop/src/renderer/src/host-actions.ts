export interface AdoptedProject {
  readonly id: string
  readonly created: boolean
}

export function requestBrowserTools(): void {
  window.dispatchEvent(new Event('chorus:enable-browser'))
}

const listeners = new Set<(project: AdoptedProject) => void>()
const pending: AdoptedProject[] = []

export function onHostProjectAdopted(listener: (project: AdoptedProject) => void): () => void {
  listeners.add(listener)
  queueMicrotask(() => {
    if (!listeners.has(listener)) return
    for (const project of pending.splice(0)) listener(project)
  })
  return () => {
    listeners.delete(listener)
  }
}

export function hostProjectAdopted(project: AdoptedProject): void {
  if (listeners.size === 0) {
    pending.push(project)
    return
  }
  for (const listener of listeners) listener(project)
}

const reconnectedListeners = new Set<() => void>()

export function onHostReconnected(listener: () => void): () => void {
  reconnectedListeners.add(listener)
  return () => {
    reconnectedListeners.delete(listener)
  }
}

export function hostReconnected(): void {
  for (const listener of reconnectedListeners) listener()
}
