import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * A Node built-in reaching renderer code is a build failure, not a substitution.
 *
 * **Vite's default is the dangerous one.** Asked to bundle `node:path` for the
 * browser it does not fail — it substitutes `__vite-browser-external`, which is
 * `module.exports = {}`. Every import still resolves, every function still
 * exists, and the property access inside one returns `undefined`. So the
 * breakage is not at the boundary; it is wherever the value is first used, as a
 * `TypeError` with no mention of a module or a bundler.
 *
 * That is not hypothetical. `@chorus/ide-protocol`'s `paths.ts` imported
 * `node:path` for its `sep` and `isAbsolute`, which was correct for the two Node
 * consumers it was written for and silently fatal in the third. `hasRoot` threw
 * for every `git:` and `gl-review:` document, which is the left side of every
 * SCM diff and both sides of every GitLab merge request; the throw happened
 * inside a VS Code `Emitter` listener, which routes to `onUnexpectedError`, so
 * nothing reached Chorus's log. Selections stopped reaching agents for days and
 * the only evidence was the *absence* of a push.
 *
 * **`resolveId` rather than a scan of the output**, because the generated
 * identifier is Vite's business and may change, and because failing at the
 * import is what names the file that did it. The bundle check below is defence
 * in depth for the same reason a belt is worn with braces — it costs nothing and
 * catches a substitution that arrives by some route this hook does not see.
 *
 * Renderer only. Main and the preloads are Node by definition.
 */
const noNodeBuiltins: Plugin = {
  name: 'chorus:no-node-builtins-in-renderer',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!isBuiltin(source)) return null
    throw new Error(
      `${source} is a Node built-in and cannot be bundled into the renderer.\n` +
        `  imported by: ${importer ?? '(entry)'}\n` +
        `Vite would substitute an empty object here rather than failing, so the ` +
        `error would surface as an unrelated TypeError at runtime. If the module ` +
        `is shared with main, split the browser-safe part out — see ` +
        `packages/ide-protocol's subpath exports.`
    )
  },
  generateBundle(_options, bundle) {
    for (const [fileName, chunk] of Object.entries(bundle)) {
      if (chunk.type !== 'chunk') continue
      if (!chunk.code.includes('__vite_browser_external')) continue
      throw new Error(
        `${fileName} contains Vite's browser-external stub, which means a Node ` +
          `built-in was replaced by an empty object. Find the import and remove it.`
      )
    }
  },
}

/**
 * VS Code injects its own stylesheets, and Vite has to hand them over as text
 * rather than inject them itself.
 *
 * `?inline` makes a CSS import resolve to a string, which is what the workbench's
 * own style plumbing expects. Without it Vite appends the rules to whichever
 * document it chooses and the workbench renders unstyled — which at a review gate
 * is indistinguishable from not rendering at all.
 *
 * Narrowed to `@codingame/monaco-vscode*` deliberately. The library's own demo
 * plugin also matches `monaco-editor`, and this repository ships real
 * `monaco-editor` under the shell's `MonacoDiff`; nothing there asks for a
 * string, so its CSS keeps Vite's ordinary handling.
 */
const vscodeCssAsString: Plugin = {
  name: 'chorus:vscode-css-as-string',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    const resolved = await this.resolve(source, importer, options)
    if (resolved === null) return undefined
    if (!/node_modules\/@codingame\/monaco-vscode.*\.css$/.test(resolved.id)) return undefined
    return { ...resolved, id: `${resolved.id}?inline` }
  },
}

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
     *
     * **`ide-protocol` is deliberately absent from this list**, and both builds
     * therefore resolve it — barrel and subpaths alike — through its `dist/`,
     * via the `exports` map its package declares. That is what makes the
     * browser-safe subpaths a real boundary rather than an alias anyone could
     * bypass, and the cost is that `dist/` has to exist and be current: a build
     * against a stale one packages code nobody wrote today, which is worse than
     * a build that fails. So the root's `app:install` and `e2e` scripts run
     * `turbo run build --filter=@chorus/desktop^...` first; `package` already
     * went through `turbo run build`. `pnpm dev` still does not, which is
     * tolerable only because it is interactive and the person watching it is
     * the person who just edited the package.
     */
    resolve: {
      alias: {
        '@chorus/shared/process-tree': resolve(
          __dirname,
          '../../packages/shared/src/process-tree.ts'
        ),
        ...Object.fromEntries(
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
    },
    build: {
      rollupOptions: {
        external: ['electron', 'better-sqlite3', 'node-pty', '@anthropic-ai/claude-agent-sdk'],
      },
    },
  },
  preload: {
    // zod is bundled rather than externalized: a sandboxed preload cannot
    // resolve from node_modules at runtime (plan §4.4). It applies to both
    // entries below, which matters: the workbench preload validates too.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      rollupOptions: {
        /*
         * Stated, not inherited, and it is not belt and braces.
         *
         * electron-vite externalizes `electron` through the `build.lib` config it
         * writes for a preload; declaring `input` takes precedence over `lib` and
         * that externalization goes with it. Rollup then resolves `electron` to
         * `node_modules/electron/index.js` — the **dev helper whose
         * `module.exports` is the path to the Electron binary** — and bundles it,
         * so `contextBridge` reads off a string. Verified by reading the emitted
         * chunk rather than inferred.
         */
        external: ['electron'],
        /*
         * Two preloads, because a workbench surface must never be handed
         * `window.chorus` (preflight §4.1b).
         *
         * The trap is that declaring `input` **replaces** electron-vite's default
         * `<root>/src/preload/{index|preload}.ts` rather than extending it. The
         * existing entry has to be listed by name, under the key `index`, or
         * `main/index.ts`'s `join(__dirname, '../preload/index.js')` resolves to
         * a file the build no longer emits — a shell window with no
         * `window.chorus` at all, from a change that looks like it was about the
         * workbench. Output names follow input keys, which is what keeps that
         * path correct.
         */
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          workbench: resolve(__dirname, 'src/preload/workbench.ts'),
          browser: resolve(__dirname, 'src/preload/browser.ts'),
        },
        /*
         * And the output has to be restated too, which the preflight did not
         * predict and which is worse than what it did.
         *
         * electron-vite builds a preload through `build.lib` — `formats: ['cjs']`
         * and `entryFileNames: '[name].js'`. Declaring `input` takes precedence
         * over `lib`, so the lib config stops applying and Rollup falls back to
         * its own defaults: ESM, named `[name].mjs`. Observed, not reasoned —
         * `out/preload/index.mjs` opened with
         * `import { _ as require_electron } from "./chunks/…"`.
         *
         * Both halves are fatal and neither says so. `main/index.ts` loads
         * `../preload/index.js`, which no longer exists, so the shell gets no
         * `window.chorus` at all; and a sandboxed preload cannot be ESM anyway,
         * so even the right path would not have run. This is the loud failure
         * §4.3 warned about, arriving in a form that looks like a build detail.
         */
        output: {
          format: 'cjs' as const,
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          /*
           * And no chunks at all, which is the part that has to be enforced
           * rather than hoped for.
           *
           * A sandboxed preload can `require` only what Electron hands it —
           * observed, from the app's own console: `Unable to load preload
           * script: …/out/preload/index.js` / `Error: module not found:
           * ./chunks/workbench-ipc-CCkEpa_4.js`, and a shell with no
           * `window.chorus`. Rollup emits a shared chunk for any module two
           * entries both reach, so with two preloads that is one accidental
           * import away, permanently.
           *
           * `preload/workbench.ts` therefore imports nothing from our own source
           * at runtime, and `electron` is external above — so the only module two
           * entries reach is one Rollup does not emit. `chunkFileNames` is kept
           * anyway, because the point of a name is to be recognisable in the
           * output when someone adds the import that reintroduces it.
           */
        },
      },
    },
  },
  renderer: {
    plugins: [
      react(),
      /*
       * VS Code injects its own stylesheets, and Vite must hand them over as
       * text rather than inject them itself.
       *
       * `?inline` makes a CSS import resolve to a string, which is what the
       * workbench's own style plumbing expects. Without it Vite appends the
       * rules to whichever document it feels like and VS Code renders unstyled.
       *
       * Narrowed to `@codingame/monaco-vscode*` deliberately. The library's own
       * demo also matches `monaco-editor`, and this repository ships real
       * `monaco-editor` under the shell's `MonacoDiff` — whose CSS must keep
       * Vite's ordinary handling, since nothing there asks for a string.
       */
      vscodeCssAsString,
      noNodeBuiltins,
    ],
    /*
     * The workbench's own document, as a second HTML entry in the same build.
     *
     * Preflight §4.3 left it open whether a second input could work at all or
     * whether the workbench needed its own build, because monaco-vscode-api
     * documents an alias of `monaco-editor` to `@codingame/monaco-vscode-editor-api`
     * and a `resolve.alias` is global to a Vite build — which would have swapped
     * the Monaco under the shell's existing diff editor. Read out of the
     * installed 36.1.1 rather than out of the docs: no `@codingame/*` **runtime**
     * file imports a bare `monaco-editor` or a bare `vscode`; both names occur
     * only in `.d.ts` files. So there is no alias here at all, the question does
     * not arise, and one build serves both entries.
     */
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          workbench: resolve(__dirname, 'src/renderer/workbench.html'),
        },
      },
      // VS Code's ESM build uses top-level await and modern syntax throughout.
      target: 'esnext',
      // Spread rather than `: undefined`, which `exactOptionalPropertyTypes`
      // refuses — and rightly, since an explicit undefined is not the same as an
      // absent key to the code reading it.
      ...(process.env['CHORUS_DEV_RENDERER'] === '1' ? { minify: false as const } : {}),
    },
    // The textmate and language-detection workers are ES modules.
    worker: { format: 'es' as const },
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
     *
     * `minify` is set on the `build` object above rather than in a spread, which
     * it used to be. A spread would replace the whole `build` key — including the
     * two-entry `rollupOptions.input` — so the workbench's HTML entry would stop
     * being emitted in exactly the build that exists to catch StrictMode bugs.
     */
    ...(process.env['CHORUS_DEV_RENDERER'] === '1'
      ? { define: { 'process.env.NODE_ENV': JSON.stringify('development') } }
      : {}),
  },
})
