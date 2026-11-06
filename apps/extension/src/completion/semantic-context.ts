import type { Hover, Position } from 'vscode'
import { z } from 'zod'
import {
  COMPLETION_CONTEXT_CHARACTERS,
  COMPLETION_CONTEXT_SNIPPETS,
  commentPrefix,
  contextualise,
  type CompletionContextSnippet,
  type EditorReport,
} from '../../../desktop/src/shared/workbench-ipc.js'
import { abortable } from './async.js'
import type { CompletionContextHost, CompletionDocument } from './contracts.js'

const MEMBER_LIMIT = 64
const RECEIVER_LIMIT = 64
const ANCHOR_SCAN_CHARACTERS = 400
const WORD_CHARACTER = /[\p{L}\p{N}_$]/u
const RECEIVER_CHARACTER = /[\p{L}\p{N}_$[\]()?.]/u

interface MemberSite {
  readonly position: Position
  readonly receiver: string
}

interface Anchor {
  readonly position: Position
  readonly token: string
}

export interface SemanticContext {
  readonly types: string | null
  readonly members: readonly string[] | null
  readonly facts: Pick<
    EditorReport,
    'memberContext' | 'memberCount' | 'typeContext' | 'typeAnchors' | 'typeResolved'
  >
}

function memberSite(
  document: CompletionDocument,
  position: Position,
  host: CompletionContextHost
): MemberSite | null {
  const line = document.lineAt(position.line).text
  let index = position.character - 1
  while (index >= 0 && WORD_CHARACTER.test(line.charAt(index))) index -= 1
  while (index >= 0 && (line.charAt(index) === ' ' || line.charAt(index) === '\t')) index -= 1
  if (index < 0 || line.charAt(index) !== '.') return null
  if (index > 0 && line.charAt(index - 1) === '.') return null
  let start = index - 1
  while (
    start >= 0 &&
    index - start <= RECEIVER_LIMIT &&
    RECEIVER_CHARACTER.test(line.charAt(start))
  ) {
    start -= 1
  }
  const receiver = line.slice(start + 1, index)
  return receiver === '' ? null : { receiver, position: host.position(position.line, index + 1) }
}

function openParen(line: string, cursor: number, limit: number): number {
  let index = cursor
  let depth = 0
  if (line.charAt(index) === ')') {
    depth = 1
    index -= 1
  }
  while (index >= limit) {
    const character = line.charAt(index)
    if (character === ')') depth += 1
    else if (character === '(') {
      depth -= 1
      if (depth <= 0) return index
    }
    index -= 1
  }
  return -1
}

function callAnchors(
  document: CompletionDocument,
  position: Position,
  host: CompletionContextHost
): Anchor[] {
  const line = document.lineAt(position.line).text
  const cursor = position.character - 1
  if (cursor < 0) return []
  const limit = Math.max(0, cursor - ANCHOR_SCAN_CHARACTERS)
  const closed = line.charAt(cursor) === ')'
  const open = openParen(line, cursor, limit)
  if (open < 0) return []
  let end = open - 1
  while (end >= limit && (line.charAt(end) === ' ' || line.charAt(end) === '\t')) end -= 1
  let start = end
  while (start >= limit && WORD_CHARACTER.test(line.charAt(start))) start -= 1
  const callee = line.slice(start + 1, end + 1)
  if (callee === '') return []
  const anchors: Anchor[] = [{ position: host.position(position.line, start + 1), token: callee }]
  let argumentEnd = closed ? cursor - 1 : cursor
  while (
    argumentEnd > open &&
    (line.charAt(argumentEnd) === ' ' || line.charAt(argumentEnd) === '\t')
  ) {
    argumentEnd -= 1
  }
  let argumentStart = argumentEnd
  while (
    argumentStart > open &&
    argumentEnd - argumentStart < RECEIVER_LIMIT &&
    RECEIVER_CHARACTER.test(line.charAt(argumentStart))
  ) {
    argumentStart -= 1
  }
  const argument = line.slice(argumentStart + 1, argumentEnd + 1)
  const last = argument.charAt(argument.length - 1)
  if (last !== '' && last !== '.' && last !== '?') {
    anchors.push({
      position: host.position(position.line, argumentEnd),
      token: argument,
    })
  }
  return anchors
}

function hoverText(hover: Hover): string | null {
  const lines: string[] = []
  for (const content of hover.contents) {
    if (typeof content !== 'string' && 'language' in content) {
      const marked = z.object({ language: z.string(), value: z.string() }).safeParse(content)
      if (marked.success) lines.push(marked.data.value)
      continue
    }
    const text = typeof content === 'string' ? content : content.value
    const entries = text.split('\n')
    if (
      entries
        .find((line) => line.trim() !== '')
        ?.trim()
        .startsWith('```') !== true
    )
      continue
    for (const line of entries) {
      if (!line.trim().startsWith('```')) lines.push(line)
    }
  }
  const text = lines.join('\n').trim()
  return text === '' ? null : text
}

export async function collectSemanticContext(
  document: CompletionDocument,
  position: Position,
  host: CompletionContextHost,
  signal: AbortSignal
): Promise<SemanticContext> {
  const site = memberSite(document, position, host)
  const anchors = callAnchors(document, position, host)
  const [list, hovers] = await Promise.all([
    site === null
      ? Promise.resolve(null)
      : abortable(() => host.members(document.uri, site.position), signal),
    Promise.all(
      anchors.map(async (anchor) => {
        const found = await abortable(() => host.hovers(document.uri, anchor.position), signal)
        for (const hover of found ?? []) {
          const text = hoverText(hover)
          if (text !== null) return `${anchor.token}\n${text}`
        }
        return null
      })
    ),
  ])
  const names = new Set<string>()
  for (const item of list?.items ?? []) {
    if (!host.memberAllowed(item)) continue
    const name = typeof item.label === 'string' ? item.label : item.label.label
    if (name !== '') names.add(name)
    if (names.size > MEMBER_LIMIT) break
  }
  const members = names.size === 0 || names.size > MEMBER_LIMIT ? null : [...names]
  const resolved = hovers.filter((text): text is string => text !== null)
  const types = resolved.length === 0 ? null : resolved.join('\n\n')
  return {
    types,
    members,
    facts: {
      ...(site === null
        ? {}
        : { memberContext: members !== null, memberCount: members?.length ?? 0 }),
      ...(anchors.length === 0
        ? {}
        : {
            typeContext: types !== null,
            typeAnchors: anchors.length,
            typeResolved: resolved.length,
          }),
    },
  }
}

interface PackedContext {
  readonly context: readonly CompletionContextSnippet[]
  readonly types: boolean
  readonly members: number
}

export function packContext(
  languageId: string,
  semantic: SemanticContext,
  definitions: readonly CompletionContextSnippet[]
): PackedContext {
  const context: CompletionContextSnippet[] = []
  let total = 0
  const step = (): number => (context.length === 0 ? 1 : 2)
  const admit = (snippet: CompletionContextSnippet): boolean => {
    if (context.length >= COMPLETION_CONTEXT_SNIPPETS) return false
    const addition = contextualise(languageId, snippet).length + step()
    if (total + addition > COMPLETION_CONTEXT_CHARACTERS) return false
    total += addition
    context.push(snippet)
    return true
  }
  const types = semantic.types !== null && admit({ text: semantic.types, path: null })
  let members = 0
  if (semantic.members !== null) {
    const marker = commentPrefix(languageId)
    const room = COMPLETION_CONTEXT_CHARACTERS - total - step()
    let characters = 0
    const names: string[] = []
    for (const member of semantic.members) {
      const addition = (names.length === 0 ? 0 : 1) + marker.length + 1 + member.length
      if (characters + addition > room) break
      characters += addition
      names.push(member)
    }
    if (names.length > 0 && admit({ text: names.join('\n'), path: null })) members = names.length
  }
  for (const definition of definitions) admit(definition)
  return { context, types, members }
}
