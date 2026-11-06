import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installThemeMirror } from './theme.js'

class ClassList {
  readonly values = new Set<string>()

  contains(value: string): boolean {
    return this.values.has(value)
  }

  toggle(value: string, present: boolean): void {
    if (present) this.values.add(value)
    else this.values.delete(value)
  }
}

class Style {
  private readonly properties = new Map<string, { value: string; priority: string }>()

  getPropertyValue(name: string): string {
    return this.properties.get(name)?.value ?? ''
  }

  getPropertyPriority(name: string): string {
    return this.properties.get(name)?.priority ?? ''
  }

  setProperty(name: string, value: string, priority = ''): void {
    this.properties.set(name, { value, priority })
  }

  removeProperty(name: string): void {
    this.properties.delete(name)
  }
}

const observers = new Set<Observer>()

class Observer {
  readonly observe = vi.fn()
  readonly disconnect = vi.fn(() => observers.delete(this))

  constructor(readonly callback: () => void) {
    observers.add(this)
  }
}

function fixture() {
  const root = { classList: new ClassList(), style: new Style() }
  const body = { classList: new ClassList() }
  const nativeQuery = { matches: true, media: 'native' }
  const nativeMatchMedia = vi.fn(function (this: unknown, _query: string) {
    return { ...nativeQuery, receiver: this }
  })
  const targetWindow = {
    document: { documentElement: root, body },
    MutationObserver: Observer,
    matchMedia: nativeMatchMedia,
  }
  vi.stubGlobal('window', targetWindow)
  return { root, body, nativeQuery, nativeMatchMedia, targetWindow }
}

let state: ReturnType<typeof fixture>
let dispose: (() => void) | undefined

function setTheme(...names: string[]): void {
  state.body.classList.values.clear()
  for (const name of names) state.body.classList.values.add(name)
  for (const observer of observers) observer.callback()
}

beforeEach(() => {
  state = fixture()
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  observers.clear()
  vi.unstubAllGlobals()
})

describe('installThemeMirror', () => {
  it.each([
    ['vscode-light', ['chorus-theme-light'], true],
    ['vscode-dark', ['chorus-theme-dark'], false],
    ['vscode-high-contrast', ['chorus-theme-dark', 'chorus-theme-high-contrast'], false],
    [
      'vscode-high-contrast-light',
      ['chorus-theme-light', 'chorus-theme-high-contrast-light'],
      true,
    ],
  ] as const)('mirrors %s independently of the operating system', (theme, classes, light) => {
    setTheme(theme)
    state.root.classList.values.add('existing')
    dispose = installThemeMirror()
    expect([...state.root.classList.values].sort()).toEqual(['existing', ...classes].sort())
    expect(window.matchMedia('(prefers-color-scheme: light)').matches).toBe(light)
    expect(state.root.style.getPropertyValue('color-scheme')).toBe(light ? 'light' : 'dark')
    expect(state.nativeMatchMedia).not.toHaveBeenCalled()
  })

  it('publishes changes after updating the root classes and explicit color scheme', () => {
    setTheme('vscode-dark')
    dispose = installThemeMirror()
    const query = window.matchMedia('(prefers-color-scheme: light)')
    const changes: {
      light: boolean
      matches: boolean
      media: string
      target: EventTarget | null
    }[] = []
    query.addEventListener('change', (event) => {
      changes.push({
        light: state.root.classList.contains('chorus-theme-light'),
        matches: event.matches,
        media: event.media,
        target: event.target,
      })
      expect(query.matches).toBe(event.matches)
    })
    setTheme('vscode-light')
    setTheme('vscode-high-contrast-light')
    setTheme('vscode-high-contrast')
    expect(changes).toEqual([
      { light: true, matches: true, media: '(prefers-color-scheme: light)', target: query },
      { light: false, matches: false, media: '(prefers-color-scheme: light)', target: query },
    ])
  })

  it('supports event removal, legacy listeners, onchange, once, and AbortSignal', () => {
    setTheme('vscode-dark')
    dispose = installThemeMirror()
    const query = window.matchMedia('(prefers-color-scheme: light)')
    const removed = vi.fn()
    const legacy = vi.fn()
    const onchange = vi.fn()
    const once = vi.fn()
    const aborted = vi.fn()
    const controller = new AbortController()
    query.addEventListener('change', removed)
    query.removeEventListener('change', removed)
    const legacyQuery: {
      addListener(listener: (event: MediaQueryListEvent) => void): void
      removeListener(listener: (event: MediaQueryListEvent) => void): void
    } = query
    legacyQuery.addListener(legacy)
    query.onchange = onchange
    query.addEventListener('change', once, { once: true })
    query.addEventListener('change', aborted, { signal: controller.signal })
    controller.abort()
    setTheme('vscode-light')
    legacyQuery.removeListener(legacy)
    query.onchange = null
    setTheme('vscode-dark')
    expect(removed).not.toHaveBeenCalled()
    expect(legacy).toHaveBeenCalledTimes(1)
    expect(onchange).toHaveBeenCalledTimes(1)
    expect(once).toHaveBeenCalledTimes(1)
    expect(aborted).not.toHaveBeenCalled()
  })

  it('delegates every other media query with its original receiver', () => {
    dispose = installThemeMirror()
    for (const query of [
      '(prefers-reduced-motion: reduce)',
      '(max-width: 720px)',
      '(prefers-color-scheme: dark)',
      '(prefers-color-scheme: light) and (max-width: 720px)',
    ]) {
      expect(window.matchMedia(query)).toEqual({
        ...state.nativeQuery,
        receiver: state.targetWindow,
      })
      expect(state.nativeMatchMedia).toHaveBeenLastCalledWith(query)
    }
  })

  it('observes only body classes and restores the previous root state on cleanup', () => {
    setTheme('vscode-light')
    state.root.classList.values.add('chorus-theme-dark')
    state.root.classList.values.add('existing')
    state.root.style.setProperty('color-scheme', 'dark light', 'important')
    dispose = installThemeMirror()
    const observer = [...observers][0]
    expect(observer?.observe).toHaveBeenCalledWith(state.body, {
      attributes: true,
      attributeFilter: ['class'],
    })
    const listener = vi.fn()
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', listener)
    dispose()
    dispose()
    expect(observer?.disconnect).toHaveBeenCalledTimes(1)
    expect(Object.getOwnPropertyDescriptor(window, 'matchMedia')?.value).toBe(
      state.nativeMatchMedia
    )
    expect([...state.root.classList.values].sort()).toEqual(['chorus-theme-dark', 'existing'])
    expect(state.root.style.getPropertyValue('color-scheme')).toBe('dark light')
    expect(state.root.style.getPropertyPriority('color-scheme')).toBe('important')
    setTheme('vscode-dark')
    expect(listener).not.toHaveBeenCalled()
  })

  it('leaves a later matchMedia wrapper installed when cleaning up', () => {
    dispose = installThemeMirror()
    const current: { matchMedia: (query: string) => MediaQueryList } = window
    const later = vi.fn(current.matchMedia)
    window.matchMedia = later
    dispose()
    expect(Object.getOwnPropertyDescriptor(window, 'matchMedia')?.value).toBe(later)
    expect(state.root.style.getPropertyValue('color-scheme')).toBe('')
  })
})
