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
     * `electron` comes from the runtime, `better-sqlite3` and `node-pty` are
     * native and have to stay real files, and the Claude SDK resolves its own
     * files at runtime — so those four remain external and are shipped as
     * themselves.
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
        external: ['electron', 'better-sqlite3', 'node-pty', '@anthropic-ai/claude-agent-sdk'],
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
    /*
     * A renderer built against React's **development** runtime.
     *
     * `pnpm dev` and a production build are different React builds, and only
     * the development one double-invokes effects under `StrictMode`. That is
     * not a detail: a whole class of bug lives in the second invocation — a ref
     * that survives a disposal, a subscription attached twice, a guard that
     * reads state the first pass left behind — and none of it exists in the
     * bundle the e2e harness drives.
     *
     * It cost a real one. `MonacoDiff` rendered an empty editor in `pnpm dev`
     * and a correct one in every automated run, four probes deep, because the
     * harness only ever launched the production build. The user could see it
     * and the tests could not.
     *
     * `--mode development` alone does not do this: vite pins
     * `process.env.NODE_ENV` to `production` for any build, so React resolves
     * to its production runtime whatever the mode says. The define is the part
     * that actually switches it, and `minify: false` keeps the stack traces
     * worth reading when it does catch something.
     *
     * Off unless asked for, so nothing ships a development React by accident —
     * `pnpm --filter @chorus/desktop run build:dev` is the only way in.
     */
    ...(process.env['CHORUS_DEV_RENDERER'] === '1'
      ? {
          define: { 'process.env.NODE_ENV': JSON.stringify('development') },
          build: { minify: false as const },
        }
      : {}),
  },
})
