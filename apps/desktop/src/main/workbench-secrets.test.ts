import { describe, expect, it, vi } from 'vitest'
import { importableGitLabToken } from './workbench-secrets.js'

vi.mock('electron', () => ({ safeStorage: {} }))

const instanceUrl = 'https://gitlab.com'

describe('importableGitLabToken', () => {
  it('imports the only PAT for the requested instance', () => {
    const raw = JSON.stringify({
      'https://gitlab.example.com|1': { token: 'fictional-other-host-token' },
      'https://gitlab.com|2': { token: 'fictional-selected-token' },
    })

    expect(importableGitLabToken(raw, instanceUrl)).toEqual({
      kind: 'token',
      token: 'fictional-selected-token',
    })
  })

  it.each(['fictional-refresh-token', ''])('refuses OAuth with refreshToken %j', (refreshToken) => {
    const raw = JSON.stringify({
      'https://gitlab.com|1': {
        token: 'fictional-oauth-token',
        refreshToken,
        expiresAtTimestampInSeconds: 2_000_000_000,
      },
    })

    expect(importableGitLabToken(raw, instanceUrl)).toEqual({ kind: 'oauth-only' })
  })

  it('refuses to choose between several PATs on the requested instance', () => {
    const raw = JSON.stringify({
      'https://gitlab.com|1': { token: 'fictional-first-token' },
      'https://gitlab.com|2': { token: 'fictional-second-token' },
    })

    expect(importableGitLabToken(raw, instanceUrl)).toEqual({ kind: 'several' })
  })

  it('selects the PAT when an OAuth account is also present', () => {
    const raw = JSON.stringify({
      'https://gitlab.com|1': {
        token: 'fictional-oauth-token',
        refreshToken: 'fictional-refresh-token',
      },
      'https://gitlab.com|2': { token: 'fictional-selected-token' },
    })

    expect(importableGitLabToken(raw, instanceUrl)).toEqual({
      kind: 'token',
      token: 'fictional-selected-token',
    })
  })

  it.each([
    { label: 'missing secret', raw: null },
    { label: 'malformed JSON', raw: '{' },
    { label: 'JSON null', raw: 'null' },
    { label: 'array instead of accounts', raw: '[]' },
    { label: 'missing token', raw: JSON.stringify({ 'https://gitlab.com|1': {} }) },
    { label: 'empty token', raw: JSON.stringify({ 'https://gitlab.com|1': { token: '' } }) },
    {
      label: 'non-string token',
      raw: JSON.stringify({ 'https://gitlab.com|1': { token: 42 } }),
    },
    {
      label: 'invalid refresh token',
      raw: JSON.stringify({
        'https://gitlab.com|1': { token: 'fictional-token', refreshToken: null },
      }),
    },
    {
      label: 'another instance',
      raw: JSON.stringify({ 'https://gitlab.example.com|1': { token: 'fictional-token' } }),
    },
    {
      label: 'instance URL prefix without the account delimiter',
      raw: JSON.stringify({ 'https://gitlab.com.example.com|1': { token: 'fictional-token' } }),
    },
  ])('returns none for $label', ({ raw }) => {
    expect(importableGitLabToken(raw, instanceUrl)).toEqual({ kind: 'none' })
  })
})
