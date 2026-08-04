import { BrowserWindow } from 'electron'
import { readSettings, SCALES, writeSettings } from './settings.js'

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
  }
}

/** Nearest step to a stored value, so a hand-edited settings file still steps. */
function indexOfScale(scale: number): number {
  let best = SCALES.indexOf(1)
  let closest = Infinity
  for (const [i, candidate] of SCALES.entries()) {
    const distance = Math.abs(candidate - scale)
    if (distance < closest) {
      closest = distance
      best = i
    }
  }
  return best
}

/**
 * Moves one step and remembers it. `0` returns to actual size.
 *
 * Persisting is what separates this from the zoom a browser forgets: the size
 * you chose is the size the app opens at tomorrow.
 */
export function stepScale(userDataPath: string, direction: -1 | 0 | 1): number {
  const current = readSettings(userDataPath)
  const index =
    direction === 0
      ? SCALES.indexOf(1)
      : Math.min(Math.max(indexOfScale(current.scale) + direction, 0), SCALES.length - 1)

  const scale = SCALES[index] ?? 1
  writeSettings(userDataPath, { ...current, scale })
  applyScale(scale)
  return scale
}
