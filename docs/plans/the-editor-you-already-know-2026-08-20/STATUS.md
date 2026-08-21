# STATUS — the editor you already know

## Phase 1 — Decide on Monaco · **shipped 2026-08-20**

**Shipped differently from how it was planned, twice, and both corrections
mattered more than the result.**

The plan's first version put a _removal_ band on a first-paint measurement. That
was wrong: first paint prices **eager loading**, not Monaco. A penalty that
disappears when an import is made lazy argues for lazy loading, not for deleting
a capability. The phase was split into 1a (eager vs lazy) and 1b (keep vs
remove), on different boundaries.

Its second version then specified a measurement that **could not be run**.
`ChangesPanel.tsx:7` imports `MonacoDiff` statically, so toggling the view
changes what is _drawn_, not what is _bundled_. There was no "without Monaco"
build until one was made deliberately — a build-time alias to a stub, which also
proved itself: the stubbed bundle came out at 1,767,433 B, reproducing this
repo's own pre-Monaco 1.7 MB figure.

**Measured.** Monaco costs **4.87 MB** on the main chunk (6,639,312 vs
1,767,433 B), plus a 598 KB worker and 82 grammar chunks.

- **1a, first contentful paint**, alternating A/B, first pair discarded, n=8:
  paired median **−8 ms**, individual differences spanning −572 to +460. No
  detectable penalty — and the variance is far too wide to claim the penalty is
  _under_ 100 ms. "No penalty measured" is not "penalty proven small".
- **1b, panel-open → content-ready**, 10/10 valid pairs: Monaco **270.2 ms**
  against FileDiff's **137.5 ms**, paired median **+155.8 ms**, every pair the
  same sign.

**Decision: the hybrid.** Keep Monaco, keep the static import, make hunks the
default. 155.8 ms on every default open is the trade the measurement rejects;
Monaco stays as the opt-in Editor view for whole-file navigation, intra-line
detail, folding and `⌘S`. Lazy loading was rejected _because_ of 1b — it would
move the chunk fetch onto the very transition a user chose deliberately. 4.87 MB
is recorded as an accepted distribution cost, not a free one.

**Landed:** `view` default flipped to `hunks` in `shared/workspace-layout.ts`
(schema and `CLOSED_CHANGES_PANEL` together), a Monaco paragraph in `CLAUDE.md`
beside the xterm one, and `changes-panel.mjs` updated.

**Two things worth carrying forward.**

A persisted `'editor'` is never migrated — it may be a deliberate choice, and the
schema cannot tell that from an old default. Because zod fills defaults and the
whole object is written back, **every existing conversation already carries
`view: 'editor'` explicitly**, so on a machine with history this change looks
like it did nothing. That is correct, and indistinguishable from broken.

And a comment in `changes-panel.mjs` was wrong about its own purpose. It clicked
"Editor" saying it was restoring the default view; the reopen assertion it named
actually checks the _base_. What needed Monaco was everything between: the tree
reads `docs/never-touched.md` out of `.monaco-diff-host`, and the save
assertions drive `⌘S`. Deleting the line — which looked right once `hunks`
became the default — would have broken both.

## Phase 2 — File icons · **shipped 2026-08-20**

**Gated on a measurement, and the measurement was wrong the first time.**

The coverage figures justifying this phase came from a research stream that
fabricated a citation, so they were re-derived rather than trusted. The first
re-derivation compared raw filenames and undercounted: **Seti's `fileNames` keys
are lowercase without a single exception**, so every capitalised name on disk
missed. Folding case moved naive coverage from 2.9% to **13.1%** and routed from
96.8% to **97.1%** — landing exactly on the originally claimed figure. Found by a
unit test asserting `LICENSE` had no icon; it does, via `license`.

Final, against 1,107 tracked files: **13.1% naive → 97.1% routed → 99.6%** with
one `.json → 'json'` entry bridging Monaco's omission (84 language definitions in
0.56, no `json` among them). Residue is four files. `seti.woff` is **37,284 B**;
~45 KB shipped with the gzipped JSON, against `material-icon-theme`'s 1.67 MB.

**A real bug, caught by an assertion written for something else.**
`fontCharacter` is `"\\E05A"` — a five-character **CSS escape**, not a codepoint.
VS Code hands it to a `content:` declaration and lets the stylesheet parser
decode it. Set as `textContent` — which is the entire safety argument for using a
font — it would have rendered a literal backslash and four hex digits beside
every filename. The test that caught it asserted the glyph was under four
characters, and was about _markup safety_. This is the Adapters rule one level
out: read the shape out of the file.

**Landed:** `file-icon.ts` (pure, exported, 9 tests), `FileIcon.tsx`,
`@font-face` and `.file-icon` in `styles.css`, one line each in `FileTree.tsx`
and `ChangesPanel.tsx`, and three vendored assets under `assets/` —
`seti.woff`, `seti-icons.json`, `seti-NOTICE.txt` (upstream's own attribution,
MIT, Jesse Weed). The JSON is in `.prettierignore`: reformatting a vendored file
makes it undiffable against upstream, which is the only way to tell it is still
what we vendored.

**Verified in the running app**, 9/9 — including the one the gate cannot reach.
A font that 404s fails _silently_, so the load-bearing assertion is
`document.fonts.check('16px seti')` → `seti:loaded`, not the DOM. Glyphs measure
15.18 px with per-type colours; `.codex-version` correctly gets no icon element
at all; directories keep their chevron.

## Phase 3 — The diff · **shipped 2026-08-20**

**Scoped to Monaco in the plan; shipped covering both viewers, because Phase 1
invalidated the premise.** The plan assumed Monaco was the default diff. Phase 1
made hunks the default, so the diff most people see was the one the phase did
not mention. Widened by decision, recorded here rather than silently.

**The default view was tinted with an agent's identity colour.** `.line--added`
was `--codex` at 12% and `.line--removed` was `--alert` — resolving to
`--voice-codex` (`#7fd1c1`, teal) and `--danger`. So an addition was painted in
**one agent's brand colour**, in a panel where agent identity carries meaning,
and a deletion in the colour reserved for danger. It read as a considered choice,
which is why nothing surfaced it.

**Landed.** A shared palette as CSS custom properties —
`--diff-{line,word,gutter}-{added,removed}` — read by both viewers. Dark from
Dark 2026; light faithful to Light 2026, **including the two line tiers it does
not set** and which fall through to the registry's `#9BB95533` / `#FF000033`.
Monaco's `defineThemes` went from two diff keys to six: only the _word_ tiers
were set before, so it fell back to its own built-in line backgrounds — a palette
nobody chose, sitting under colours somebody did. Plus `hideUnchangedRegions` on
with VS Code's four values.

**Verified in the app**, 6/6. The two-tier stack is now measurable: line
`rgba(52,125,57,0.15)` under word `rgba(87,171,90,0.3)` — 15% and 30%,
compositing to the predicted 40.5%. Folding reduced a 300-line file to 18
rendered lines across 2 hidden-region widgets.

**`renderSideBySide: true` is inert, and that is the correct outcome.**
`CHANGES_WIDTH.max` is 820 and the editor measured **347px** at every window
size — the panel is a fixed strip, not a window. Both are under the 900px
breakpoint, so it resolves to inline every time, which is exactly what VS Code
renders in a pane this narrow. Kept rather than reverted to a hardcoded `false`:
it states the rule instead of one of its outcomes, and it starts working by
itself if the panel's max width ever rises. Lowering the breakpoint to force a
split would mean two ~400px columns of code and a divergence from the thing being
matched.

**Two failures in the first verification run were both the test, not the code** —
a fixed 2.5s sample that read the DOM before Monaco's worker had decorated it,
and an assertion that resized the _window_ to test a breakpoint measured on the
_editor_. Worth recording because "side-by-side does not work" was the obvious
reading of the output and was wrong twice over.

## Phase 3 — original entry (superseded)

Unblocked 2026-08-20: both values previously marked _verify_ were resolved by
finding they are set **nowhere** in Light 2026's include chain
(`2026-light → light_modern → light_plus → light_vs`), so they fall through to
the registry's `#9BB95533` / `#FF000033`, read from `editorColors.ts`.

**A claim was then made and retracted in the same day, and the retraction is the
point.** This first went down as "Light 2026 has an upstream bug — the line tier
is heavier than the word tier, inverting the scheme". That compared raw alphas.
The washes **stack**: `1 − (1 − 0.20)(1 − 0.15) = 0.32`, so changed words sit at
32% against the line's 20% and the word tier is still stronger. Dark 2026 reaches
40.5% the same way. Nothing is inverted.

What remains is a **hue** mismatch, which is a question about pixels and cannot
be settled in prose. A deliberate divergence from upstream was nearly committed
on arithmetic alone. Phase 3 must render faithful and corrected variants in real
light mode and compare before choosing.

## Phase 4 — SCM vocabulary · **shipped 2026-08-20**

Re-scoped after review before any code: a parser-to-renderer change, not the
re-labelling the first draft assumed. Five layers — parser, IPC contract,
reconciliation, renderer, i18n — plus tests.

**The worst of the three was not a missing letter.** Kind-`2` porcelain lines are
"renamed **or** copied", and the XY code says which. Every one was read as a
rename, so **a copied file reported its source as if the original had moved** —
a false statement about the tree rather than an absent distinction.

**Second: conflicts were dropped entirely.** A path can be conflicted and absent
from `git diff` — both sides deleted it, say — and `mergeChanges` skipped
anything that was neither in the diff nor untracked. The panel hid exactly the
files a merge needs to show. Conflicts now also outrank a diff that _does_
describe them, because rendering one as an ordinary modification is how a
conflict gets committed by accident; the counts still come from the diff.

**Third: untracked reported `status: 'added'`**, making `U` and `A` the same row.

**Landed:** `FileState` widened with `copied` and `typechanged`; `stateFromXy`
reads `T`; kind-`2` reads `C`; `ChangedFile.status` widened to the merged
vocabulary; letters `C T U !` and tooltips in i18n; `gitDecoration.*` colours
from the 2026 themes with **both upstream mismatches copied on purpose** — `T`
coloured as modified, `C` as renamed — and strikethrough on deletions.

**Verified in the app**, 11/11, against a fixture holding a **real merge
conflict** rather than a simulated one. `!` at `#f48771`, `U` at `#73c991`, `T`
at `#e5ba7d` (the modified colour, as upstream does it), `D` struck through and
nothing else struck.

**`C` is correct and unreachable.** Probed at the git level before trusting it: a
byte-identical file at a new path is reported `1 A.` — a plain add — **even with
`status.renames=copies` set**. So the parser now labels a copy correctly if one
ever arrives, but `git status --porcelain=v2` as invoked here does not produce
one. Same shape as `I`: the code is right, the state does not come. Recorded so
nobody hunts for a `C` that git is not sending.

**Two defects the typecheck caught**, both from the five-file discipline working:
`shared/ipc.ts` carries its own copy of the union and refused to build until
widened; and `STATUS_WINS` as a `Set<string>` did not narrow, leaking `deleted`
— the status's word — into a union that says `removed`. It is a type guard now.

## Phase 5 — Appearance · **shipped 2026-08-20**

**Argued down before it was built, and the argument was most of the value.** The
plan scoped "overall chrome": activity bar, side bar, status bar, a token-level
reskin of a 9,752-line stylesheet. That was rejected as inverting the product —
Chorus is a shared conversation with agents, and VS Code's chrome encodes a
single-developer file editor. What survived was the one genuine gap inside it:
**light mode was a `prefers-color-scheme` media query with no switch attached**,
so the only way to change appearance was to change the whole machine.

**Corrected before implementation:** the first draft put the setting in
`ChangesPanelState`, which is per-conversation. One session in dark and the next
in light is not a feature. It lives in global `main/settings.ts`.

**The mechanism is one line, and that is the point.** `nativeTheme.themeSource`
moves what Chromium reports for `prefers-color-scheme`; CSS, Monaco's
`themeNow()`, xterm and the Seti icons all already answer to that query, so none
of them needed changing. A per-consumer theme prop would have been a second
mechanism doing the same job worse, and would have missed whichever consumer was
added next.

Two conditions, both implemented: applied **before the first window opens** — set
it after and the app paints in the OS appearance then snaps, a flash on every
launch — and **re-applied on every settings write**, from the stored value rather
than the request, so a write that does not mention the theme re-asserts it
instead of clearing it.

**Landed:** `theme: 'system' | 'light' | 'dark'` in `main/settings.ts` and
`shared/ipc.ts` (both `.default('system')`, or every settings file written before
this would fail its parse and reset), `main/theme.ts`, the call before
`createWindow()`, the call in `settings:write`, an `Appearance` fieldset in
`Settings.tsx`, and five i18n strings.

**Verified in the app**, 8/8, and the assertions are deliberately on consumers
**this phase never touched**: the app ground `#181818 → #f6f8fa`, Phase 4's SCM
letters `#73c991 → #587c0c`, Phase 3's diff wash `#347d3926 → #9bb95533`, and
Phase 2's icons `rgb(81,154,186) → rgb(73,139,167)`. The choice survives a
relaunch and the media query already reports it at first paint, which is the
before-the-window condition holding.

**Deliberately not done:** the activity bar, the side bar model, the status bar.

## Everything left open

- **`C` is unreachable** — parsed correctly, but `git status --porcelain=v2`
  does not report copies even with `status.renames=copies`. Phase 4.
- **Light 2026's hue mismatch is unexamined by eye.** Shipped faithful by
  decision; the retraction established it cannot be settled in prose.
- ~~**Deferred from the screenshot that started all this.**~~ **Both fixed
  2026-08-20**, and neither was what it looked like — see below.
- **The e2e suite has not been run** against any of this. Five verification
  scripts drove the app directly instead; `changes-panel.mjs` was edited in
  Phase 1 and its edits are reasoned, not executed.
- **Thirteen items shipped after the plan ended.** They are Phase 6 below.

Phase 5 was argued down to a theme _setting_ only, moved from per-conversation
state to global `main/settings.ts`, using `nativeTheme.themeSource`.

## The two screenshot bugs · **fixed 2026-08-20**

Deferred through every phase, then fixed last. **Neither was the bug it was
reported as**, and in both cases the wrong diagnosis was the obvious one.

### The home directory was a race, not a path resolution

Reported — and recorded here for four phases — as `cwd: ''` resolving to
`homedir()`. That resolution is deliberate and documented in `runtime.ts:1334`:
an empty directory means "start at home", because the filesystem is a starting
point rather than a boundary. Nothing was resolving wrongly.

The defect is in `App.tsx`. The auto-start effect fired on `restored` alone,
while `defaults.cwd` sat at its placeholder `''` until a **separate**
`readSettings` round trip answered. Restore is a database read; settings is a
small JSON read; restore usually wins. So the first session of a launch was
created before anyone had said where it should be, and the runtime — correctly —
started it at home. The panel then listed every dotfile in it.

**Confirmed rather than argued:** the settings on this machine name
`/Users/mohamadtaleb/code/hub`, and the session still opened at home. That is
what turned a plausible story into a diagnosis.

Fixed by gating the effect on a `settingsRead` flag, set in a `.finally()` so a
settings file that cannot be read still leaves the app able to open a session.

### The header overlap was an undefined CSS class

"Compare against" is `<span className="visually-hidden">` — a screen-reader-only
label. **`visually-hidden` is not a class this stylesheet has ever defined.** An
undefined class is not an error at any layer: the span rendered at full size
inside a flex header, pushed the toolbar sideways, and clipped the last control
off the right edge. It read as a layout bug in the header and was a typo in a
label nobody was meant to see.

The codebase already had the utility under another name — `.sr-only`, with the
complete clip-rect pattern. Changed to use it rather than defining a second one.

**Verified in the app**, 6/6: the first session opens on the configured folder
and not on home; the label is still present for screen readers at 1×1px,
`position: absolute`; and the furthest control in the header sits at 1414px
against a header edge of 1423px, so nothing overflows.

---

## Phase 6 — Everything after the plan · **shipped 2026-08-20/21**

The plan ended at Phase 5. What follows was asked for by hand while driving the
result, and is recorded here because none of it was in the plan and all of it
shipped. Thirteen items, in the order they were asked for.

### The panel became two views, not one

**1 · The file manager is separate from Changes.** An activity rail inside the
panel — `ExplorerIcon` and `SourceControlIcon` — the way VS Code separates
Explorer from Source Control. `ChangesPanel.tsx` grew `panel.column`, and the
column decides the mode rather than the selection doing it:

```ts
const fromTree = panel.column === 'tree'
const editorMode: 'diff' | 'file' = fromTree || selectedDiff === null ? 'file' : 'diff'
```

**2 · The Files tab shows a regular editor, not a diff.** This was reported
twice — first as "still shows the changes only view", then as "the files view
have two numbering columns". Both are the same defect: a Monaco _diff_ editor
renders two gutters, so a file opened from the tree looked like a diff of itself.
`MonacoDiff` took a `mode: 'diff' | 'file'` prop; the tree always asks for
`file`.

**3 · A resizable divider between the file list and the diff**, `startListResize`
on `.changes-split`.

**4 · The divider position persists**, in the workspace layout schema alongside
the rest of the panel's state.

**5 · The chat side has a smaller minimum width**, so the editor gets the room.

### The staging controls

**6 · The tree's disclosure arrow is bigger.**

**7 · The `+` / `−` / discard icons are bigger and actually visible.** They were
present and unreadable.

**8 · `+` and `−` moved to the trailing edge**, after discard, so the
destructive action is not the one nearest the pointer's resting place.

### Autosave, and the bug underneath it

**9 · Autosave** — `AUTOSAVE_PAUSE_MS = 1_000`, with `flush()` shared by `⌘S` and
the pause so there is one write path rather than two that drift.

**10 · The editor rendered blank, and the first diagnosis was wrong.** I blamed
HMR staleness; a fresh window disproved it. The actual cause was **React
StrictMode double-invoking the effect** against `monaco.editor.create()`'s
default empty model, with a `loaded` ref surviving the first disposal. The fix
is `loaded.current = null` in **both** cleanups — and a guard in `flush`, because
writing `('', null)` with no baseline raised spurious conflicts:

```ts
const was = loaded.current
if (was === null) return
if (was.modified === content) return
```

**11 · Every automated probe had been running against the wrong React.** The
harness only ever built production, where StrictMode does not double-invoke —
which is why four probes deep the bug was invisible to tests and plain to the
user. `CHORUS_DEV_RENDERER=1` now builds the renderer against React's
development runtime; `--mode development` alone does not do it, because vite pins
`NODE_ENV` to production for any build. `ensureBuilt(mode)` stamps `out/` and
wipes it when the mode changes, after four `changes-panel.mjs` failures that were
mixed dev/production artifacts breaking Monaco's worker and looked exactly like a
code regression.

### Two startup bugs found on the way

**12 · Dev and the installed build shared a data directory.** A schema written by
one could break the other. `main/index.ts` now splits dev onto its own
`…-dev` path unless `CHORUS_USER_DATA` overrides it. This is also what made the
performance fixture work possible: a copy can be pointed at safely.

**13 · The Zod `invalid_union` on startup**, the screenshot that opened the
session — auto-start raced `readSettings`, `restored` won, and the first session
opened at `homedir()`. Auto-start is now gated on `settingsRead`.

### What is unverified

None of the thirteen has been driven by the e2e suite. Items 1–9 were verified by
hand, by the person who asked for them; 10–13 were driven with direct probes.
`changes-panel.mjs` was edited during this work and its edits remain reasoned
rather than executed.

**One thing this work broke and did not notice**, found later while profiling:
the control-rail redesign dropped `onOpenHistory`, leaving `HistoryPanel`
unreachable from anywhere in the UI. Repaired, with a guard, under
`the-conversation-that-got-too-big-2026-08-21`. `SessionRow`'s row component,
`data-arrange-toggle` and the `.session-drawer` CSS are dead code left behind by
the same redesign, and six `specs.mjs` cases still drive them — see that plan's
STATUS.
