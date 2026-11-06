import type { Position, Range, Uri } from 'vscode'
import {
  COMPLETION_CHARACTERS_PER_SIDE,
  COMPLETION_PATH_LIMIT,
  COMPLETION_SNIPPET_SOURCE_CHARACTERS,
  assembleContext,
  type CompletionContextSnippet,
  type CompletionPayload,
  type EditorReport,
} from '../../../desktop/src/shared/workbench-ipc.js'
import { abortable, runBounded } from './async.js'
import type { CompletionContextHost, CompletionDocument, DefinitionLocation } from './contracts.js'
import { collectSemanticContext, packContext } from './semantic-context.js'

const QUERY_POSITION_LIMIT = 8
const SCAN_LINES = 40
const CANDIDATES_PER_SOURCE = 32
const LINE_SCAN_COLUMNS = 2000
const COLLECTION_CONCURRENCY = 4
const COLLECTION_TIMEOUT_MS = 1500
const SNIPPET_CONCURRENCY = 2
const SNIPPET_CANDIDATES = 32

export function boundedPath(path: string | null): string | null {
  return path === null ? null : path.slice(0, COMPLETION_PATH_LIMIT)
}

export function completionPayload(
  document: CompletionDocument,
  position: Position,
  context: readonly CompletionContextSnippet[],
  host: CompletionContextHost
): CompletionPayload {
  const assembled = assembleContext(document.languageId, context).text
  const budget = Math.max(0, COMPLETION_CHARACTERS_PER_SIDE - assembled.length)
  const offset = document.offsetAt(position)
  return {
    prefix: document
      .getText(host.range(document.positionAt(Math.max(0, offset - budget)), position))
      .slice(-budget),
    suffix: document
      .getText(host.range(position, document.positionAt(offset + COMPLETION_CHARACTERS_PER_SIDE)))
      .slice(0, COMPLETION_CHARACTERS_PER_SIDE),
    languageId: document.languageId,
    path: boundedPath(host.relativePath(document.uri)),
    context,
  }
}

function scanLines(
  document: CompletionDocument,
  from: number,
  to: number,
  cursor: Position,
  host: CompletionContextHost
): Position[] {
  const found: Position[] = []
  for (let line = from; line <= to && found.length < CANDIDATES_PER_SOURCE; line += 1) {
    const limit = Math.min(document.lineAt(line).text.length, LINE_SCAN_COLUMNS)
    let character = 0
    while (character < limit && found.length < CANDIDATES_PER_SOURCE) {
      const word = document.getWordRangeAtPosition(host.position(line, character))
      if (word === undefined) character += 1
      else {
        found.push(word.start)
        character = Math.max(character + 1, word.end.character + 1)
      }
    }
  }
  return found.sort((a, b) => Math.abs(a.line - cursor.line) - Math.abs(b.line - cursor.line))
}

export function queryPositions(
  document: CompletionDocument,
  position: Position,
  host: CompletionContextHost
): readonly Position[] {
  const near = scanLines(
    document,
    Math.max(0, position.line - SCAN_LINES),
    Math.min(document.lineCount - 1, position.line + SCAN_LINES),
    position,
    host
  )
  const declarations = scanLines(
    document,
    0,
    Math.min(document.lineCount - 1, SCAN_LINES - 1),
    position,
    host
  )
  const positions: Position[] = []
  const seen = new Set<string>()
  const take = (candidate: Position | undefined): boolean => {
    if (candidate === undefined || positions.length >= QUERY_POSITION_LIMIT) return false
    const key = `${String(candidate.line)}:${String(candidate.character)}`
    if (!seen.has(key)) {
      seen.add(key)
      positions.push(candidate)
    }
    return true
  }
  for (let index = 0; positions.length < QUERY_POSITION_LIMIT; index += 1) {
    const first = take(near[index])
    const second = take(declarations[index])
    if (!first && !second) break
  }
  return positions
}

function targetOf(location: DefinitionLocation): { readonly uri: Uri; readonly range: Range } {
  return 'targetUri' in location
    ? { uri: location.targetUri, range: location.targetRange }
    : location
}

export interface CollectedCompletionContext {
  readonly context: readonly CompletionContextSnippet[]
  readonly facts: Omit<EditorReport, 'requestId' | 'outcome'>
}

async function definitionSnippets(
  document: CompletionDocument,
  locations: readonly DefinitionLocation[],
  host: CompletionContextHost,
  signal: AbortSignal
): Promise<readonly CompletionContextSnippet[]> {
  const seen = new Set<string>()
  const work: (() => Promise<CompletionContextSnippet | null>)[] = []
  for (const location of locations) {
    const target = targetOf(location)
    if (
      !host.insideProject(target.uri) ||
      target.uri.scheme !== document.uri.scheme ||
      target.uri.authority !== document.uri.authority
    ) {
      continue
    }
    const key = `${target.uri.toString()}#${String(target.range.start.line)}:${String(target.range.start.character)}`
    if (seen.has(key)) continue
    seen.add(key)
    work.push(async () => {
      const source = await abortable(() => host.openDocument(target.uri), signal)
      if (source === null || source.isClosed || !host.insideProject(source.uri)) return null
      const version = source.version
      const startLine = Math.max(0, Math.min(source.lineCount - 1, target.range.start.line))
      const endLine = Math.min(source.lineCount - 1, target.range.end.line)
      const lines: string[] = []
      let characters = 0
      for (let line = startLine; line <= endLine; line += 1) {
        const text = source.lineAt(line).text.slice(0, COMPLETION_SNIPPET_SOURCE_CHARACTERS)
        lines.push(text)
        characters += text.length + 1
        if (characters > COMPLETION_SNIPPET_SOURCE_CHARACTERS) break
      }
      if (source.version !== version || signal.aborted) return null
      const text = lines.join('\n').slice(0, COMPLETION_SNIPPET_SOURCE_CHARACTERS)
      return text === '' ? null : { text, path: boundedPath(host.relativePath(target.uri)) }
    })
    if (work.length >= SNIPPET_CANDIDATES) break
  }
  const results = await runBounded(work, SNIPPET_CONCURRENCY, signal)
  return results.filter((snippet): snippet is CompletionContextSnippet => snippet !== null)
}

export async function collectCompletionContext(
  document: CompletionDocument,
  position: Position,
  host: CompletionContextHost,
  callerSignal: AbortSignal
): Promise<CollectedCompletionContext> {
  if (callerSignal.aborted || document.isClosed || !host.insideProject(document.uri)) {
    return { context: [], facts: {} }
  }
  const timeout = new AbortController()
  const timer = setTimeout(() => {
    timeout.abort()
  }, COLLECTION_TIMEOUT_MS)
  const signal = AbortSignal.any([callerSignal, timeout.signal])
  const version = document.version
  const stale = (): boolean =>
    callerSignal.aborted || document.isClosed || document.version !== version
  try {
    const work: (() => Promise<readonly DefinitionLocation[]>)[] = []
    for (const at of queryPositions(document, position, host)) {
      work.push(
        async () => (await abortable(() => host.definitions(document.uri, at), signal)) ?? [],
        async () => (await abortable(() => host.typeDefinitions(document.uri, at), signal)) ?? []
      )
    }
    const [semantic, results] = await Promise.all([
      collectSemanticContext(document, position, host, signal),
      runBounded(work, COLLECTION_CONCURRENCY, signal),
    ])
    const definitions = await definitionSnippets(document, results.flat(), host, signal)
    if (stale()) {
      return { context: [], facts: {} }
    }
    const packed = packContext(document.languageId, semantic, definitions)
    return {
      context: packed.context,
      facts: {
        ...semantic.facts,
        emptyQueries: results.filter((result) => result.length === 0).length,
        totalQueries: results.length,
        snippetPaths: definitions.map((snippet) => snippet.path),
        snippetExtents: definitions.map((snippet) => snippet.text.split('\n').length),
        memberContext: packed.members > 0,
        memberCount: packed.members,
        typeContext: packed.types,
      },
    }
  } finally {
    clearTimeout(timer)
  }
}
