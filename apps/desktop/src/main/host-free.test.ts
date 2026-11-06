import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

function forbiddenImports(entry: string, renderer = false): string[] {
  const found = new Set<string>()
  const seen = new Set<string>()
  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue
      if (node.moduleSpecifier === undefined || !ts.isStringLiteral(node.moduleSpecifier)) continue
      if (ts.isImportDeclaration(node)) {
        if (node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue
        const bindings = node.importClause?.namedBindings
        if (
          node.importClause?.name === undefined &&
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.every((part) => part.isTypeOnly)
        )
          continue
      } else if (
        node.isTypeOnly ||
        (node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.every((part) => part.isTypeOnly))
      )
        continue
      const name = node.moduleSpecifier.text
      if (name === 'electron') found.add(`${file}: ${name}`)
      if (renderer && name.startsWith('@codingame/')) found.add(`${file}: ${name}`)
      const target = ts.resolveModuleName(
        name,
        file,
        { moduleResolution: ts.ModuleResolutionKind.Bundler },
        ts.sys
      ).resolvedModule
      if (target === undefined || target.resolvedFileName.endsWith('.d.ts')) continue
      const path = realpathSync(target.resolvedFileName)
      if (renderer && path.includes('/renderer/src/workbench/')) found.add(`${file}: ${path}`)
      if (!path.includes('/node_modules/')) visit(path)
    }
  }
  visit(resolve(here, entry))
  return [...found]
}

describe('host-free entry points', () => {
  it.each([
    'runtime.ts',
    'ipc-handlers.ts',
    'traffic-ipc.ts',
    'console-ipc.ts',
    'run-ipc.ts',
    'browser-ipc.ts',
    'browser-console.ts',
    'project-service.ts',
  ])('loads %s without Electron', (entry) => {
    expect(forbiddenImports(entry)).toEqual([])
  })

  it('mounts the shared renderer without Electron or Code-OSS', () => {
    expect(forbiddenImports('../renderer/src/mount-app.tsx', true)).toEqual([])
  })
})
