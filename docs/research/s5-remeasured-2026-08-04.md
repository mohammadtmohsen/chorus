# S5, re-measured against the real transcript — 2026-08-04

The original S5 (2026-08-03) measured plain text nodes and concluded that
renderer-side coalescing was worth having. Plan §6.2 made re-running it against
the real transcript an M4 exit gate, because markdown parsing and serif layout
are a different weight class.

**Both conclusions from the original run turned out to be wrong at this
fidelity.** The harness drives the actual `Entry` and `MarkdownView` components
with a 200-message backlog, streaming realistic agent output — prose, inline
code, a fenced block and a list — at 5,000 tokens/s.

## Results

Frame budget is 8.3 ms (120 Hz). "Dropped" counts frames over 16.7 ms.

| Run            | chars streamed | p50 | p95  | p99  | max   | dropped            |
| -------------- | -------------- | --- | ---- | ---- | ----- | ------------------ |
| naive, 6 s     | 19,220         | 8.3 | 9.2  | 9.4  | 17.6  | **2 / 717 (0.3%)** |
| coalesced, 6 s | 17,020         | 8.3 | 15.0 | 16.7 | 17.6  | 15 / 685 (2.2%)    |
| naive, 20 s    | 35,760         | 8.4 | 17.4 | 33.4 | 125.2 | 253 / 1843 (14%)   |

## ⚠ Renderer-side coalescing makes things worse

The original run found coalescing removed a 74.6 ms tail spike. Against the real
transcript it does the opposite: **15 dropped frames versus 2**, and p95 nearly
doubles.

The reason is that coalescing trades many small updates for fewer large ones,
and the cost here is markdown parsing rather than React scheduling. A large
flush parses more text in one frame, so the frame overruns. React 19's automatic
batching already absorbs the many-small-updates case, which is what the original
harness was really measuring.

**Decision: no coalescing in the renderer.** Write-side coalescing in
`DeltaBuffer` is unaffected and still justified — it exists for durability and
log size (S3), not for frame time.

## ⚠ The bottleneck was re-parsing, not entry count

The first real-transcript run dropped 17% of frames on a 25k-character reply.
The cause was that every delta re-parsed the entire growing message, so cost is
quadratic in message length.

Two attempts:

1. **Split into settled prefix and live tail** — barely helped (17% → 15%). The
   prefix changes every time a block completes, so the cache kept invalidating
   and re-parsing everything before it.
2. **Split into blocks, memoise each on its own text** — this worked. Same 20 s
   run carried **46% more content** (35,760 vs 24,440 chars) with _fewer_
   dropped frames. Only the block currently being written does any work; the
   rest keep a stable element reference React skips reconciling.

## Virtualisation is not needed yet — and would not have helped

201 entries render without trouble, and `Entry` is memoised, so entries that are
not receiving text neither re-render nor re-parse. The measured cost is
dominated entirely by the single message being streamed into.

**Decision: defer virtualisation.** It addresses DOM size with thousands of
messages, which is a real but different problem, and nothing measured here is
improved by it. Revisit when a conversation actually reaches that size — the
number to watch is scroll and layout cost, not streaming frame time.

## What the 20 s run does and does not say

14% dropped frames on a 35k-character single message looks alarming and mostly
is not: 5,000 tokens/s sustained for 20 seconds into **one** message is roughly
two orders of magnitude beyond what a real agent emits. The realistic 6 s runs
sit at 0.3%.

It is still the honest ceiling, and it says where to look if streaming ever does
feel slow: the per-delta `splitBlocks` scan is O(n) in message length, and that
is the next thing to make incremental if it matters.

## Net effect on the plan

| Finding                          | Changes                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| Renderer coalescing hurts        | §4.6 — removed. `DeltaBuffer` (write side) unchanged.           |
| Per-block memoisation is the win | `MarkdownView` splits then memoises per block                   |
| `Entry` must be memoised         | Otherwise every message re-renders per token                    |
| Virtualisation deferred          | Not the bottleneck; revisit on conversation size, with evidence |
