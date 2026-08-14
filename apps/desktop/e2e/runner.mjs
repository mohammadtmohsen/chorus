/**
 * The loop that runs specs, kept apart from the script that launches them.
 *
 * Split out of `run.mjs` so it can be driven by fake specs. The runner is the
 * one piece of this suite that decides what "passed" means, and until now the
 * only way to exercise that decision was to run twenty-eight real Electrons and
 * read the output — which is to say it was never exercised at all (C-027).
 */

/**
 * A spec declining to run, as opposed to one that failed or one that passed.
 *
 * Thrown rather than returned because it has to unwind the spec from wherever it
 * is, and because a return value would need every spec to cooperate in passing
 * it back up. The runner is the only thing that catches it.
 */
export class Skipped extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'Skipped'
  }
}

/** A spec that finished having checked nothing. Named so the summary can say so. */
export class AssertedNothing extends Error {
  constructor() {
    super('the spec finished without asserting anything')
    this.name = 'AssertedNothing'
  }
}

/**
 * Runs each spec and tallies it into exactly one of three buckets.
 *
 * Three, not two, and that is the whole point of this file. `assert(true, …)`
 * followed by `return` used to be indistinguishable from a spec that did its
 * job — in the output and in the exit code — which is how a spec waiting on a
 * class nothing had carried for months reported green for as long as nobody
 * looked. A spec that means to skip now has to say so.
 */
export async function runSpecs(specs, { log = console.log, now = () => Date.now() } = {}) {
  const tally = { passed: 0, skipped: 0, failed: 0 }

  for (const spec of specs) {
    const started = now()
    const notes = []
    let asserted = 0

    const assert = (ok, note) => {
      asserted += 1
      notes.push(`${ok ? '  ✓' : '  ✗'} ${note}`)
      if (!ok) throw new Error(note)
    }
    const skip = (reason) => {
      throw new Skipped(reason)
    }

    const took = () => String(Math.round((now() - started) / 1000))

    try {
      await spec.run(assert, skip)
      /*
       * A spec that asserted nothing has not passed, whatever it returned.
       *
       * This is the cheap half of C-027: it cannot catch `assert(true, …)`,
       * which is why `skip` exists above, but it does catch the other shape —
       * an early `return` on a selector that matched nothing, leaving a spec
       * that ran to completion having checked no claim at all.
       */
      if (asserted === 0) throw new AssertedNothing()
      tally.passed += 1
      log(`✓ ${spec.name} (${took()}s)`)
      for (const note of notes) log(note)
    } catch (error) {
      if (error instanceof Skipped) {
        tally.skipped += 1
        log(`– ${spec.name} (skipped: ${error.message})`)
        for (const note of notes) log(note)
        continue
      }
      tally.failed += 1
      log(`✗ ${spec.name}`)
      for (const note of notes) log(note)
      log(`  ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return tally
}

/**
 * The last line, and it may only say "all N passed" when that is true.
 *
 * An unqualified `all N passed` printed while two of those N skipped is the claim
 * this whole entry is about, so that form is reserved for the one case that earns
 * it: nothing skipped and nothing failed. (The example here named a count once;
 * it went stale, like every other total written down in this repo.)
 */
export function summarize({ passed, skipped, failed }) {
  if (skipped === 0 && failed === 0) return `all ${String(passed)} passed`
  return `${String(passed)} passed, ${String(skipped)} skipped, ${String(failed)} failed`
}
