import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = import.meta.dirname
const target = resolve(root, 'dist/development')
mkdirSync(resolve(target, 'dist'), { recursive: true })
rmSync(resolve(target, 'dist/engine.cjs'), { force: true })
rmSync(resolve(target, 'node_modules'), { recursive: true, force: true })
const manifest = {
  ...JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')),
  name: 'chorus',
}
delete manifest.scripts
delete manifest.devDependencies
writeFileSync(resolve(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
cpSync(resolve(root, 'package.nls.json'), resolve(target, 'package.nls.json'))
for (const name of ['extension.cjs', 'continuous-row.js', 'webview'])
  cpSync(resolve(root, 'dist', name), resolve(target, 'dist', name), { recursive: true })
