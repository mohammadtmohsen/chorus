/**
 * What "the primary modifier" means, and how to spell it.
 *
 * Command on macOS, Ctrl on Windows. Twelve keyboard handlers in
 * `Workspace.tsx` and two in `TerminalView.tsx` tested `event.metaKey`
 * directly, which on Windows is the **Windows key** — so every one of them was
 * either dead or, worse, bound to a chord the OS already owns.
 *
 * ## Why this is not `metaKey || ctrlKey`
 *
 * That is the obvious rewrite and it is wrong in both directions.
 *
 * On macOS it would make `⌃K` — which a terminal must forward to the shell as
 * "kill line" — start clearing the scrollback instead. On Windows it would
 * make the Windows key a second Ctrl, so `Win+W` would close a tab.
 *
 * And there is a live counter-example in the same handler: `⌃⇧\`` (new
 * terminal) is deliberately Ctrl-based on *both* platforms, because that is
 * VS Code's binding. A blanket `metaKey || ctrlKey` swallows it on macOS, since
 * `⌃⇧\`` would then also look like a primary chord.
 *
 * So the modifier is chosen by platform, and the non-primary one is required to
 * be **absent** — which is what keeps `⌃⇧\`` distinguishable from `⌘⇧\``.
 */

export type Platform = 'darwin' | 'win32' | 'linux'

/** The subset of a keyboard event these functions read. Keeps them testable. */
export interface ModifierState {
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

/**
 * Whether the primary modifier — and only it — is held.
 *
 * The other platform's modifier being *absent* is part of the test, so `⌃K` on
 * macOS and `Win+K` on Windows both answer false rather than falling through to
 * whatever the primary chord does.
 */
export function isPrimary(event: ModifierState, platform: Platform): boolean {
  return platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/**
 * The primary modifier held with no Alt and no Shift.
 *
 * The common case: `⌘J`, `⌘W`, `⌘1`. Written once because every handler that
 * spelled it out inline got a slightly different combination of negations.
 */
export function isPrimaryOnly(event: ModifierState, platform: Platform): boolean {
  return isPrimary(event, platform) && !event.altKey && !event.shiftKey
}

/** Primary + Shift, with no Alt — `⌘⇧J`, `⌘⇧[`. */
export function isPrimaryShift(event: ModifierState, platform: Platform): boolean {
  return isPrimary(event, platform) && event.shiftKey && !event.altKey
}

/** Primary + Alt — `⌘⌥←`, and with Shift for the reordering gestures. */
export function isPrimaryAlt(event: ModifierState, platform: Platform): boolean {
  return isPrimary(event, platform) && event.altKey
}

/**
 * A shortcut written the way the platform writes it.
 *
 * macOS uses glyphs with nothing between them; Windows spells the modifiers out
 * and joins with `+`. Three shortcut strings were hardcoded as `⌘J`, `⌘⇧J` and
 * `⌃⇧\`` in `en.json`, which is also why they could not be translated — a glyph
 * is not a word, and `en.json` is where user-facing strings are supposed to
 * live.
 *
 * Takes the parts rather than a string to re-spell, so there is no parsing step
 * that could silently fail to recognise a glyph and pass it through unchanged.
 */
export interface ShortcutParts {
  readonly primary?: boolean
  /** Ctrl on *both* platforms — `⌃⇧\`` is VS Code's binding, not a Cmd chord. */
  readonly control?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
  readonly key: string
}

export function formatShortcut(parts: ShortcutParts, platform: Platform): string {
  const mac = platform === 'darwin'
  const pieces: string[] = []

  /*
   * Order matters and differs. macOS convention is ⌃⌥⇧⌘ then the key; Windows
   * is Ctrl+Alt+Shift+Key. Getting this wrong produces something that reads as
   * a typo rather than as a shortcut.
   */
  if (mac) {
    if (parts.control === true) pieces.push('⌃')
    if (parts.alt === true) pieces.push('⌥')
    if (parts.shift === true) pieces.push('⇧')
    if (parts.primary === true) pieces.push('⌘')
    return pieces.join('') + parts.key.toUpperCase()
  }

  // On Windows the primary modifier *is* Ctrl, so a shortcut asking for both
  // must not print "Ctrl+Ctrl+".
  if (parts.primary === true || parts.control === true) pieces.push('Ctrl')
  if (parts.alt === true) pieces.push('Alt')
  if (parts.shift === true) pieces.push('Shift')
  pieces.push(parts.key.toUpperCase())
  return pieces.join('+')
}

/**
 * The running platform, held at module scope rather than passed as a prop.
 *
 * `app:getInfo` is async and resolves after first paint, and `Workspace.tsx`'s
 * keyboard effect has `[]` deps by design — it reads everything else through
 * refs precisely so it never re-runs and never re-binds the document listener.
 * A `platform` prop would therefore be captured as its initial value and stay
 * wrong forever.
 *
 * Reading it at *event* time sidesteps that: a keystroke necessarily happens
 * after paint, so by then this is set. The pure functions above still take the
 * platform explicitly, so none of this is in the way of testing them.
 *
 * Defaults to `darwin` because that is the only platform shipped so far; a
 * wrong guess for the few milliseconds before the IPC resolves costs a
 * keystroke nobody is pressing yet.
 */
let running: Platform = 'darwin'

export function setRunningPlatform(value: string): void {
  running = value === 'win32' ? 'win32' : value === 'linux' ? 'linux' : 'darwin'
}

export function runningPlatform(): Platform {
  return running
}

/** `isPrimary` against the running platform — what the handlers actually call. */
export const primary = (e: ModifierState): boolean => isPrimary(e, running)
export const primaryOnly = (e: ModifierState): boolean => isPrimaryOnly(e, running)
export const primaryShift = (e: ModifierState): boolean => isPrimaryShift(e, running)
export const primaryAlt = (e: ModifierState): boolean => isPrimaryAlt(e, running)
export const shortcutLabel = (parts: ShortcutParts): string => formatShortcut(parts, running)
