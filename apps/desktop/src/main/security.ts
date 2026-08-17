import { shell, type BrowserWindow, type Session } from 'electron'
import { isSafeHref } from '../shared/markdown.js'

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

  /*
   * The renderer's own allowlist, not a second one.
   *
   * This used to read `url.startsWith('https://')`, which is narrower than what
   * `MarkdownView` is willing to draw as a link — `isSafeHref` admits `http:`
   * and `mailto:` too. The gap was silent by construction: the transcript
   * rendered an underlined, coloured link, the click reached here, and `deny`
   * ended it with nothing on screen to say why. Measured before it was fixed, a
   * plain-`http` link opened zero connections while an `https` one opened four.
   *
   * Sharing the predicate is the point rather than adding two schemes. Two
   * allowlists over the same decision drift, and the drift shows up as a dead
   * control rather than as an error.
   *
   * The scheme was never the protection anyway — a model can write `https://`
   * as easily as `http://`. What protects the app is that this hands the URL to
   * the OS browser and denies the window, which is unchanged.
   */
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeHref(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // A webview tag would reintroduce everything we just disabled.
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}
