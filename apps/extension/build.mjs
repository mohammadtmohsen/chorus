import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = import.meta.dirname
await build({
  entryPoints: [resolve(root, 'src/extension.ts')],
  outfile: resolve(root, 'dist/extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['vscode'],
})
await build({
  entryPoints: [resolve(root, 'src/continuous-row/page.ts')],
  outfile: resolve(root, 'dist/continuous-row.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
})
await build({
  entryPoints: [resolve(root, 'src/continuous-row/uninstall.ts')],
  outfile: resolve(root, 'dist/uninstall.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
})
mkdirSync(resolve(root, 'dist'), { recursive: true })
copyFileSync(resolve(root, '../engine/dist/engine.cjs'), resolve(root, 'dist/engine.cjs'))
