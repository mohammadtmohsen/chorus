import { build } from 'esbuild'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const names = [
  'adapter-claude',
  'adapter-codex',
  'agent-protocol',
  'event-store',
  'orchestrator',
  'shared',
  'workspace',
]
const alias = Object.fromEntries(
  names.map((name) => [
    `@chorus/${name}`,
    resolve(import.meta.dirname, `../../packages/${name}/src/index.ts`),
  ])
)
alias['@chorus/shared/process-tree'] = resolve(
  import.meta.dirname,
  '../../packages/shared/src/process-tree.ts'
)
await build({
  entryPoints: [resolve(import.meta.dirname, 'src/bootstrap.ts')],
  outfile: resolve(import.meta.dirname, 'dist/engine.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['better-sqlite3', 'node-pty'],
  alias,
  define: {
    'import.meta.url': '__chorus_import_meta_url',
    __CHORUS_APP_VERSION__: JSON.stringify(
      JSON.parse(readFileSync(resolve(import.meta.dirname, '../extension/package.json'), 'utf8'))
        .version
    ),
  },
  banner: {
    js: 'var __chorus_import_meta_url = require("node:url").pathToFileURL(__filename).href;',
  },
  plugins: [
    {
      name: 'no-electron',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, ({ importer }) => {
          throw new Error(`Electron reached the engine from ${importer}`)
        })
      },
    },
  ],
})
