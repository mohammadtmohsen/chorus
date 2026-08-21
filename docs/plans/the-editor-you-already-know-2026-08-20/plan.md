# The editor you already know

Making the tree, the diff, and the Changes panel legible to someone whose hands
already know VS Code — without pretending Chorus is an IDE.

## The problem, and why it is not the one we thought

The ask was "shall I use the VS Code open source to match the folder icons,
diffs, git functions". The honest answer is that **the decision was already
taken, on this branch, and never written down**.

`monaco-editor ^0.56` is a dependency. `MonacoDiff.tsx` (225 lines) and
`monaco-setup.ts` (145 lines) are both new and uncommitted, and Monaco is the
**default** diff view — `view: 'editor'`. So the fork in the road is behind us.
What is in front of us is narrower and more awkward: we are carrying VS Code's
editor without having argued for it, and we are carrying a second, hand-written
diff viewer beside it.

That matters because CLAUDE.md still says `@xterm/xterm` is _the_ exception and
that "the reason does not generalise". There are now two exceptions. The second
one has no paragraph justifying it, and its cost is real and measured: the
renderer's main chunk went **1.7 MB → 6.6 MB**, plus a 598 KB worker and 82 lazy
grammar chunks. Cold-start impact is **unmeasured**, and no budget is enforced.

> **Read this section as the problem statement it was, not as current state.**
> Everything above and in "Shape of the answer" below was written on
> 2026-08-20 _before_ any measurement. Phases 1 and 2 have since shipped and
> several of these sentences are now false — Monaco is no longer the default
> view, the launch cost is measured, and the icons exist. The phases carry the
> current position; `STATUS.md` carries what actually happened. This preamble is
> kept unedited because a plan that quietly rewrites its own premise loses the
> record of what was believed when the work was chosen.

So this plan does two things at once. It makes the surfaces familiar, and it
forces the Monaco question to be answered out loud rather than by default.

## What "feels like VS Code" actually decomposes into

Familiarity here is not one thing, and the four pieces have wildly different
cost-to-benefit:

**Icons are the largest visible gap and the cheapest to close.** There is no
icon system at all today — not the wrong icons, _none_. Both trees render text
chevrons (`▸`/`▾`) and nothing else, plus seven one-off inline SVGs scattered
across `QuickRail.tsx` and `SessionPreview.tsx`. A file tree with no file icons
is the single loudest "this is not VS Code" signal in the screenshot.

**The diff is already 80% there and the last 20% is configuration.** Monaco
gives word-level intra-line highlighting for free. Two behaviours that read as
quintessentially VS Code are simply switched off:
`renderSideBySide` is hardcoded `false` in `MonacoDiff.tsx:71` (VS Code's
default is `true`, with `useInlineViewWhenSpaceIsLimited` flipping to inline
below a 900 px breakpoint), and `hideUnchangedRegions` is unset, which defaults
to `false` in the library. Both are one-line changes.

**The SCM panel is structurally right and lexically wrong.** Staged/unstaged
grouping exists. Status letters exist. But the letter set is `A/D/M/R` where VS
Code's is `M A D R C T U I !`, and two of the mappings are counterintuitive
enough that guessing them produces a panel that is _confidently_ wrong — see the
phase.

**Chrome is the one to be suspicious of.** It is the largest surface, the least
reversible, and the least clearly good. Argued below.

## Shape of the answer

Take VS Code's _vocabulary_ — its letters, its colours, its two-tier diff wash,
its icon set — and decline its _architecture_. Concretely: keep the hand-built
tree and SCM panel, keep Monaco for the diff since it is already there, adopt
Seti for icons because it is what VS Code actually ships, and leave the app
shell alone.

The licensing research makes one choice for us and rules out the obvious
alternative:

| Component                          | License                          | Verdict                                                                                                |
| ---------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Code-OSS source                    | MIT                              | Reusable; the _branded binary_ is proprietary                                                          |
| Monaco Editor                      | MIT                              | Already in use                                                                                         |
| Seti theme JSON (in Code-OSS)      | MIT                              | Use; keep the notice                                                                                   |
| Seti artwork (`jesseweed/seti-ui`) | MIT © 2014 Jesse Weed            | Use; keep the notice                                                                                   |
| `material-icon-theme` 5.37.0       | MIT                              | Usable but **not VS Code's look** — a third-party theme; npm reports **1.67 MB unpacked, 1,387 files** |
| **`vscode-icons`**                 | code MIT, **icons CC-BY-SA-4.0** | **Avoid.** Share-alike, plus a branded carve-out with no per-icon provenance                           |
| `vscode-icons-js`                  | MIT, mapping only                | Ships zero art; last publish 2021-09-30, **~5 years stale**                                            |
| `@vscode/codicons`                 | icons CC-BY-4.0, code MIT        | UI glyphs only, not file types; needs attribution                                                      |

`vscode-icons` is the trap: its LICENSE file and its GitHub badge both say MIT,
and only the README says the icons are share-alike. Reading the LICENSE alone —
the normal, careful thing to do — gets it wrong.

Seti wins on a point that is about this codebase specifically rather than about
Seti: **it is a font**, so an icon is a codepoint plus a colour. That means
`textContent`, not markup, which satisfies the no-`dangerouslySetInnerHTML` rule
the same way xterm does — by construction, not by discipline. It is ~37 KB. And
it has **no folder icons at all**, which is not a gap here: it means Seti's own
design already matches the bare `▾`/`▸` chevrons the trees draw today.

---

## Phase 1 — Decide on Monaco, in writing

Nothing else in this plan is safe to build on until this is settled, because
every later phase either leans on Monaco or routes around it.

**The question.** Monaco is in the tree and is the default diff view. Do we keep
it? If yes, CLAUDE.md's "xterm is the exception and the reason does not
generalise" needs a second paragraph making the case, on the same standard xterm
was held to: is a conformant diff editor genuinely intractable to hand-roll, or
is this the convenience case the project rejects?

**What resolves it — and the trap in the obvious version.** "Measure with and
without" was the first answer here, and it does not work as stated.
`ChangesPanel.tsx:7` imports `MonacoDiff` **statically**, so switching `view` to
the hunks renderer changes what is drawn and not what is bundled. There is no
"without Monaco" build to measure until one is deliberately made.

### 1a. What first paint can and cannot decide

**It prices _eager loading_, not Monaco.** This is the correction that matters,
and the first draft of this phase got it wrong by putting a removal band on the
same ruler. A 400 ms static-import penalty that **disappears when the import is
made lazy** is evidence for lazy loading — it is not evidence that Monaco should
not exist. Deleting a capability because of how it was wired is the wrong
inference from the right number.

So this measurement answers exactly one question: **eager or lazy.** Whether
Monaco earns its place at all is a separate question with a separate measurement,
below.

**DECIDED — the metric is app first paint.** Monaco is imported statically, so it
is paid at launch whether or not a diff is ever opened.

**The boundary, precisely, because "first paint" is not self-defining.** Renderer
`performance.timeOrigin` to the `first-contentful-paint` entry from
`performance.getEntriesByType('paint')`. Three reasons: it is Chromium-native so
nothing in the app needs instrumenting; it isolates the **renderer**, which is
the only process Monaco's bundle affects; and it is read rather than computed, so
there is no timing code to get wrong.

**Protocol.** Packaged build, not `pnpm dev` — dev-server timings say nothing
about what ships. The "without Monaco" variant is a **build-time stub**, not a
refactor of production code. Then:

- **Alternate the variants run by run** — A, B, A, B — rather than ten of one and
  then ten of the other. Consecutive blocks let thermal state, background load
  and disk pressure drift between the blocks and land entirely on one variant.
  Interleaving spreads that drift across both.
- **Discard the first pair**, not the first run of each.
- Compare **medians**, not means; the distribution has a long tail in one
  direction only.

**Name the result honestly: this is not cold start.** Discarding the first pair
means the filesystem cache is warm, so what is being measured is a **routine
packaged launch on a warm machine** — the common case, and a legitimate thing to
optimise for, but _not_ a genuinely cold first-launch-after-boot. Reporting it as
cold start would overstate what the number covers.

**THRESHOLD — two bands.**

| Added first paint (median) | Outcome                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **< 100 ms**               | **Keep the static import.** Below the threshold at which a delay reads as instant; the cost is real but imperceptible, and static is simpler. |
| **≥ 100 ms**               | **Make the import lazy.**                                                                                                                     |

There is no removal band here, by design.

### 1b. Whether Monaco survives — a separate measurement, after 1a

Removal is decided on what Monaco costs **at the point of use**, once eager
loading is no longer confounding it. That means measuring **click-to-rendered-diff
after lazy loading is in place** — and rendered means the diff _with its
decorations painted_, not the component mounted. A mounted editor with no
highlighting yet is not what the user is waiting for, and stopping the clock
there would flatter the result.

Only that number can support deleting `MonacoDiff.tsx`, because only that number
speaks to what Monaco is for.

**The judgement it feeds.** The honest argument _for_ is not "diffs are hard" —
`FileDiff.tsx` renders a perfectly good unified diff in 166 lines. It is that
word-level intra-line diffing, collapsible unchanged regions with draggable
edges, an overview ruler and inline editing with `⌘S` are individually reasonable
and collectively a project. The argument _against_ is 6.6 MB and an upstream to
track.

Until measured, the 6.6 MB is an unpriced liability. That is the whole point of
the phase.

**Also decide: do both diff viewers survive?** `FileDiff.tsx` is retained on a
measured 7.1× DOM-node argument, which is a real number and a real reason. Two
viewers is defensible — Monaco for reading and editing, hunks for dense
scanning — but only if we say which is for what. Two viewers _by accident_ is
how one of them silently rots. Note this survives even the removal case in
reverse: if 1b keeps Monaco, `FileDiff.tsx` still needs a stated job.

**Exit criteria, in order:**

1. **1a** — first-paint medians for both variants, reported as _routine warm
   launch_ rather than cold start, and the eager-or-lazy call made against the
   100 ms line. ✅ **measured 2026-08-20**
2. **Lazy implemented, if 1a says so.** — not required; see below.
3. **1b** — click-to-content measured, and the keep-or-remove call made on that.
   ✅ **decided 2026-08-20** — hybrid: keep Monaco, hunks becomes the default
4. A paragraph in CLAUDE.md next to the xterm one, and a recorded decision about
   what the second viewer is for. ✅ **written 2026-08-20**
5. **Implementation** — flip the persisted default to `hunks`. ⬜ **not started,
   awaiting approval**

### Results — measured 2026-08-20

**Bundle, proven.** Built twice from the same tree, the second with `MonacoDiff`
aliased to a stub. `ChangesPanel.tsx:7` is Monaco's only importer, so the alias
removes the whole subtree:

|             | main chunk      | asset files |
| ----------- | --------------- | ----------- |
| with Monaco | **6,639,312 B** | 85          |
| without     | **1,767,433 B** | 3           |

Monaco costs **4.87 MB** in the main chunk, plus a 598,422 B worker and 82 lazy
grammar chunks. The "without" figure reproduces this repo's own pre-Monaco 1.7 MB
almost exactly, which is the evidence that the stub cut the right subtree and not
merely _a_ subtree.

**1a — first contentful paint, alternating A/B, first pair discarded, n=8 each.**

The runs were **paired**, so the paired median is the correct statistic — not the
difference of medians. Paired median **−8 ms** (A minus B), individual paired
differences spanning **−572 to +460 ms**. The difference-of-medians figure of
+22 ms was computed first and is the wrong test for this design; it is recorded
here only so it is not quoted later.

> **Result: no detectable FCP penalty in this harness. Retain the static import
> provisionally.** The variance is far too large to demonstrate that Monaco's
> penalty falls below a 100 ms non-inferiority margin — "no penalty measured" is
> not "penalty proven under 100 ms", and the threshold must not be reported as
> passed.

A 3.75× bundle difference producing no measurable first paint is best explained
by V8 compiling function bodies lazily: Monaco is imported at launch but never
_instantiated_, so it costs parse-scan rather than full compile. **That is an
inference from the shape of the result, not something measured.**

The deeper point is that first paint turned out to be **blind to Monaco
entirely** — which is exactly why it could never have decided removal. Had the
original three-band rule survived, it would have returned "keep static, Monaco is
cheap" on a metric that cannot see Monaco at all.

**1b — click to diff decorations, DOM-ready.**

**Say DOM-ready, not painted.** The timestamp is taken inside a
`MutationObserver` callback, which runs before the frame is composited. Only the
_detection_ is polled from Node, because Chromium throttles timers in an occluded
window; `bringToFront()` is called for the same reason. Stop condition is a diff
decoration with text content, never `.monaco-editor` merely existing.

**Environment:** the electron-vite production bundle in `out/`, driven by the
electron binary — **not the packaged `.app`**. Absolute times are therefore
comparative, not a production performance claim.

| Monaco, cold first open          | median    | raw (ms)                                             |
| -------------------------------- | --------- | ---------------------------------------------------- |
| ~~first attempt~~ **SUPERSEDED** | ~~146.9~~ | ~~207, 152, 243, 149, 128, 156, 126, 122, 118, 145~~ |
| **pristine state per launch**    | **110.4** | 110, 99, 111, 121, 78, 72, 119, 273                  |

**Why the first attempt was wrong, recorded because it nearly shipped as a
result.** It reused one `userData` directory across launches, so the panel
reopened with a file _already_ selected and its diff already rendered. A
`MutationObserver` cannot fire when the target state already holds, so those
samples were timing re-renders, not cold opens — and in the control run the same
defect surfaced as two "never became true" timeouts read as flakes, plus a 32 ms
sample sitting among 199–443 ms ones. The fix is a pristine copy of a seeded
profile per launch, plus an assertion that the stop condition is **false** before
the click. That assertion is the part worth keeping: it converts a silent wrong
number into a loud discard.

**The FileDiff control could not be measured on a click boundary — 8/8
discarded.** In the hunks view the diff is already rendered before an observer
can be armed; in Monaco it never is. The two viewers do not share a comparable
interaction boundary in this harness. That is _suggestive_ that `FileDiff`
completes within panel-open while Monaco does not, but it is equally consistent
with the panel auto-selecting a file and `FileDiff` simply being synchronous
enough to beat the first `evaluate` round-trip. **Not resolved, and not to be
quoted as a comparison.**

**1c — the shared boundary, which finally produced the comparison.**

Panel-open (`⌘⇧G`) → content-ready, for both viewers. `t0` is taken **in the
renderer**, in the same synchronous block as the synthetic keydown, so the Node
round-trip that delivers the instruction sits outside the measurement. Each
sample is a pristine copy of a profile seeded with the target view persisted, the
file already selected, and the panel closed. **10/10 valid pairs, 0 discarded.**

|              | median       | raw (ms)                                         |
| ------------ | ------------ | ------------------------------------------------ |
| **Monaco**   | **270.2 ms** | 345, 316, 256, 251, 296, 284, 394, 247, 247, 229 |
| **FileDiff** | **137.5 ms** | 172, 134, 167, 110, 117, 109, 224, 192, 141, 100 |

**Paired differences: 173, 182, 90, 141, 179, 175, 170, 55, 106, 129.**

> ### Paired median incremental cost of Monaco: **155.8 ms**

**This is a real effect, and the contrast with 1a is the reason to believe it.**
Every one of the ten paired differences is positive, and eight of ten exceed
100 ms, spanning 55–182. In 1a the paired differences spanned −572 to +460 and
straddled zero — noise. Here the sign never flips. Monaco roughly **doubles** the
time from asking for the panel to seeing a diff.

**Against the pre-registered rule, 155.8 ms is above the 100 ms line, so this is
a product tradeoff rather than an automatic keep.** What is being bought for
~156 ms is word-level intra-line diffing, collapsible unchanged regions, an
overview ruler and inline editing with `⌘S`. What is being paid is that plus
4.87 MB. That is a judgement about the product, not a number that decides itself,
and it is the one remaining item in Phase 1.

**Note the interaction with 1a: lazy loading would make this path worse**, since
a deferred chunk would be fetched and compiled on the very first open being
measured here. 1a's "retain the static import" therefore stands on this evidence
too, independently of first paint.

**Caveats that travel with every number above:** DOM-ready, not painted —
timestamps come from a `MutationObserver` callback, before compositing. The
`out/` production bundle under the electron binary, **not** the packaged `.app`.
Absolute times are comparative; the 155.8 ms _difference_ is the finding, not the
270 ms.

### DECISION — the hybrid

**Keep Monaco. Keep the static import. Make hunks the default view.**

The benchmark rejects _instantiating Monaco on every default panel open_. It does
not justify deleting a capability a user can ask for. Those are different claims,
and the 155.8 ms sits against the first one only.

- **Hunks is the fast review path** — the default. It reaches content in half the
  time, and reviewing a change is what the panel is for.
- **Monaco is the advanced editing path** — an explicit **Editor** view, for
  whole-file navigation, intra-line detail, folding and `⌘S`.
- **The import stays static.** Lazy loading would move the chunk fetch onto the
  opt-in transition, making the moment a user deliberately asks for Monaco worse
  than it is now — and 1a found no detectable first-paint penalty to justify it.
- **4.87 MB is an accepted distribution cost**, recorded as accepted rather than
  waved through as free. It is the price of the Editor view being available at
  all.

**Only new state changes; existing conversations keep what they have.** This
falls out of how the schema already works rather than needing migration code:
`view` is `z.enum(['editor','hunks']).default('editor')`
(`shared/workspace-layout.ts:215`), zod fills the default on read and the whole
object is written back — so any conversation whose panel state has ever been
persisted already carries `view: 'editor'` **explicitly**, and flipping the
default cannot touch it.

**Which has a consequence worth stating before anyone tests it:** on a machine
with existing conversations, this change will look like it did nothing. Only
panels with no persisted state pick up the new default. That is the correct
behaviour — an explicit user selection must survive — but read without knowing
it, "the default did not change" is exactly what a broken implementation would
also look like.

**Harness defects found and fixed, recorded because both were nearly misread as
flakes.** In 1a, two runs died to an in-page polling loop — the throttling trap
above. In 1b, three of six runs failed to open the panel, _alternately_ (1, 3,
5): the panel's open state persists across launches and `⌘⇧G` toggles, so the
chord was closing it every second run. The alternation is what identified it;
read as a flake it would have been retried forever.

---

## Phase 2 — File icons

The biggest visible win, and it attaches at exactly two call sites.

`FileTree.tsx:127` renders `'▾' : '▸'`, and `ChangesPanel.tsx:420` hardcodes `▾`.
Both already sit inside a fixed-width `.changes-tree-twist` span. A
`FileIcon({ path, directory, open })` module drops in with no structural change,
and incidentally deduplicates the chevron the two trees currently each own.

**The coverage trap — MEASURED 2026-08-20, and the claims hold.** Seti's
`icons.json` maps largely by `languageIds` rather than by extension, so `.ts`,
`.md` and `.json` do not resolve by suffix. These figures originally came from
the research stream that fabricated a source and were recorded as untrusted.
They have now been re-derived independently against this repo:

|                                                 | claimed      | **measured**                  |
| ----------------------------------------------- | ------------ | ----------------------------- |
| naive coverage (`fileNames` + `fileExtensions`) | 3.4%         | **13.1%** — 145/1107          |
| routed through a language-id lookup             | ~97.1%       | **97.1%** — 1075/1107         |
| Monaco language registry                        | 78 languages | **78**, 186 extensions mapped |
| `seti.woff`                                     | ~37 KB       | **37,284 B**                  |

Method: `git ls-files` (1,107 tracked files) resolved against
`extensions/theme-seti/icons/vs-seti-icon-theme.json` at `main` — 238
`fileExtensions`, 101 `fileNames`, 83 `languageIds`, 383 `iconDefinitions` — with
the extension→language map extracted from monaco-editor 0.56's own
`esm/vs/languages/definitions/*/register.js`, which is the registry
`languageFor()` reads at runtime.

**Naive coverage of 13.1% is the finding that justifies the phase.** Without
routing, 870 `.ts`, 84 `.md`, 38 `.mjs` and 36 `.tsx` files all resolve to
nothing — the panel would show icons on 145 files out of 1,107 and look broken.

**A correction, because the first pass of this measurement was itself wrong.**
It reported 2.9% naive and 96.8% routed. Both were too low: it compared raw
filenames, and **Seti's `fileNames` keys are lowercase without a single
exception**, so every capitalised name on disk missed. Folding case moves naive
from 2.9% to 13.1% and routed to 97.1% — which lands exactly on the figure
originally claimed. The bug was found by a unit test asserting `LICENSE` had no
icon; it does, via `license`.

**The residue after routing is 32 files, and 28 of them are `.json`** — confirmed
to be Monaco's doing, not Seti's: there are 84 language definitions in
monaco-editor 0.56 and **no `json` among them**, while Seti's `languageIds` does
carry both `json` and `jsonc`. So one explicit `.json → 'json'` entry, bridging
Monaco's omission rather than fixing Seti, takes coverage to **99.6%**
(1103/1107). The last 4 are `.gitignore`, `.prettierignore`, `.icns` and
`.codex-version` — a reasonable set to leave with
a default icon.

**Asset weight, measured:** `seti.woff` **37,284 B** (already compressed — gzip
makes it marginally larger), `icons.json` **54,732 B** raw / **7,871 B** gzipped.
**~45 KB shipped**, 92 KB on disk. Against `material-icon-theme`'s 1.67 MB
unpacked across 1,387 files, that is roughly **18× lighter** — and the phase's
premise survives its own audit.

**A dependency that couples this to Phase 1.** The routing strategy leans on
`languageFor()` in `monaco-setup.ts:131`, which reads Monaco's language registry.
If Phase 1 drops Monaco, that lookup goes with it and this phase needs its own
extension→language table. Phase 2 is therefore **not** independent of Phase 1,
contrary to how it read in the first draft. Either settle Phase 1 first, or
budget for a standalone mapping.

**Deliberately not doing:** folder icons. Seti has none, VS Code's default look
has none, and inventing them would make us look _less_ familiar, not more.

**Exit criteria:** the two coverage figures measured and recorded first; then a
pure `iconFor(path, languageId)` with tests, wired at both call sites.

---

## Phase 3 — The diff, mostly by configuration

**Two one-line switches first.** `renderSideBySide: true` plus
`useInlineViewWhenSpaceIsLimited` and `renderSideBySideInlineBreakpoint: 900`,
and `hideUnchangedRegions: { enabled: true, contextLineCount: 3,
minimumLineCount: 3, revealLineCount: 20 }` — those four numbers are VS Code's
own defaults, not guesses.

**Then the colours — but pick the target theme before picking any value.** The
first draft prescribed the older registry palette (20% line / 20% word) while its
own open questions noted that Dark 2026 uses roughly 15% / 30%. That is choosing
values before choosing what we are matching, and it cannot be resolved by taste
later: the two palettes disagree on both hue and weight.

**DECIDED — the target is Dark 2026 / Light 2026**, VS Code's current defaults,
shipped v1.113 (Mar 2026) and listed first upstream. That is what a fresh VS Code
install looks like today, which is the right anchor for "familiar".

**This decision reaches into Phase 4**, and that is the point of making it here:
the git decoration colours in that phase were drafted from the _older_ registry
palette. They have been replaced with the 2026 values. Matching "VS Code" without
naming a version is exactly how a palette ends up half one and half another.

Diff values, Dark 2026 / Light 2026:

| Key                                      | Dark 2026   | Light 2026                  |
| ---------------------------------------- | ----------- | --------------------------- |
| `diffEditor.insertedLineBackground`      | `#347d3926` | **`#9BB95533`** (inherited) |
| `diffEditor.insertedTextBackground`      | `#57ab5a4d` | `#587c0c26`                 |
| `diffEditor.removedLineBackground`       | `#c93c3726` | **`#FF000033`** (inherited) |
| `diffEditor.removedTextBackground`       | `#f470674d` | `#ad070726`                 |
| `editorGutter.addedBackground`           | `#72C892`   | `#587c0c`                   |
| `editorGutter.deletedBackground`         | `#F28772`   | `#ad0707`                   |
| `editorOverviewRuler.addedForeground`    | `#73c991`   | `#587c0c`                   |
| `editorOverviewRuler.modifiedForeground` | `#6ab890`   | `#0069CC`                   |
| `editorOverviewRuler.deletedForeground`  | `#f48771`   | `#ad0707`                   |

**Note the alpha, because it confirms the mechanism.** In Dark 2026 the line tier
is `…26` (≈15%) and the word tier `…4d` (≈30%) — unlike the older registry, where
both were ≈20%. The two-tier structure survives; the weights changed.

### Resolved 2026-08-20 — and Light 2026 has an upstream inconsistency

Both values previously marked _verify_ were chased to ground, and the answer is
that **2026-light.json does not set them at all.** Nor does anything in its
include chain: `2026-light → light_modern → light_plus → light_vs`, and
`diffEditor.insertedLineBackground` / `removedLineBackground` appear in none of
them. They fall through to the registry, read from `editorColors.ts` at `main`:

```
defaultInsertColor = rgba(155, 185, 85, .2)   // #9BB95533
defaultRemoveColor = rgba(255,   0,  0, .2)   // #FF000033
```

both registered for `dark` _and_ `light`.

**Which means Light 2026's two tiers disagree, in hue and in weight:**

|          | line tier (inherited)               | word tier (set)                   |
| -------- | ----------------------------------- | --------------------------------- |
| inserted | `#9BB95533` — yellow-green, **20%** | `#587c0c26` — dark olive, **15%** |
| removed  | `#FF000033` — pure red, **20%**     | `#ad070726` — crimson, **15%**    |

**RETRACTED — this was written up as "an upstream bug" and it is not one.**

The claim was that a 20% line tier under a 15% word tier inverts the scheme,
leaving changed words less prominent than the lines holding them. That compared
the raw alpha values, which is the wrong arithmetic: the two washes **stack**, so
changed words carry

```
1 − (1 − 0.20)(1 − 0.15) = 0.32
```

**32% against the line's 20% — the word tier is still stronger.** Dark 2026
reaches 40.5% the same way. The structure holds in both; light is merely flatter.

What genuinely remains is a **hue** mismatch — a yellow-green `#9BB955` line
under a dark-olive `#587c0c` word, and a pure-red `#FF0000` line under a crimson
`#ad0707` one. That may read as muddy or may be fine, and **nothing written here
can settle it, because it is a question about pixels.**

The mistake worth not repeating: a deliberate divergence from upstream was
nearly committed on arithmetic alone, without rendering either version. **So
Phase 3 does not get to pick from this table.** It has to draw faithful Light
2026 and a corrected variant in real light mode and compare them. Only then is
the alternative — line `#587c0c26` / `#ad070726`, word `#587c0c4d` /
`#ad07074d` — a defensible option rather than a guess.

**`gitDecoration.renamedResourceForeground` resolved the same way:** absent from
both 2026 themes _and_ from every theme in both include chains, so it takes the
git extension's registry default — `#73C991` dark, `#007100` light, the same
green as untracked.

**The mechanism, which is worth copying even though the values are undecided.**
VS Code's diff is _two stacked semi-transparent washes_: a whole-line tier
(`diffEditor.insertedLineBackground`) and a word tier
(`diffEditor.insertedTextBackground`) painted over it. The changed words read as
roughly twice as saturated because the washes **add** — not because the word
colour is stronger. The registry says why in so many words: "The color must not
be opaque so as not to hide underlying decorations." Sample the resulting pixel
colour and flatten it into one value, and it will be subtly wrong everywhere.

**These are Monaco theme colour keys, not hand-authored decorations.** The first
draft's exit criteria said "implemented as two decorations", which describes
VS Code's internals rather than Monaco's public surface. In Monaco they are keys
in the theme's `colors` map, and `monaco-setup.ts`'s `defineThemes()` already
bridges Chorus tokens to hex and is already re-called on `prefers-color-scheme`
change — so this is entries in an existing map, not new plumbing and not custom
decoration code.

**Deliberately not doing:** moved-code detection. It is still `experimental.` and
still `false` by default in VS Code itself as of 1.134 — matching VS Code means
leaving it off.

**Exit criteria:** a named target theme recorded here; both light and dark values
written down; side-by-side above 900 px with inline below it; unchanged regions
folded; and the two tiers expressed as two theme colour keys rather than one
blended value.

---

## Phase 4 — The SCM panel's vocabulary

**This is not a re-labelling job, and the first draft was wrong to call it one.**
"Structure is right, words are wrong" was a guess that survived because nobody
read the pipeline. Reading it: the status vocabulary is narrowed twice on the way
to the screen, and the letters cannot be added at the end of a pipe that already
threw the information away. This phase touches the parser, the reconciliation,
the renderer, i18n and tests.

**What the pipeline actually does today:**

- `packages/workspace/src/status.ts:13` parses **six** states —
  `added | modified | deleted | renamed | untracked | conflicted`. Porcelain-v2
  `u` lines _are_ handled, so conflicts survive parsing.
- `changed-files.ts:26` then reconciles diff-plus-status down to **four** —
  `added | removed | modified | renamed` — with untracked demoted to a boolean
  flag and **conflicted dropped entirely**. A conflicted path absent from the
  diff does not survive `mergeChanges` at all.
- `stateFromXy` tests for `A`, `D`, `R` and falls through to `modified`, so
  **`T` (type changed) is invisible**. And `parseEntry` routes every porcelain
  kind-`2` line to `renamed`, so **`C` (copied) is reported as a rename**.

**So the work, honestly sized:**

| Letter           | State today                                                                      | Work                                                                            |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `U` untracked    | **Already available** — `ChangedFile.untracked` is a boolean on the merged shape | Renderer selection, i18n key, colour. No parser or IPC change.                  |
| `!` conflict     | Parsed, then dropped in reconciliation                                           | Survive `mergeChanges`; widen the renderer-facing union; renderer, i18n, colour |
| `C` copied       | Collapsed into `renamed` at `parseEntry`                                         | Parser, union, reconciliation, renderer, i18n, colour                           |
| `T` type changed | Falls through to `modified` in `stateFromXy`                                     | Parser, union, reconciliation, renderer, i18n, colour                           |

**The two traps in the letters themselves**, which a careful person would get
backwards:

- **`U` means _untracked_, not _unmerged_.** Conflicts get **`!`**, with a source
  comment explaining the choice: _"Using ! instead of ⚠, because the latter looks
  really bad on windows."_
- **`C` means _copied_, not _conflict_.** Using `C` for conflicts would be
  confidently, invisibly wrong.

**`I` is deliberately excluded, and this is a correction to the first draft.**
VS Code defines an `I` mapping, but its own status command runs `git status -z
-uall` (or `-uno`) and **never `--ignored`** — so ignored files do not normally
enter the SCM groups at all. Adding `--ignored` here in the name of parity would
diverge from what VS Code actually does _and_ enumerate whole ignored trees like
`node_modules`. Chorus's parser already returns `null` for `!` entries with a
comment saying they are never interesting; that judgement was right. Matching
VS Code means leaving `I` unreachable, not implementing it.

**The colour mapping is deliberately not 1:1 with the letters.** `T` (type
changed) is coloured as _modified_; `C` (copied) is coloured as _renamed_;
untracked and renamed share the same green. Copy the mismatches on purpose.

**Dark 2026 / Light 2026**, per the target chosen in Phase 3. These are the
theme's overrides, not the git extension's registry defaults — the earlier draft
of this table used the registry values and would have mixed two palettes:

|                | Dark 2026 | Light 2026 |
| -------------- | --------- | ---------- |
| added          | `#73c991` | `#587c0c`  |
| modified       | `#e5ba7d` | `#667309`  |
| deleted        | `#f48771` | `#ad0707`  |
| untracked      | `#73c991` | `#587c0c`  |
| conflicting    | `#f48771` | `#ad0707`  |
| ignored        | `#8C8C8C` | `#8E8E90`  |
| stage-modified | `#e5ba7d` | `#667309`  |
| stage-deleted  | `#f48771` | `#ad0707`  |

**`renamedResourceForeground` is missing from that list and must not be
guessed.** The 2026 themes were not observed to override it, which would mean it
falls back to the registry default (`#73C991` dark / `#007100` light) — but
"was not observed" is not "does not exist". Read it out of the theme JSON before
implementing.

Note that in this palette **conflicting and deleted are the same colour**, and
**untracked and added are the same colour** — the older registry distinguished
both pairs. That is upstream's choice, not an error to correct.

**Two smaller things that carry a lot of familiarity.** Deleted filenames are
struck through. And a deleted file does _not_ propagate its badge up the folder
tree, while everything else does — that asymmetry is deliberate upstream.

**The commit box — and a correction, because the first draft read a bug as a
missing feature.** That draft said the placeholder should name the branch,
citing a screenshot showing `Message — commits or`. But `en.json:436` is already
`"Message — commits on {{branch}}"` and `ChangesPanel.tsx` already passes the
branch in. **The branch was always named; the string was clipped** — by the same
header-overflow bug that is explicitly out of scope. A rendering artifact was
mistaken for a gap, and the phase nearly gained an item to build something that
exists.

The real gap is the other half of VS Code's placeholder: the **keybinding**. VS
Code writes `Message (⌘Enter to commit on "main")` because `scm.acceptInput` is
bound to `⌘/Ctrl+Enter`. Chorus's commit form has `onSubmit` but **no keydown
handler**, so the shortcut does not exist. That leaves two honest options and one
dishonest one:

- Implement `⌘/Ctrl+Enter` — cross-platform, `metaKey` on macOS and `ctrlKey`
  elsewhere — and _then_ name it in the placeholder.
- Leave the placeholder as it is, naming only the branch.
- **Not an option:** advertise the shortcut in the string without implementing
  it. A placeholder promising a key that does nothing is worse than one that
  promises nothing.

**Deliberately not doing:** the Source Control Graph, incoming/outgoing sections,
and multi-repository views. Also worth knowing that `scm.showIncomingChanges` /
`scm.showOutgoingChanges` **no longer exist upstream** — that information moved
into the Graph view in v1.93. Copying the 2024 design would be copying something
VS Code has since removed.

**Exit criteria:** `U`, `!`, `C` and `T` reaching the renderer — which means the
renderer-facing union widened and `mergeChanges` no longer discarding conflicts —
with upstream's colour mapping including both deliberate mismatches, i18n keys
for every new letter, strikethrough on deletes, and reconciliation tests
covering a conflicted path that is absent from the diff. `I` stays unreachable
by decision, not by omission.

---

## Phase 5 — Chrome, and an argument for doing very little

This is in scope by request, and it is the phase I would most like to argue
down.

Chorus is a shared conversation with several agents. VS Code is a
single-developer file editor. Its chrome — activity bar, side bar, panel, status
bar — encodes _that_ app's information architecture. Adopting it wholesale would
make Chorus look like an IDE that happens to have a chat panel, which inverts
what the product is. `styles.css` is **9,752 lines**; a token-level reskin is not
a small change, and it is the least reversible thing in this plan.

**What is worth taking:** the diff and git colour tokens (phases 3 and 4, already
scoped), and one genuine gap — **light mode is a `prefers-color-scheme` media
query only.** There is no class, no setting, no way for a user to choose. Every
VS Code user expects to pick a theme. That is a real piece of missing function
hiding inside "chrome", and it is worth doing on its own merits.

**Where that setting lives, corrected.** The first draft pointed at
`ChangesPanelState` in `shared/workspace-layout.ts:179`. That is the wrong owner:
it is **per-conversation**, and appearance is **application-wide** — one
conversation in dark and the next in light is not a feature. The theme belongs in
the global `main/settings.ts:34`, alongside the other app-level preferences.

**And the mechanism is cheaper than a reskin.** CSS, Monaco (`themeNow()`) and
xterm _already_ follow `prefers-color-scheme`, so the setting does not need to
reach any of them individually. Electron's `nativeTheme.themeSource` moves what
the OS reports, and every existing consumer follows for free — no changes to
`styles.css`, `monaco-setup.ts`, the terminal, or the wordmark.

Two conditions on that, which are the whole implementation:

- **It must be applied before the first window opens**, or the app paints in the
  OS theme and then snaps to the chosen one — a visible flash on every launch.
  That is the same "set before anything reads a path" ordering constraint the
  `userData` override already lives under in `main/index.ts`.
- **It must be re-applied whenever the setting changes**, not only at boot.

**What is not worth taking:** the activity bar, the side bar model, and the
status bar.

**Proposed:** cut this phase down to the theme _setting_ — global settings entry,
`nativeTheme.themeSource`, applied pre-window and on change — and treat the rest
as a separate conversation with a mock in front of us rather than a phase in this
plan.

---

## What we are deliberately not doing

- **Not forking VS Code.** No serious version of this ask requires it, and no
  public quantified account of that maintenance burden even exists — the
  frequently-cited claims about fork-rebase teams trace to secondary commentary,
  not primary statements.
- **Not using `vscode-icons`** — CC-BY-SA-4.0 art with a branded carve-out.
- **Not using `material-icon-theme`** — MIT and well-maintained, but it is a
  third-party theme, not what VS Code looks like out of the box. It would buy
  _unfamiliarity_ at an order of magnitude more weight: npm reports 1.67 MB
  unpacked across 1,387 files, against a Seti font measured in tens of KB.
- **Not adding folder icons.** VS Code's default has none.
- **Not touching the `$HOME` tree bug or the overlapping panel header.** Both are
  real and both were seen in the screenshot that prompted this work; both were
  explicitly deferred. Recorded in open questions so they are not lost.
- **Not building the SCM Graph, incoming/outgoing, or multi-repo.**

## Open questions and risks

1. **Monaco's launch cost is unmeasured, and not yet measurable.** 6.6 MB main
   chunk, 598 KB worker. The static import at `ChangesPanel.tsx:7` means there is
   no "without Monaco" build to compare against until one is made deliberately —
   see Phase 1. Largest unpriced item in the plan. Note the split: 1a's first-paint
   number decides **eager vs lazy only**; whether Monaco stays at all is 1b's
   click-to-rendered-diff number, and conflating the two would delete a capability
   over how it happened to be wired.
2. **Do both diff viewers survive Phase 1?** If yes, write down which is for
   what. If no, deleting 166 lines with a measured 7.1× DOM argument behind them
   should be a deliberate act, not a tidy-up.
3. ~~**Which VS Code are we matching?**~~ **RESOLVED: Dark 2026 / Light 2026.**
   Phases 3 and 4 both updated to that palette. Two loose ends remain: Light
   2026's `insertedLineBackground` / `removedLineBackground` and the 2026
   `renamedResourceForeground` were not captured and are marked _verify_ rather
   than guessed. There is also an unresolved naming discrepancy upstream — the
   v1.113 release note calls them "VS Code Dark" / "VS Code Light", the code says
   "Dark 2026" / "Light 2026" — which matters only for knowing which file to open.
4. **A theme setting is a schema change — in the global settings file, not the
   per-conversation one.** Phase 5 now puts it in `main/settings.ts`. The
   `.default(...)` discipline still applies wherever it lands: the warning in
   `shared/workspace-layout.ts` is that a **required** field silently loses every
   open conversation, and a global settings file has the same failure mode
   against every existing install.
5. **CLAUDE.md is stale on two counts, independent of this plan.**
   `packages/workspace` is described as "read-only git status and diff", but
   `git-write.ts` now exports `stage`, `unstage`, `discard`, `commit`, `push`.
   And "xterm is the exception" is no longer true. Both should be corrected
   whether or not any phase here ships.
6. **Deferred, from the screenshot that started this:** `App.tsx:66` seeds
   `cwd: ''` and `runtime.ts:1334` reads `options.cwd.trim() === '' ? homedir()
: options.cwd`, so an unset cwd lists the user's home directory — with
   `git check-ignore` exiting non-zero outside a repo and being read as "ignore
   nothing". Separately, the panel header overlaps: "Compare against" collides
   with the toolbar and "Publish branch" clips. Neither is styling; neither is
   in scope here.

## Provenance — read this before trusting a number here

**One research stream fabricated a source while producing this material**, and
said so afterwards, unprompted. It claimed a sub-agent had reported and
attributed a block of icon findings to it; no such report existed. The concrete
damage was one invented figure — "~505 KB" for `material-icon-theme` — presented
as measured. That row has been replaced with npm's own `dist.unpackedSize`.

**This plan was then reviewed twice by Codex and revised against both rounds.**
That review caught four things worth recording, because each was a claim written
confidently on no evidence: Phase 1's benchmark was unrunnable (static import);
Phase 4 was sized as "words and colours" when it is a parser-to-renderer change;
the commit-placeholder item was built on a _truncated screenshot string_ and
would have re-added something that already exists; and Phase 4 would have added
`--ignored` for a letter VS Code itself never reaches. Codex was in turn wrong
once — it applied the global plan format over this project's, which overrides it —
and that correction was accepted rather than followed.

The lesson is not the number. It is that a fabricated citation makes a whole
document unauditable, because the reader has no way to know which half to
re-check. Hence this section, which sorts every load-bearing claim by how it can
be re-derived.

**Verified directly, re-derivable in one command:**

- 1.7 MB → 6.6 MB main chunk — this repo, `docs/plans/a-window-on-the-whole-change-2026-08-19/STATUS.md:192`
- `seti-ui` 1.11.0, MIT and `material-icon-theme` 5.37.0, MIT, 1.67 MB unpacked / 1,387 files — `npm view`
- Everything in the "what exists today" sections — read out of the working tree

**Read from primary source by a research stream, cited, not independently
re-read by me:** VS Code's git decoration colours (`extensions/git/package.json`),
diff colours (`editorColors.ts`), the `!`/`U`/`C` status letters
(`extensions/git/src/repository.ts`), and Monaco's diff defaults
(`diffEditor.ts`). These arrived with file paths and were cross-checked against
tags 1.134.0 and 1.104.0. I consider them sound but I did not re-fetch them.

**Derived, not literal:** overview-ruler hexes are
`transparent(gutterColor, 0.6)` — they appear nowhere as constants.

~~**Not verified by anyone, and load-bearing for Phase 2:** the Seti icon-coverage
figures and asset weight.~~ **RE-DERIVED 2026-08-20 and they hold** — 13.1% naive
against a claimed 3.4%, **97.1% routed against a claimed 97.1%**, `seti.woff` at
37,284 B against a claimed ~37 KB. Measured against `git ls-files` and
monaco-editor 0.56's own registry; method and residue in Phase 2.

Worth stating plainly, since the fabrication is recorded above: **the stream that
invented one figure had the others substantially right.** That is not a reason to
have trusted them — a source that fabricates once cannot be audited by spot
checks, which is why they were re-derived rather than accepted. But the record
should say the numbers survived, not imply they failed.

Nobody ran VS Code to confirm any of this visually, and nobody ran Chorus.
