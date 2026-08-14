# Loop — readable control rail

One line per round, newest at the bottom. Written by claude at every gate, so
you can follow without asking. `STATUS.md` is the considered record; this is the
running one.

## Watch it live

```bash
# what is running right now
ps axo pid,etime,command | grep -E 'e2e/run.mjs|shots-rail' | grep -v grep

# the screenshots, newest first
ls -lt docs/plans/readable-control-rail-2026-08-13/visuals/impl-parity-*.png

# this file
tail -f docs/plans/readable-control-rail-2026-08-13/LOOP.md
```

## Where it stands — 2026-08-13 22:04

**Waiting on you: visual approval of the four `impl-parity-*` captures (20:57).**
Nothing is staged, committed or pushed. Branch `main`, 22 files modified, 20 new.

|                   |                                                                           |
| ----------------- | ------------------------------------------------------------------------- |
| Code gate         | **green** — typecheck, lint, prettier, **1510 passed / 3 skipped**, 22:03 |
| Visual parity     | round 2 captured, codex accepted at desktop size                          |
| Interaction suite | **green — all 31 passed**, exit 0, no skips, 22:00                        |
| Open defects      | none known                                                                |

## Rounds

| #   | What was rejected                                                                                         | What changed                                                                                                                                     | Gate                                |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 1   | You: implementation does not match the approved composition                                               | built from the plan's prose, not the golden image                                                                                                | rejected 19:08                      |
| 2   | codex: split target hundreds of px wide, drag tile clipped, quotas unreadable                             | rail geometry, quota blocks                                                                                                                      | rejected                            |
| 3   | codex: accepted at desktop size                                                                           | header row restored, thin dashed edge split strip, DR drag tile, 212px session terminal, 171px composer with VS Code path                        | captured 20:57                      |
| 4   | full suite: voice rail 2px off-centre at phone width; a stale spec counted `@`/`#` as send actions        | `styles.css` 21:20, `specs.mjs` 21:22                                                                                                            | both targeted specs pass            |
| 5   | full suite 28/31 — macOS focus activation, agent response timeout, version-marker timeout                 | nothing; no assertion reported a wrong UI state                                                                                                  | reruns in flight                    |
| 6   | merge-selection check failed twice waiting for its marker                                                 | exact socket diagnostic rendered `remembered · MR a1b2c3d`; the helper can accept the first stale root before the requested project root arrives | harness correction next             |
| 7   | codex wedged — 16 leaked `codex app-server` children of the dev app, all 0% CPU. Killed; claude took over | `fake-ide.mjs` `awaitRoots(expect)`, two call sites in `specs.mjs`                                                                               | both specs pass, full suite running |

## The three flakes, resolved

Individually, sequentially — this harness is not safe to run concurrently, which
is what invalidated codex's first independent pass.

- `a session is one row` — **passed**
- `the question stays at the top` — **passed**, including **0px** compact rail offset
- `a merge request selection says` — **passed in 6s** after the harness fix, all
  four assertions, twice in a row. `Send asks the editor again`, which shares the
  same call shape, passed with all seven.

**It was not flake.** Two places send `setRoots`: `ide-bridge.ts:473` answers the
handshake with whatever the bridge holds at that instant, and `ide-bridge.ts:183`
sends the real update when the runtime resyncs. `setProjectDirectory` resolving
does not mean the bridge has the root yet, so the first frame can be empty.
`awaitRoots()` returned on that first frame, `const [root] = …` yielded
`undefined`, the bridge filtered the resulting `report()`, and the spec timed out
on a pill that was never going to render. The two specs that never flaked are
exactly the two that searched the roots array instead of destructuring it.

`awaitRoots(expect)` now waits for the frame that actually carries the requested
root, matched through `realpathSync` — macOS gives `/var/folders/…`, the app
canonicalizes to `/private/var/folders/…`. Test harness only; no product code,
no UI change.

## What is deliberately not being done

- No commit, no push, until you approve the visuals.
- No full-suite rerun for a CSS-only correction — targeted spec plus captures.
- True 200% zoom and working/waiting/failed states under live agent load remain
  documented follow-ups, not part of this gate.
