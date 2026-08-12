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

/**
 * `codesign --sign -` over the packed .app.
 *
 * Deep, so the framework and helpers are sealed too, and forced, because the
 * Electron binary arrives already linker-signed and that signature has to be
 * replaced rather than added to.
 *
 * Failing loudly is the point: a silently unsigned build looks fine here and
 * is unopenable on the machine it was sent to.
 */
exports.default = async function signAdHoc({ appOutDir, packager, electronPlatformName }) {
  if (electronPlatformName !== 'darwin') return

  const app = join(appOutDir, `${packager.appInfo.productFilename}.app`)
  repairSpawnHelper(app)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
