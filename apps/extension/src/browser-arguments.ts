import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { z } from 'zod'

export function enableBrowserArguments(source: string): string {
  const errors: ParseError[] = []
  const raw: unknown = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0) throw new Error('invalid-runtime-arguments')
  const current = z
    .looseObject({ 'enable-proposed-api': z.array(z.string()).optional() })
    .parse(raw)
  const enabled = current['enable-proposed-api'] ?? []
  if (enabled.includes('mohammadtmohsen.chorus')) return source
  const edits = modify(source, ['enable-proposed-api'], [...enabled, 'mohammadtmohsen.chorus'], {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  return applyEdits(source, edits)
}
