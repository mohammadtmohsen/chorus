import type { ChorusApi } from '../../shared/ipc.js'

declare global {
  interface Window {
    /** The only bridge to the main process. Injected by the preload script. */
    readonly chorus: ChorusApi
  }
}

export {}
