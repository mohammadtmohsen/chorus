export type JournalAnswer =
  | { readonly ok: true; readonly matched: boolean; readonly current: string | null }
  | { readonly ok: false }

export interface JournalBackend {
  read(): JournalAnswer
  compare(expected: string | null, next: string | null): JournalAnswer
  subscribe?: (listener: () => void) => () => void
}
