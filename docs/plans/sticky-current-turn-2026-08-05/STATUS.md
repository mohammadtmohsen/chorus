# Status — sticky current turn

## Phase 1 done: current-turn structure and scroll anchor

`Session.tsx` splits the transcript at the last user message. Everything before
it stays ordinary history; that message and everything after it form a `.turn`
block, with the question and every waiting agent's thinking row sharing one
`.turn-head`.

`makeRoom` sizes a `.turn-tail` spacer so the turn is always at least one view
tall, and sets `--spare` so the rail stops short of that held-open room. The
room lives **inside** the turn: a pinned header travels only within its own
containing block, so a turn no taller than its own question gave the pin nowhere
to go. The existing bottom-follow keeps its opt-out; a new effect keyed on the
current turn re-anchors when a question is asked, since a short question below a
long answer can add less height than the spare room it takes away — the resize
observer sees nothing and the message stays halfway up.

## Phase 2 done: sticky presentation

`.turn-head` is `position: sticky` on the pane's own background, over the rail
and under the quote offer. Its offset is `calc(var(--score-top) * -1)`, not `0`:
a sticky offset is measured from the scroller's _content_ box, so `0` pinned the
header a padding's width down and left a strip above it that history slid
through. `.rail--turn` carries the rail through the opaque header, solid rather
than faded. The narrow gutter and the 390px layout both hold.

## Phase 3 done: regression coverage and verification

`e2e/specs.mjs` gains "the question stays at the top of the answer it asked for"
— 23 assertions across pin, thinking rows, rail continuity, long answers,
sideways overflow, scroll-back, the handoff to the next question, and the same
questions again at 390px. `harness.mjs` grew a generic `send` for the debugger
protocol, with `evaluate` rebuilt on it and a `viewport` helper, so the narrow
layout is asserted rather than eyeballed. Full e2e suite: 9 passed.
`pnpm run check`: green.

Verified live by screenshot at idle, thinking, streaming, complete, scrolled
back, second-message handoff, and at 390px.

## Phase 4 done: three things the spec found

Not in the plan; all three are consequences of pinning being reachable only by
being scrolled to, which turned quiet layout faults into visible ones.

- **Following stopped for good, one entry short of the bottom.** `onScroll`
  judged following by distance alone, so a transcript that gained an entry
  between a scroll being written and its event being delivered read as a reader
  who had wandered off — 34px, past the 32px threshold. It now stops only when
  the scroll actually went _up_, and always resumes at the bottom. Pre-existing;
  it merely used to cost a cropped last line rather than a stranded question.
- **The rail missed its own dots at phone width.** The compact gutter gave
  `.rail` and `.tick` the same `left`, which aligns their left edges — a 1px
  line beside a 7px dot is then 3px off. The line moved, not the dots. This is
  the bug the suite already has a spec for, in the one layout that spec never
  ran in.
- **The pinned header had no bottom edge.** It cuts whatever line of the reply
  is passing under it, which read as damage rather than an edge. A hairline now
  draws the cut, and only once a reply exists to divide — before that there is
  nothing under the header but the room held open for it.

### Trap for the next run

E2E specs bind debug ports from 9800 upward, per process. A stray Electron left
from a killed run keeps that port, and the next run silently attaches to the
_old_ app — so new code appears to do nothing. `pkill -9 -f Electron` before a
run, and check `lsof -nP -iTCP:9800 -sTCP:LISTEN`.
