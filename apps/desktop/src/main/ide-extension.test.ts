import { describe, expect, it } from 'vitest'
import { openFileInEditor, type ExtensionDeps } from './ide-extension.js'

interface Call {
  readonly bin: string
  readonly args: readonly string[]
}

function deps(overrides: Partial<ExtensionDeps> & { calls?: Call[] } = {}): ExtensionDeps {
  const calls = overrides.calls ?? []
  return {
    findCode:
      overrides.findCode ??
      (() =>
        Promise.resolve({ file: '/usr/local/bin/code', argsPrefix: [], kind: 'native' as const })),
    exec:
      overrides.exec ??
      ((bin, args) => {
        calls.push({ bin, args })
        return Promise.resolve({ stdout: '' })
      }),
  }
}

describe('openFileInEditor', () => {
  it('goes to the file with -g, and passes it as one argument', async () => {
    const calls: Call[] = []
    await openFileInEditor("/p/my project/'; rm -rf /.ts", deps({ calls }))
    expect(calls[0]?.args).toEqual(['-g', "/p/my project/'; rm -rf /.ts"])
  })

  it('adds no window flags', async () => {
    const calls: Call[] = []
    await openFileInEditor('/p/a/src/rate.ts', deps({ calls }))
    expect(calls[0]?.args).toHaveLength(2)
  })

  it('fails cleanly with no CLI', async () => {
    const result = await openFileInEditor(
      '/p/a/src/rate.ts',
      deps({ findCode: () => Promise.resolve(null) })
    )
    expect(result).toEqual({ ok: false, reason: 'cli-missing' })
  })
})
