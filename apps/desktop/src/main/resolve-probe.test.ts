import { describe, expect, it } from 'vitest'
import { executableCandidates } from './command.js'
import { resolveCommand } from './which.js'

/**
 * An observation, not a unit test — it reads the machine it runs on.
 *
 * Everything else about Windows in this repo is tested by injecting a fake
 * platform from a Mac, which is the only option available here and cannot
 * answer the one question that actually bit: **where does the CLI really
 * live, and does the candidate list contain that place?**
 *
 * Chorus reported `claude` as missing on a real Windows machine while it ran
 * fine from that machine's terminal. The fix — adding
 * `%USERPROFILE%\.local\bin` — was reasoned from the macOS install path and the
 * installer's documented behaviour. Reasoning is what produced the gap in the
 * first place.
 *
 * So this runs on a Windows runner, against a genuinely installed CLI, and
 * fails if the resolver cannot find it. Skipped everywhere else, because on any
 * other machine it would either be vacuous or a test of that developer's laptop.
 */
const probing = process.env['CHORUS_RESOLVE_PROBE'] === '1'

describe.skipIf(!probing)('resolving a real CLI on the machine this runs on', () => {
  it('finds the installed claude, and says where', async () => {
    const resolved = await resolveCommand('claude')
    // Printed either way: a failure here is only useful with the search list
    // beside it, and a pass is the answer to "where does it live".
    console.log('resolved:', JSON.stringify(resolved, null, 1))
    console.log(
      'searched:',
      JSON.stringify(
        executableCandidates('claude', {
          platform: process.platform,
          env: process.env,
          home: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
        }).slice(0, 40),
        null,
        1
      )
    )
    expect(resolved).not.toBeNull()
  })
})
