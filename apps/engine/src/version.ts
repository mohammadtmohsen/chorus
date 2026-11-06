declare const __CHORUS_APP_VERSION__: string

export const ENGINE_VERSION =
  typeof __CHORUS_APP_VERSION__ === 'undefined' ? 'development' : __CHORUS_APP_VERSION__
