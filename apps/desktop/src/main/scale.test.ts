import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const { applyScale, currentScale, stepScale } = await import('./scale.js')

beforeEach(() => {
  // The size is module state with a one-launch lifetime; this is what a launch
  // looks like to a test.
  stepScale(0)
  setZoomFactor.mockClear()
  send.mockClear()
})

describe('stepScale', () => {
  it('starts at 100%', () => {
    expect(currentScale()).toBe(1)
  })

  it('steps up and down by 5%', () => {
    expect(stepScale(1)).toBe(1.05)
    expect(stepScale(1)).toBe(1.1)
    expect(stepScale(-1)).toBe(1.05)
  })

  it('returns to actual size', () => {
    stepScale(1)
    stepScale(1)
    expect(stepScale(0)).toBe(1)
  })

  it('stays on whole percents through a long run of presses', () => {
    // 0.85 + 0.05 is 0.8999999999999999 in binary floating point, and a badge
    // reading 89% would be the arithmetic showing through.
    for (let i = 0; i < 3; i++) stepScale(-1)
    const seen = Array.from({ length: 8 }, () => stepScale(1))
    expect(seen).toEqual([0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25])
  })

  it('stops at each end rather than wrapping', () => {
    // Wrapping from largest to smallest on one extra press is the kind of thing
    // that makes people think the shortcut is broken.
    for (let i = 0; i < 40; i++) stepScale(1)
    expect(stepScale(1)).toBe(1.5)
    for (let i = 0; i < 40; i++) stepScale(-1)
    expect(stepScale(-1)).toBe(0.8)
  })

  it('applies to the window', () => {
    stepScale(-1)
    expect(setZoomFactor).toHaveBeenCalledWith(0.95)
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
