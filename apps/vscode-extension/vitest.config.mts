import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'vscode-extension',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      /*
       * `vscode` is injected by the extension host and cannot be resolved from
       * disk, so every file that imports it would fail at import time here.
       * The stub exists only to make `extension.ts` loadable; the rules worth
       * testing live in `editor-context.ts`, which imports nothing from VS Code
       * precisely so it can be tested without any of this.
       */
      vscode: fileURLToPath(new URL('./src/test/vscode-stub.ts', import.meta.url)),
    },
  },
})
