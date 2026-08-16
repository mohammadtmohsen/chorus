/**
 * `rm -rf`, for a machine that has no `rm`.
 *
 * Every `clean` script in the workspace shelled out to `rm -rf`, and the two
 * desktop dev scripts to `env -u` (see `without-env.mjs`). Neither exists on a
 * Windows runner, so `pnpm clean` and `pnpm dev` failed there before reaching
 * anything Chorus owns.
 *
 * Deliberately not a dependency. `rimraf` is the obvious package and this is
 * `fs.rmSync` with an argv loop — `pnpm-workspace.yaml` keeps build scripts
 * opt-in one package at a time, and a dependency whose whole body is one stdlib
 * call is not worth a lockfile entry.
 *
 * Takes literal paths and one trailing-`*` form, because `*.tsbuildinfo` is the
 * only glob any of these scripts used and a real glob engine here would be the
 * same mistake as the dependency.
 */
import { readdirSync, rmSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'

const remove = (path) => {
  rmSync(path, { recursive: true, force: true })
}

for (const arg of process.argv.slice(2)) {
  const name = basename(arg)
  if (!name.includes('*')) {
    remove(arg)
    continue
  }

  // `*.tsbuildinfo` and friends: match on the suffix in one directory. No
  // recursion, which is what the shell would have done too without `**`.
  const dir = dirname(arg)
  const suffix = name.slice(name.indexOf('*') + 1)
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    // Nothing to clean is the ordinary case, not an error — `rm -f` agrees.
    continue
  }
  for (const entry of entries) {
    if (entry.endsWith(suffix)) remove(join(dir, entry))
  }
}
