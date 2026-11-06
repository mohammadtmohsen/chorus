import type {
  CompletionList,
  Hover,
  Location,
  LocationLink,
  Position,
  Range,
  TextDocument,
  Uri,
} from 'vscode'
import type {
  CompletionPayload,
  CompletionReply,
  EditorReport,
} from '../../../desktop/src/shared/workbench-ipc.js'

export interface CompletionPort {
  insideProject(uri: Uri): boolean
  configured(): Promise<boolean>
  request(
    requestId: string,
    payload: CompletionPayload,
    signal: AbortSignal
  ): Promise<CompletionReply>
  report?(report: EditorReport): void
  relativePath?(uri: Uri): string | null
  snoozed?(): boolean
}

export type CompletionDocument = Pick<
  TextDocument,
  | 'uri'
  | 'languageId'
  | 'version'
  | 'isClosed'
  | 'lineCount'
  | 'lineAt'
  | 'offsetAt'
  | 'positionAt'
  | 'getText'
  | 'getWordRangeAtPosition'
>

export type DefinitionLocation = Location | LocationLink

export interface CompletionContextHost {
  position(line: number, character: number): Position
  range(start: Position, end: Position): Range
  insideProject(uri: Uri): boolean
  relativePath(uri: Uri): string | null
  definitions(uri: Uri, position: Position): Promise<readonly DefinitionLocation[] | undefined>
  typeDefinitions(uri: Uri, position: Position): Promise<readonly DefinitionLocation[] | undefined>
  hovers(uri: Uri, position: Position): Promise<readonly Hover[] | undefined>
  members(uri: Uri, position: Position): Promise<CompletionList | undefined>
  memberAllowed(item: CompletionList['items'][number]): boolean
  openDocument(uri: Uri): Promise<CompletionDocument>
}

export interface CompletionEnvironment extends CompletionContextHost {
  enabled(document: CompletionDocument): boolean
  activeEditor(): { readonly uri: Uri; readonly position: Position } | null
  requestId(): string
  now(): number
}
