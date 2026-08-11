# STATUS

## Phase 0 done: the bug does not exist as filed

C-026 said the pane resizes itself forever. **It does not.** Measured with both
edges of `makeRoom` instrumented, at a stated window, with the probes the review
asked for. Instrumentation reverted; no production code changed.

| Condition                        | Observer callbacks |
| -------------------------------- | ------------------ |
| Wide pane, quiet, 10s            | 2                  |
| **Narrow pane, quiet, 10s**      | **0**              |
| Narrow, no spacer write, 5s      | 0                  |
| Narrow, pane resizes ignored, 5s | 0                  |
| Narrow, `scrollbar-gutter`, 5s   | 0                  |
| After a selection, 2s then 5s    | 0, then 0          |
| **After a resize, first 2s**     | **38**             |
| **The 8s after that**            | **0**              |

A resize provokes a burst of about **38 callbacks over roughly two seconds**, and
then it stops dead. Nothing else provokes anything, and a quiet narrow pane costs
nothing at all.

### What the original observation actually was

"Fourteen times in 107ms and still firing when the run ended" was true, and
meaningless. The 107ms sat **inside the two-second settling burst that follows a
resize**, and the burst had not finished — which is what "still firing" recorded.
Extrapolating it to "forever" was the mistake, and the review was right that
107ms could not support the word.

The same burst explains C-025 without any permanent loop: the retries there all
fell inside those two seconds, so every offer was destroyed by a scroll write
from the settling cascade. C-025's fix stands on its own regardless — an offer
should not die because the transcript moved — but its cause was a transient, not
a pathology.

### What the probes eliminated

- **The scrollbar is not involved.** `clientWidth` and `offsetWidth` were
  recorded on entry and exit of every callback, for the scroller and the content.
  Neither moved, in any run, at any width. The pane-width readings that suggested
  otherwise were taken _between_ callbacks and were the viewport override
  settling — exactly the ambiguity the plan's open question flagged.
- **The spacer is not running away.** `spare` moved 304 → 283 → 261 while `said`
  moved 408 → 429 → 451: converging, monotonically, not alternating. That is a
  damped settle, which is what the subtraction in `makeRoom` is for.
- **The 22px shrink never existed.** With `maxScroll` finally logged, one sample
  shows `scrollTop: 50` against `maxScroll: 49` — at the maximum, not a thousand
  pixels adrift. The arithmetic that produced 22px assumed what it needed to
  prove, as the review said.

### The one real finding, and it is small

A resize costs about **38 layout-and-observer cycles over two seconds** to
converge, rather than the two or three a settle should take. It does terminate.
Whether that is worth reducing is a genuine question — a resize is a user action
and two seconds of churn is perceptible — but it is a performance nicety, not the
defect that was filed.

### A driver bug worth recording

The first run reported **zero callbacks everywhere, including after a resize** —
which is impossible, since the observer watches the pane. The fault was mine:
`observe()` drained the log on entry, so every provoked measurement threw away
the burst it had just triggered. Only the quiet measurements were valid.

Suspecting the driver before the code is the house rule, and it was right again:
the app was behaving correctly the whole time.

### Not done

C-026 is being rewritten rather than worked on. Phases 1 and 2 of this plan are
moot as written — there is nothing to stop.
