import { describe, expect, it } from 'vitest'
import { createChorusApi } from '../../desktop/src/shared/create-chorus-api.js'
import { PARITY } from './parity.js'

const api = createChorusApi({
  invoke: () => Promise.resolve(undefined),
  on: () => () => undefined,
  pathForFile: () => '',
  noteJournal: () => ({ ok: false, error: 'unused' }),
})

describe('the extension accounts for every ChorusApi method', () => {
  it('classifies exactly the methods the shared API exposes', () => {
    expect(Object.keys(PARITY).sort()).toEqual(Object.keys(api).sort())
  })

  it('waives only what the user accepted losing', () => {
    expect(
      Object.entries(PARITY)
        .filter(([, parity]) => parity === 'waived')
        .map(([method]) => method)
        .sort()
    ).toEqual([
      'actOnBrowserDownload',
      'allowBrowserPasswordSaving',
      'decideBrowserPassword',
      'fillBrowserPassword',
      'readBrowserDownloads',
      'readBrowserPasswords',
      'removeBrowserPassword',
      'setBrowserDevtoolsGeometry',
    ])
  })
})
