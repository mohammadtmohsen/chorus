# Status

| Phase                                    | State       |
| ---------------------------------------- | ----------- |
| 1 — say which `none` it is               | **shipped** |
| 2 — reproduce with a real keyboard first | not started |
| 3 — fix the named cause, and the stamp   | not started |
| 4 — put it in front of a person          | not started |

Running in a worktree at `../chorus-c003` off `fix/a-suite-that-can-go-red`, so
the terminal branch and its uncommitted work are never touched.

## Phase 1 — shipped

### What changed

`data-mention` reports the **raw parsed mention** again, one string meaning one
thing. Four attributes join it, and none of them carries a character anyone
typed: `data-mention-live` (`none` / `stale` / `live`), `data-mention-why` (which
of the four writers last decided), `data-stamp-len` against the existing
`data-draft-len`, and `data-left-box`.

All four `setMention` writers are tagged — the parse, the `dismissed` branch,
`choose`, and Escape. The first draft of the plan listed three of six decision
points; the review found the rest.

### Proved by forcing, not by reasoning

| forced condition                       | `data-mention` | `live`    | `why`      |
| -------------------------------------- | -------------- | --------- | ---------- |
| a real mention                         | `@0:c`         | `live`    | `parsed`   |
| `liveMention` mutated to always reject | `@0:c`         | **stale** | `parsed`   |
| draft with no mention in it            | `none`         | **none**  | `no-parse` |

The middle row is the whole point: before this, a rejected stamp and an absent
mention both printed `data-mention: "none"`, and the two unexplained runs could
have been either. They are now different records.

`pnpm check` green — 1288 passed. The mutation was reverted and verified absent.

### What the phase found on its way past

**React's `onSelect` does not fire from a synthetic `select` event.** The first
attempt to force a stale stamp wrote the DOM without an input event and then
dispatched `new Event('select')` — and nothing happened: `data-stamp-len` stayed
at the old value, so `refreshMention` never ran. React implements `onSelect` as a
polyfill over `selectionchange`, focus and pointer events rather than by
listening for `select` directly.

That matters for Phase 2 beyond the inconvenience. The plan's hypothesised race
is "a programmatic DOM write, then `onSelect` runs before the render", and this
says the second half of that sentence is harder to reach than the plan assumed —
a synthetic event will not do it. Phase 2's real-keyboard requirement is
therefore not only about avoiding a harness artifact; it is the only route to the
`onSelect` path at all.

## Not done, and deliberately

The **stamp blocker** — text equality lets a stale mention reactivate when the
same text returns, and `choose` mixes a stamped offset with a live caret — is
untouched. It is a real defect and it is Phase 3's, because the plan's rule is
that no fix is written before the failing record is in hand. This work has
already produced two fixes that were obviously right and measured worse.
