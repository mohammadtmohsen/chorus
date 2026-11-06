import { z } from 'zod'

export const HostCapabilities = z.object({
  embeddedEditor: z.boolean(),
  nativeBrowserViews: z.boolean(),
  streamedBrowser: z.boolean(),
  detachedWindows: z.boolean(),
  globalTerminal: z.boolean(),
  ownTheme: z.boolean(),
})

export type HostCapabilities = z.infer<typeof HostCapabilities>

export const DESKTOP_CAPABILITIES: HostCapabilities = {
  embeddedEditor: true,
  nativeBrowserViews: true,
  streamedBrowser: false,
  detachedWindows: true,
  globalTerminal: true,
  ownTheme: true,
}

export const EXTENSION_CAPABILITIES: HostCapabilities = {
  embeddedEditor: false,
  nativeBrowserViews: false,
  streamedBrowser: true,
  detachedWindows: false,
  globalTerminal: false,
  ownTheme: false,
}
