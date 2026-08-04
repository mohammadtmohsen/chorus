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

  it('returns nothing for an empty diff', () => {
    expect(parseDiff('')).toEqual([])
  })
})
