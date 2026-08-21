/**
 * Vite's `?worker` import, declared rather than pulled in from `vite/client`.
 *
 * `tsconfig.web.json` sets `"types": []` deliberately — it keeps ambient
 * globals out of the renderer — and `vite/client` would bring the whole set
 * back to describe one suffix. The suffix turns a module into a constructor
 * that builds a **bundled, same-origin** worker, which is the only form Monaco
 * can use under `sandbox: true` and `webSecurity: true`: its own documentation
 * suggests a `blob:` URL or a CDN, and both are what those flags exist to
 * refuse.
 *
 * Its own file, and that is not a style choice — a wildcard module declaration
 * has to sit in a file with no top-level `import` or `export`, or TypeScript
 * reads it as an attempt to augment a module that does not exist. `env.d.ts`
 * imports `ChorusApi`, so it cannot host this.
 */
declare module '*?worker' {
  const workerConstructor: new () => Worker
  export default workerConstructor
}
