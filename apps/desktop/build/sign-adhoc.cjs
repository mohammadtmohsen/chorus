const { execFileSync } = require('node:child_process')
const { chmodSync, existsSync, statSync } = require('node:fs')
const { join } = require('node:path')

/**
 * node-pty's `spawn-helper` is published without its executable bit.
 *
 * It is mode 0644 in the npm tarball, nothing in node-pty's own install or
 * postinstall scripts repairs it, and electron-builder copies the mode through
 * verbatim. The helper is exec'd on every `pty.spawn`, so without this the
 * terminal fails with a bare `posix_spawnp failed.` — measured, not assumed.
 *
 * Projects that compile node-pty from source never see this: `lib/utils.js`
 * prefers `build/Release`, and the linker sets the bit there. We deliberately do
 * not compile (`npmRebuild: false`), so the prebuilt helper is what ships and
 * this is ours to fix.
 *
 * **Order matters.** This runs before `codesign`, because changing a file inside
 * a signed bundle invalidates the signature — which would turn a working build
 * into the "damaged" dialog this whole hook exists to avoid.
 */
function repairSpawnHelper(app) {
  const helper = join(
    app,
    'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds',
    `darwin-${process.arch}`,
    'spawn-helper'
  )
  if (!existsSync(helper)) {
    throw new Error(`spawn-helper missing from the bundle: ${helper}`)
  }
  chmodSync(helper, 0o755)
  if ((statSync(helper).mode & 0o111) === 0) {
    throw new Error(`spawn-helper is still not executable: ${helper}`)
  }
}

function assertEngineSpawnHelper(app) {
  const root = join(app, 'Contents/Resources/engine/node_modules/node-pty')
  const directory = [
    join(root, 'build', 'Release'),
    join(root, 'build', 'Debug'),
    join(root, 'prebuilds', `darwin-${process.arch}`),
  ].find((path) => existsSync(join(path, 'pty.node')))
  if (directory === undefined) {
    throw new Error(`node-pty native binding missing from the engine: ${root}`)
  }
  const helper = join(directory, 'spawn-helper')
  if (!existsSync(helper)) {
    throw new Error(`spawn-helper missing from the engine: ${helper}`)
  }
  if ((statSync(helper).mode & 0o111) === 0) {
    throw new Error(`Engine spawn-helper is not executable: ${helper}`)
  }
}

/**
 * `codesign` over the packed .app — ad-hoc, or with a named identity.
 *
 * Deep, so the framework and helpers are sealed too, and forced, because the
 * Electron binary arrives already linker-signed and that signature has to be
 * replaced rather than added to.
 *
 * Failing loudly is the point: a silently unsigned build looks fine here and
 * is unopenable on the machine it was sent to.
 *
 * **`CHORUS_SIGN_IDENTITY` is set by `package-local.mjs` and by nothing else.**
 * Ad-hoc stays the default, so the release pipeline and every gate are
 * unchanged and the notes they publish about being ad-hoc signed stay true.
 *
 * The reason a local install wants more than ad-hoc is the keychain rather than
 * Gatekeeper: `--sign -` produces no stable designated requirement, so the
 * access list `safeStorage` needs has nothing to bind to and "Always Allow"
 * silently records nothing. `local-identity.mjs` has the whole argument.
 */
exports.default = async function signAdHoc({ appOutDir, packager, electronPlatformName }) {
  if (electronPlatformName !== 'darwin') return

  const app = join(appOutDir, `${packager.appInfo.productFilename}.app`)
  repairSpawnHelper(app)
  assertEngineSpawnHelper(app)

  const identity = process.env.CHORUS_SIGN_IDENTITY
  const signWith = identity === undefined || identity === '' ? '-' : identity
  if (signWith !== '-') console.log(`sign-adhoc: signing with "${signWith}"`)

  execFileSync('codesign', ['--force', '--deep', '--sign', signWith, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
