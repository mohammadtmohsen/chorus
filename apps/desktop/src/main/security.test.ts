import { describe, expect, it } from 'vitest'
import {
  isOwnRemoteResource,
  isWebviewDocument,
  webviewDocumentPolicy,
  workbenchPolicy,
} from './security.js'

/**
 * What the workbench renderer may reach, named exactly.
 *
 * This document runs third-party extension code, so its policy is the boundary
 * between an extension and the machine — and it now contains two deliberate
 * widenings: `https://open-vsx.org`, so the Extensions view can show a README
 * instead of "Failed to fetch", and the REH's own `http://<authority>` in
 * `img-src`/`font-src`, so an installed icon theme can load the images it draws
 * with. A test that lists every origin is what makes the *next* widening a
 * decision rather than a diff nobody reads.
 */
describe('the workbench content security policy', () => {
  const policy = workbenchPolicy(false, '127.0.0.1:51515')
  const directive = (name: string): string =>
    policy.split('; ').find((part) => part.startsWith(`${name} `)) ?? ''

  it('reaches the gallery it installs from, and says so in both directives', () => {
    expect(directive('connect-src')).toContain('https://open-vsx.org')
    expect(directive('img-src')).toContain('https://open-vsx.org')
  })

  /*
   * The CDN the gallery redirects to. Allowing only `open-vsx.org` left the
   * details pane failing identically, because every asset URL 302s to Eclipse's
   * content host and a CSP governs the redirect target.
   */
  it('reaches the CDN those assets actually redirect to', () => {
    expect(directive('connect-src')).toContain('https://openvsx.eclipsecontent.org')
    expect(directive('img-src')).toContain('https://openvsx.eclipsecontent.org')
  })

  it('reaches its own server as two exact origins', () => {
    expect(directive('connect-src')).toContain('ws://127.0.0.1:51515')
    expect(directive('connect-src')).toContain('http://127.0.0.1:51515')
  })

  /*
   * The directive an installed icon theme actually needs, and the one the colour
   * theme that proved the CORS fix never exercised. Material Icon Theme emits one
   * `background-image: url(http://<authority>/…/vscode-remote-resource…)` per
   * definition; with the origin only in `connect-src` the JSON loads, the theme
   * applies, and all 1251 images are blocked.
   *
   * `ws://` is asserted absent rather than merely unlisted: a helper that reused
   * `remoteConnectSources` here would pass every other assertion in this file
   * while putting a scheme in `img-src` that can never serve an image.
   */
  it('loads an installed theme’s own images and fonts from that server', () => {
    expect(directive('img-src')).toContain('http://127.0.0.1:51515')
    expect(directive('font-src')).toContain('http://127.0.0.1:51515')
    expect(directive('img-src')).not.toContain('ws://')
    expect(directive('font-src')).not.toContain('ws://')
  })

  /*
   * The rule the file's own comment is emphatic about: the port is ephemeral, so
   * a wildcard is the tempting shortcut, and it would let any local server be
   * reached from a renderer running third-party code.
   */
  it('never widens to a local wildcard in production', () => {
    expect(policy).not.toContain('127.0.0.1:*')
    expect(policy).not.toContain('localhost:*')
  })

  it('starts from nothing and frames nobody', () => {
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
  })

  /*
   * The whole list, so an origin added anywhere shows up here as a failing
   * assertion rather than as a directive nobody re-read.
   */
  it('allows no host beyond the gallery and its own server', () => {
    const hosts = [...policy.matchAll(/\b(?:https?|wss?):\/\/[^\s;]+/g)].map((m) => m[0]).sort()
    expect(hosts).toEqual([
      // connect-src, img-src, font-src — the same one server, three directives.
      'http://127.0.0.1:51515',
      'http://127.0.0.1:51515',
      'http://127.0.0.1:51515',
      'https://open-vsx.org',
      'https://open-vsx.org',
      'https://openvsx.eclipsecontent.org',
      'https://openvsx.eclipsecontent.org',
      'ws://127.0.0.1:51515',
    ])
  })

  it('refuses an authority that is not host:port rather than interpolating it', () => {
    expect(() => workbenchPolicy(false, 'evil.example.com/path')).toThrow()
  })
})

/**
 * The second policy, and the boundary it must not blur.
 *
 * A webview's bootstrap document exists in order to be framed; the workbench
 * document exists in order not to be. The base policy said `frame-ancestors
 * 'none'` for both, so Chromium refused the webview's own response
 * (`ERR_BLOCKED_BY_RESPONSE`) and every webview in the app was blank — markdown
 * preview, the PDF viewer, the DOCX reader — with nothing downstream ever
 * running.
 *
 * The fix is per-response, and the tests below are about the *selector* as much
 * as the policy: the cheap wrong version of this is "sub-frames get the weaker
 * policy", which would hand it to any frame an extension can cause to load.
 */
describe('the webview document policy', () => {
  const dev = webviewDocumentPolicy(true, '127.0.0.1:51515')
  const prod = webviewDocumentPolicy(false, '127.0.0.1:51515')
  const directive = (policy: string, name: string): string =>
    policy.split('; ').find((part) => part.startsWith(`${name} `)) ?? ''

  it('lets this app frame the webview, and nobody else', () => {
    expect(directive(prod, 'frame-ancestors')).toBe("frame-ancestors 'self'")
  })

  /*
   * The whole point of two policies rather than one widened one. If this ever
   * fails, an extension webview can frame the workbench, which is the attack the
   * base policy's own comment names.
   */
  it('leaves the workbench itself unframeable', () => {
    expect(workbenchPolicy(false, '127.0.0.1:51515')).toContain("frame-ancestors 'none'")
    expect(workbenchPolicy(true, '127.0.0.1:51515')).toContain("frame-ancestors 'none'")
  })

  /*
   * **This asserted the opposite until the hash was measured and failed.**
   *
   * The narrow version admitted only the bundled bootstrap by
   * `sha256-2bgY7b4A…`. The console then showed inline scripts refused against
   * that exact hash on every preview, because the inner frame is written with
   * extension-authored HTML and a hash can only name scripts we ship.
   *
   * What keeps this honest is not the directive but the selector, which the
   * tests below pin: two bundled documents, sub-frames only. The workbench's own
   * policy is asserted free of `'unsafe-inline'` in the same breath, because
   * that is the property this must never cost.
   */
  it('admits extension inline script, and never lets the workbench do the same', () => {
    expect(directive(prod, 'script-src')).toContain("'unsafe-inline'")
    expect(directive(dev, 'script-src')).toContain("'unsafe-inline'")
    /*
     * `script-src` specifically, not the whole policy. The workbench has carried
     * `style-src 'self' 'unsafe-inline'` for as long as it has existed, because
     * VS Code writes theme colours into inline style attributes on nearly every
     * element it draws — a first version of this assertion tested the whole
     * string and failed on that, which is the assertion being wrong rather than
     * the policy.
     */
    expect(directive(workbenchPolicy(false, '127.0.0.1:51515'), 'script-src')).not.toContain(
      "'unsafe-inline'"
    )
  })

  /*
   * Every one of these was observed refused in the packaged app before it was
   * added — stylesheets and scripts for Markdown preview and the PDF viewer, and
   * the base URI the preview sets to the document it is rendering. The host is a
   * routing convention answered by the webview's service worker, not a real
   * fetch, but CSP is applied before the worker is consulted.
   */
  it('reaches the resource host the service worker answers for', () => {
    for (const name of [
      'script-src',
      'style-src',
      'img-src',
      'font-src',
      'connect-src',
      /*
       * `worker-src` does not fall back to `script-src`, so a viewer whose work
       * happens off the main thread needs it named separately. The PDF viewer
       * loads `pdf.worker.js` through `asWebviewUri`; with this missing it
       * rendered its own loading HTML and then stopped, while Markdown preview —
       * which uses no worker — worked.
       */
      'worker-src',
    ]) {
      expect(directive(prod, name)).toContain('https://*.vscode-cdn.net')
    }
    expect(directive(prod, 'base-uri')).toBe('base-uri https://*.vscode-cdn.net')
  })

  /* The workbench must not gain that host along the way. */
  it('does not widen the workbench to the resource host', () => {
    expect(workbenchPolicy(false, '127.0.0.1:51515')).not.toContain('vscode-cdn.net')
  })
})

describe('which responses are webview documents', () => {
  const asset = (name: string): string =>
    `file:///Applications/Chorus.app/Contents/Resources/app.asar/out/renderer/assets/${name}`
  const devWorkerIframe =
    'http://127.0.0.1:5173/@fs/Users/example/chorus/node_modules/.pnpm/' +
    '@codingame+monaco-vscode-extensions-service-override@33.0.9_patch_hash=48af9da4e21880b2_a3cdb0c21a24fa53daea8625a4bbc07b/' +
    'node_modules/@codingame/monaco-vscode-extensions-service-override/' +
    'vscode/src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html'
  const devWebviewBootstrap =
    'http://127.0.0.1:5173/@fs/Users/example/chorus/node_modules/.pnpm/' +
    '@codingame+monaco-vscode-view-common-service-override@33.0.9/' +
    'node_modules/@codingame/monaco-vscode-view-common-service-override/' +
    'service-override/vs/workbench/contrib/webview/browser/pre/index.html'

  it.each([
    ['worker-host iframe', devWorkerIframe],
    ['webview bootstrap', devWebviewBootstrap],
  ])('admits the localhost %s only in development', (_name, url) => {
    const localhostUrl = url.replace('127.0.0.1', 'localhost')
    expect(isWebviewDocument(localhostUrl, 'subFrame', true)).toBe(true)
    expect(isWebviewDocument(localhostUrl, 'subFrame', false)).toBe(false)
    expect(isWebviewDocument(localhostUrl, 'mainFrame', true)).toBe(false)
  })

  it('admits the observed webview bootstrap served by Vite only in development', () => {
    expect(isWebviewDocument(devWebviewBootstrap, 'subFrame', true)).toBe(true)
    expect(isWebviewDocument(devWebviewBootstrap, 'subFrame', false)).toBe(false)
    expect(isWebviewDocument(`${devWebviewBootstrap}.evil`, 'subFrame', true)).toBe(false)
    expect(
      isWebviewDocument(
        devWebviewBootstrap.replace('127.0.0.1', 'evil.example.com'),
        'subFrame',
        true
      )
    ).toBe(false)
    expect(isWebviewDocument(devWebviewBootstrap, 'mainFrame', true)).toBe(false)
  })

  it('admits the observed nested webview document only as a development sub-frame', () => {
    const nestedDocument = devWebviewBootstrap.replace('/index.html', '/fake.html')
    expect(isWebviewDocument(nestedDocument, 'subFrame', true)).toBe(true)
    expect(isWebviewDocument(nestedDocument, 'subFrame', false)).toBe(false)
    expect(isWebviewDocument(nestedDocument, 'mainFrame', true)).toBe(false)
    expect(isWebviewDocument(`${nestedDocument}.evil`, 'subFrame', true)).toBe(false)
  })

  it('admits the pinned worker-host iframe served by Vite only in development', () => {
    expect(isWebviewDocument(devWorkerIframe, 'subFrame', true)).toBe(true)
    expect(isWebviewDocument(devWorkerIframe, 'subFrame', false)).toBe(false)
    expect(isWebviewDocument(devWorkerIframe, 'subFrame')).toBe(false)
  })

  it('keeps other origins, paths, and resource types outside the development exception', () => {
    expect(
      isWebviewDocument(devWorkerIframe.replace('127.0.0.1', 'evil.example.com'), 'subFrame', true)
    ).toBe(false)
    expect(isWebviewDocument(`${devWorkerIframe}.evil`, 'subFrame', true)).toBe(false)
    expect(isWebviewDocument(devWorkerIframe.replace('33.0.9', '33.0.10'), 'subFrame', true)).toBe(
      false
    )
    expect(isWebviewDocument(devWorkerIframe.replace('/@fs/', '/assets/'), 'subFrame', true)).toBe(
      false
    )
    expect(isWebviewDocument(devWorkerIframe, 'mainFrame', true)).toBe(false)
    expect(isWebviewDocument(devWorkerIframe, 'xhr', true)).toBe(false)
  })

  it('matches the two bundled documents a webview is built from', () => {
    expect(isWebviewDocument(asset('index-D5H5KsJm.html'), 'subFrame')).toBe(true)
    expect(isWebviewDocument(asset('fake-DXkbmQ09.html'), 'subFrame')).toBe(true)
  })

  /*
   * The selector is an allowlist of exact shapes, never an exemption for
   * sub-frames as a class. A webview renders extension-authored HTML, so "any
   * sub-frame" would hand the weaker policy to content an extension controls.
   */
  it('refuses any other sub-frame, however close', () => {
    expect(isWebviewDocument(asset('index-D5H5KsJm.html.evil'), 'subFrame')).toBe(false)
    expect(isWebviewDocument(asset('nested/index-AAAA.html'), 'subFrame')).toBe(false)
    expect(isWebviewDocument(asset('indexes-AAAA.html'), 'subFrame')).toBe(false)
    expect(isWebviewDocument('https://evil.example.com/index-AAAA.html', 'subFrame')).toBe(false)
    expect(isWebviewDocument(asset('main-AAAA.js'), 'subFrame')).toBe(false)
  })

  /*
   * The workbench document is served from the same directory tree, so the
   * resource type is what keeps it out — a top-level document is never one of
   * these, whatever it is named.
   */
  it('never matches a top-level document', () => {
    expect(isWebviewDocument(asset('index-D5H5KsJm.html'), 'mainFrame')).toBe(false)
    expect(isWebviewDocument(asset('index-D5H5KsJm.html'), 'xhr')).toBe(false)
  })

  it('treats an unparseable url as not a webview document', () => {
    expect(isWebviewDocument('not a url', 'subFrame')).toBe(false)
  })
})

/**
 * The one response the workbench session adds `Access-Control-Allow-Origin` to.
 *
 * An installed theme lives on the remote extension host, so applying it fetches
 * `http://<authority>/vscode-remote-resource`. VS Code's server only sends CORS
 * headers when the origin matches `product.webEndpointUrlTemplate`, and
 * VSCodium's product defines none — so the browser refuses the response and it
 * surfaces as a bare "Failed to fetch".
 *
 * Every assertion here is about **exactness**. This predicate is the whole
 * safety of that header: it runs in a session that executes third-party
 * extension code, and a prefix match or a subtree would hand that code a CORS
 * bypass for anything the server serves.
 */
describe('the remote resource CORS exemption', () => {
  const authority = '127.0.0.1:51515'
  /* The real pair from `workbench-runtime.json`, so the path under test is the
     path the client actually builds. */
  const product = { quality: 'stable', commit: '987c9597516278c9fcf10d963a0592ce1384ab93' }
  const segment = `${product.quality}-${product.commit}`
  const ok = (url: string) => isOwnRemoteResource(url, authority, product)

  it('matches the resource endpoint on our own server', () => {
    expect(ok(`http://${authority}/${segment}/vscode-remote-resource?path=%2Ficon.svg`)).toBe(true)
  })

  /*
   * The bug this predicate shipped with: it matched the unprefixed path, which
   * the client never generates, so the header branch was unreachable and the
   * screenshot stayed identical through two commits.
   */
  it('refuses the unprefixed path the client never builds', () => {
    expect(ok(`http://${authority}/vscode-remote-resource`)).toBe(false)
  })

  it('refuses another build of the same server', () => {
    expect(
      ok(
        `http://${authority}/stable-0000000000000000000000000000000000000000/vscode-remote-resource`
      )
    ).toBe(false)
    expect(ok(`http://${authority}/insider-${product.commit}/vscode-remote-resource`)).toBe(false)
  })

  it('refuses another port, which is another server', () => {
    expect(ok('http://127.0.0.1:9999/' + segment + '/vscode-remote-resource')).toBe(false)
  })

  it('refuses another host on the same port', () => {
    expect(ok('http://evil.example.com:51515/' + segment + '/vscode-remote-resource')).toBe(false)
  })

  /* A subtree would be a bypass for everything below it. */
  it('refuses a path that merely starts the same', () => {
    expect(ok(`http://${authority}/${segment}/vscode-remote-resource/../secrets`)).toBe(false)
    expect(ok(`http://${authority}/${segment}/vscode-remote-resourceX`)).toBe(false)
  })

  it('refuses every other endpoint the server exposes', () => {
    expect(ok(`http://${authority}/`)).toBe(false)
    expect(ok(`http://${authority}/version`)).toBe(false)
  })

  /* https is not what the workbench connects over, and matching it would be a
     second origin nobody decided to allow. */
  it('refuses a different scheme', () => {
    expect(ok(`https://${authority}/${segment}/vscode-remote-resource`)).toBe(false)
  })

  it('exempts nothing when there is no server', () => {
    expect(
      isOwnRemoteResource(`http://${authority}/${segment}/vscode-remote-resource`, null, product)
    ).toBe(false)
  })

  it('refuses something that is not a url at all', () => {
    expect(ok('not a url')).toBe(false)
  })
})
