import { BrowserWindow } from 'electron'
import { SCALE_PUSH_CHANNEL } from '../shared/ipc.js'

/**
 * Window zoom, owned by the main process.
 *
 * Here rather than in the renderer because the renderer is sandboxed and
 * `webFrame` is not reachable from it — and because the menu accelerators live
 * in this process too, so one module owns every way the size can change.
 *
 * The size lives for one launch and is not written anywhere. Zoom is an
 * adjustment rather than a preference: the app opens at 100% every time, and a
 * size you set to read one long diff should not be waiting for you tomorrow.
 */

/** The range the layout was checked at; past either end it stops being a layout. */
export const MIN_SCALE = 0.8
export const MAX_SCALE = 1.5

/** One press, 5%: fine enough to land on the size you want, coarse enough to feel. */
export const SCALE_STEP = 0.05

/** Reset by the process restarting, which is exactly the intended lifetime. */
let current = 1

export function currentScale(): number {
  return current
}

export function applyScale(scale: number): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.setZoomFactor(scale)
    // Told, not inferred: the renderer cannot read the zoom factor it is being
    // drawn at, and it is the one that has to say what just happened.
    window.webContents.send(SCALE_PUSH_CHANNEL, scale)
  }
}

/**
 * Moves one 5% step. `0` returns to actual size.
 *
 * Rounded to whole percents at every step: 0.85 + 0.05 is 0.8999999999999999 in
 * binary floating point, and a badge reading 89% would be the arithmetic showing
 * through.
 */
export function stepScale(direction: -1 | 0 | 1): number {
  const moved = direction === 0 ? 1 : current + SCALE_STEP * direction
  current = Math.min(Math.max(round(moved), MIN_SCALE), MAX_SCALE)
  applyScale(current)
  return current
}

function round(scale: number): number {
  return Math.round(scale * 100) / 100
}
