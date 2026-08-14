# Baseline for the readable control rail

**Date:** 2026-08-13 · **Machine:** Darwin 25.6.0, arm64 · **Build:** `electron-vite` `out/`, dev bundle
**Reproduce:** `node apps/desktop/e2e/perf-rail.mjs --sessions 6 --out /tmp/rail-before.json`

This is Phase 0 of [the plan](../plans/readable-control-rail-2026-08-13/plan.md). It exists so that
no optimisation claim in the phases after it is made without a number to compare
against, and so that the numbers were taken from the app rather than from a
synthetic page.

## What was measured, and what was not

`perf-rail.mjs` drives the real Electron app over the debugger protocol. For each
interaction it resets a render counter, reads Chrome's own `Performance` metrics,
performs the interaction, waits two animation frames, and reads the metrics back.
Two frames rather than one because the first callback runs before the commit the
interaction caused has been painted.

**Not measured, and this is a deviation from the plan's Phase 0 wording.** The
plan asks for React Profiler commit counts in a profiling build. This repo ships
no profiling build and adding one to answer one question is a larger change than
the question is worth. What replaces it is `render-count.ts`: a counter that does
not exist unless `window.__chorusRenderCounts` has been installed from outside,
which the perf script does and nothing else does. It counts component renders
rather than React commits — a coarser reading, but the Phase 4 claim ("row and
shell render counts stay flat during an ordinary text delta") is a claim about
renders, so it is the reading that claim needs.

The baseline build predates that seam, so `renders` is empty in `perf-before.json`.
Render counts are an after-only reading and are reported as such.

**Also not measured:** streaming-under-load frame drops with six live agents.
That needs six real agent turns, which is neither deterministic nor cheap, and
the existing workspace measurement (four mounted streaming sessions at 35.6–36.7%
renderer CPU, 10.8–12% in layout) is the recorded figure the plan already cites.
Idle frame stability is measured here as the control.

## Before, six sessions, one pane

Milliseconds. `paintedMs` is interaction to second frame; the rest are Chrome
counter deltas across the same window.

| Interaction        | painted |  Task | Script | Layout | RecalcStyle |
| ------------------ | ------: | ----: | -----: | -----: | ----------: |
| rail switch        |      10 | 25.82 |   4.55 |   0.49 |        1.78 |
| rail scroll        |      10 |  4.37 |   0.06 |      0 |        2.44 |
| drawer toggle      |      15 | 19.43 |   4.24 |   4.34 |        3.11 |
| drawer toggle back |      15 |     — |      — |      — |           — |
| search keystroke   |      13 |     — |      — |      — |           — |
| preview open       |       4 |     — |      — |      — |        0.53 |
| preview close      |      10 |  4.69 |   2.32 |      0 |           0 |
| split pane         |      16 | 18.46 |  10.82 |   1.92 |        1.62 |
| terminal open      |      41 | 47.30 |  33.25 |   2.55 |        3.79 |
| terminal close     |       9 |  8.60 |   0.44 |   0.44 |        0.61 |

Idle over two seconds: 241 frames, 0 dropped, p95 frame gap 9.2ms.
Idle cost over three seconds: 7.88ms task time, no script, layout or style time.

`shortcutCount` is **0** and `previewPresent` is **false** — the baseline build has
neither a per-session rail shortcut nor a hover preview, which is the shape of
the problem rather than a measurement failure.

## What the baseline says

Every interaction already meets the 100ms product target on an idle machine with
six sessions and nothing streaming. That matters, because it means the reported
lag is **not** reproducible from the interaction path alone, and any Phase 4
change justified as "making clicks faster" would be optimising a number that was
never the complaint. The measurable risks the plan lists — the shell subscribing
to every pulse, each card subscribing to `lastSeq`, the 140ms typewriter drain —
are about what happens _while an agent streams_, and the honest reading here is
that this scenario does not reach that state.

Terminal open at 41ms / 47ms task time is the most expensive interaction, and it
is a one-off construction cost rather than a per-frame one.

## Contrast, before

From the plan, recomputed against the tokens actually in `styles.css`:

| Theme           | On ground | On raised | On sunken | WCAG AA normal text |
| --------------- | --------: | --------: | --------: | ------------------: |
| Dark `#5d5775`  |    2.69:1 |    2.50:1 |    2.81:1 |               4.5:1 |
| Light `#8b85a0` |    3.04:1 |    3.52:1 |    2.76:1 |               4.5:1 |

`--faint` was used 68 times. That is the Phase 1 work.

## State matrix for the visual pass

The human gate in Phase 5 walks these, at dark and light, at 240px, 336px and a
narrow window, with one, six and twenty sessions:

collapsed rail · expanded drawer · idle · working · waiting · unread · failed ·
active · open elsewhere · offscreen · long title · duplicate monogram · long path ·
multiple running tasks · near-full context · Arrange mode · preview open ·
menu open · split panes · session terminal open · global terminal open.
