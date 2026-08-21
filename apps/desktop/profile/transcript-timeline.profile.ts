import { serialize, deserialize } from 'node:v8'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EventStore, openSqlite } from '@chorus/event-store'
import { IPC_CONTRACT } from '../src/shared/ipc.js'
import { TRANSCRIPT_TYPES } from '../src/shared/transcript-events.js'
import { EMPTY_VIEW, reduceEvents } from '../src/renderer/src/transcript.js'
import type { TranscriptEvent } from '../src/shared/ipc.js'

/**
 * Where opening a long conversation actually spends its time.
 *
 * **Why this exists.** Phases 5 and 6 answer different problems — paging fixes a
 * read that is too big, virtualising fixes a DOM that is too large — and doing
 * the wrong one first is weeks spent on the smaller half. An earlier draft of
 * the plan proposed measuring `runtime.history` and then resuming at IPC return,
 * which hides four stages that each scale with payload: main's own response
 * validation, the structured clone, the hop, and preload's validation. Zod's
 * `safeParse` **rebuilds the value it validates**, so a transcript is
 * reconstructed twice before a reducer ever sees it. That is the kind of cost a
 * two-point measurement attributes to "the database".
 *
 * **Against a pristine copy, never the live store.** Opening a conversation
 * restores sessions and appends events, so profiling the real file would mutate
 * the fixture between runs and make the second measurement describe a different
 * conversation from the first. `CHORUS_PROFILE_DB` points at the copy.
 *
 * **What this file cannot see.** Commit and paint happen in a renderer, and
 * retention needs a live heap. Those are measured by driving the built app; this
 * measures everything from the SQL up to and including the reduction, which is
 * the part that is deterministic and can be re-run to prove a phase worked.
 */

const DB = process.env['CHORUS_PROFILE_DB'] ?? '/tmp/chorus-profile/fixture/chorus.db'

/*
 * Written to a file rather than logged. Vitest intercepts stdout, and a
 * measurement that only exists in a terminal scrollback cannot be pasted into a
 * STATUS entry or diffed against the next run.
 */
const REPORT = process.env['CHORUS_PROFILE_OUT'] ?? '/tmp/chorus-profile/timeline.txt'

/**
 * Byte-heavy and entry-heavy, because one fixture cannot tell the costs apart.
 *
 * Profiling only the first would attribute a DOM cost to SQLite; only the second
 * would miss the transport cost entirely.
 */
const FIXTURES = [
  { name: 'byte-heavy', id: '019ff9c5-d999-7e66-b7af-8a0a35bde4e1' },
  { name: 'entry-heavy', id: '019fe5f6-9477-7181-ba52-3b28dcf4dece' },
]

/*
 * Even, deliberately. `compare()` flips which side leads on alternate
 * repetitions, so an odd count gives one side the lead 3 times and the other 2 —
 * which is not "each side leads half" however it is described.
 */
const REPS = 6

function median(runs: readonly number[]): number {
  return [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)] ?? 0
}

/** Collect the garbage the previous stage made, when the flag allows it. */
function settle(): void {
  const collect = (globalThis as { gc?: () => void }).gc
  if (collect !== undefined) collect()
}

interface Timed<T> {
  readonly ms: number
  readonly value: T
}

/**
 * Times two alternatives against each other, alternating, discarding a warm-up.
 *
 * **Two things this got wrong before a review caught them.**
 *
 * *Order.* The first version timed every "before" mark and then every "after"
 * mark, and reported the entry-heavy reduction as 15% slower on strictly fewer
 * events — not a result, an artifact: the first run pays JIT warm-up against a
 * cold page cache, the second runs against a heap the first one filled. The
 * second version interleaved them but always ran A before B *within* the pair,
 * so B still inherited A's warm cache every single time. This one flips the
 * order on alternate repetitions, so each side leads half the runs.
 *
 * *Statistics.* The second version called its output "paired medians" and was
 * not: taking `median(aRuns)` and `median(bRuns)` separately is a difference of
 * independently-taken medians, which is a different quantity and can come from
 * different repetitions. `ratio` below is the real paired figure — the median of
 * the per-repetition b/a — and it is what the report leads with. The two medians
 * are still printed, labelled as what they are.
 */
function compare<A, B>(
  a: () => A,
  b: () => B
): {
  a: Timed<A>
  b: Timed<B>
  /** Median of the per-repetition b/a. Below 1 means the "after" side is faster. */
  ratio: number
} {
  const aRuns: number[] = []
  const bRuns: number[] = []
  const ratios: number[] = []
  let aValue!: A
  let bValue!: B

  const run = <T>(fn: () => T): { ms: number; value: T } => {
    settle()
    const start = performance.now()
    const value = fn()
    return { ms: performance.now() - start, value }
  }

  for (let i = 0; i <= REPS; i++) {
    // Flip on alternate repetitions so neither side always leads, and so
    // whichever one runs second does not always inherit the other's warm cache.
    let aOne: { ms: number; value: A }
    let bOne: { ms: number; value: B }
    if (i % 2 === 0) {
      aOne = run(a)
      bOne = run(b)
    } else {
      bOne = run(b)
      aOne = run(a)
    }
    aValue = aOne.value
    bValue = bOne.value

    // i === 0 is the warm-up pair: run so both sides pay it, then dropped.
    if (i > 0) {
      aRuns.push(aOne.ms)
      bRuns.push(bOne.ms)
      ratios.push(aOne.ms === 0 ? 1 : bOne.ms / aOne.ms)
    }
  }

  return {
    a: { ms: median(aRuns), value: aValue },
    b: { ms: median(bRuns), value: bValue },
    ratio: median(ratios),
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(2)} MB`
}

function ms(value: number): string {
  return `${value.toFixed(1)} ms`.padStart(9)
}

describe.skipIf(!existsSync(DB))('the transcript timeline', () => {
  const handle = openSqlite({ path: DB })
  // The same door the app uses, migrations included. Safe here precisely because
  // this is a copy: a migration against the live store would be the mutation
  // this whole file is arranged to avoid.
  const { store } = EventStore.open(handle)
  const history = IPC_CONTRACT['conversation:history'].response
  const transcript = IPC_CONTRACT['conversation:transcript'].response
  const COLUMNS = 'seq, id, conversation_id, actor, type, payload, created_at'

  const gcNote =
    (globalThis as { gc?: unknown }).gc === undefined
      ? 'gc: unavailable — re-run with NODE_OPTIONS=--expose-gc'
      : 'gc: forced between stages'
  writeFileSync(REPORT, `${gcNote}\n`)

  for (const fixture of FIXTURES) {
    it(`splits the cost of opening the ${fixture.name} conversation`, () => {
      const lines: string[] = []
      const marks: {
        mark: string
        before: number
        after: number
        ratio: number | null
        note: string
      }[] = []

      const typeList = TRANSCRIPT_TYPES.map((t) => `'${t}'`).join(', ')

      // ── SQL, split from the Zod that `read()` fuses onto it ────────────────
      const sql = compare(
        () =>
          handle
            .prepare(`SELECT ${COLUMNS} FROM events WHERE conversation_id = @id ORDER BY seq`)
            .all({ id: fixture.id }),
        () =>
          handle
            .prepare(
              `SELECT ${COLUMNS} FROM events WHERE conversation_id = @id AND type IN (${typeList}) ORDER BY seq`
            )
            .all({ id: fixture.id })
      )

      const read = compare(
        () => store.read(fixture.id),
        () => store.read(fixture.id, { types: TRANSCRIPT_TYPES })
      )

      // A read that returned nothing would make every assertion below pass
      // trivially — 0 rows reduce to 0 rows.
      expect(read.a.value.length).toBeGreaterThan(1_000)

      const toEvents = (rows: ReturnType<typeof store.read>): TranscriptEvent[] =>
        rows.map((e) => ({
          seq: e.seq,
          id: e.id,
          conversationId: e.conversationId,
          actor: e.actor,
          type: e.type,
          payload: e.payload,
          createdAt: e.createdAt,
        }))

      const wide = toEvents(read.a.value)
      const narrow = toEvents(read.b.value)
      const seq = store.lastSeq()

      marks.push({
        mark: 'sql fetch',
        before: sql.a.ms,
        after: sql.b.ms,
        ratio: sql.ratio,
        note: `${String(wide.length)} → ${String(narrow.length)} rows`,
      })
      marks.push({
        mark: 'parse + validate payload',
        before: read.a.ms - sql.a.ms,
        after: read.b.ms - sql.b.ms,
        // No paired ratio, and that is the honest answer rather than a gap.
        // This row is a SUBTRACTION of two medians taken in different runs
        // (`read` minus `sql`), so there is no per-repetition pair to take a
        // ratio of. Reporting `read.ratio` here — as an earlier version did —
        // labelled the whole read's ratio as the parse stage's, which it is not.
        ratio: null,
        note: 'derived: read − sql, no paired ratio',
      })

      // ── Main's own response validation ─────────────────────────────────────
      // Not a formality: safeParse walks and rebuilds the whole array before it
      // is handed to the clone.
      const out = compare(
        () => history.safeParse(wide),
        () => transcript.safeParse({ events: narrow, throughSeq: seq })
      )
      expect(out.a.value.success).toBe(true)
      expect(out.b.value.success).toBe(true)
      marks.push({
        mark: 'main validation',
        before: out.a.ms,
        after: out.b.ms,
        ratio: out.ratio,
        note: 'zod safeParse, rebuilds the array',
      })

      // ── The structured clone, as CPU ───────────────────────────────────────
      // Named for what it is. An earlier version called this "clone + transfer"
      // and **no transfer happens** — `serialize` produces a local buffer and
      // `deserialize` reads it back in the same process. It is a fair proxy for
      // the CPU Electron's hop spends on the same algorithm, and nothing more.
      //
      // Serialise and deserialise stay one interval: Electron exposes no
      // application-level mark between them, so splitting them would invent a
      // boundary the runtime does not offer.
      //
      // And ONE timed closure, not two averaged. Averaging the serialize ratio
      // with the deserialize ratio is not the ratio of the combined stage — it
      // weights a fast half and a slow half equally. Timing the round trip gives
      // the stage its own paired figure.
      const wideBuf = serialize(wide)
      const narrowBuf = serialize({ events: narrow, throughSeq: seq })
      const roundTrip = compare(
        () => deserialize(serialize(wide)) as TranscriptEvent[],
        () =>
          deserialize(serialize({ events: narrow, throughSeq: seq })) as {
            events: TranscriptEvent[]
            throughSeq: number
          }
      )
      marks.push({
        mark: 'structured clone (CPU)',
        before: roundTrip.a.ms,
        after: roundTrip.b.ms,
        ratio: roundTrip.ratio,
        note: `${mb(wideBuf.byteLength)} → ${mb(narrowBuf.byteLength)}`,
      })

      const pre = compare(
        () => history.safeParse(roundTrip.a.value),
        () => transcript.safeParse(roundTrip.b.value)
      )
      marks.push({
        mark: 'preload validation',
        before: pre.a.ms,
        after: pre.b.ms,
        ratio: pre.ratio,
        note: 'the same schema, a second time',
      })

      const reduced = compare(
        () => reduceEvents(EMPTY_VIEW, wide),
        () => reduceEvents(EMPTY_VIEW, narrow)
      )
      marks.push({
        mark: 'reduce',
        before: reduced.a.ms,
        after: reduced.b.ms,
        ratio: reduced.ratio,
        note: `${String(reduced.a.value.messages.length)} rows to draw`,
      })

      // Phase 2 filters what the reducer has no case for, so dropping those
      // events may not change a single row.
      expect(reduced.b.value.messages.length).toBe(reduced.a.value.messages.length)

      /*
       * The whole path, end to end, as ONE timed closure per side.
       *
       * This is the only defensible total. Summing the stage medians gives a
       * number that no single execution ever produced — and the stages above are
       * each timed on their own input rather than on the previous stage's
       * output, so their sum is a cost model, not a duration. Running the chain
       * per repetition, with each stage fed the real output of the last, gives a
       * quantity that exists and a paired ratio that means what it says.
       *
       * It still crosses no process. `v8.serialize` is the serialization format
       * the hop uses and a fair proxy for the CPU of the clone; the hop itself,
       * IPC scheduling, context isolation, commit and paint are all absent.
       */
      const chain = compare(
        () => {
          const rows = toEvents(store.read(fixture.id))
          const validated = history.safeParse(rows)
          const buf = serialize(validated.success ? validated.data : rows)
          const returned = deserialize(buf) as TranscriptEvent[]
          const checked = history.safeParse(returned)
          return reduceEvents(EMPTY_VIEW, checked.success ? checked.data : returned)
        },
        () => {
          const rows = toEvents(store.read(fixture.id, { types: TRANSCRIPT_TYPES }))
          const body = { events: rows, throughSeq: store.lastSeq() }
          const validated = transcript.safeParse(body)
          const buf = serialize(validated.success ? validated.data : body)
          const returned = deserialize(buf) as { events: TranscriptEvent[]; throughSeq: number }
          const checked = transcript.safeParse(returned)
          return reduceEvents(EMPTY_VIEW, checked.success ? checked.data.events : returned.events)
        }
      )
      // The two paths must agree on what is drawn, or the filter lost something.
      expect(chain.b.value.messages.length).toBe(chain.a.value.messages.length)

      const before = marks.reduce((sum, m) => sum + m.before, 0)
      const after = marks.reduce((sum, m) => sum + m.after, 0)

      lines.push(`\n${fixture.name} — ${fixture.id.slice(0, 8)}`)
      lines.push(
        `  ${String(wide.length)} events → ${String(narrow.length)} after the filter,` +
          ` ${String(reduced.a.value.messages.length)} rows drawn`
      )
      lines.push('')
      lines.push(
        `  ${'mark'.padEnd(26)}${'history'.padStart(9)}${'transcript'.padStart(12)}${'paired'.padStart(9)}   note`
      )
      for (const m of marks) {
        lines.push(
          `  ${m.mark.padEnd(26)}${ms(m.before)}${ms(m.after).padStart(12)}` +
            `${(m.ratio === null ? '—' : `×${m.ratio.toFixed(2)}`).padStart(9)}   ${m.note}`
        )
      }
      lines.push(
        `  ${'  (sum of the above)'.padEnd(26)}${ms(before)}${ms(after).padStart(12)}` +
          '        —   a cost model, not a duration'
      )
      lines.push(
        `  ${'— whole CPU chain'.padEnd(26)}${ms(chain.a.ms)}${ms(chain.b.ms).padStart(12)}` +
          `×${chain.ratio.toFixed(2)}`.padStart(9) +
          '   one closure; no IPC, commit or paint'
      )
      lines.push('')
      lines.push(
        `  serialized payload ${mb(wideBuf.byteLength)} → ${mb(narrowBuf.byteLength)}` +
          ` (${(100 - (narrowBuf.byteLength / wideBuf.byteLength) * 100).toFixed(1)}% smaller)`
      )
      lines.push(
        // An ESTIMATE, and labelled as one: it divides a median from the reduce
        // comparison by a median from the chain comparison, which are two
        // independent measurements. It is the right order of magnitude for
        // "where does the CPU go", not a measured share of one execution.
        `  the reduction is ~${((reduced.b.ms / chain.b.ms) * 100).toFixed(0)}% of that chain (estimate: two separate comparisons)`
      )
      lines.push('')
      /*
       * Said in the output, not only in a plan, because a table of milliseconds
       * reads as an end-to-end measurement to anyone who did not write it.
       *
       * Three separate caveats, and they are not interchangeable:
       *
       * - The **chain** row is the only real duration here: one closure per
       *   repetition, every stage fed the previous stage's actual output. It is
       *   still only the CPU path — "end to end" would be a lie, since the IPC
       *   hop, the commit and the paint are all outside it.
       * - The **sum** row is a cost model. Each stage above is timed on its own
       *   input, so their total is a number no execution ever produced.
       * - **parse+validate** is `read` minus `sql`, two medians from different
       *   runs, so it has no per-repetition pair and prints no ratio at all.
       *
       * And none of it crosses a process. `v8.serialize` is the serialization
       * format Electron's hop uses and a fair proxy for the CPU of the clone,
       * but it produces a local buffer and hands it to nobody. Commit and paint
       * are absent for the same reason — they need a renderer, and
       * `e2e/perf-transcript.mjs` is where they are measured.
       */
      lines.push('  the chain row is one timed closure per repetition, stages fed forward.')
      lines.push('  the sum row is a cost model only — no single run ever produced it.')
      lines.push('  parse+validate is a subtraction, so it has no paired ratio at all.')
      lines.push('  nothing here crosses a process: no IPC hop, no commit, no paint.')

      appendFileSync(REPORT, `${lines.join('\n')}\n`)
    })
  }
})
