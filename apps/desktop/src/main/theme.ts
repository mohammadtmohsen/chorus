import { nativeTheme } from 'electron'
import type { Settings } from './settings.js'

/**
 * The appearance the person chose, applied to the one place that decides it.
 *
 * **Nothing in the renderer needed changing for this.** `styles.css`, Monaco's
 * `themeNow()`, xterm and the file icons all already answer to
 * `prefers-color-scheme`; `nativeTheme.themeSource` moves what Chromium reports
 * for that query, so every one of them follows without being told. A per-consumer
 * theme prop would have been a second mechanism doing the same job worse — and
 * would have missed whichever consumer was added next.
 *
 * Two conditions, and they are the whole implementation:
 *
 *  - **Before the first window opens.** Set it after, and the app paints in the
 *    OS appearance and then snaps to the chosen one — a visible flash on every
 *    launch, worst for the person whose choice differs from their system.
 *  - **Again whenever the setting changes**, or the switch appears to do nothing
 *    until relaunch.
 *
 * `Settings['theme']` is `'system' | 'light' | 'dark'`, which is exactly
 * Electron's own union — deliberately, so this is an assignment and not a
 * mapping that could drift.
 */
export function applyTheme(theme: Settings['theme']): void {
  nativeTheme.themeSource = theme
}
