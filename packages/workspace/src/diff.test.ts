import { describe, expect, it } from 'vitest'
import { diffTotals, parseDiff } from './diff.js'

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function existing() {
 const keep = 1
-const gone = 2
+const added = 2
+const alsoAdded = 3
 const tail = 4
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -10,2 +10,2 @@
-old line
+new line
\\ No newline at end of file
`

describe('parseDiff', () => {
  it('separates files', () => {
    expect(parseDiff(SAMPLE).map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('counts additions and removals per file', () => {
    const [a, b] = parseDiff(SAMPLE)
    expect(a).toMatchObject({ added: 2, removed: 1 })
    expect(b).toMatchObject({ added: 1, removed: 1 })
  })

  it('totals across files', () => {
    expect(diffTotals(parseDiff(SAMPLE))).toEqual({ added: 3, removed: 2 })
  })

  it('numbers lines on both sides', () => {
    // Without both, a reviewer cannot point at a line in the file they have open.
    const lines = parseDiff(SAMPLE)[0]?.hunks[0]?.lines ?? []
    expect(lines[0]).toMatchObject({ kind: 'context', before: 1, after: 1 })
    expect(lines[1]).toMatchObject({ kind: 'removed', text: 'const gone = 2', before: 2 })
    expect(lines[2]).toMatchObject({ kind: 'added', text: 'const added = 2', after: 2 })
    expect(lines[3]).toMatchObject({ kind: 'added', after: 3 })
  })

  it('gives an added line no original number, and vice versa', () => {
    const lines = parseDiff(SAMPLE)[0]?.hunks[0]?.lines ?? []
    expect(lines[1]).not.toHaveProperty('after')
    expect(lines[2]).not.toHaveProperty('before')
  })

  it('keeps the hunk header, which carries the enclosing context', () => {
    expect(parseDiff(SAMPLE)[0]?.hunks[0]?.header).toContain('function existing()')
  })

  it('treats a missing trailing newline as metadata, not a line', () => {
    // Rendering it as context would imply a line that is not in the file.
    const lines = parseDiff(SAMPLE)[1]?.hunks[0]?.lines ?? []
    expect(lines.at(-1)).toMatchObject({ kind: 'meta', text: 'No newline at end of file' })
  })

  it('drops git headers rather than rendering them as changes', () => {
    const kinds = parseDiff(SAMPLE).flatMap((f) =>
      f.hunks.flatMap((h) => h.lines.map((l) => l.kind))
    )
    expect(kinds).not.toContain('meta-header')
    expect(parseDiff(SAMPLE)[0]?.hunks[0]?.lines.some((l) => l.text.startsWith('+++'))).toBe(false)
  })

  it('flags a binary file instead of pretending it has hunks', () => {
    const binary = `diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`
    expect(parseDiff(binary)[0]).toMatchObject({ path: 'logo.png', binary: true, hunks: [] })
  })

  it('reads both paths of a rename', () => {
    const renamed = `diff --git a/old.ts b/new.ts
similarity index 92%
rename from old.ts
rename to new.ts
`
    expect(parseDiff(renamed)[0]).toMatchObject({ oldPath: 'old.ts', path: 'new.ts' })
  })

  it('handles several hunks in one file', () => {
    const multi = `diff --git a/x.ts b/x.ts
@@ -1,1 +1,1 @@
-a
+b
@@ -50,1 +50,1 @@
-c
+d
`
    expect(parseDiff(multi)[0]?.hunks).toHaveLength(2)
    expect(parseDiff(multi)[0]?.hunks[1]?.lines[0]).toMatchObject({ before: 50 })
  })

  /*
   * The adapter serializes an agent's edit into this exact shape, and it is
   * thinner than git's: no `index`, no `---`/`+++`, and an absolute path makes
   * the header read `a//repo/...`. Recorded from a real `replace_all` edit.
   *
   * Pinned here rather than in the adapter because this parser is the consumer,
   * and a change to either side that silently stopped agreeing would show up as
   * diffs vanishing from the transcript rather than as a failure.
   */
  it('reads the thin diff an agent edit produces', () => {
    const patch =
      'diff --git a//repo/delta.ts b//repo/delta.ts\n' +
      '@@ -1,4 +1,4 @@\n' +
      '-const a = "TOKEN"\n' +
      '+const a = "MARKER"\n' +
      ' const pad1 = 0\n' +
      '@@ -16,4 +16,4 @@\n' +
      ' const qad8 = 0\n' +
      '-const c = "TOKEN"\n' +
      '+const c = "MARKER"\n'

    const [file] = parseDiff(patch)
    expect(file?.path).toBe('/repo/delta.ts')
    expect(file).toMatchObject({ added: 2, removed: 2 })
    expect(file?.hunks).toHaveLength(2)
    expect(file?.hunks[1]?.lines[1]).toMatchObject({ kind: 'removed', before: 17 })
    expect(file?.hunks[1]?.lines[2]).toMatchObject({ kind: 'added', after: 17 })
  })

  it('reads a synthesized new-file diff as all additions', () => {
    const [file] = parseDiff(
      'diff --git a//repo/new.ts b//repo/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n'
    )
    expect(file).toMatchObject({ added: 2, removed: 0 })
    expect(file?.hunks[0]?.lines).toMatchObject([
      { kind: 'added', after: 1 },
      { kind: 'added', after: 2 },
    ])
  })

  it('returns nothing for an empty diff', () => {
    expect(parseDiff('')).toEqual([])
  })
})

/**
 * The letter a change gets in a `Changes` card.
 *
 * From the headers git writes, never from the shape of the hunks: a rewritten
 * file is all-additions too, so counting `+` lines calls it new. Each of these
 * is a header that has to be read rather than skipped as noise.
 */
describe('file status', () => {
  it('reads a created file from its mode line', () => {
    const created = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
`
    expect(parseDiff(created)[0]).toMatchObject({ status: 'added', added: 2, removed: 0 })
  })

  it('reads a deleted file from its mode line', () => {
    const deleted = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`
    expect(parseDiff(deleted)[0]).toMatchObject({ status: 'removed', added: 0, removed: 2 })
  })

  it('reads a rename from the two paths in the header', () => {
    const renamed = `diff --git a/old.ts b/new.ts
similarity index 92%
rename from old.ts
rename to new.ts
`
    expect(parseDiff(renamed)[0]).toMatchObject({
      status: 'renamed',
      oldPath: 'old.ts',
      path: 'new.ts',
    })
  })

  it('letters the exact patch adapter-claude synthesizes for a create', () => {
    /*
     * Byte-for-byte what `toUnifiedDiff(…, created)` writes, asserted there as a
     * string. The two halves of one convention live in two packages that must
     * not import each other — an adapter may not depend on the workspace — so
     * the text is the contract, and this is the end that reads it.
     */
    const synthesized =
      'diff --git a//repo/fresh.ts b//repo/fresh.ts\n' +
      'new file mode 100644\n' +
      '--- /dev/null\n' +
      '+++ b//repo/fresh.ts\n' +
      '@@ -0,0 +1,1 @@\n' +
      '+a\n'
    expect(parseDiff(synthesized)[0]).toMatchObject({ status: 'added', added: 1, removed: 0 })
  })

  it('calls an ordinary edit modified', () => {
    const edited = `diff --git a/x.ts b/x.ts
@@ -1 +1 @@
-a
+b
`
    expect(parseDiff(edited)[0]).toMatchObject({ status: 'modified' })
  })

  it('does not call a rewritten file new just because every line is an addition', () => {
    // The distinction the mode line exists for: same path, no mode line, all
    // additions. Guessing from the hunks would letter this `A`.
    const rewritten = `diff --git a/x.ts b/x.ts
@@ -1,0 +1,2 @@
+one
+two
`
    expect(parseDiff(rewritten)[0]).toMatchObject({ status: 'modified' })
  })
})

describe('parseDiff with hunks: false', () => {
  /*
   * The summary has to survive, and that is the whole risk of the option.
   *
   * Counting happens inside the same branches that build the line objects, so
   * the obvious implementation — bail out when there is no hunk to push into —
   * returns every file with `+0 −0` and a file list of zeroes. A cheaper read
   * that silently lies about the numbers is worse than the cost it saves.
   */
  it('keeps the counts, the status and the paths, and drops only the lines', () => {
    const withHunks = parseDiff(SAMPLE)
    const without = parseDiff(SAMPLE, { hunks: false })

    expect(without.map((f) => f.path)).toEqual(withHunks.map((f) => f.path))
    expect(without.map((f) => f.added)).toEqual(withHunks.map((f) => f.added))
    expect(without.map((f) => f.removed)).toEqual(withHunks.map((f) => f.removed))
    expect(without.map((f) => f.status)).toEqual(withHunks.map((f) => f.status))
    expect(without.map((f) => f.oldPath)).toEqual(withHunks.map((f) => f.oldPath))
    expect(without.map((f) => f.binary)).toEqual(withHunks.map((f) => f.binary))

    // The counts are real, not incidentally-equal zeroes.
    expect(withHunks.some((f) => f.added > 0 || f.removed > 0)).toBe(true)
    expect(without.every((f) => f.hunks.length === 0)).toBe(true)
  })

  it('defaults to building them, so every existing caller is unchanged', () => {
    expect(parseDiff(SAMPLE)).toEqual(parseDiff(SAMPLE, {}))
  })
})
