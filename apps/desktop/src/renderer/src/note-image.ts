import type { NodeViewRendererProps } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import type { NodeView } from '@tiptap/pm/view'
import { resolveNoteImageUrl } from './host-resources.js'

export function createNoteImageView(
  { node, HTMLAttributes }: Pick<NodeViewRendererProps, 'node' | 'HTMLAttributes'>,
  ownerDocument: Document = document
): NodeView {
  const dom = ownerDocument.createElement('img')
  let previous = new Set<string>()
  const render = (attributes: Record<string, unknown>): void => {
    for (const key of previous) {
      if (attributes[key] === undefined || attributes[key] === null) dom.removeAttribute(key)
    }
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const raw = String(value)
      dom.setAttribute(key, key === 'src' ? resolveNoteImageUrl(raw) : raw)
    }
    const source: unknown = attributes['src']
    if (typeof source === 'string') dom.dataset['noteImageSource'] = source
    else delete dom.dataset['noteImageSource']
    previous = new Set(Object.keys(attributes))
  }
  render(HTMLAttributes)
  return {
    dom,
    update: (updated) => {
      if (updated.type !== node.type) return false
      render({ ...HTMLAttributes, ...updated.attrs })
      return true
    },
  }
}

export const NoteImage = Image.extend({
  addNodeView() {
    return (props) => createNoteImageView(props)
  },
})
