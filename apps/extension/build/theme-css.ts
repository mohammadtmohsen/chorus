import type { CSSOptions } from 'vite'

type InlinePostcss = Exclude<NonNullable<CSSOptions['postcss']>, string>
type AcceptedPlugin = NonNullable<InlinePostcss['plugins']>[number]
type MediaCondition = boolean | string

interface Segment {
  readonly start: number
  readonly end: number
  readonly text: string
}

function topLevelSegments(source: string): Segment[] {
  const segments: Segment[] = []
  let depth = 0
  let bracket = 0
  let quote = ''
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (quote === '' && character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 1
      continue
    }
    if (quote !== '') {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (character === '[') bracket += 1
    else if (character === ']') bracket -= 1
    else if (depth === 0 && bracket === 0 && character !== undefined) {
      const previous = source[index - 1]
      if (character !== ',' && previous !== undefined && /[\w-]/.test(previous)) continue
      const separator = /^(?:,|(?:and|or)(?![\w-]))/i.exec(source.slice(index))?.[0]
      if (separator === undefined) continue
      segments.push({ start: index, end: index + separator.length, text: separator.toLowerCase() })
      index += separator.length - 1
    }
  }
  return segments
}

function splitCondition(source: string, separator: string): string[] {
  const parts: string[] = []
  let start = 0
  for (const segment of topLevelSegments(source)) {
    if (segment.text !== separator) continue
    parts.push(source.slice(start, segment.start).trim())
    start = segment.end
  }
  parts.push(source.slice(start).trim())
  return parts
}

function combineConditions(parts: MediaCondition[], operator: 'and' | 'or'): MediaCondition {
  const shortCircuit = operator === 'or'
  if (parts.includes(shortCircuit)) return shortCircuit
  const remaining = parts.filter((part): part is string => typeof part === 'string')
  return remaining.length === 0 ? !shortCircuit : remaining.join(` ${operator} `)
}

function evaluateCondition(source: string, light: boolean): MediaCondition {
  const query = source.trim()
  if (/^\(\s*prefers-color-scheme\s*:\s*light\s*\)$/i.test(query)) return light
  const queries = splitCondition(query, ',')
  if (queries.length > 1) {
    const evaluated = queries.map((part) => evaluateCondition(part, light))
    if (evaluated.includes(true)) return true
    const remaining = evaluated.filter((part): part is string => typeof part === 'string')
    return remaining.length === 0 ? false : remaining.join(', ')
  }
  const mediaModifier = /^(not|only)\s+(?=[a-z][\w-]*(?:\s|$))/i.exec(query)
  if (mediaModifier?.[1] !== undefined) {
    const condition = evaluateCondition(query.slice(mediaModifier[0].length), light)
    if (typeof condition === 'boolean') {
      return mediaModifier[1].toLowerCase() === 'not' ? !condition : condition
    }
    return `${mediaModifier[1]} ${condition}`
  }
  for (const operator of ['or', 'and'] as const) {
    const parts = splitCondition(query, operator)
    if (parts.length > 1) {
      return combineConditions(
        parts.map((part) => evaluateCondition(part, light)),
        operator
      )
    }
  }
  if (/^not\s+/i.test(query)) {
    const condition = evaluateCondition(query.replace(/^not\s+/i, ''), light)
    return typeof condition === 'boolean' ? !condition : `not ${condition}`
  }
  if (query.startsWith('(') && query.endsWith(')')) {
    const inner = query.slice(1, -1)
    const condition = evaluateCondition(inner, light)
    return typeof condition === 'boolean' ? condition : `(${condition})`
  }
  return query
}

function scopeSelector(selector: string, gate: string): string {
  let depth = 0
  let bracket = 0
  let quote = ''
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (quote === '' && character === '/' && selector[index + 1] === '*') {
      const end = selector.indexOf('*/', index + 2)
      index = end === -1 ? selector.length : end + 1
      continue
    }
    if (quote !== '') {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (character === '[') bracket += 1
    else if (character === ']') bracket -= 1
    else if (
      character === ':' &&
      depth === 0 &&
      bracket === 0 &&
      /^:(?::|(?:before|after|first-line|first-letter)(?![\w-]))/i.test(selector.slice(index))
    ) {
      return `${selector.slice(0, index)}${gate}${selector.slice(index)}`
    }
  }
  return `${selector}${gate}`
}

export function chorusThemeCss(): AcceptedPlugin {
  return {
    postcssPlugin: 'chorus-vscode-theme',
    Once(root, { Rule }) {
      type CssNode = (typeof root.nodes)[number]
      type CssAtRule = Extract<CssNode, { type: 'atrule' }>

      const scopeNodes = (nodes: readonly CssNode[], gate: string): void => {
        for (const node of nodes) {
          if (node.type === 'rule') {
            node.selectors = node.selectors.map((selector) => scopeSelector(selector, gate))
          } else if (node.type === 'atrule' && node.nodes !== undefined) {
            if (
              /keyframes$/i.test(node.name) ||
              node.nodes.some((child) => child.type === 'decl')
            ) {
              throw node.error('Theme media queries must contain style rules')
            }
            scopeNodes(node.nodes, gate)
          }
        }
      }

      const hasRuleParent = (media: CssAtRule): boolean => {
        let parent: CssNode['parent'] | typeof root.parent = media.parent
        while (parent !== undefined) {
          if (parent.type === 'rule') return true
          parent = parent.parent
        }
        return false
      }

      const mediaRules: CssAtRule[] = []
      root.walkAtRules(/^media$/i, (media) => {
        mediaRules.push(media)
      })
      for (const media of mediaRules.reverse()) {
        if (!/prefers-color-scheme\s*:\s*light/i.test(media.params) || media.nodes === undefined)
          continue
        const conditions = [true, false].map((light) => ({
          light,
          condition: evaluateCondition(media.params, light),
        }))
        if (conditions.every(({ condition }) => condition === media.params)) continue
        for (const { light, condition } of conditions) {
          if (condition === false) continue
          const clone = media.clone()
          const name = light ? 'chorus-theme-light' : 'chorus-theme-dark'
          const gate = `:where(html.${name}, html.${name} *)`
          if (hasRuleParent(media)) {
            const rule = new Rule({ selector: `&${gate}` })
            if (media.source !== undefined) rule.source = media.source
            rule.append(clone.nodes ?? [])
            clone.removeAll().append(rule)
          } else scopeNodes(clone.nodes ?? [], gate)
          if (condition === true) media.before(clone.nodes ?? [])
          else {
            clone.params = condition
            media.before(clone)
          }
        }
        media.remove()
      }
    },
  } satisfies AcceptedPlugin
}
