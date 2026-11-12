import { shell, type Session, type WebContents, type WindowOpenHandlerResponse } from 'electron'
import { isSafeHref } from '../shared/markdown.js'
import { TOAST_WINDOW_NAME } from '../shared/toast-window-ipc.js'
import { NOTE_IMAGE_SCHEME } from './note-images.js'

/**
 * Chorus renders untrusted model output. Without these, an injection in an
 * agent message escalates from "weird text" to remote code execution, so none
 * of it is optional (plan §4.4).
 */

const BASE_CSP = [
  "default-src 'none'",
  // Vite injects styles at runtime; scripts stay strict, which is what matters.
  "style-src 'self' 'unsafe-inline'",
  /*
   * `chorus-note:` is main's own scheme and nothing else can answer on it.
   *
   * Named rather than the directive being widened to a class: the handler in
   * `note-images.ts` serves one folder under `userData` and refuses any name it
   * did not generate, so what this admits is a fixed set of files this process
   * wrote. The alternative was a data URL, which needs no directive at all and
   * would put every pasted screenshot inside the note's database row.
   */
  `img-src 'self' data: ${NOTE_IMAGE_SCHEME}:`,
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
 * The workbench's own policy, on the workbench's own session — a second policy,
 * not a wider one (preflight §5.2).
 *
 * The shell's `default-src 'none'` is what an embedded workbench cannot run
 * under, and the failure everything here is arranged against is that somebody
 * relaxes it *as a block* to make the workbench work. Because the workbench lives
 * on its own `chorus-workbench` partition, none of `PRODUCTION_CSP` moves: this
 * is a separate document under a separate policy that the shell never sees.
 *
 * The relocated risk is the opposite one, and it is quieter. A fresh partition
 * starts with **no** CSP and **no** permission handler at all, so every directive
 * below is here because it had to be installed deliberately rather than because
 * it was loosened. An absent control is not a relaxed control; it is a dead one.
 *
 * Each line names what needs it:
 *
 *  - `script-src 'self' 'unsafe-eval'` — VS Code compiles regexes and evaluates
 *    generated code in its own runtime, and its workers are built from the
 *    bundle. `'self'` is still the only *origin*; no remote script is admissible.
 *  - `worker-src`/`child-src` with `blob:` — the textmate, language-detection and
 *    editor workers are started from blob URLs by the bundler's worker plumbing.
 *  - `style-src 'unsafe-inline'` — VS Code writes theme colours into inline style
 *    attributes on nearly every element it draws. There is no version of the
 *    workbench that runs without this.
 *  - `connect-src 'self' data: blob:` plus **exactly** `ws://<authority>` and
 *    `http://<authority>` for the one remote extension host Chorus spawned, with
 *    the port substituted at spawn time. Never a `127.0.0.1:*` wildcard: the
 *    port is ephemeral, so a wildcard is the tempting shortcut, and it would let
 *    *any* local server be reached from a renderer that runs third-party
 *    extension code. The narrow form is possible only because main reads the port
 *    back out of the child it started, which is the same fact that makes
 *    "never attach to a port Chorus did not open" enforceable.
 *  - `img-src` and `font-src` with that same `http://<authority>`, because an
 *    installed *icon* theme's images are served by that host: a policy that lets
 *    the renderer `fetch()` the theme's JSON but not load the images it names
 *    applies the theme and paints nothing.
 *  - `frame-ancestors 'none'` — nothing frames the workbench either. A workbench
 *    document that permitted framing is one an extension webview could try to
 *    frame.
 */
const WORKBENCH_BASE_CSP = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
]

/**
 * The one remote extension host this session may reach, validated once.
 *
 * Built from the authority main read out of the child's own stdout, so the
 * policy and the server cannot drift: there is no second place the port is
 * written down. An authority that is not `host:port` is refused rather than
 * interpolated, because a policy assembled from an unvalidated string is a policy
 * whose meaning depends on what was in the string.
 *
 * Validated here rather than inside each directive's helper: three directives now
 * name this authority, and a check written out three times is a check that can
 * come to disagree with itself.
 */
function remoteAuthorityOrNull(remoteAuthority: string | null): string | null {
  if (remoteAuthority === null) return null
  if (!/^[A-Za-z0-9.\-[\]:]+:\d+$/.test(remoteAuthority)) {
    throw new Error(`Not a usable workbench remote authority: ${remoteAuthority}`)
  }
  return remoteAuthority
}

/** The REH as the two origins a *connection* may be opened to. */
function remoteConnectSources(remoteAuthority: string | null): string {
  const authority = remoteAuthorityOrNull(remoteAuthority)
  return authority === null ? '' : ` ws://${authority} http://${authority}`
}

/**
 * The REH as the one origin *content* is fetched from — `http://` only, since
 * `ws://` is meaningless to `img-src` and naming an origin a directive can never
 * use only makes the policy harder to read.
 *
 * **This is the second half of a chain whose first half was already fixed.**
 * `STATUS.md` records making an installed theme able to load its own resources,
 * and that was proved with a *colour* theme — which loads no images, so
 * `connect-src` plus the CORS exemption below was sufficient and the rest of the
 * gap stayed invisible. An icon theme is the case that finds it: it emits one
 * `background-image` per definition — 1251 of them for Material Icon Theme — each
 * pointing at `http://<authority>/…/vscode-remote-resource`, and every one is
 * governed by `img-src` rather than `connect-src`. The theme scanned, listed,
 * applied, persisted, injected its stylesheet, and painted nothing at all.
 *
 * `font-src` is the same failure one step over: an icon theme may ship a webfont
 * instead of SVGs, and seti — the built-in — is exactly that shape, so the class
 * is real rather than hypothetical.
 *
 * **What this widens, stated plainly.** The renderer may now load images and
 * fonts from the REH's own origin. That origin is a server Chorus spawned and
 * already trusts in `connect-src`, and an extension can already fetch any byte of
 * it from there — so this grants no reach that was not already granted, and
 * changes only which directive governs it.
 */
function remoteContentSource(remoteAuthority: string | null): string {
  const authority = remoteAuthorityOrNull(remoteAuthority)
  return authority === null ? '' : ` http://${authority}`
}

/**
 * Exported for its test, which is the point rather than a convenience: this
 * string is a security boundary, and it now contains a deliberate widening. A
 * test that names every origin is how the next widening has to be deliberate too.
 */

/**
 * Where a webview's own resources come from, and it is not really a CDN.
 *
 * `asWebviewUri` rewrites an extension's scripts, stylesheets, images and
 * workers to `https://<encoded-authority>.vscode-resource.vscode-cdn.net/…`.
 * Nothing is fetched from the internet: the service worker registered by the
 * bootstrap intercepts these and answers them over `postMessage`. The host is a
 * routing convention, not a destination.
 *
 * It is still named here rather than waved through, because the browser applies
 * CSP before the service worker is consulted — a refused request never reaches
 * the worker at all, which is exactly what was observed: every stylesheet and
 * script of Markdown preview and the PDF viewer refused, while the DOCX reader
 * worked because it writes inline HTML and asks for no resources.
 *
 * The wildcard is on the subdomain because the encoded authority is in it, and
 * that authority contains the REH's ephemeral port.
 */
const WEBVIEW_RESOURCE_HOST = 'https://*.vscode-cdn.net'
const DEV_WORKER_HOST_IFRAME_PATH = new RegExp(
  '^/@fs/.+/node_modules/\\.pnpm/' +
    '@codingame\\+monaco-vscode-extensions-service-override@33\\.0\\.9_patch_hash=[a-f0-9]{16}_[a-f0-9]{32}/' +
    'node_modules/@codingame/monaco-vscode-extensions-service-override/' +
    'vscode/src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe\\.html$'
)
const DEV_WEBVIEW_DOCUMENT_PATH = new RegExp(
  '^/@fs/.+/node_modules/\\.pnpm/' +
    '@codingame\\+monaco-vscode-view-common-service-override@33\\.0\\.9/' +
    'node_modules/@codingame/monaco-vscode-view-common-service-override/' +
    'service-override/vs/workbench/contrib/webview/browser/pre/(?:index|fake)\\.html$'
)

/**
 * Is this response a document the workbench legitimately frames?
 *
 * **Exact filenames under the renderer's asset directory, and a sub-frame.**
 * Both halves matter: the workbench document must never match this, and neither
 * must anything else a webview loads. An extension's own HTML is *written into*
 * the inner frame rather than fetched, so it never reaches this check — which is
 * why matching known bundler outputs is sufficient and a prefix is not.
 *
 * The hashed suffix is the bundler's, so the match is on shape rather than on a
 * literal that would break every build.
 *
 * **`webWorkerExtensionHostIframe` is the third, and it is not a webview.** It is
 * the frame the web-worker extension host runs in, emitted once
 * `enableWorkerExtensionHost` was turned on in `workbench/services.ts` and
 * registered as an asset by `extensions-service-override`. It is named here
 * because it needs the identical concession and for the identical reason: the
 * workbench frames it, so served the base policy's `frame-ancestors 'none'`
 * Chromium refuses the response and the host never starts. Everything assigned
 * to that host then silently never activates — which presented as an Excalidraw
 * file opening a custom editor that loaded forever, since the contribution was
 * registered from the extension registry while the extension backing it was
 * never run.
 *
 * That the function now covers a non-webview is why it is no longer named after
 * "the two documents a webview is built from". The predicate is "the workbench
 * frames this on purpose", and `frame-ancestors 'self'` is what that requires.
 * Widening the *base* policy instead would let an extension webview frame the
 * workbench, which is the attack the base policy's own comment names — the
 * per-document exception is the whole point and must stay per-document.
 */
export function isWebviewDocument(url: string, resourceType: string, isDev = false): boolean {
  if (resourceType !== 'subFrame') return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (
    /\/out\/renderer\/assets\/(?:index|fake|webWorkerExtensionHostIframe)-[A-Za-z0-9_-]+\.html$/.test(
      parsed.pathname
    )
  )
    return true
  return (
    isDev &&
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
    (DEV_WORKER_HOST_IFRAME_PATH.test(parsed.pathname) ||
      DEV_WEBVIEW_DOCUMENT_PATH.test(parsed.pathname))
  )
}

/**
 * What the webview's own two documents may do — and it differs from the
 * workbench's in exactly one way that matters.
 *
 * **`frame-ancestors 'self'` instead of `'none'`, and that is the whole bug.**
 * The base policy is applied to every response in this session, so the webview's
 * bootstrap document was served `frame-ancestors 'none'` — "nothing may frame
 * me" — while the workbench was framing it. Chromium refused the response,
 * `ERR_BLOCKED_BY_RESPONSE`, and every webview in the app was blank. Nothing
 * downstream of that had ever run: not the inline bootstrap, not the
 * `vscode-cdn.net` fetches, not the service worker.
 *
 * **The workbench document keeps `'none'`, and widening the base policy would
 * have been the wrong fix.** `frame-ancestors` constrains who may frame *this*
 * document, so relaxing it session-wide would let an extension webview frame the
 * workbench — the attack the base policy's own comment names. The distinction is
 * per-document and can only be drawn per response.
 *
 * Deliberately no `https://*.vscode-cdn.net` yet. That is the *predicted* next
 * blocker, and predicting is what produced three causes none of which turned out
 * to be reachable. It goes in when a real request is observed being refused.
 */
export function webviewDocumentPolicy(isDev: boolean, remoteAuthority: string | null): string {
  const remote = remoteConnectSources(remoteAuthority)
  const content = remoteContentSource(remoteAuthority)
  return [
    "default-src 'none'",
    `style-src 'self' 'unsafe-inline' ${WEBVIEW_RESOURCE_HOST}`,
    `img-src 'self' data: blob: ${WEBVIEW_RESOURCE_HOST}${content}`,
    `font-src 'self' data: ${WEBVIEW_RESOURCE_HOST}${content}`,
    `media-src 'self' data: blob: ${WEBVIEW_RESOURCE_HOST}`,
    /*
     * The resource host here too, for the viewers that do their work off the main
     * thread. `adamraichu.pdf-viewer` loads `pdf.worker.js` through
     * `asWebviewUri`, so the worker resolves to the same host its scripts do —
     * and `worker-src` does not fall back to `script-src`.
     *
     * The symptom this fixes is a viewer that renders its *own* loading HTML and
     * then stops: the document needs no worker, the content does. Markdown
     * preview was unaffected and started working one change earlier, which is
     * what distinguished the two.
     */
    `worker-src 'self' blob: ${WEBVIEW_RESOURCE_HOST}`,
    "child-src 'self' blob:",
    /*
     * `base-uri` for the resource host, which is not decoration: the webview sets
     * its own base URI to the document being previewed —
     * `…vscode-resource.vscode-cdn.net/…/AGENTS.md` — so that relative links in
     * the content resolve. Observed refused as
     * "Setting the document's base URI … violates the following Content Security
     * Policy directive"; without it every relative reference in a preview points
     * at the wrong place.
     */
    `base-uri ${WEBVIEW_RESOURCE_HOST}`,
    "form-action 'none'",
    "object-src 'none'",
    /*
     * The one document in this app that may be framed, and only by this app.
     * `'self'` and not the parent's literal origin: they are the same origin
     * today, and naming it would encode the `file:` scheme.
     */
    "frame-ancestors 'self'",
    /*
     * **`'unsafe-inline'`, and the hash it replaces was a prediction that failed
     * measurement.**
     *
     * The narrower design — admit only the bundled bootstrap by its own
     * `sha256-2bgY7b4AY+EULl24tUGduYOHUHUBH5EuIHGYqk8TM+k=` — was tried first,
     * and it is right about the bootstrap. It cannot be right about
     * everything else: the inner frame is written with *extension-authored*
     * HTML, and the console showed inline scripts refused against that very hash
     * on every preview. A hash can only ever name scripts we ship, and none of
     * these are ours.
     *
     * This is how VS Code itself works, and the division of labour is the reason
     * it is acceptable: the **envelope** permits inline script, and the
     * **content** constrains it with its own `<meta>` CSP, which extensions are
     * required to set. The two policies intersect, so an extension that sets a
     * strict meta policy still gets it.
     *
     * What bounds the widening is the selector, not this directive. It reaches
     * exactly two bundled documents in sub-frames; the workbench document keeps
     * `script-src` with no `'unsafe-inline'` and keeps `frame-ancestors 'none'`,
     * so this cannot be turned back on the shell.
     */
    isDev
      ? `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${WEBVIEW_RESOURCE_HOST}`
      : `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${WEBVIEW_RESOURCE_HOST}`,
    `connect-src 'self' data: blob: ${WEBVIEW_RESOURCE_HOST}${remote}${isDev ? ' ws://localhost:* http://localhost:*' : ''}`,
  ].join('; ')
}

export function workbenchPolicy(isDev: boolean, remoteAuthority: string | null): string {
  const remote = remoteConnectSources(remoteAuthority)
  const content = remoteContentSource(remoteAuthority)
  return [
    ...WORKBENCH_BASE_CSP,
    isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:"
      : "script-src 'self' 'unsafe-eval' blob:",
    /*
     * `https://open-vsx.org` here and in `connect-src` — the one host this
     * workbench may reach beyond its own server, and it is the gallery it is
     * already configured to install from.
     *
     * Without it the Extensions view can search and install and cannot *show* what
     * it is offering: the details pane renders "Failed to fetch" and every icon is
     * blank, because installing happens on the REH while the README and the icons
     * are fetched by this renderer. Reported as "failed to fetch" against an
     * extension that had in fact installed.
     *
     * **Two hosts, and the second is not optional.** Every asset URL Open VSX
     * returns — README, licence, icon — is on `open-vsx.org/api/...` and
     * **302-redirects to `openvsx.eclipsecontent.org`**, Eclipse's content CDN. A
     * CSP applies to the redirect target, so allowing only the first host leaves
     * the pane failing exactly as it did before, which is what happened: the
     * gallery origin was added, the error did not change, and the redirect was
     * only visible by following the request rather than reading the config.
     *
     * Narrowly, and the narrowness is the point the paragraph above makes: this
     * renderer runs third-party extension code, so each origin added is one that
     * code can reach. These two buy nothing new in practice — an extension already
     * talks to Open VSX through the extension host — which is what makes them the
     * only widening worth making.
     *
     * These two directives live here rather than in `WORKBENCH_BASE_CSP` because
     * they now name the REH as well, and the authority is only known here.
     */
    `img-src 'self' data: blob: https://open-vsx.org https://openvsx.eclipsecontent.org${content}`,
    `font-src 'self' data:${content}`,
    `connect-src 'self' data: blob: https://open-vsx.org https://openvsx.eclipsecontent.org${remote}${isDev ? ' ws://localhost:* http://localhost:*' : ''}`,
  ].join('; ')
}

/**
 * Is this the REH's own resource endpoint, on the server Chorus started.
 *
 * **The path carries the product segment**, and a first version of this did not
 * — so the branch it guards was unreachable and the fix it enabled did nothing
 * at all, while the screenshot stayed identical. The client builds
 * `/${quality}-${commit}/vscode-remote-resource`: `network.js`'s
 * `getServerProductSegment` returns `${product.quality}-${product.commit}` and
 * joins it in front. `workbench-ipc.ts` already documents that prefix, in the
 * paragraph explaining why a `quality` mismatch 404-storms rather than failing
 * loudly.
 *
 * Compared exactly rather than with `endsWith`, which is the point of threading
 * the identity here at all: both values are already in `WorkbenchRuntime`, so
 * there is no reason to accept a path that merely finishes the right way. This
 * runs in a session that executes third-party extension code.
 */
export function isOwnRemoteResource(
  url: string,
  remoteAuthority: string | null,
  product: { readonly quality: string; readonly commit: string } | null
): boolean {
  if (remoteAuthority === null || product === null) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.origin === `http://${remoteAuthority}` &&
    parsed.pathname === `/${product.quality}-${product.commit}/vscode-remote-resource`
  )
}

export function applyWorkbenchContentSecurityPolicy(
  session: Session,
  isDev: boolean,
  remoteAuthority: string | null,
  /** The server's identity, which its resource path is prefixed with. */
  product: { readonly quality: string; readonly commit: string } | null
): void {
  const policy = workbenchPolicy(isDev, remoteAuthority)
  const webviewPolicy = webviewDocumentPolicy(isDev, remoteAuthority)

  session.webRequest.onHeadersReceived((details, callback) => {
    /*
     * Two policies, chosen per response, because `frame-ancestors` is a statement
     * about *this* document and the session holds two kinds. Everything that is
     * not one of the two bundled webview documents keeps the restrictive policy,
     * including any other sub-frame — the selector is an allowlist of exact
     * shapes, not an exemption for sub-frames as a class.
     */
    const responseHeaders: Record<string, string[]> = {
      ...details.responseHeaders,
      'Content-Security-Policy': [
        isWebviewDocument(details.url, details.resourceType, isDev) ? webviewPolicy : policy,
      ],
    }

    /*
     * The one response Chorus adds a CORS header to, and why it has to.
     *
     * An installed theme lives on the remote extension host, so applying it ends
     * in `FileIconThemeLoader -> readExtensionResource ->
     * http://<authority>/vscode-remote-resource`. VS Code's server sends
     * `Access-Control-Allow-Origin` only when the request's origin matches
     * `product.webEndpointUrlTemplate`, and VSCodium's bundled product defines
     * no such template — so no origin ever matches, the browser refuses the
     * response, and it surfaces as a bare "Failed to fetch" toast naming nothing.
     *
     * **Scoped to one origin and one path**, both compared exactly: the origin is
     * the server Chorus itself spawned and read the port back from, and the path
     * is the single resource endpoint. Not a prefix, not a subtree — the same
     * narrowness the CSP above is written for, because this session runs
     * third-party extension code.
     *
     * `*` is defensible *here* rather than in general: the endpoint is
     * authenticated by the connection token, which nothing without it can
     * supply, and CORS forbids `*` together with credentials. What it grants is
     * the ability to *read* a response somebody was already entitled to request.
     *
     * Existing spellings are dropped rather than appended to: two
     * `Access-Control-Allow-Origin` headers are treated as none.
     */
    if (!isOwnRemoteResource(details.url, remoteAuthority, product)) {
      callback({ responseHeaders })
      return
    }

    /*
     * Rebuilt without any existing spelling rather than deleting keys: header
     * names are case-insensitive, so a server-sent `access-control-allow-origin`
     * beside ours would be two values for one header, which browsers treat as
     * none.
     */
    const withCors = Object.fromEntries(
      Object.entries(responseHeaders).filter(
        ([name]) => name.toLowerCase() !== 'access-control-allow-origin'
      )
    )
    callback({
      responseHeaders: { ...withCors, 'Access-Control-Allow-Origin': ['*'] },
    })
  })

  /*
   * Set, not inherited. `setPermissionRequestHandler` is a session method, so
   * the shell's `callback(false)` covers `session.defaultSession` and nothing
   * else — leaving this partition without one means every request is answered by
   * Electron's defaults instead. Denied stays denied in Phase 1: a denial is a
   * legible failure, a blanket grant is an invisible one, and an absent handler
   * is invisible twice over.
   */
  session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
}

/**
 * The one address a `WebContents` is allowed to hold, reduced to the three parts
 * that decide which document loads.
 *
 * `null` for anything unparseable **and for anything carrying a query string**.
 * No entry Chorus loads has one, and on the dev server the query is the one part
 * of a URL that reaches the network — so admitting it would be admitting a
 * channel rather than a document. The fragment is ignored instead of refused,
 * and the difference is read out of Electron's own typings rather than guessed:
 * `will-navigate` "is also not emitted for in-page navigations, such as clicking
 * anchor links or updating the `window.location.hash`", so a hash can only reach
 * here attached to a real cross-document load of the same entry.
 */
function entryKey(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.search !== '') return null
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
}

/**
 * The renderer must never navigate away from our own bundle, and must never
 * open a window itself. External links go to the OS browser instead.
 *
 * **`allowedEntries` is an exact allowlist, and it replaced a prefix test that
 * was not a boundary at all.** The rule used to be "starts with `file://`, or
 * starts with the dev server's URL", and both halves fail:
 *
 *  - Under `file://` **every document on the disk qualifies** — including the
 *    shell's own `index.html`. A workbench surface runs third-party extension
 *    code by design, so that admitted the one navigation that matters: a surface
 *    walking itself onto the shell's entry, in a `WebContents` the shell's own
 *    preload was never meant to meet.
 *  - A prefix over an origin is not even a same-origin test. `http://localhost:5173`
 *    is a prefix of `http://localhost:51739.evil.example/`, so a host that merely
 *    *starts* the same passes.
 *
 * Callers derive the list from the very value they load, so the allowlist and
 * the document cannot drift — the failure `security.ts` already records once, in
 * the window-open handler below, where two allowlists over one decision drifted
 * and the drift showed up as a dead control rather than an error.
 *
 * A malformed entry throws here rather than being skipped: a list with a silent
 * hole in it is the same dead control one level further out.
 *
 * Takes a `WebContents` rather than a `BrowserWindow` because a `WebContentsView`
 * has no window of its own and inherits none of this: its `webContents` is a
 * different object, and every listener below binds to one object. Left unbound on
 * a workbench view, `will-attach-webview` in particular is not relaxed — it is
 * simply absent, which is the dead-control failure the comment further down
 * already records once.
 */
export function lockDownNavigation(
  contents: WebContents,
  allowedEntries: readonly string[],
  /**
   * Called when this document sends a URL to the OS browser.
   *
   * Optional because the shell window uses this too and has no callback to
   * route: only a workbench surface can be the origin of a flow that comes back
   * through the app's URL scheme.
   */
  onExternal?: (url: string) => void,
  openToastWindow?: () => WindowOpenHandlerResponse
): void {
  const allowed = new Set<string>()
  for (const entry of allowedEntries) {
    const key = entryKey(entry)
    if (key === null) throw new Error(`Not a usable navigation entry: ${entry}`)
    allowed.add(key)
  }

  contents.on('will-navigate', (event, url) => {
    const key = entryKey(url)
    if (key === null || !allowed.has(key)) event.preventDefault()
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
  contents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && frameName === TOAST_WINDOW_NAME && openToastWindow !== undefined) {
      return openToastWindow()
    }
    if (isSafeHref(url)) {
      void shell.openExternal(url)
      /*
       * Reported, not merely done — this is the only moment main can know *which*
       * surface sent a person to a browser.
       *
       * An OAuth callback comes back as a `chorus://` URL with no project in it,
       * and one REH serves up to five surfaces, so "who was this for?" has no
       * answer in the callback itself. Answering it by delivering to every
       * surface would hand one project's token to all of them. The surface that
       * opened the browser is the only honest claimant, and this is where that
       * fact exists.
       */
      onExternal?.(url)
    }
    return { action: 'deny' }
  })

  // A webview tag would reintroduce everything we just disabled.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}
