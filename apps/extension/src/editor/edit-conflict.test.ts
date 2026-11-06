import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchEditRequest } from '../../../desktop/src/shared/workbench-ipc.js'
import { editConflict, type EditDocument } from './edit-conflict.js'

const request = (over: Partial<WorkbenchEditRequest> = {}): WorkbenchEditRequest => ({
  requestId: 'request',
  path: 'src/a.ts',
  baseVersion: 7,
  range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
  oldText: 'old',
  newText: 'new',
  ...over,
})

const document = (over: Partial<EditDocument> = {}): EditDocument => ({
  version: 7,
  lineCount: 2,
  lineText: () => 'old text',
  rangeText: () => 'old',
  ...over,
})

describe('live edit conflict decisions', () => {
  it('refuses a stale model before reading a range', () => {
    const rangeText = vi.fn(() => 'old')
    expect(editConflict(document({ version: 8, rangeText }), request())).toBe('version')
    expect(rangeText).not.toHaveBeenCalled()
  })

  it('refuses a stale expected string even when the model version matches', () => {
    expect(editConflict(document({ rangeText: () => 'someone typed' }), request())).toBe('text')
  })

  it('accepts an exact range and text against the current version', () => {
    expect(editConflict(document(), request())).toBeNull()
  })

  it.each([
    { startLine: 0, startColumn: 1, endLine: 1, endColumn: 4 },
    { startLine: 1, startColumn: 0, endLine: 1, endColumn: 4 },
    { startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 },
    { startLine: 2, startColumn: 1, endLine: 1, endColumn: 1 },
    { startLine: 1, startColumn: 4, endLine: 1, endColumn: 2 },
    { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 },
    { startLine: 1, startColumn: 10, endLine: 2, endColumn: 1 },
    { startLine: 1.5, startColumn: 1, endLine: 2, endColumn: 1 },
    { startLine: 1, startColumn: 1, endLine: 2, endColumn: Number.POSITIVE_INFINITY },
  ])('rejects an invalid range without relying on VS Code to clamp it: %j', (range) => {
    const rangeText = vi.fn(() => 'old')
    expect(editConflict(document({ rangeText }), request({ range }))).toBe('range')
    expect(rangeText).not.toHaveBeenCalled()
  })

  it('allows an insertion exactly after the last character', () => {
    expect(
      editConflict(
        document({ rangeText: () => '' }),
        request({
          range: { startLine: 2, startColumn: 9, endLine: 2, endColumn: 9 },
          oldText: '',
        })
      )
    ).toBeNull()
  })

  it('compares multiline text including its original line endings', () => {
    const oldText = 'one\r\ntwo'
    const range = { startLine: 1, startColumn: 1, endLine: 2, endColumn: 4 }
    expect(
      editConflict(
        document({
          lineText: () => 'one',
          rangeText: () => oldText,
        }),
        request({ range, oldText })
      )
    ).toBeNull()
    expect(
      editConflict(
        document({
          lineText: () => 'one',
          rangeText: () => 'one\ntwo',
        }),
        request({ range, oldText })
      )
    ).toBe('text')
  })
})
