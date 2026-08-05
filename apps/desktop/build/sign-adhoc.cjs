const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

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
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
