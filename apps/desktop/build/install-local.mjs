import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Installs the locally packed .app straight into /Applications.
 *
 * The point is the copy never touches a browser. `com.apple.quarantine` is set
 * by whatever downloads a file, not by macOS at large, so an app that goes
 * disk → disk never acquires it — and without it Gatekeeper does not run the
 * notarization check that produces "Apple could not verify Chorus.app".
 *
 * So this is not a way around the M9 signing gate; it sidesteps the one input
 * that makes the gate fire. A build handed to anyone else still needs a
 * Developer ID and notarization.
 */

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  console.error('install-local: macOS only — there is nothing to install elsewhere yet.')
  process.exit(1)
}

/* electron-builder.yml is the source of truth for both names. Read rather than
   duplicate: a productName changed in one place and not the other would look
   like a missing build. */
const builderConfig = readFileSync(join(desktopDir, 'electron-builder.yml'), 'utf8')
const readSetting = (key) => {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(builderConfig)
  if (match === null) throw new Error(`install-local: no ${key} in electron-builder.yml`)
  return match[1].trim()
}
const productName = readSetting('productName')
const appId = readSetting('appId')

/* Whichever arch was packed most recently. `--dir` writes release/mac-arm64/,
   the dmg target writes the same place, so either build works as a source. */
const releaseDir = join(desktopDir, 'release')
const packed = (existsSync(releaseDir) ? readdirSync(releaseDir) : [])
  .filter((entry) => entry.startsWith('mac'))
  .map((entry) => join(releaseDir, entry, `${productName}.app`))
  .filter((app) => existsSync(app))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

if (packed.length === 0) {
  console.error(`install-local: no ${productName}.app under ${releaseDir} — run \`pnpm package\`.`)
  process.exit(1)
}
const source = packed[0]

/* A downloaded .app copied in here would carry its quarantine flag along and
   defeat the whole exercise, silently. Refuse instead of installing something
   that will not open. */
try {
  execFileSync('xattr', ['-p', 'com.apple.quarantine', source], { stdio: 'pipe' })
  console.error(`install-local: ${source} is quarantined, so it did not come from a local build.`)
  process.exit(1)
} catch {
  /* `xattr -p` exits non-zero when the attribute is absent, which is the good case. */
}

const installDir = process.env.CHORUS_INSTALL_DIR ?? '/Applications'
const destination = join(installDir, `${productName}.app`)

/* About to rm -rf this path, so prove it is ours first. A productName typo
   pointing at some other vendor's app would otherwise delete it. */
if (existsSync(destination)) {
  const installedId = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleIdentifier', join(destination, 'Contents/Info.plist')],
    { encoding: 'utf8' }
  ).trim()
  if (installedId !== appId) {
    console.error(`install-local: ${destination} is ${installedId}, not ${appId}. Refusing.`)
    process.exit(1)
  }
}

/* Overwriting a running bundle leaves the running copy reading files that are
   no longer there. Ask it to quit rather than killing it — it owns a SQLite
   event store and agent subprocesses, and both deserve an orderly shutdown. */
const isRunning = () => {
  try {
    execFileSync('pgrep', ['-x', productName], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

if (isRunning()) {
  console.log(`quitting the running ${productName}…`)
  execFileSync('osascript', ['-e', `tell application id "${appId}" to quit`], { stdio: 'pipe' })
  const deadline = Date.now() + 10_000
  while (isRunning() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (isRunning()) {
    console.error(`install-local: ${productName} is still running — quit it and re-run.`)
    process.exit(1)
  }
}

/* `ditto` rather than `cp -R`: it is the copy that preserves extended
   attributes and the code signature intact, and a broken seal here would land
   us back at "damaged". */
rmSync(destination, { recursive: true, force: true })
execFileSync('ditto', [source, destination], { stdio: 'inherit' })
execFileSync('codesign', ['--verify', '--deep', '--strict', destination], { stdio: 'inherit' })

console.log(`installed ${destination}`)
