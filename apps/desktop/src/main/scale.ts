import { BrowserWindow } from 'electron'
import { SCALE_PUSH_CHANNEL } from '../shared/ipc.js'
import { MAX_SCALE, MIN_SCALE, readSettings, SCALE_STEP, writeSettings } from './settings.js'

/**
 * Window zoom, owned by the main process.
 *
 * Here rather than in the renderer because the renderer is sandboxed and
 * `webFrame` is not reachable from it — and because the menu accelerators live
 * in this process too, so one module owns every way the size can change.
 */

export function applyScale(scale: number): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.setZoomFactor(scale)
    // Told, not inferred: the renderer cannot read the zoom factor it is being
    // drawn at, and it is the one that has to say what just happened.
    window.webContents.send(SCALE_PUSH_CHANNEL, scale)
  }
}

/**
 * Moves one 5% step and remembers it. `0` returns to actual size.
 *
 * Rounded to whole percents at every step: 0.85 + 0.05 is 0.8999999999999999 in
 * binary floating point, and a badge reading 89% would be the arithmetic showing
 * through. Rounding also pulls a hand-edited value onto the grid.
 *
 * Persisting is what separates this from the zoom a browser forgets: the size
 * you chose is the size the app opens at tomorrow.
 */
export function stepScale(userDataPath: string, direction: -1 | 0 | 1): number {
  const current = readSettings(userDataPath)
  const moved = direction === 0 ? 1 : current.scale + SCALE_STEP * direction
  const scale = Math.min(Math.max(round(moved), MIN_SCALE), MAX_SCALE)

  writeSettings(userDataPath, { ...current, scale })
  applyScale(scale)
  return scale
}

function round(scale: number): number {
  return Math.round(scale * 100) / 100
}
