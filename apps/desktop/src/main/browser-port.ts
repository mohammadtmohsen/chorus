import type { ShellClient } from './shell-client.js'
import type { BrowserSurfaces } from './browser-surface.js'
import type { BrowserDownloads } from './browser-downloads.js'

type WithShellOwner<T, Async extends boolean = false> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (
        owner: ShellClient,
        ...args: A extends [unknown, ...infer Rest] ? Rest : never
      ) => Async extends true ? Awaited<R> | Promise<Awaited<R>> : R
    : never
}

export type BrowserSurfacePort = WithShellOwner<
  Pick<
    BrowserSurfaces,
    | 'webReady'
    | 'attachWebTab'
    | 'attach'
    | 'detach'
    | 'restore'
    | 'navigate'
    | 'act'
    | 'find'
    | 'close'
    | 'reopen'
    | 'geometry'
    | 'addFavorite'
    | 'removeFavorite'
    | 'openFavorite'
    | 'passwords'
    | 'decide'
    | 'fill'
    | 'removePassword'
    | 'allowPasswords'
    | 'closeOwner'
  >,
  true
> &
  Pick<BrowserSurfaces, 'shutdown'>

export type BrowserDownloadPort = WithShellOwner<Pick<BrowserDownloads, 'list' | 'act'>>
