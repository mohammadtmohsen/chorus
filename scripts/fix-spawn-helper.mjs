/**
 * Give node-pty's `spawn-helper` its executable bit back after an install.
 *
 * The helper ships mode 0644 in the npm tarball. node-pty's own `install` script
 * only checks that a prebuild exists, and its `postinstall` does nothing on
 * anything but Windows — so nothing in the dependency repairs it. The native
 * binding execs the helper on every `pty.spawn`, and without the bit the failure
 * is a bare `posix_spawnp failed.` with no mention of permissions.
 *
 * Projects that compile node-pty from source never hit this: `lib/utils.js`
 * prefers `build/Release`, where the linker sets the bit. Chorus deliberately
 * does not compile — both native deps ship N-API prebuilds that load in Electron
 * unmodified, which is the posture the build plan chose and the reason there is
 * no toolchain here. See docs/plans/a-terminal-in-every-session-2026-08-12/plan.md §3.
 *
 * The packaged app is repaired separately, in `apps/desktop/build/sign-adhoc.cjs`,
 * because electron-builder copies the mode through verbatim and the fix has to
 * land before codesign runs.
 *
 * Silent no-op when there is nothing to do: this runs on every install, including
 * on platforms and in checkouts where node-pty is absent.
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Every installed copy, not one resolved path.
 *
 * `hoist=false` and `node-linker=isolated` mean the real package lives under
 * `node_modules/.pnpm/`, and a lockfile can legitimately carry more than one
 * version. Walking the store fixes each of them rather than guessing which one a
 * given importer will resolve to.
 */
function installedCopies() {
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store)) return []
  return readdirSync(store)
    .filter((entry) => entry.startsWith('node-pty@'))
    .map((entry) => join(store, entry, 'node_modules', 'node-pty'))
    .filter((path) => existsSync(path))
}

let repaired = 0
for (const pkg of installedCopies()) {
  const prebuilds = join(pkg, 'prebuilds')
  if (!existsSync(prebuilds)) continue
  for (const triple of readdirSync(prebuilds)) {
    const helper = join(prebuilds, triple, 'spawn-helper')
    // Windows triples ship no helper; only Unix ones have something to fix.
    if (!existsSync(helper)) continue
    if ((statSync(helper).mode & 0o111) !== 0) continue
    chmodSync(helper, 0o755)
    repaired += 1
  }
}

if (repaired > 0) {
  console.log(
    `node-pty: made ${repaired} spawn-helper binar${repaired === 1 ? 'y' : 'ies'} executable`
  )
}
