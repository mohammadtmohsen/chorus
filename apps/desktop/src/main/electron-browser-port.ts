import type { BrowserSurfacePort, BrowserDownloadPort } from './browser-port.js'
import type { BrowserSurfaces } from './browser-surface.js'
import type { BrowserDownloads } from './browser-downloads.js'
import { electronContents } from './electron-shell-client.js'

export function electronBrowserPort(surfaces: BrowserSurfaces): BrowserSurfacePort {
  return {
    webReady: (owner, ...args) => surfaces.webReady(electronContents(owner), ...args),
    attachWebTab: (owner, ...args) => surfaces.attachWebTab(electronContents(owner), ...args),
    attach: (owner, ...args) => surfaces.attach(electronContents(owner), ...args),
    detach: (owner, ...args) => surfaces.detach(electronContents(owner), ...args),
    restore: (owner, ...args) => surfaces.restore(electronContents(owner), ...args),
    navigate: (owner, ...args) => surfaces.navigate(electronContents(owner), ...args),
    act: (owner, ...args) => surfaces.act(electronContents(owner), ...args),
    find: (owner, ...args) => surfaces.find(electronContents(owner), ...args),
    close: (owner, ...args) => surfaces.close(electronContents(owner), ...args),
    reopen: (owner, ...args) => surfaces.reopen(electronContents(owner), ...args),
    geometry: (owner, ...args) => surfaces.geometry(electronContents(owner), ...args),
    addFavorite: (owner, ...args) => surfaces.addFavorite(electronContents(owner), ...args),
    removeFavorite: (owner, ...args) => surfaces.removeFavorite(electronContents(owner), ...args),
    openFavorite: (owner, ...args) => surfaces.openFavorite(electronContents(owner), ...args),
    passwords: (owner, ...args) => surfaces.passwords(electronContents(owner), ...args),
    decide: (owner, ...args) => surfaces.decide(electronContents(owner), ...args),
    fill: (owner, ...args) => surfaces.fill(electronContents(owner), ...args),
    removePassword: (owner, ...args) => surfaces.removePassword(electronContents(owner), ...args),
    allowPasswords: (owner, ...args) => surfaces.allowPasswords(electronContents(owner), ...args),
    closeOwner: (owner, ...args) => {
      surfaces.closeOwner(electronContents(owner), ...args)
    },
    shutdown: () => surfaces.shutdown(),
  }
}

export function electronBrowserDownloads(downloads: BrowserDownloads): BrowserDownloadPort {
  return {
    list: (owner, ...args) => downloads.list(electronContents(owner), ...args),
    act: (owner, ...args) => downloads.act(electronContents(owner), ...args),
  }
}
