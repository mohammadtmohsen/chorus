import { describe, expect, it, vi } from 'vitest'
import type { DiagnosticDocument } from '../../../vscode-extension/src/diagnostic-pick.js'
import type { EditorProject } from './types.js'
import { projectDiagnostic } from './diagnostics.js'
import { diagnosticParams } from '@chorus/ide-protocol/protocol'

const project = (id: string, root: string, host = ''): EditorProject => ({
  id,
  name: id,
  root,
  host,
  lastOpenedAt: 0,
  openConversations: 0,
  profileId: null,
  agentIds: null,
  notes: null,
  noteWidth: null,
  noteHeight: null,
  missing: false,
})

const location = {
  host: '',
  filePath: '/repo/nested/a.ts',
  provenance: { kind: 'worktree' as const },
}
const document = (over: Partial<DiagnosticDocument> = {}): DiagnosticDocument => ({
  filePath: location.filePath,
  languageId: 'typescript',
  provenance: location.provenance,
  cursor: { line: 2, character: 2 },
  diagnostics: [
    {
      severity: 'error',
      message: 'broken',
      range: { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } },
    },
  ],
  linesOf: () => 'context',
  ...over,
})

describe('diagnostic project routing', () => {
  it('serializes native VS Code ranges as protocol data rather than their array JSON form', () => {
    const range = {
      start: { line: 2, character: 1 },
      end: { line: 2, character: 4 },
      toJSON: () => [
        { line: 2, character: 1 },
        { line: 2, character: 4 },
      ],
    }
    const result = projectDiagnostic(
      [project('inner', '/repo/nested')],
      true,
      location,
      document({ diagnostics: [{ severity: 'error', message: 'native diagnostic', range }] })
    )
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(diagnosticParams.parse(JSON.parse(JSON.stringify(result.params)))).toMatchObject({
        range: { start: range.start, end: range.end },
      })
  })

  it('routes to the deepest containing project for either registration order', () => {
    const outer = project('outer', '/repo')
    const inner = project('inner', '/repo/nested')
    for (const projects of [
      [outer, inner],
      [inner, outer],
    ]) {
      expect(projectDiagnostic(projects, true, location, document())).toMatchObject({
        ok: true,
        projectId: 'inner',
        params: {
          root: inner.root,
          filePath: location.filePath,
          message: 'broken',
          text: 'context',
        },
      })
    }
  })

  it('does not read or disclose a diagnostic in a restricted workspace', () => {
    const linesOf = vi.fn(() => 'private')
    expect(
      projectDiagnostic([project('outer', '/repo')], false, location, document({ linesOf }))
    ).toEqual({ ok: false, reason: 'untrusted' })
    expect(linesOf).not.toHaveBeenCalled()
  })

  it('does not send a matching path from another host', () => {
    const linesOf = vi.fn(() => 'private')
    expect(
      projectDiagnostic(
        [project('remote', '/repo', 'office')],
        true,
        location,
        document({ linesOf })
      )
    ).toEqual({ ok: false, reason: 'outside-roots' })
    expect(linesOf).not.toHaveBeenCalled()
  })

  it('keeps the existing most-specific-diagnostic selection rule', () => {
    const found = projectDiagnostic(
      [project('outer', '/repo')],
      true,
      location,
      document({
        diagnostics: [
          {
            severity: 'error',
            message: 'whole statement',
            range: { start: { line: 1, character: 0 }, end: { line: 4, character: 0 } },
          },
          {
            severity: 'warning',
            message: 'expression',
            range: { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } },
          },
        ],
      })
    )
    expect(found).toMatchObject({
      ok: true,
      params: { severity: 'warning', message: 'expression' },
    })
  })
})
