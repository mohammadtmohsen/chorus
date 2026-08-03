import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * electron-vite already knows the entry points (src/main, src/preload,
 * src/renderer) and emits CJS for main and preload. Overriding `build.lib` here
 * breaks its Electron-specific interop, so the config stays minimal on purpose.
 *
 * Two things that look incidental but are not:
 *  - This package is deliberately NOT `"type": "module"`. Electron's main
 *    process cannot take named imports from the CJS `electron` module under
 *    ESM, and a sandboxed preload must be CJS. The renderer is still ESM.
 *  - The `dev` and `preview` scripts run under `env -u ELECTRON_RUN_AS_NODE`.
 *    VS Code's extension host exports that variable, and it makes the Electron
 *    binary behave as plain Node — `require('electron')` returns a path string
 *    and the app dies on `app.whenReady()`.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    // zod is bundled rather than externalized: a sandboxed preload cannot
    // resolve from node_modules at runtime (plan §4.4).
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
  },
  renderer: {
    plugins: [react()],
  },
})
