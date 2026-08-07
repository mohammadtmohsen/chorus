import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The one API here that says, in its own name, not to depend on it.
 *
 * `readPlanUsage` calls `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`
 * to fill the account panel before a turn is spent. It is called defensively —
 * feature-detected, wrapped, absence treated as normal — so a rename cannot
 * crash anything. That is the right failure mode and also the dangerous one: the
 * panel simply stops filling, which looks like an account with no plan window,
 * and nothing anywhere says why.
 *
 * This is the canary. It reads the installed SDK's own type declarations and
 * fails when that name is gone — at the moment of the upgrade, in CI, with the
 * name to search for in the failure message. It cannot make the API stable; it
 * can make its disappearance loud.
 */
const METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'

describe('the experimental usage API this adapter leans on', () => {
  it('is still called that in the installed SDK', () => {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk')
    const declarations = readFileSync(join(dirname(entry), 'sdk.d.ts'), 'utf8')

    expect(
      declarations.includes(METHOD),
      `The SDK no longer declares ${METHOD}. Claude's account usage will stop ` +
        'filling in silently — it is feature-detected, so nothing throws. Find ' +
        "the method that replaced it in sdk.d.ts and update `readPlanUsage`.",
    ).toBe(true)
  })
})
