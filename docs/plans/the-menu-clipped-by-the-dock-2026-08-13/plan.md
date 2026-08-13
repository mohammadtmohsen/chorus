# The menu clipped by the dock

## Status

| Phase                                           | State                                                    |
| ----------------------------------------------- | -------------------------------------------------------- |
| 1 — make visibility, not DOM presence, the test | shipped — failed on the unfixed build, passes on the fix |
| 2 — move the popup outside the clipping subtree | shipped                                                  |
| 3 — drive the real menu                         | shipped — driven and screenshotted, `pnpm check` green   |

**Phase 1 held the bug in its hands before the fix landed.** With `Composer.tsx`
and `styles.css` stashed, the new assertion reported
`{"ok":false,"why":"score","row":{"top":770,"bottom":797},"dockTop":796}` — the
first row drawn from 770 to 797, the dock's clip starting at 796, and
`elementFromPoint` at the row's centre returning `.score` from the transcript
behind it. Restored, the same point returns `mention-detail`.

**One deviation, and it is the stacking note in Phase 2.** "Keep the current
stacking intent" required changing the number: `z-index: 5` was chosen when the
menu lived inside a pane, and out on the body it is stacked against the whole
window — under the sidebar's 60. It is now `70`, the same value and for the same
reason as `.workspace-session-profile-menu`: clear of the sidebar, under the 80
a sheet covers everything with.

**What Phase 3 actually observed**, at 1854×… and again at 900×620: a bare `@`
sits at 723–759 with the dock's edge at 755, so 32px of it is now painted where
nothing was; `left`/`right` match the composer's exactly and the 6px gap is
preserved; narrowing to `@mention-menu` grows it upward to 696; `↓` moves the
highlight and `↵` inserts `apps/desktop/src/renderer/src/mention-menu.ts` and
closes the menu; 50 commands in a 620px-tall window cap at 40vh and scroll inside
themselves rather than running off the top; and typing five lines into the box
moves the popup up with it (653–689 against a composer top of 695). No flash at
the viewport origin was seen — the layout effect places it before the first
paint, and the `visibility: hidden` guard covers the frame if one is ever lost.

**Not covered by this.** The 28-spec e2e suite was not run; the two menu specs
(`an @ offers the cast…`, `typing a slash offers the commands…`) were, and pass.

## Why this is still broken

The earlier mention fix repaired derivation and focus state. It did not prove that
the resulting listbox was painted. The existing end-to-end spec stops at finding
`.mention-menu .mention-name`, so a popup hidden by an ancestor passes it.

The supplied screenshot and the running app name the layout defect. The bare `@`
menu measures 35.5px high, from 765.5px to 801px. Its `.dock` ancestor begins at
796px and has `overflow-y: auto`, leaving exactly 5px visible. That scroll
container was added to keep large approval cards reachable; removing its overflow
would trade this bug for that one.

## Shape of the answer

The menu leaves `.dock` while it is open. `Composer` portals the listbox to
`document.body`, positions it from the composer's measured viewport rectangle,
and refreshes that position when the viewport or composer geometry changes. Its
keyboard, pointer and ARIA behaviour remain owned by `Composer`.

The regression assertion samples the popup through `document.elementFromPoint`.
That asks whether Chromium can actually paint and hit-test a row above the dock,
which fails on the current build even though the row exists in the DOM.

This deliberately does not relax `.dock` overflow, change mention lookup or
focus state, or turn the menu into in-flow content that moves the composer.

## Phase 1 — make visibility, not DOM presence, the test

Extend the existing `an @ offers the cast, then the project's files` desktop
spec in `apps/desktop/e2e/specs.mjs`. After a bare `@` produces rows, sample a
point in the menu above the dock and require the hit-tested element to belong to
the listbox. Run that one spec first and keep the current failure as proof that
the assertion catches the screenshot's defect.

## Phase 2 — move the popup outside the clipping subtree

In `apps/desktop/src/renderer/src/Composer.tsx`, render the existing listbox
through a body portal and keep a fixed viewport position derived from the
composer box. Update the position on opening, window resize, ancestor scroll and
composer resize so attachments, textarea growth and dock scrolling cannot leave
the popup behind.

In `apps/desktop/src/renderer/src/styles.css`, make the portalled menu fixed and
width/edge controlled by its measured anchor. Keep the current height bound,
scrolling, colours and stacking intent, and remove the duplicate `max-height`
and `overflow-y` declarations encountered in the same rule.

## Phase 3 — drive the real menu

Run the focused `@` end-to-end spec and inspect the popup in the real Electron
window. Verify a bare `@`, narrowing to a file, keyboard selection, and the menu
at a constrained viewport. Then read the full diff. The full `pnpm check` remains
for the pre-push boundary unless requested now.

## Open questions / risks

The portal must not briefly flash at the viewport origin before its first
measurement. It should render hidden until positioned. The popup also has to
remain below global sheets and above pane content after leaving the pane's local
stacking context.
