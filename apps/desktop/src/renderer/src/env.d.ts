import type { ChorusApi, DesktopShellApi } from '../../shared/ipc.js'
import type { ChorusWorkbenchApi } from '../../shared/workbench-ipc.js'
import type { ChorusToastApi } from '../../shared/toast-window-ipc.js'

declare global {
  interface Window {
    /** The only bridge to the main process. Injected by the preload script. */
    readonly chorus: ChorusApi
    readonly chorusDesktop?: DesktopShellApi
    readonly chorusToasts: ChorusToastApi
    /**
     * The workbench surface's bridge, and its whole surface is one method.
     *
     * These two are mutually exclusive at runtime and TypeScript cannot say so:
     * one `Window` interface covers both documents. `window.chorus` exists only
     * in the shell (`index.html`, `preload/index.js`) and `window.chorusWorkbench`
     * only in a surface (`workbench.html`, `preload/workbench.js`). A surface
     * reaching for `window.chorus` typechecks and is `undefined` — which the
     * containment gate asserts, because that assertion is what proves the shell's
     * preload did not follow the view.
     */
    readonly chorusWorkbench: ChorusWorkbenchApi
  }
}

export {}
