import type { TrafficBodyDescriptor } from '../../shared/traffic-ipc.js'
import { quotePath } from './attach.js'

export type BodyView = 'raw' | 'formatted' | 'hex'

/** What a body is rendered as, and whether that needed a decision. */
export interface BodyText {
  readonly text: string
  /** `binary` when the bytes are not text and a hex dump was substituted. */
  readonly note: 'binary' | null
}

const TEXTUAL =
  /^(text\/|application\/(json|xml|x-www-form-urlencoded|javascript|graphql)|[a-z-]+\/[a-z0-9.+-]*\+json|[a-z-]+\/[a-z0-9.+-]*\+xml)/i

export const bytesFromBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export const textOf = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: false }).decode(bytes)

/**
 * Whether to read a body as text, by what it says it is and then by what it is.
 *
 * **The content type wins when it says something**, because a `text/plain`
 * header on bytes that happen to contain a zero is still a declaration and
 * overriding it would surprise the person who set it. With no content type at
 * all the bytes are asked directly: JSON served without a type is common, and a
 * hex dump of it answers nothing.
 */
export const isTextual = (contentType: string | null, bytes: Uint8Array): boolean => {
  const declared = (contentType ?? '').trim()
  if (declared !== '') return TEXTUAL.test(declared)
  for (const byte of bytes.subarray(0, 256)) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) return false
  }
  return true
}

export const prettyJson = (text: string): string | null => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return null
  }
}

export type JsonScalar = 'string' | 'number' | 'boolean' | 'null'

export type JsonNode =
  | { readonly kind: 'object'; readonly entries: readonly (readonly [string, JsonNode])[] }
  | { readonly kind: 'array'; readonly items: readonly JsonNode[] }
  | { readonly kind: 'value'; readonly scalar: JsonScalar; readonly text: string }

const scalarOf = (value: unknown): { readonly scalar: JsonScalar; readonly text: string } => {
  if (typeof value === 'string') return { scalar: 'string', text: JSON.stringify(value) }
  if (typeof value === 'number') return { scalar: 'number', text: String(value) }
  if (typeof value === 'boolean') return { scalar: 'boolean', text: String(value) }
  return { scalar: 'null', text: 'null' }
}

const nodeOf = (value: unknown): JsonNode => {
  if (Array.isArray(value)) return { kind: 'array', items: value.map(nodeOf) }
  if (value !== null && typeof value === 'object') {
    return {
      kind: 'object',
      entries: Object.entries(value as Record<string, unknown>).map(
        ([key, each]) => [key, nodeOf(each)] as const
      ),
    }
  }
  return { kind: 'value', ...scalarOf(value) }
}

export const jsonTree = (text: string): JsonNode | null => {
  try {
    return nodeOf(JSON.parse(text))
  } catch {
    return null
  }
}

export interface TreeRow {
  readonly path: string
  readonly node: JsonNode
  readonly depth: number
  readonly label: string | null
  readonly expandable: boolean
  readonly expanded: boolean
  readonly delimiter: '{' | '[' | '}' | ']' | null
}

const childrenOf = (node: JsonNode): number =>
  node.kind === 'value' ? 0 : node.kind === 'array' ? node.items.length : node.entries.length

export const treeRows = (root: JsonNode, collapsed: ReadonlySet<string>): readonly TreeRow[] => {
  const rows: TreeRow[] = []

  const walk = (node: JsonNode, path: string, depth: number, label: string | null): void => {
    const expandable = childrenOf(node) > 0
    const expanded = expandable && !collapsed.has(path)
    rows.push({ path, node, depth, label, expandable, expanded, delimiter: null })
    if (!expanded) return
    if (node.kind === 'object') {
      node.entries.forEach(([key, child], index) => {
        walk(child, `${path}/${String(index)}`, depth + 1, key)
      })
    } else if (node.kind === 'array') {
      node.items.forEach((child, index) => {
        walk(child, `${path}/${String(index)}`, depth + 1, `[${String(index)}]`)
      })
    }
    rows.push({
      path: `${path}/>`,
      node,
      depth,
      label: null,
      expandable: false,
      expanded: false,
      delimiter: node.kind === 'array' ? ']' : '}',
    })
  }

  const bare = (path: string, delimiter: '{' | '[' | '}' | ']'): void => {
    rows.push({
      path,
      node: root,
      depth: 0,
      label: null,
      expandable: false,
      expanded: false,
      delimiter,
    })
  }

  if (root.kind === 'value') {
    walk(root, '', 0, null)
    return rows
  }
  bare('', root.kind === 'array' ? '[' : '{')
  if (root.kind === 'array') {
    root.items.forEach((child, index) => {
      walk(child, `/${String(index)}`, 1, `[${String(index)}]`)
    })
  } else {
    root.entries.forEach(([key, child], index) => {
      walk(child, `/${String(index)}`, 1, key)
    })
  }
  bare('/>', root.kind === 'array' ? ']' : '}')
  return rows
}

export interface TreeToken {
  readonly text: string
  readonly kind: 'key' | JsonScalar | 'punct'
}

const PREVIEW_ENTRIES = 3
const PREVIEW_DEPTH = 1

const compactToken = (node: JsonNode, depth: number, tokens: TreeToken[]): void => {
  if (node.kind === 'value') {
    tokens.push({ text: node.text, kind: node.scalar })
    return
  }
  const open = node.kind === 'array' ? '[' : '{'
  const close = node.kind === 'array' ? ']' : '}'
  const count = childrenOf(node)
  tokens.push({ text: open, kind: 'punct' })
  if (count > 0) {
    if (depth >= PREVIEW_DEPTH) {
      tokens.push({ text: '…', kind: 'punct' })
    } else {
      if (node.kind === 'array') {
        node.items.slice(0, PREVIEW_ENTRIES).forEach((each, index) => {
          if (index > 0) tokens.push({ text: ', ', kind: 'punct' })
          compactToken(each, depth + 1, tokens)
        })
      } else {
        node.entries.slice(0, PREVIEW_ENTRIES).forEach(([key, each], index) => {
          if (index > 0) tokens.push({ text: ', ', kind: 'punct' })
          tokens.push({ text: key, kind: 'key' }, { text: ': ', kind: 'punct' })
          compactToken(each, depth + 1, tokens)
        })
      }
      if (count > PREVIEW_ENTRIES) tokens.push({ text: ', …', kind: 'punct' })
    }
  }
  tokens.push({ text: close, kind: 'punct' })
}

export const previewTokens = (node: JsonNode): readonly TreeToken[] => {
  const tokens: TreeToken[] = []
  compactToken(node, 0, tokens)
  return tokens
}

export const isForm = (contentType: string | null): boolean =>
  (contentType ?? '').toLowerCase().includes('x-www-form-urlencoded')

export const formFields = (text: string): readonly (readonly [string, string])[] => {
  const fields: (readonly [string, string])[] = []
  for (const [name, value] of new URLSearchParams(text)) fields.push([name, value])
  return fields
}

export const encodedFields = (text: string): readonly (readonly [string, string])[] =>
  text
    .split('&')
    .filter((part) => part !== '')
    .map((part): readonly [string, string] => {
      const at = part.indexOf('=')
      return at === -1 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)]
    })

export const queryStringOf = (url: string): string => {
  const [beforeFragment = ''] = url.split('#', 1)
  const start = beforeFragment.indexOf('?')
  return start === -1 ? '' : beforeFragment.slice(start + 1)
}

const PRINTABLE_FROM = 32
const PRINTABLE_TO = 126

export const hexDump = (bytes: Uint8Array, limit = 4_096): string => {
  const lines: string[] = []
  const shown = bytes.subarray(0, Math.min(limit, bytes.length))
  for (let offset = 0; offset < shown.length; offset += 16) {
    const chunk = shown.subarray(offset, offset + 16)
    const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(chunk, (byte) =>
      byte >= PRINTABLE_FROM && byte <= PRINTABLE_TO ? String.fromCharCode(byte) : '.'
    ).join('')
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`)
  }
  return lines.join('\n')
}

const SET_BY_CURL = new Set(['host', 'content-length', 'content-encoding', 'accept-encoding'])

export const curlCommand = (request: {
  readonly method: string
  readonly url: string
  readonly headers: readonly (readonly [string, string])[]
  readonly body: string
}): string => {
  const parts = [`curl -X ${quotePath(request.method)} ${quotePath(request.url)}`]
  for (const [name, value] of request.headers) {
    if (SET_BY_CURL.has(name.toLowerCase())) continue
    parts.push(`-H ${quotePath(`${name}: ${value}`)}`)
  }
  if (request.headers.some(([name]) => name.toLowerCase() === 'accept-encoding')) {
    parts.push('--compressed')
  }
  if (request.body !== '') parts.push(`--data-raw ${quotePath(request.body)}`)
  return parts.join(' \\\n  ')
}

export const bodyView = (
  bytes: Uint8Array,
  descriptor: TrafficBodyDescriptor,
  view: BodyView
): BodyText => {
  if (view === 'hex') return { text: hexDump(bytes), note: null }
  if (!isTextual(descriptor.contentType, bytes)) return { text: hexDump(bytes), note: 'binary' }
  const text = textOf(bytes)
  if (view === 'formatted') {
    const pretty = prettyJson(text)
    if (pretty !== null) return { text: pretty, note: null }
  }
  return { text, note: null }
}

/** What the viewer is told about a page it is looking at, in one line. */
export const describeBody = (descriptor: TrafficBodyDescriptor): string | null => {
  if (descriptor.truncation !== null) return descriptor.truncation
  if (descriptor.decoding === 'unsupported') return 'unsupported'
  if (descriptor.decoding === 'invalid') return 'invalid'
  if (descriptor.decoding === 'limit') return 'limit'
  if (descriptor.state === 'evicted') return 'evicted'
  if (descriptor.state === 'aborted') return 'aborted'
  return null
}
