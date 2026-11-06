import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { noNodeBuiltins } from '../desktop/build/no-node-builtins.mjs'
import { chorusThemeCss } from './build/theme-css.js'

export default defineConfig({
  base: './',
  publicDir: false,
  css: { postcss: { plugins: [chorusThemeCss()] } },
  plugins: [
    react(),
    noNodeBuiltins,
    {
      name: 'chorus-extension-no-workbench',
      moduleParsed(module) {
        if (
          /[/\\](?:@codingame|monaco-editor)[/\\]|[/\\]renderer[/\\]src[/\\]workbench[/\\]/.test(
            module.id
          )
        )
          throw new Error(`Workbench module reached the webview: ${module.id}`)
      },
    },
  ],
  build: {
    chunkSizeWarningLimit: 2000,
    outDir: 'dist/webview',
    emptyOutDir: true,
    manifest: true,
    cssCodeSplit: false,
    rollupOptions: { input: resolve(import.meta.dirname, 'src/webview/main.ts') },
  },
})
