import { resolve } from 'node:path'
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
    /*
     * The workspace packages are compiled in as source, not required at runtime.
     *
     * Left as dependencies they stay `require("@chorus/orchestrator")` in the
     * output — fine under `pnpm dev`, where the workspace is on disk, and fatal
     * once packaged, where node_modules is not shipped. The app started, failed
     * that require before any logging existed, and exited silently: no window,
     * no log, no crash report.
     *
     * Neither `externalizeDepsPlugin({ exclude })` nor `ssr.noExternal` undid
     * it, because electron-vite decides externals itself. Pointing the names at
     * their sources sidesteps the question: they stop being dependencies and
     * become ordinary imports.
     *
     * `electron` comes from the runtime, `better-sqlite3` is native and has to
     * stay a real file, and the Claude SDK resolves its own files at runtime —
     * so those three remain external and are shipped as themselves.
     */
    resolve: {
      alias: Object.fromEntries(
        [
          'adapter-claude',
          'adapter-codex',
          'agent-protocol',
          'event-store',
          'orchestrator',
          'shared',
          'workspace',
        ].map((name) => [
          `@chorus/${name}`,
          resolve(__dirname, `../../packages/${name}/src/index.ts`),
        ])
      ),
    },
    build: {
      rollupOptions: {
        external: ['electron', 'better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
      },
    },
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
