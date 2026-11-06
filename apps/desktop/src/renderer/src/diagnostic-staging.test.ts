import { describe, expect, it, vi } from 'vitest'
import { DiagnosticStaging } from './diagnostic-staging.js'

const diagnostic = {
  conversationId: 'nested',
  relativePath: 'file.ts',
  languageId: 'typescript',
  severity: 'error' as const,
  message: 'problem',
  startLine: 1,
  endLine: 1,
  text: 'broken',
}

describe('diagnostic staging across project switches', () => {
  it('keeps a diagnostic while its conversation is unmounted and delivers it exactly once on mount', () => {
    const queue = new DiagnosticStaging()
    const other = vi.fn()
    queue.subscribe('outer', other)
    queue.stage(diagnostic)
    expect(other).not.toHaveBeenCalled()
    const insert = vi.fn()
    const stop = queue.subscribe('nested', insert)
    expect(insert).toHaveBeenCalledExactlyOnceWith(diagnostic)
    stop()
    const remounted = vi.fn()
    queue.subscribe('nested', remounted)
    expect(remounted).not.toHaveBeenCalled()
  })

  it('inserts directly into a mounted conversation and holds later problems across its unmount', () => {
    const queue = new DiagnosticStaging()
    const insert = vi.fn()
    const stop = queue.subscribe('nested', insert)
    queue.stage(diagnostic)
    stop()
    queue.stage({ ...diagnostic, message: 'next problem' })
    expect(insert).toHaveBeenCalledExactlyOnceWith(diagnostic)
    const next = vi.fn()
    queue.subscribe('nested', next)
    expect(next).toHaveBeenCalledExactlyOnceWith({ ...diagnostic, message: 'next problem' })
  })
})
