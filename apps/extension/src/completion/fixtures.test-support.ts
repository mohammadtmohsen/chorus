import type { CancellationToken, Position, Range, TextDocument, Uri } from 'vscode'
import { vi } from 'vitest'
import type { CompletionReply } from '../../../desktop/src/shared/workbench-ipc.js'
import type { CompletionDocument, CompletionEnvironment, CompletionPort } from './contracts.js'

export function position(line: number, character: number): Position {
  return {
    line,
    character,
    isEqual: (other: Position) => line === other.line && character === other.character,
    isBefore: (other: Position) =>
      line < other.line || (line === other.line && character < other.character),
    isBeforeOrEqual: (other: Position) =>
      line < other.line || (line === other.line && character <= other.character),
    isAfter: (other: Position) =>
      line > other.line || (line === other.line && character > other.character),
    isAfterOrEqual: (other: Position) =>
      line > other.line || (line === other.line && character >= other.character),
  } as Position
}

export function range(start: Position, end: Position): Range {
  return {
    start,
    end,
    isEmpty: start.isEqual(end),
    isSingleLine: start.line === end.line,
    contains: (value: Position) => start.isBeforeOrEqual(value) && end.isAfterOrEqual(value),
  } as Range
}

export function uri(path: string, scheme = 'file', authority = ''): Uri {
  return {
    scheme,
    authority,
    path,
    fsPath: path,
    toString: () => `${scheme}://${authority}${path}`,
  } as Uri
}

export function document(text: string, resource = uri('/project/main.ts')) {
  const lines = text.split('\n')
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  const offsetAt = (at: Position): number =>
    Math.min(text.length, (offsets[at.line] ?? text.length) + at.character)
  const positionAt = (requested: number): Position => {
    const at = Math.min(text.length, Math.max(0, requested))
    let line = lines.length - 1
    while (line > 0 && (offsets[line] ?? 0) > at) line -= 1
    return position(line, at - (offsets[line] ?? 0))
  }
  const source = {
    uri: resource,
    version: 1,
    isClosed: false,
    languageId: 'typescript',
    lineCount: lines.length,
    lineAt: (line: number | Position) => {
      const index = typeof line === 'number' ? line : line.line
      return { text: lines[index] ?? '' }
    },
    getText: (span?: Range) =>
      span === undefined ? text : text.slice(offsetAt(span.start), offsetAt(span.end)),
    offsetAt,
    positionAt,
    getWordRangeAtPosition: (at: Position): Range | undefined => {
      for (const match of (lines[at.line] ?? '').matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu)) {
        if (match.index <= at.character && match.index + match[0].length > at.character) {
          return range(
            position(at.line, match.index),
            position(at.line, match.index + match[0].length)
          )
        }
      }
      return undefined
    },
  }
  return source as typeof source & TextDocument
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

export function cancellation() {
  const callbacks = new Set<(event: unknown) => unknown>()
  const token: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: (listener) => {
      callbacks.add(listener)
      return {
        dispose: () => {
          callbacks.delete(listener)
        },
      }
    },
  }
  return {
    token,
    cancel: () => {
      Object.defineProperty(token, 'isCancellationRequested', { value: true })
      for (const callback of callbacks) callback(undefined)
    },
  }
}

export function fixture(text = 'const result = ') {
  const source = document(text)
  let active = { uri: source.uri, position: source.positionAt(text.length) }
  const configured = vi.fn(() => Promise.resolve(true))
  const request = vi.fn<CompletionPort['request']>(() =>
    Promise.resolve<CompletionReply>({ configured: true, text: 'answer' })
  )
  const report = vi.fn<NonNullable<CompletionPort['report']>>()
  const insideProject = (resource: Uri): boolean => resource.path.startsWith('/project/')
  const port: CompletionPort = { insideProject, configured, request, report }
  const definitions = vi.fn<CompletionEnvironment['definitions']>(() => Promise.resolve([]))
  const typeDefinitions = vi.fn<CompletionEnvironment['typeDefinitions']>(() => Promise.resolve([]))
  const hovers = vi.fn<CompletionEnvironment['hovers']>(() => Promise.resolve([]))
  const members = vi.fn<CompletionEnvironment['members']>(() => Promise.resolve(undefined))
  const openDocument = vi.fn((_resource: Uri): Promise<CompletionDocument> =>
    Promise.resolve(source)
  )
  const enabled = vi.fn(() => true)
  let sequence = 0
  const host: CompletionEnvironment = {
    position,
    range,
    insideProject,
    relativePath: (resource) => resource.path.slice('/project/'.length),
    definitions,
    typeDefinitions,
    hovers,
    members,
    memberAllowed: () => true,
    openDocument,
    enabled,
    activeEditor: () => active,
    requestId: () => String((sequence += 1)),
    now: () => 0,
  }
  return {
    source,
    port,
    host,
    configured,
    request,
    report,
    definitions,
    typeDefinitions,
    hovers,
    members,
    openDocument,
    enabled,
    active: () => active,
    move: (at: Position, resource = source.uri) => {
      active = { uri: resource, position: at }
    },
  }
}
