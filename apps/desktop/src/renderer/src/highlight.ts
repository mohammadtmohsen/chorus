/**
 * A small syntax highlighter producing typed tokens, never markup.
 *
 * Same reasoning as the markdown parser next door: agent output is untrusted
 * input, so nothing here emits an HTML string for anyone to inject into. It
 * returns tokens and the renderer turns them into React elements, which makes
 * injection impossible by construction rather than by filtering (plan §4.4).
 *
 * It covers what agents actually put in fenced blocks — shell, TypeScript and
 * JavaScript, JSON, Python, and diffs — with a generic fallback for everything
 * else that still finds strings, numbers and comments. An unknown language
 * degrades to plain text, which is the safe direction to fail.
 *
 * Deliberately not a dependency. A full highlighter is a large grammar engine
 * running over text an agent produced; this is a hundred lines that can be read
 * in one sitting, and the failure mode of a missed token is a word in the wrong
 * colour.
 */

export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'function'
  | 'property'
  | 'operator'
  | 'meta'
  | 'added'
  | 'removed'

export interface Token {
  readonly kind: TokenKind
  readonly text: string
}

interface Rule {
  readonly kind: TokenKind
  /** Sticky, so it can only match at the cursor rather than anywhere ahead. */
  readonly pattern: RegExp
}

const rule = (kind: TokenKind, source: string): Rule => ({ kind, pattern: new RegExp(source, 'y') })

/** Strings, in the three quote styles, tolerating escapes and running to EOL. */
const STRINGS = [
  rule('string', String.raw`"(?:[^"\\\n]|\\.)*"?`),
  rule('string', String.raw`'(?:[^'\\\n]|\\.)*'?`),
  rule('string', String.raw`\`(?:[^\`\\]|\\.)*\`?`),
]

const NUMBER = rule(
  'number',
  String.raw`\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:e[-+]?\d+)?)\b`
)

const SCRIPT_KEYWORDS =
  'as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|is|keyof|let|new|of|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|var|void|while|yield|true|false|null|undefined'

const PYTHON_KEYWORDS =
  'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|True|False|None'

/** Commands worth recognising by name; the rest read as plain words. */
const SHELL_BUILTINS =
  'cd|echo|export|source|set|unset|read|test|exit|return|local|alias|pushd|popd|if|then|else|elif|fi|for|while|do|done|case|esac|function|in'

type Grammar = 'shell' | 'script' | 'json' | 'python' | 'generic'

const GRAMMARS: Record<Grammar, readonly Rule[]> = {
  shell: [
    rule('comment', String.raw`#[^\n]*`),
    ...STRINGS,
    // A flag is the part of a command line you scan for, so it gets its own hue.
    rule('meta', String.raw`(?<=\s)--?[\w-]+`),
    // $VAR and ${VAR}, the other thing you scan a script for.
    rule('property', String.raw`\$\{[^}\n]*\}|\$\w+`),
    rule('keyword', String.raw`\b(?:${SHELL_BUILTINS})\b`),
    NUMBER,
    rule('operator', String.raw`[|&;<>()]{1,2}`),
  ],
  script: [
    rule('comment', String.raw`//[^\n]*|/\*[\s\S]*?\*/`),
    ...STRINGS,
    rule('keyword', String.raw`\b(?:${SCRIPT_KEYWORDS})\b`),
    // Named before the paren, which is how a reader picks calls out of a line.
    rule('function', String.raw`\b[A-Za-z_$][\w$]*(?=\s*\()`),
    rule('property', String.raw`(?<=\.)[A-Za-z_$][\w$]*`),
    NUMBER,
    rule('operator', String.raw`=>|[=!<>+\-*/%&|^~?:]+`),
  ],
  json: [
    rule('property', String.raw`"(?:[^"\\\n]|\\.)*"(?=\s*:)`),
    ...STRINGS,
    rule('keyword', String.raw`\b(?:true|false|null)\b`),
    NUMBER,
    rule('operator', String.raw`[:,]`),
  ],
  python: [
    rule('comment', String.raw`#[^\n]*`),
    rule('string', String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''`),
    ...STRINGS,
    rule('keyword', String.raw`\b(?:${PYTHON_KEYWORDS})\b`),
    rule('function', String.raw`\b[A-Za-z_][\w]*(?=\s*\()`),
    rule('property', String.raw`(?<=\.)[A-Za-z_]\w*`),
    NUMBER,
    rule('operator', String.raw`[=!<>+\-*/%&|^~]+`),
  ],
  generic: [rule('comment', String.raw`//[^\n]*|#[^\n]*|/\*[\s\S]*?\*/`), ...STRINGS, NUMBER],
}

/** Names agents actually write on a fence. */
const ALIASES: Record<string, Grammar | 'diff'> = {
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell',
  terminal: 'shell',
  js: 'script',
  jsx: 'script',
  javascript: 'script',
  ts: 'script',
  tsx: 'script',
  typescript: 'script',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  python: 'python',
  diff: 'diff',
  patch: 'diff',
}

/** Resolves a fence label to a grammar, or null when there is nothing to add. */
export function grammarFor(language: string | null): Grammar | 'diff' | null {
  if (language === null) return null
  return ALIASES[language.toLowerCase()] ?? null
}

export function highlight(code: string, language: string | null): Token[] {
  const grammar = grammarFor(language)
  if (grammar === 'diff') return highlightDiff(code)
  if (grammar === 'shell') return highlightShell(code)

  return tokenize(code, GRAMMARS[grammar ?? 'generic'])
}

/**
 * `/bin/zsh -lc '…'` is how both agents run everything, and taken literally the
 * whole command is one quoted string — the half worth reading, flat and
 * uncoloured. So the wrapper is tokenised as itself and the body tokenised again
 * as shell, which is what it is.
 */
const WRAPPED = /^(\s*\$?\s*\S*sh\s+-\w*c\s+)(['"])([\s\S]*)\2(\s*)$/

function highlightShell(code: string): Token[] {
  const wrapped = WRAPPED.exec(code)
  if (wrapped === null) return tokenize(code, GRAMMARS.shell)

  const [, prefix = '', quote = "'", inner = '', tail = ''] = wrapped
  return merge([
    ...tokenize(prefix, GRAMMARS.shell),
    { kind: 'operator', text: quote },
    ...tokenize(inner, GRAMMARS.shell),
    { kind: 'operator', text: quote },
    ...(tail === '' ? [] : [{ kind: 'plain' as const, text: tail }]),
  ])
}

/**
 * Line-oriented, because that is what a diff is. The marker column carries the
 * whole meaning, so the line takes its colour rather than its contents.
 */
function highlightDiff(code: string): Token[] {
  const tokens: Token[] = []
  for (const line of code.split(/(?<=\n)/)) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      tokens.push({ kind: 'meta', text: line })
    } else if (line.startsWith('+')) {
      tokens.push({ kind: 'added', text: line })
    } else if (line.startsWith('-')) {
      tokens.push({ kind: 'removed', text: line })
    } else {
      tokens.push({ kind: 'plain', text: line })
    }
  }
  return merge(tokens)
}

/**
 * Walks the source once, trying each rule at the cursor.
 *
 * A character no rule claims is consumed as plain and merged with its
 * neighbours, so the output is a short list of runs rather than one token per
 * character.
 */
function tokenize(code: string, rules: readonly Rule[]): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < code.length) {
    let matched = false
    for (const { kind, pattern } of rules) {
      pattern.lastIndex = i
      const found = pattern.exec(code)
      // A zero-length match would spin forever; treat it as no match.
      if (found === null || found[0] === '') continue
      tokens.push({ kind, text: found[0] })
      i += found[0].length
      matched = true
      break
    }
    if (!matched) {
      tokens.push({ kind: 'plain', text: code[i] ?? '' })
      i += 1
    }
  }

  return merge(tokens)
}

function merge(tokens: readonly Token[]): Token[] {
  const out: Token[] = []
  for (const token of tokens) {
    const last = out[out.length - 1]
    if (last?.kind === token.kind) {
      out[out.length - 1] = { kind: token.kind, text: last.text + token.text }
    } else {
      out.push(token)
    }
  }
  return out
}
