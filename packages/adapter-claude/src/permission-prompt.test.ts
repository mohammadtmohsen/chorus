import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ApprovalId } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { mapToolPermission } from './mapping.js'

/**
 * The third argument to `canUseTool` used to be dropped on the floor.
 *
 * It carries the sentence the CLI already rendered, the path that triggered the
 * request, why it triggered, and — the part with teeth — the set of rules that
 * would stop it asking again. Without handing that set back there is no
 * protocol-correct "always allow": Chorus stops asking and the CLI does not.
 */

const CTX = { seq: 1, now: 1_000, approvalTtlMs: 60_000 }
const ID = 'ap-1' as ApprovalId

describe('what the provider said', () => {
  it('carries the sentence, the reason and the blocked path', () => {
    expect(
      mapToolPermission('Bash', { command: 'cat ../secrets' }, CTX, ID, {
        title: 'Claude wants to run cat ../secrets',
        description: 'Reads a file outside the project',
        decisionReason: 'Outside the allowed directories',
        blockedPath: '/etc/secrets',
      })
    ).toMatchObject({
      kind: 'command',
      title: 'Claude wants to run cat ../secrets',
      description: 'Reads a file outside the project',
      decisionReason: 'Outside the allowed directories',
      blockedPath: '/etc/secrets',
    })
  })

  it('leaves out what the provider did not say', () => {
    // Absent must stay absent: the renderer falls back to its own summary on
    // absence, and an empty string is not an answer.
    const request = mapToolPermission('Bash', { command: 'ls' }, CTX, ID, { title: '' })
    expect(request).not.toHaveProperty('title')
    expect(request).not.toHaveProperty('decisionReason')
  })

  it('needs no prompt at all, since older CLIs send none', () => {
    expect(mapToolPermission('Bash', { command: 'ls' }, CTX, ID)).toMatchObject({ kind: 'command' })
  })

  it('reaches every kind of request, not only commands', () => {
    for (const [tool, input] of [
      ['Edit', { file_path: '/repo/a.ts' }],
      ['mcp__slack__send', { channel: '#eng' }],
      ['Task', { description: 'explore' }],
    ] as const) {
      expect(mapToolPermission(tool, input, CTX, ID, { title: 'said' })).toMatchObject({
        title: 'said',
      })
    }
  })
})

/**
 * The decision going back the other way. Exercised through the shape the
 * adapter builds rather than through a live session, because what matters is
 * which fields are set for which button.
 */
function resultFor(
  scope: 'once' | 'session',
  suggestions: unknown[] | undefined
): PermissionResult {
  const always = scope === 'session' ? suggestions : undefined
  return {
    behavior: 'allow',
    updatedInput: {},
    ...(always === undefined || always.length === 0 ? {} : { updatedPermissions: always as never }),
    decisionClassification: scope === 'session' ? 'user_permanent' : 'user_temporary',
  }
}

describe('answering with the provider’s own rules', () => {
  it('hands the whole suggestion set back for "always"', () => {
    const result = resultFor('session', [{ type: 'addRules', destination: 'session' }])
    expect(result).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addRules', destination: 'session' }],
      decisionClassification: 'user_permanent',
    })
  })

  it('writes no rule for "just this once"', () => {
    // The entire difference between the two buttons.
    const result = resultFor('once', [{ type: 'addRules', destination: 'session' }])
    expect(result).not.toHaveProperty('updatedPermissions')
    expect(result).toMatchObject({ decisionClassification: 'user_temporary' })
  })

  it('omits the field when the provider suggested nothing', () => {
    expect(resultFor('session', undefined)).not.toHaveProperty('updatedPermissions')
    expect(resultFor('session', [])).not.toHaveProperty('updatedPermissions')
  })
})
