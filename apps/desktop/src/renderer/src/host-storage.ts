export interface HostStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const browserStorage: HostStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => {
    window.localStorage.setItem(key, value)
  },
}

export let hostStorage = browserStorage

export function configureHostStorage(storage: HostStorage = browserStorage): void {
  hostStorage = storage
}
