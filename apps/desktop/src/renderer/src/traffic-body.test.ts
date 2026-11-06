import { describe, expect, it } from 'vitest'
import type { TrafficBodyDescriptor } from '../../shared/traffic-ipc.js'
import { maskHeaders } from '../../shared/traffic-mask.js'
import {
  bodyView,
  bytesFromBase64,
  curlCommand,
  describeBody,
  encodedFields,
  formFields,
  hexDump,
  isForm,
  isTextual,
  jsonTree,
  prettyJson,
  previewTokens,
  queryStringOf,
  textOf,
  treeRows,
  type JsonNode,
} from './traffic-body.js'

const treeOf = (text: string): JsonNode => {
  const tree = jsonTree(text)
  if (tree === null) throw new Error(`not JSON: ${text}`)
  return tree
}

const base64 = (text: string): string => btoa(text)

const bytesOf = (...values: number[]): Uint8Array => Uint8Array.from(values)

const descriptor = (over: Partial<TrafficBodyDescriptor> = {}): TrafficBodyDescriptor => ({
  state: 'complete',
  truncation: null,
  observedBytes: 0,
  capturedBytes: 0,
  contentType: null,
  contentEncoding: null,
  decoding: 'ready',
  ...over,
})

describe('bytesFromBase64', () => {
  it('round-trips through the text it came from', () => {
    expect(textOf(bytesFromBase64(base64('{"code":"OK"}')))).toBe('{"code":"OK"}')
  })
})

describe('isTextual', () => {
  it('believes a declared content type over the bytes', () => {
    expect(isTextual('text/plain', bytesOf(0, 1, 2))).toBe(true)
    expect(isTextual('application/octet-stream', bytesFromBase64(base64('hello')))).toBe(false)
  })

  it('asks the bytes when nothing was declared', () => {
    expect(isTextual(null, bytesOf(104, 101, 108, 108, 111))).toBe(true)
    expect(isTextual(null, bytesOf(104, 0, 108))).toBe(false)
    expect(isTextual(null, bytesOf(104, 7, 108))).toBe(false)
  })

  it('takes a +json suffix as json', () => {
    expect(isTextual('application/vnd.api+json', bytesOf(123))).toBe(true)
  })
})

describe('prettyJson', () => {
  it('indents what parses and refuses what does not', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('not json')).toBeNull()
  })
})

describe('formFields', () => {
  it('keeps a repeated key rather than folding it', () => {
    expect(formFields('a=1&a=2&b=')).toEqual([
      ['a', '1'],
      ['a', '2'],
      ['b', ''],
    ])
  })

  it('is only offered when the type says so', () => {
    expect(isForm('application/x-www-form-urlencoded')).toBe(true)
    expect(isForm('application/json')).toBe(false)
  })
})

describe('queryStringOf', () => {
  it('takes the query as sent from an absolute or a relative URL, without the fragment', () => {
    expect(queryStringOf('http://h/a?sort%5B%5D=x,asc&page=1#top')).toBe('sort%5B%5D=x,asc&page=1')
    expect(queryStringOf('/a?page=1')).toBe('page=1')
  })

  it('finds nothing in a URL with no query', () => {
    expect(queryStringOf('http://h/a')).toBe('')
    expect(queryStringOf('http://h/a#x?y=1')).toBe('')
  })
})

describe('encodedFields', () => {
  it('keeps every occurrence in order, exactly as it was sent', () => {
    expect(encodedFields('sort%5B%5D=a%20b&sort%5B%5D=c&flag&empty=&&x=1=2')).toEqual([
      ['sort%5B%5D', 'a%20b'],
      ['sort%5B%5D', 'c'],
      ['flag', ''],
      ['empty', ''],
      ['x', '1=2'],
    ])
  })
})

describe('hexDump', () => {
  it('shows offsets, bytes and the printable run', () => {
    const dump = hexDump(bytesOf(65, 66, 0))
    expect(dump.startsWith('00000000  41 42 00')).toBe(true)
    expect(dump.endsWith('AB.')).toBe(true)
  })
})

describe('maskHeaders', () => {
  it('hides a credential and leaves everything else alone', () => {
    const masked = maskHeaders(
      [
        ['authorization', 'Bearer secret-token'],
        ['accept', 'application/json'],
      ],
      false
    )
    expect(masked[0]?.[1]).not.toContain('secret-token')
    expect(masked[1]?.[1]).toBe('application/json')
  })

  it('shows them again when the person asks', () => {
    expect(maskHeaders([['authorization', 'Bearer x']], true)[0]?.[1]).toBe('Bearer x')
  })

  it('does not mask an empty value, which hides nothing anyway', () => {
    expect(maskHeaders([['cookie', '']], false)[0]?.[1]).toBe('')
  })
})

describe('jsonTree', () => {
  it('reads one, and refuses anything JSON.parse refuses', () => {
    expect(jsonTree('{"a": 1}')).not.toBeNull()
    expect(jsonTree('not json')).toBeNull()
    expect(jsonTree('')).toBeNull()
  })

  it('keeps an object in the order the wire had it', () => {
    const tree = jsonTree('{"b": 1, "a": 2}')
    expect(tree?.kind).toBe('object')
    expect(tree?.kind === 'object' ? tree.entries.map(([key]) => key) : []).toEqual(['b', 'a'])
  })

  it('quotes a string and leaves the other scalars bare', () => {
    const tree = jsonTree('{"s": "x", "n": 1.5, "t": true, "z": null}')
    const entries = tree?.kind === 'object' ? tree.entries : []
    expect(entries.map(([, node]) => (node.kind === 'value' ? node.text : ''))).toEqual([
      '"x"',
      '1.5',
      'true',
      'null',
    ])
    expect(entries.map(([, node]) => (node.kind === 'value' ? node.scalar : ''))).toEqual([
      'string',
      'number',
      'boolean',
      'null',
    ])
  })
})

describe('treeRows', () => {
  const tree = treeOf('{"a": {"deep": 1}, "list": [1, 2]}')

  it('draws the contents, never the object that holds them', () => {
    expect(treeRows(tree, new Set()).map((row) => row.path)).toEqual([
      '',
      '/0',
      '/0/0',
      '/0/>',
      '/1',
      '/1/0',
      '/1/1',
      '/1/>',
      '/>',
    ])
  })

  it('hides what a collapsed node holds, and only that', () => {
    const rows = treeRows(tree, new Set(['/0']))
    expect(rows.map((row) => row.path)).toEqual(['', '/0', '/1', '/1/0', '/1/1', '/1/>', '/>'])
    expect(rows[1]?.expanded).toBe(false)
    expect(rows[1]?.expandable).toBe(true)
  })

  it('calls an empty container and every leaf unexpandable', () => {
    const rows = treeRows(treeOf('{"empty": {}, "leaf": 1}'), new Set())
    expect(rows.filter((row) => row.delimiter === null).map((row) => row.expandable)).toEqual([
      false,
      false,
    ])
  })

  it('opens and closes every container on rows of its own, folded ones included', () => {
    const delimiters = (collapsed: ReadonlySet<string>): readonly (string | null)[] =>
      treeRows(tree, collapsed)
        .filter((row) => row.delimiter !== null)
        .map((row) => row.delimiter)
    expect(delimiters(new Set())).toEqual(['{', '}', ']', '}'])
    expect(delimiters(new Set(['/0']))).toEqual(['{', ']', '}'])
  })

  it('still draws something when the contents are all there is not', () => {
    expect(treeRows(treeOf('[]'), new Set()).map((row) => row.delimiter)).toEqual(['[', ']'])
    expect(treeRows(treeOf('"bare"'), new Set()).map((row) => row.path)).toEqual([''])
  })

  it('labels a member of an array by position', () => {
    const rows = treeRows(treeOf('["x"]'), new Set()).filter((row) => row.delimiter === null)
    expect(rows[0]?.label).toBe('[0]')
  })
})

describe('previewTokens', () => {
  const text = (tokens: readonly { text: string }[]): string =>
    tokens.map((token) => token.text).join('')

  it('draws a container on one line, with the first few of its contents', () => {
    expect(text(previewTokens(treeOf('{"a": 1, "b": 2, "c": 3, "d": 4}')))).toBe(
      '{a: 1, b: 2, c: 3, …}'
    )
  })

  it('stops at a nested container rather than reading into it', () => {
    expect(text(previewTokens(treeOf('{"a": {"b": 1, "c": 2}}')))).toBe('{a: {…}}')
    expect(text(previewTokens(treeOf('{"a": [1, 2], "b": 3}')))).toBe('{a: […], b: 3}')
  })

  it('closes an empty one without a comma or an ellipsis', () => {
    expect(text(previewTokens(treeOf('{"a": {}, "b": []}')))).toBe('{a: {}, b: []}')
  })

  it('colours a key apart from its value', () => {
    expect(previewTokens(treeOf('{"a": "x"}')).map((token) => token.kind)).toEqual([
      'punct',
      'key',
      'punct',
      'string',
      'punct',
    ])
  })
})

describe('bodyView', () => {
  it('renders text as it came, and formats it when asked', () => {
    const bytes = bytesFromBase64(base64('{"a":1}'))
    expect(bodyView(bytes, descriptor({ contentType: 'application/json' }), 'raw').text).toBe(
      '{"a":1}'
    )
    expect(bodyView(bytes, descriptor({ contentType: 'application/json' }), 'formatted').text).toBe(
      '{\n  "a": 1\n}'
    )
  })

  it('falls back to hex for a body that is not text, and says why', () => {
    const rendered = bodyView(bytesOf(0, 255, 1), descriptor(), 'raw')
    expect(rendered.note).toBe('binary')
    expect(rendered.text.startsWith('00000000  00 ff 01')).toBe(true)
  })

  it('shows hex when hex was asked for, whatever the type says', () => {
    const rendered = bodyView(
      bytesFromBase64(base64('ab')),
      descriptor({ contentType: 'text/plain' }),
      'hex'
    )
    expect(rendered.note).toBeNull()
    expect(rendered.text.startsWith('00000000  61 62')).toBe(true)
  })
})

describe('describeBody', () => {
  it('reports the most specific thing it knows first', () => {
    expect(describeBody(descriptor({ truncation: 'body-limit' }))).toBe('body-limit')
    expect(describeBody(descriptor({ decoding: 'unsupported' }))).toBe('unsupported')
    expect(describeBody(descriptor({ state: 'aborted' }))).toBe('aborted')
    expect(describeBody(descriptor())).toBeNull()
  })
})

describe('curlCommand', () => {
  const login = {
    method: 'POST',
    url: 'http://88.99.104.107:30081/api/v1/auth/login',
    headers: [
      ['host', '192.168.1.15:30100'],
      ['content-type', 'application/json'],
      ['authorization', 'Bearer abc'],
      ['content-length', '20'],
      ['accept-encoding', 'gzip'],
    ] as const,
    body: '{"username":"Admin"}',
  }

  it('sends every header the app sent except the ones curl sets itself', () => {
    expect(curlCommand(login)).toBe(
      [
        'curl -X POST http://88.99.104.107:30081/api/v1/auth/login',
        "-H 'content-type: application/json'",
        "-H 'authorization: Bearer abc'",
        '--compressed',
        `--data-raw '{"username":"Admin"}'`,
      ].join(' \\\n  ')
    )
  })

  it('quotes a single quote so bash reads the body back unchanged', () => {
    expect(curlCommand({ ...login, headers: [], body: '{"name":"O\'Brien"}' })).toContain(
      `--data-raw '{"name":"O'\\''Brien"}'`
    )
  })

  it('sends no body flag when there is no body', () => {
    expect(curlCommand({ ...login, method: 'GET', headers: [], body: '' })).toBe(
      'curl -X GET http://88.99.104.107:30081/api/v1/auth/login'
    )
  })
})
