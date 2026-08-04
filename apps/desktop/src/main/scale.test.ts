import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * `electron` is not importable outside an Electron process, and `scale.ts` needs
 * it only to find open windows. Stubbed so the stepping — the part with the
 * arithmetic in it — can be tested as ordinary code.
 */
const setZoomFactor = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { setZoomFactor } }] },
}))

const { applyScale, stepScale } = await import('./scale.js')
const { DEFAULT_SETTINGS, writeSettings } = await import('./settings.js')

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chorus-scale-'))
  setZoomFactor.mockClear()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const stored = (): number =>
  (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { scale: number }).scale

describe('stepScale', () => {
  it('steps up and down through the offered sizes', () => {
    writeSettings(dir, DEFAULT_SETTINGS)
    expect(stepScale(dir, 1)).toBe(1.15)
    expect(stepScale(dir, 1)).toBe(1.3)
    expect(stepScale(dir, -1)).toBe(1.15)
  })

  it('returns to actual size', () => {
    writeSettings(dir, { ...DEFAULT_SETTINGS, scale: 1.5 })
    expect(stepScale(dir, 0)).toBe(1)
  })

  it('stops at each end rather than wrapping', () => {
    // Wrapping from largest to smallest on one extra press is the kind of thing
    // that makes people think the shortcut is broken.
    writeSettings(dir, { ...DEFAULT_SETTINGS, scale: 1.5 })
    expect(stepScale(dir, 1)).toBe(1.5)
    writeSettings(dir, { ...DEFAULT_SETTINGS, scale: 0.85 })
    expect(stepScale(dir, -1)).toBe(0.85)
  })

  it('steps from the nearest size when the stored one is between two', () => {
    // A hand-edited settings file should still respond to the shortcut.
    writeSettings(dir, { ...DEFAULT_SETTINGS, scale: 1.2 })
    expect(stepScale(dir, 1)).toBe(1.3)
  })

  it('persists, so the size survives a relaunch', () => {
    writeSettings(dir, DEFAULT_SETTINGS)
    stepScale(dir, 1)
    expect(stored()).toBe(1.15)
  })

  it('applies to the window as well as the file', () => {
    writeSettings(dir, DEFAULT_SETTINGS)
    stepScale(dir, -1)
    expect(setZoomFactor).toHaveBeenCalledWith(0.85)
  })

  it('starts from the default when there is no settings file', () => {
    expect(stepScale(dir, 1)).toBe(1.15)
  })

  it('starts from the default when the file is corrupt', () => {
    // Refusing to zoom because a JSON file is broken would be a strange failure.
    writeFileSync(join(dir, 'settings.json'), '{ not json', 'utf8')
    expect(stepScale(dir, 1)).toBe(1.15)
  })
})

describe('applyScale', () => {
  it('zooms every open window', () => {
    applyScale(1.3)
    expect(setZoomFactor).toHaveBeenCalledWith(1.3)
  })
})
