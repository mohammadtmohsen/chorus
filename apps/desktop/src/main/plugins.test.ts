import { describe, expect, it } from 'vitest'
import { parsePlugins } from './plugins.js'

/** One real row, copied from `claude plugin list --json` on this machine. */
const REAL = JSON.stringify([
  {
    id: 'frontend-design@claude-plugins-official',
    version: 'unknown',
    scope: 'user',
    enabled: true,
    installPath: '/Users/x/.claude/plugins/cache/claude-plugins-official/frontend-design/unknown',
    installedAt: '2026-03-24T16:13:34.742Z',
    lastUpdated: '2026-08-08T21:20:15.829Z',
  },
])

describe('parsePlugins', () => {
  it('reads what the CLI actually prints', () => {
    expect(parsePlugins(REAL)).toEqual([
      {
        id: 'frontend-design@claude-plugins-official',
        name: 'frontend-design',
        enabled: true,
        scope: 'user',
      },
    ])
  })

  /*
   * The CLI reports "unknown" more often than it reports a version, and a row
   * reading "Version: unknown" is worse than one that says nothing.
   */
  it('drops an unknown version rather than showing the word', () => {
    expect(parsePlugins(REAL)[0]).not.toHaveProperty('version')
    const withVersion = parsePlugins(JSON.stringify([{ id: 'a@b', version: '1.2.0' }]))
    expect(withVersion[0]).toMatchObject({ version: '1.2.0' })
  })

  it('keeps a disabled plugin, which is the one worth seeing', () => {
    expect(parsePlugins(JSON.stringify([{ id: 'a@b', enabled: false }]))[0]).toMatchObject({
      name: 'a',
      enabled: false,
    })
  })

  /*
   * This is another program's output. A release that renames a key should cost
   * a row, never an exception inside the settings sheet.
   */
  it('survives anything that is not the shape it expects', () => {
    expect(parsePlugins('not json')).toEqual([])
    expect(parsePlugins('{}')).toEqual([])
    expect(parsePlugins('[]')).toEqual([])
    expect(parsePlugins(JSON.stringify([null, 3, 'x', {}, { id: '' }]))).toEqual([])
  })

  /* An undescribed plugin is not one to draw as switched off. */
  it('treats a missing enabled flag as on', () => {
    expect(parsePlugins(JSON.stringify([{ id: 'a@b' }]))[0]).toMatchObject({ enabled: true })
  })
})
