import { describe, expect, it } from 'vitest'
import { editorApprovalRequest } from './editor-preview.js'

describe('editor approval preview', () => {
  it('preserves multiline replacements and trailing newlines in a range diff', () => {
    const request = editorApprovalRequest({
      path: 'src/file.ts',
      version: 7,
      range: { startLine: 3, startColumn: 2, endLine: 4, endColumn: 1 },
      patch:
        '--- a/src/file.ts\n+++ b/src/file.ts\n@@ -3,2 +3,3 @@\n-before\n-\n+after\n+second\n+',
    })
    expect(request).toMatchObject({
      baseVersion: 7,
      oldText: 'before\n',
      newText: 'after\nsecond\n',
    })
  })

  it('keeps a pure insertion empty on the original side', () => {
    const request = editorApprovalRequest({
      path: 'file.ts',
      version: 2,
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      patch: '--- a/file.ts\n+++ b/file.ts\n@@ -1,0 +1,1 @@\n+inserted',
    })
    expect(request.oldText).toBe('')
    expect(request.newText).toBe('inserted')
  })
})
