import { isBuiltin } from 'node:module'
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
export const noNodeBuiltins: Plugin = {
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

