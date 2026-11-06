import { describe, expect, it } from 'vitest'
import {
  COMPLETION_CHARACTERS_PER_SIDE,
  COMPLETION_CONTEXT_CHARACTERS,
  assembleContext,
} from '../../../desktop/src/shared/workbench-ipc.js'
import { collectCompletionContext, completionPayload, queryPositions } from './context.js'
import { deferred, document, fixture, position, range, uri } from './fixtures.test-support.js'

describe('completion context collection', () => {
  it('keeps prefix, suffix, and assembled context within the desktop budgets', () => {
    const { host } = fixture()
    const source = document('a'.repeat(5000) + 'b'.repeat(5000))
    const snippets = [{ path: 'types.ts', text: 'declare const answer: number' }]
    const payload = completionPayload(source, position(0, 5000), snippets, host)
    const assembled = assembleContext(payload.languageId, payload.context).text

    expect(payload.prefix.length + assembled.length).toBe(COMPLETION_CHARACTERS_PER_SIDE)
    expect(payload.suffix.length).toBe(COMPLETION_CHARACTERS_PER_SIDE)
    expect(assembled.length).toBeLessThanOrEqual(COMPLETION_CONTEXT_CHARACTERS)
    expect(payload.path).toBe('main.ts')
  })

  it('never opens definition targets outside a project or on a different remote authority', async () => {
    const f = fixture('value')
    const allowed = uri('/project/types.ts', 'vscode-remote', 'ssh-remote+host')
    f.source.uri = uri('/project/main.ts', 'vscode-remote', 'ssh-remote+host')
    const span = range(position(0, 0), position(0, 35))
    f.definitions.mockResolvedValue([
      { uri: uri('/elsewhere/private.ts', 'vscode-remote', 'ssh-remote+host'), range: span },
      { uri: uri('/project/other.ts', 'vscode-remote', 'ssh-remote+other'), range: span },
      { targetUri: allowed, targetRange: span, targetSelectionRange: span },
      { uri: allowed, range: span },
    ])
    f.openDocument.mockResolvedValue(document('export interface Value { id: number }', allowed))

    const result = await collectCompletionContext(
      f.source,
      position(0, 5),
      f.host,
      new AbortController().signal
    )

    expect(f.openDocument).toHaveBeenCalledTimes(1)
    expect(f.openDocument).toHaveBeenCalledWith(allowed)
    expect(result.context).toEqual([
      { path: 'types.ts', text: 'export interface Value { id: number }' },
    ])
  })

  it('does not collect source context for an uncontained file', async () => {
    const f = fixture('value')
    f.source.uri = uri('/elsewhere/private.ts')
    const result = await collectCompletionContext(
      f.source,
      position(0, 5),
      f.host,
      new AbortController().signal
    )
    expect(result.context).toEqual([])
    expect(f.definitions).not.toHaveBeenCalled()
    expect(f.openDocument).not.toHaveBeenCalled()
  })

  it('uses bounded definition queries and discards a result collected for an older version', async () => {
    const f = fixture('one two three four five six seven eight nine ten')
    const pending = deferred<[]>()
    f.definitions.mockReturnValue(pending.promise)
    expect(queryPositions(f.source, position(0, 4), f.host)).toHaveLength(8)
    const collecting = collectCompletionContext(
      f.source,
      position(0, 4),
      f.host,
      new AbortController().signal
    )
    f.source.version += 1
    pending.resolve([])
    expect((await collecting).context).toEqual([])
    expect(
      f.definitions.mock.calls.length + f.typeDefinitions.mock.calls.length
    ).toBeLessThanOrEqual(16)
  })

  it('stops awaiting a language provider after cancellation without opening its target', async () => {
    const f = fixture('value')
    const pending = deferred<[]>()
    f.definitions.mockReturnValue(pending.promise)
    const controller = new AbortController()
    const collecting = collectCompletionContext(f.source, position(0, 5), f.host, controller.signal)
    controller.abort()

    expect((await collecting).context).toEqual([])
    expect(f.openDocument).not.toHaveBeenCalled()
  })

  it('collects available member names and call types through the injected language services', async () => {
    const member = fixture('value.')
    member.members.mockResolvedValue({
      isIncomplete: false,
      items: [{ label: 'id' }, { label: 'id' }],
    })
    const memberContext = await collectCompletionContext(
      member.source,
      position(0, 6),
      member.host,
      new AbortController().signal
    )
    expect(memberContext.context).toEqual([{ path: null, text: 'id' }])

    const type = fixture('consume(value)')
    type.hovers.mockResolvedValue([
      { contents: [{ language: 'typescript', value: 'interface Value { id: number }' }] },
    ])
    const typeContext = await collectCompletionContext(
      type.source,
      position(0, 14),
      type.host,
      new AbortController().signal
    )
    expect(typeContext.context[0]?.text).toContain('interface Value { id: number }')
    expect(typeContext.facts).toMatchObject({ typeContext: true, typeAnchors: 2, typeResolved: 2 })
  })
})
