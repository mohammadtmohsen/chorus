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
  alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
  external: ['vscode'],
})
mkdirSync(resolve(root, 'dist'), { recursive: true })
copyFileSync(resolve(root, '../engine/dist/engine.cjs'), resolve(root, 'dist/engine.cjs'))
