import { ensureBuilt } from './harness.mjs'
import { runSpecs, summarize } from './runner.mjs'
import { specs } from './specs.mjs'

/**
 * Runs the specs one at a time against the built app.
 *
 * Serially on purpose: each one launches a real Electron and real agents, and
 * several at once would compete for the same CLIs and make timings meaningless.
 *
 * The loop itself lives in `runner.mjs` so it can be tested against fake specs;
 * this file is the part that needs a build and a machine.
 */
ensureBuilt()

const only = process.argv[2]
const chosen = only === undefined ? specs : specs.filter((s) => s.name.includes(only))
if (chosen.length === 0) {
  console.error(`no spec matches "${only}"`)
  process.exit(1)
}

const tally = await runSpecs(chosen)

console.log(`\n${summarize(tally)}`)
/*
 * A skip does not fail the run.
 *
 * It is a spec saying this machine cannot answer the question — an account with
 * no plan window, say — which is not the same as the answer being wrong. It is
 * counted and named in the summary instead, which is the whole of C-027: the
 * cost of a skip should be that someone can see it, not that the build stops.
 */
process.exit(tally.failed === 0 ? 0 : 1)
