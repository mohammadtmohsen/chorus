import { shell, type BrowserWindow, type Session } from 'electron'

/**
 * Chorus renders untrusted model output. Without these, an injection in an
 * agent message escalates from "weird text" to remote code execution, so none
 * of it is optional (plan §4.4).
 */

const BASE_CSP = [
  "default-src 'none'",
  // Vite injects styles at runtime; scripts stay strict, which is what matters.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
]

const PRODUCTION_CSP = [...BASE_CSP, "script-src 'self'", "connect-src 'self'"].join('; ')

/**
 * Dev only. React Fast Refresh injects an inline preamble script and talks to
 * the Vite dev server over a websocket, both of which the production policy
 * correctly refuses. Shipping this to users would defeat the point, so it is
 * selected by the dev-server URL rather than by a build flag that could drift.
 */
const DEVELOPMENT_CSP = [
  ...BASE_CSP,
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
].join('; ')

export function applyContentSecurityPolicy(session: Session, isDev: boolean): void {
  const policy = isDev ? DEVELOPMENT_CSP : PRODUCTION_CSP

  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })

  // No renderer of ours has any business asking for the camera, mic, or geo.
  session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
}

/**
 * The renderer must never navigate away from our own bundle, and must never
 * open a window itself. External links go to the OS browser instead.
 */
export function lockDownNavigation(window: BrowserWindow, devServerUrl: string | undefined): void {
  const isInternal = (url: string): boolean =>
    url.startsWith('file://') || (devServerUrl !== undefined && url.startsWith(devServerUrl))

  window.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url)) event.preventDefault()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // A webview tag would reintroduce everything we just disabled.
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}
