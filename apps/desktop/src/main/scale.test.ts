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
const send = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { setZoomFactor, send } }] },
}))

const { applyScale, stepScale } = await import('./scale.js')
const { DEFAULT_SETTINGS, writeSettings } = await import('./settings.js')

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chorus-scale-'))
  setZoomFactor.mockClear()
  send.mockClear()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const stored = (): number =>
  (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { scale: number }).scale

describe('stepScale', () => {
  it('steps up and down by 5%', () => {
    writeSettings(dir, DEFAULT_SETTINGS)
    expect(stepScale(dir, 1)).toBe(1.05)
    expect(stepScale(dir, 1)).toBe(1.1)
    expect(stepScale(dir, -1)).toBe(1.05)
  })

  it('stays on whole percents through a long run of presses', () => {
    // 0.85 + 0.05 is 0.8999999999999999 in binary floating point, and a badge
    // reading 89% would be the arithmetic showing through.
    writeSettings(dir, { ...DEFAULT_SETTINGS, scale: 0.85 })
    const seen = Array.from({ length: 8 }, () => stepScale(dir, 1))
    expect(seen).toEqual([0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25])
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
    writeSettings(dir, { ...DEFAULT_SETTINGS, scale: 0.8 })
    expect(stepScale(dir, -1)).toBe(0.8)
  })

  it('pulls a value off the grid back onto it', () => {
    // A hand-edited settings file should still land on whole percents.
    writeSettings(dir, { ...DEFAULT_SETTINGS, scale: 1.234 })
    expect(stepScale(dir, 1)).toBe(1.28)
  })

  it('persists, so the size survives a relaunch', () => {
    writeSettings(dir, DEFAULT_SETTINGS)
    stepScale(dir, 1)
    expect(stored()).toBe(1.05)
  })

  it('applies to the window as well as the file', () => {
    writeSettings(dir, DEFAULT_SETTINGS)
    stepScale(dir, -1)
    expect(setZoomFactor).toHaveBeenCalledWith(0.95)
  })

  it('starts from the default when there is no settings file', () => {
    expect(stepScale(dir, 1)).toBe(1.05)
  })

  it('starts from the default when the file is corrupt', () => {
    // Refusing to zoom because a JSON file is broken would be a strange failure.
    writeFileSync(join(dir, 'settings.json'), '{ not json', 'utf8')
    expect(stepScale(dir, 1)).toBe(1.05)
  })
})

describe('applyScale', () => {
  it('zooms every open window', () => {
    applyScale(1.3)
    expect(setZoomFactor).toHaveBeenCalledWith(1.3)
  })

  it('tells the renderer, which cannot read its own zoom factor', () => {
    applyScale(1.3)
    expect(send).toHaveBeenCalledWith('settings:scale', 1.3)
  })
})
