export const READ_PREVIEW_SELECTION = String.raw`(() => {
  const frame = document.getElementById('active-frame')
  const doc = frame?.contentDocument
  const win = frame?.contentWindow
  const data = doc?.getElementById('vscode-markdown-preview-data')
  if (!doc || !win || !data) return null
  const { source } = JSON.parse(data.getAttribute('data-settings') ?? '{}')
  if (typeof source !== 'string') return null
  const markers = Array.from(doc.querySelectorAll('.code-line[data-line]'))
  const lineOf = (marker) => Number(marker.getAttribute('data-line'))
  const sentinel = markers[markers.length - 1]
  const lineCount = sentinel === undefined ? 1 : Math.max(1, lineOf(sentinel))
  const display = (line) => Math.min(line + 1, lineCount)
  const atViewportTop = () => {
    const above = markers.filter((marker) => marker.getBoundingClientRect().top <= 0)
    const top =
      above[above.length - 1] ??
      (doc.querySelector('.frontmatter, .frontmatter-error') === null ? markers[0] : undefined)
    const line = display(top === undefined ? 0 : lineOf(top))
    return { source, text: '', startLine: line, endLine: line }
  }
  const selection = win.getSelection()
  const text = selection?.toString() ?? ''
  if (text.trim() === '' || selection.rangeCount === 0) return atViewportTop()
  const range = selection.getRangeAt(0)
  const ancestor = range.commonAncestorContainer
  const root = ancestor.nodeType === 1 ? ancestor : ancestor.parentNode
  const walker = doc.createTreeWalker(root, 4)
  let first = null
  let last = null
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue
    const from = node === range.startContainer ? range.startOffset : 0
    const to = node === range.endContainer ? range.endOffset : node.length
    if (node.data.slice(from, to).trim() === '') continue
    const marker =
      node.parentElement?.closest('.code-line[data-line]') ??
      markers.filter((candidate) => candidate.compareDocumentPosition(node) & 4).pop()
    const line = marker === undefined ? 0 : lineOf(marker)
    first = first === null ? line : Math.min(first, line)
    last = last === null ? line : Math.max(last, line)
  }
  if (first === null || last === null) return atViewportTop()
  const next = markers.find((marker) => lineOf(marker) > last)
  return {
    source,
    text,
    startLine: display(first),
    endLine: next === undefined ? display(last) : lineOf(next),
  }
})()`
