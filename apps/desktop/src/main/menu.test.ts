import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() } }))
vi.mock('./scale.js', () => ({ stepScale: vi.fn() }))

const { menuTemplate } = await import('./menu.js')
const { stepScale } = await import('./scale.js')

function view(): MenuItemConstructorOptions[] {
  const found = menuTemplate('/tmp/x').find((item) => item.label === 'View')
  return (found?.submenu ?? []) as MenuItemConstructorOptions[]
}

function accelerators(): string[] {
  return view()
    .map((item) => item.accelerator)
    .filter((a): a is string => a !== undefined)
}

describe('menuTemplate', () => {
  it('binds zoom in, zoom out and actual size', () => {
    expect(accelerators()).toContain('CommandOrControl+Plus')
    expect(accelerators()).toContain('CommandOrControl+-')
    expect(accelerators()).toContain('CommandOrControl+0')
  })

  it('also binds ⌘= , since ⌘+ needs Shift on most layouts', () => {
    const equals = view().find((item) => item.accelerator === 'CommandOrControl+=')
    expect(equals).toBeDefined()
    // Hidden: a visible duplicate would read as two different commands.
    expect(equals?.visible).toBe(false)
  })

  it('steps in the direction the item says', () => {
    const click = (label: string, accelerator: string): void => {
      const item = view().find((i) => i.label === label && i.accelerator === accelerator)
      item?.click?.(undefined as never, undefined, undefined as never)
    }
    click('Zoom In', 'CommandOrControl+Plus')
    expect(stepScale).toHaveBeenLastCalledWith('/tmp/x', 1)
    click('Zoom Out', 'CommandOrControl+-')
    expect(stepScale).toHaveBeenLastCalledWith('/tmp/x', -1)
    click('Actual Size', 'CommandOrControl+0')
    expect(stepScale).toHaveBeenLastCalledWith('/tmp/x', 0)
  })

  it('keeps the edit menu, or the app loses copy and paste', () => {
    // Replacing Electron's default menu means inheriting what it gave for free.
    expect(menuTemplate('/tmp/x').map((item) => item.role)).toContain('editMenu')
  })
})
