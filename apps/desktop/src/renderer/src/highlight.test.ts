import { describe, expect, it } from 'vitest'
import { grammarFor, highlight, type Token } from './highlight.js'

/** The kinds a snippet produced, in order, ignoring the plain glue between. */
const kinds = (tokens: Token[]): string[] =>
  tokens.filter((t) => t.kind !== 'plain').map((t) => t.kind)

const textOf = (tokens: Token[], kind: string): string[] =>
  tokens.filter((t) => t.kind === kind).map((t) => t.text)

describe('highlight', () => {
  it('never loses or invents a character', () => {
    // The whole thing has to round-trip: a highlighter that drops a byte is
    // showing you something other than what the agent said.
    const samples: [string, string][] = [
      ['const x = "hi" // note', 'ts'],
      ['rg --files | wc -l # count', 'bash'],
      ['{"a": 1, "b": [true, null]}', 'json'],
      ['def f(x):\n    return x  # ok', 'python'],
      ['+added\n-removed\n@@ -1 +1 @@', 'diff'],
      ['no language here at all', null as unknown as string],
    ]
    for (const [source, language] of samples) {
      expect(
        highlight(source, language)
          .map((t) => t.text)
          .join('')
      ).toBe(source)
    }
  })

  it('finds strings, comments and keywords in TypeScript', () => {
    const tokens = highlight('const name = "chorus" // a comment', 'ts')
    expect(kinds(tokens)).toContain('keyword')
    expect(textOf(tokens, 'string')).toEqual(['"chorus"'])
    expect(textOf(tokens, 'comment')).toEqual(['// a comment'])
  })

  it('picks out calls and properties', () => {
    const tokens = highlight('store.append(input)', 'ts')
    expect(textOf(tokens, 'function')).toEqual(['append'])
  })

  it('treats flags and variables as the landmarks of a command line', () => {
    // They are what you scan a shell line for, so they get their own hue.
    const tokens = highlight('rg --files -n "$HOME/src" # find', 'bash')
    expect(textOf(tokens, 'meta')).toEqual(['--files', '-n'])
    expect(textOf(tokens, 'string')).toEqual(['"$HOME/src"'])
    expect(textOf(tokens, 'comment')).toEqual(['# find'])
  })

  it('looks inside the shell wrapper agents run everything through', () => {
    // Taken literally the whole command is one quoted string, and the half worth
    // reading would be flat.
    const tokens = highlight(`$ /bin/zsh -lc 'rg --files | wc -l'`, 'shell')
    // Every flag, including the one in the piped command: -lc, --files and -l.
    expect(textOf(tokens, 'meta')).toEqual(['-lc', '--files', '-l'])
    expect(tokens.map((t) => t.text).join('')).toBe(`$ /bin/zsh -lc 'rg --files | wc -l'`)
    // The body is no longer one string token.
    expect(textOf(tokens, 'string')).toEqual([])
  })

  it('leaves an ordinary command alone', () => {
    const tokens = highlight('rg --files', 'shell')
    expect(textOf(tokens, 'meta')).toEqual(['--files'])
  })

  it('separates a JSON key from a JSON string value', () => {
    const tokens = highlight('{"agents": ["codex"]}', 'json')
    expect(textOf(tokens, 'property')).toEqual(['"agents"'])
    expect(textOf(tokens, 'string')).toEqual(['"codex"'])
  })

  it('colours a diff by its marker column, line at a time', () => {
    const tokens = highlight('@@ -1,2 +1,2 @@\n-old\n+new\n same\n', 'diff')
    expect(textOf(tokens, 'meta')).toEqual(['@@ -1,2 +1,2 @@\n'])
    expect(textOf(tokens, 'removed')).toEqual(['-old\n'])
    expect(textOf(tokens, 'added')).toEqual(['+new\n'])
  })

  it('handles python triple-quoted strings', () => {
    const tokens = highlight('x = """doc\nstring"""', 'python')
    expect(textOf(tokens, 'string')).toEqual(['"""doc\nstring"""'])
  })

  it('still finds strings and comments with no language given', () => {
    const tokens = highlight('value = "text" # trailing', null)
    expect(textOf(tokens, 'string')).toEqual(['"text"'])
    expect(textOf(tokens, 'comment')).toEqual(['# trailing'])
  })

  it('does not hang on an unterminated string', () => {
    // A half-typed line arrives mid-stream on every single reply.
    expect(
      highlight('echo "unclosed', 'bash')
        .map((t) => t.text)
        .join('')
    ).toBe('echo "unclosed')
    expect(
      highlight('const a = `open', 'ts')
        .map((t) => t.text)
        .join('')
    ).toBe('const a = `open')
  })

  it('merges runs rather than emitting a token per character', () => {
    const tokens = highlight('plain words with no features', 'ts')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.kind).toBe('plain')
  })

  it('maps the fence labels agents actually write', () => {
    expect(grammarFor('bash')).toBe('shell')
    expect(grammarFor('TSX')).toBe('script')
    expect(grammarFor('patch')).toBe('diff')
    expect(grammarFor('brainfuck')).toBeNull()
    expect(grammarFor(null)).toBeNull()
  })
})
