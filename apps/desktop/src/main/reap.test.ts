import { describe, expect, it } from 'vitest'
import { reapOrphanedAgents } from './reap.js'

/**
 * The Windows arm, which is a refusal rather than an implementation.
 *
 * There is no test here that a Unix orphan gets killed: doing that honestly
 * means spawning a real process, orphaning it, and racing the reaper, which is
 * the kind of test that goes flaky and then gets deleted. The Unix path is
 * covered by having been measured by hand, as `reap.ts`'s own comment records.
 *
 * What is worth pinning is the distinction the `skipped` flag exists for.
 * Before it, Windows returned `killed: 0, inspected: 0` — identical to a clean
 * macOS machine — because `pgrep` threw ENOENT into a catch that reads a missing
 * binary as "nothing matched". A backstop that is absent and a backstop that
 * found nothing are different facts, and only one of them should be reassuring.
 */
describe('reapOrphanedAgents', () => {
  it('does not run on windows, and says so rather than reporting a clean sweep', async () => {
    expect(await reapOrphanedAgents('win32')).toEqual({
      killed: 0,
      inspected: 0,
      skipped: true,
    })
  })

  it('runs on unix and reports that it ran', async () => {
    // Nothing is orphaned in a test runner, so this is the "ran, found nothing"
    // case — the one that must stay distinguishable from the above.
    const result = await reapOrphanedAgents('darwin')
    expect(result.skipped).toBe(false)
    expect(result.killed).toBe(0)
  })

  it('kills nothing merely by being called', async () => {
    // The reaper runs at startup on every launch. A bug that widened its match
    // would take out the user's own `codex` in their own terminal, so the
    // no-orphans case returning zero kills is the property worth pinning.
    expect((await reapOrphanedAgents('darwin')).killed).toBe(0)
  })
})
