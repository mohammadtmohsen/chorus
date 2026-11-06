import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSchema } from '@tiptap/core'
import { DOMSerializer } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { configureHostResources, resolveNoteImageUrl } from './host-resources.js'
import { NoteImage } from './note-image.js'

afterEach(() => {
  configureHostResources()
})

describe('note image host resources', () => {
  it('keeps desktop URLs unchanged and maps only stored note resources', () => {
    const source = 'chorus-note://image/image.png'
    expect(resolveNoteImageUrl(source)).toBe(source)
    const resolve = vi.fn(() => 'https://webview.invalid/image.png')
    configureHostResources({ noteImageUrl: resolve })
    expect(resolveNoteImageUrl(source)).toBe('https://webview.invalid/image.png')
    expect(resolveNoteImageUrl('https://example.com/image.png')).toBe(
      'https://example.com/image.png'
    )
    expect(resolve).toHaveBeenCalledExactlyOnceWith(source)
  })

  it('retains the stored URL when a note is edited and serialized', () => {
    const source = 'chorus-note://image/image.png'
    configureHostResources({ noteImageUrl: () => 'https://webview.invalid/image.png' })
    const schema = getSchema([StarterKit, NoteImage])
    const document = schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: source, alt: 'note image' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'edited' }] },
      ],
    })
    expect(resolveNoteImageUrl(source)).not.toBe(source)
    const image = document.firstChild
    if (image === null) throw new Error()
    const serialize = DOMSerializer.fromSchema(schema).nodes['image']
    if (serialize === undefined) throw new Error()
    expect(serialize(image)).toEqual(
      expect.arrayContaining([expect.objectContaining({ src: source })])
    )
    expect(JSON.stringify(document.toJSON())).toContain(source)
    expect(JSON.stringify(document.toJSON())).not.toContain('webview.invalid')
  })
})
