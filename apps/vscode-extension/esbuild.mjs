import { build } from 'esbuild'

/**
 * One self-contained CommonJS file, because that is what a VS Code extension
 * host loads. `@chorus/ide-protocol` and zod are bundled rather than left as
 * dependencies: the VSIX has to carry everything it needs, and the extension
 * must speak exactly the protocol version it shipped with.
 *
 * `vscode` is the one external — it is injected by the host and cannot be
 * resolved from disk.
 */
await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
})
