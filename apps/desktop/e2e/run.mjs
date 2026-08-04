import { ensureBuilt } from './harness.mjs'
import { specs } from './specs.mjs'

/**
 * Runs the specs one at a time against the built app.
 *
 * Serially on purpose: each one launches a real Electron and real agents, and
 * several at once would compete for the same CLIs and make timings meaningless.
 */
ensureBuilt()

const only = process.argv[2]
const chosen = only === undefined ? specs : specs.filter((s) => s.name.includes(only))
if (chosen.length === 0) {
  console.error(`no spec matches "${only}"`)
  process.exit(1)
}

let failed = 0
for (const spec of chosen) {
  const started = Date.now()
  const notes = []
  try {
    await spec.run((ok, note) => {
      notes.push(`${ok ? '  ✓' : '  ✗'} ${note}`)
      if (!ok) throw new Error(note)
    })
    console.log(`✓ ${spec.name} (${String(Math.round((Date.now() - started) / 1000))}s)`)
    for (const note of notes) console.log(note)
  } catch (error) {
    failed += 1
    console.log(`✗ ${spec.name}`)
    for (const note of notes) console.log(note)
    console.log(`  ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(failed === 0 ? `\nall ${String(chosen.length)} passed` : `\n${String(failed)} failed`)
process.exit(failed === 0 ? 0 : 1)
