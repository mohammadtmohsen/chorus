import { describe, expect, it } from 'vitest'

import { runSpecs, summarize } from './runner.mjs'

/**
 * The runner, driven by fake specs.
 *
 * Four fixtures rather than the real suite, because the thing under test is the
 * *decision* — which bucket a spec lands in — and the real suite can only
 * produce a skip on an account that happens to have no plan window. A criterion
 * that depends on the tester's billing plan is not a criterion (C-027).
 */

const collect = async (specs) => {
  const lines = []
  let clock = 0
  const tally = await runSpecs(specs, {
    log: (line) => lines.push(line),
    now: () => (clock += 1000),
  })
  return { tally, out: lines.join('\n') }
}

const passes = { name: 'passes', run: (assert) => assert(true, 'it checked a thing') }
const skips = { name: 'skips', run: (_assert, skip) => skip('no plan window on this account') }
const fails = { name: 'fails', run: (assert) => assert(false, 'it checked and was wrong') }
const checksNothing = { name: 'checks nothing', run: () => undefined }

describe('the runner tells three outcomes apart', () => {
  it('counts a passing spec as passed, and only that', async () => {
    const { tally, out } = await collect([passes])
    expect(tally).toEqual({ passed: 1, skipped: 0, failed: 0 })
    expect(out).toContain('✓ passes')
  })

  it('counts a skipped spec as skipped, names the reason, and does not call it passed', async () => {
    const { tally, out } = await collect([skips])
    expect(tally).toEqual({ passed: 0, skipped: 1, failed: 0 })
    expect(out).toContain('– skips (skipped: no plan window on this account)')
    // The bug this file exists for: a skip that printed a tick.
    expect(out).not.toContain('✓')
  })

  it('counts a failing spec as failed and reports what it was checking', async () => {
    const { tally, out } = await collect([fails])
    expect(tally).toEqual({ passed: 0, skipped: 0, failed: 1 })
    expect(out).toContain('✗ fails')
    expect(out).toContain('it checked and was wrong')
  })

  /*
   * The other half of C-027, and the shape that actually shipped: a spec that
   * ran to completion, threw nothing, and checked no claim at all.
   */
  it('fails a spec that finished without asserting anything', async () => {
    const { tally, out } = await collect([checksNothing])
    expect(tally).toEqual({ passed: 0, skipped: 0, failed: 1 })
    expect(out).toContain('without asserting anything')
  })

  it('keeps going after a failure and tallies a mixed run', async () => {
    const { tally } = await collect([passes, fails, skips, checksNothing, passes])
    expect(tally).toEqual({ passed: 2, skipped: 1, failed: 2 })
  })
})

describe('the summary may only claim what it earned', () => {
  it('says "all N passed" when nothing skipped and nothing failed', () => {
    expect(summarize({ passed: 28, skipped: 0, failed: 0 })).toBe('all 28 passed')
  })

  /*
   * The line C-027 is named for. `all 28 passed` beside a skip is the claim
   * nobody could check, so the unqualified form is not available here.
   */
  it('refuses "all N passed" when a spec skipped', () => {
    expect(summarize({ passed: 27, skipped: 1, failed: 0 })).toBe('27 passed, 1 skipped, 0 failed')
  })

  it('reports failures with the passed and skipped counts beside them', () => {
    expect(summarize({ passed: 25, skipped: 1, failed: 2 })).toBe('25 passed, 1 skipped, 2 failed')
  })
})

/*
 * A skip must not turn the build red.
 *
 * `run.mjs` exits on `tally.failed`, so this is the assertion that the exit code
 * is unchanged by a skip — stated here because it is a decision, not an
 * accident: a machine that cannot answer a question has not answered it wrongly.
 */
it('leaves a skip out of the failure count that decides the exit code', async () => {
  const { tally } = await collect([skips, skips, passes])
  expect(tally.failed).toBe(0)
})
