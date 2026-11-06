import { describe, expect, it } from 'vitest'
import { droppedUris, hasUriDrop, localFilePath } from './drop-uris.js'

const transfer = (values: Record<string, string>) => ({
  types: Object.keys(values),
  getData: (type: string) => values[type] ?? '',
})

describe('editor file drops', () => {
  it('reads URI lists and VS Code resource objects without treating prose as a file', () => {
    const data = transfer({
      'text/uri-list': '# selection\nfile:///tmp/a%20b.ts#L3\nhttps://example.test',
      'application/vnd.code.editors': JSON.stringify([
        { resource: { scheme: 'file', path: '/tmp/b.ts' } },
      ]),
      'text/plain': 'ordinary prose',
    })
    expect(hasUriDrop(data.types)).toBe(true)
    expect(droppedUris(data)).toEqual(['file:///tmp/a%20b.ts', 'file:///tmp/b.ts'])
  })
  it('keeps remote authorities and handles Windows file paths', () => {
    expect(
      droppedUris(transfer({ resourceurls: '["vscode-remote://ssh-remote+box/work/file.ts"]' }))
    ).toEqual(['vscode-remote://ssh-remote+box/work/file.ts'])
    expect(localFilePath('file:///C:/work/file.ts')).toBe('C:/work/file.ts')
    expect(localFilePath('file://server/share/file.ts')).toBe('//server/share/file.ts')
    expect(localFilePath('vscode-remote://ssh-remote+box/work/file.ts')).toBeNull()
  })
})
