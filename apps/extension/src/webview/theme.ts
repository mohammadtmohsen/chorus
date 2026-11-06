const LIGHT_QUERY = '(prefers-color-scheme: light)'
const ROOT_CLASSES = [
  'chorus-theme-light',
  'chorus-theme-dark',
  'chorus-theme-high-contrast',
  'chorus-theme-high-contrast-light',
] as const

type ChangeListener = (this: MediaQueryList, event: MediaQueryListEvent) => unknown

class ColorSchemeChange extends Event implements MediaQueryListEvent {
  readonly media = LIGHT_QUERY

  constructor(readonly matches: boolean) {
    super('change')
  }
}

class ColorSchemeQuery extends EventTarget implements MediaQueryList {
  readonly media = LIGHT_QUERY
  private currentMatches: boolean
  private changeHandler: ChangeListener | null = null

  constructor(matches: boolean) {
    super()
    this.currentMatches = matches
  }

  get matches(): boolean {
    return this.currentMatches
  }

  get onchange(): ChangeListener | null {
    return this.changeHandler
  }

  set onchange(listener: ChangeListener | null) {
    if (this.changeHandler !== null) this.removeEventListener('change', this.changeHandler)
    this.changeHandler = listener
    if (listener !== null) this.addEventListener('change', listener)
  }

  addListener(listener: ChangeListener | null): void {
    this.addEventListener('change', listener)
  }

  removeListener(listener: ChangeListener | null): void {
    this.removeEventListener('change', listener)
  }

  override addEventListener<K extends keyof MediaQueryListEventMap>(
    type: K,
    listener: ((this: MediaQueryList, event: MediaQueryListEventMap[K]) => unknown) | null,
    options?: boolean | AddEventListenerOptions
  ): void
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ChangeListener | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    super.addEventListener(type, listener as EventListenerOrEventListenerObject | null, options)
  }

  override removeEventListener<K extends keyof MediaQueryListEventMap>(
    type: K,
    listener: ((this: MediaQueryList, event: MediaQueryListEventMap[K]) => unknown) | null,
    options?: boolean | EventListenerOptions
  ): void
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ): void
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ChangeListener | null,
    options?: boolean | EventListenerOptions
  ): void {
    super.removeEventListener(type, listener as EventListenerOrEventListenerObject | null, options)
  }

  update(matches: boolean): void {
    if (matches === this.currentMatches) return
    this.currentMatches = matches
    this.dispatchEvent(new ColorSchemeChange(matches))
  }
}

export function installThemeMirror(targetWindow = window): () => void {
  const { document } = targetWindow
  const root = document.documentElement
  const body = document.body
  const previousClasses = ROOT_CLASSES.map((name) => [name, root.classList.contains(name)] as const)
  const previousScheme = root.style.getPropertyValue('color-scheme')
  const previousPriority = root.style.getPropertyPriority('color-scheme')
  const mediaWindow: { matchMedia: (query: string) => MediaQueryList } = targetWindow
  const originalMatchMedia = mediaWindow.matchMedia
  const scheme = new ColorSchemeQuery(false)
  let active = true

  const mirror = (): void => {
    if (!active) return
    const contrastLight = body.classList.contains('vscode-high-contrast-light')
    const contrastDark = !contrastLight && body.classList.contains('vscode-high-contrast')
    const light = contrastLight || (!contrastDark && body.classList.contains('vscode-light'))
    root.classList.toggle('chorus-theme-light', light)
    root.classList.toggle('chorus-theme-dark', !light)
    root.classList.toggle('chorus-theme-high-contrast', contrastDark)
    root.classList.toggle('chorus-theme-high-contrast-light', contrastLight)
    root.style.setProperty('color-scheme', light ? 'light' : 'dark')
    scheme.update(light)
  }

  const mirroredMatchMedia: typeof targetWindow.matchMedia = (query) =>
    /^\(\s*prefers-color-scheme\s*:\s*light\s*\)$/i.test(query.trim())
      ? scheme
      : originalMatchMedia.call(targetWindow, query)

  mirror()
  const observer = new targetWindow.MutationObserver(mirror)
  observer.observe(body, { attributes: true, attributeFilter: ['class'] })
  targetWindow.matchMedia = mirroredMatchMedia

  return () => {
    if (!active) return
    active = false
    observer.disconnect()
    if (targetWindow.matchMedia === mirroredMatchMedia) targetWindow.matchMedia = originalMatchMedia
    for (const [name, present] of previousClasses) root.classList.toggle(name, present)
    if (previousScheme === '') root.style.removeProperty('color-scheme')
    else root.style.setProperty('color-scheme', previousScheme, previousPriority)
  }
}
