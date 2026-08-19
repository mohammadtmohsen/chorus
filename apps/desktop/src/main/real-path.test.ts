import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalPath } from './real-path.js'
import { isInside } from '@chorus/ide-protocol'

/**
 * The failure this was written for, reproduced rather than described.
 *
 * `ide:openFile` refused a file that was genuinely inside the project, because
 * the project was reached by one name and the path by another. On macOS that is
 * not exotic: every temp directory is under `/var`, which is a symlink to
 * `/private/var`, and agents print realpaths.
 */

const root = mkdtempSync(join(tmpdir(), 'chorus-realpath-'))
mkdirSync(join(root, 'project/src'), { recursive: true })
writeFileSync(join(root, 'project/src/a.ts'), 'const a = 1\n')
// The project reached through a link, which is the shape that failed.
symlinkSync(join(root, 'project'), join(root, 'linked'))

describe('canonicalPath', () => {
  it('resolves a symlinked directory in the middle of a path', () => {
    expect(canonicalPath(join(root, 'linked/src/a.ts'))).toBe(
      realpathSync(join(root, 'project/src/a.ts'))
    )
  })

  /**
   * The reason `realpathSync` cannot be called directly.
   *
   * Opening a file that does not exist is allowed — VS Code creates it — so a
   * function that threw here would turn a working case into an error.
   */
  it('answers for a file that does not exist yet', () => {
    const missing = join(root, 'linked/src/not-yet/deeper.ts')
    expect(canonicalPath(missing)).toBe(
      join(realpathSync(join(root, 'project/src')), 'not-yet/deeper.ts')
    )
  })

  it('leaves a path with nothing to resolve alone', () => {
    const plain = join(root, 'project/src/a.ts')
    expect(canonicalPath(plain)).toBe(realpathSync(plain))
  })

  /* Never throws: the caller is deciding containment and must get an answer. */
  it('falls back rather than failing on a path that cannot exist', () => {
    expect(canonicalPath('/no/such/root/at/all')).toBe('/no/such/root/at/all')
  })
})

/**
 * The guard itself, at the level the bug lived.
 *
 * The lexical check stays — that is what keeps a symlinked `node_modules`
 * working — and the canonical one is an additional way to say yes, never a new
 * way to say no.
 */
describe('the containment decision', () => {
  const allowed = (cwd: string, target: string): boolean =>
    isInside(cwd, target) || isInside(canonicalPath(cwd), canonicalPath(target))

  it('accepts the project’s own file named through the link', () => {
    // Exactly the reported refusal: cwd as given, path as an agent prints it.
    expect(isInside(join(root, 'linked'), realpathSync(join(root, 'project/src/a.ts')))).toBe(false)
    expect(allowed(join(root, 'linked'), realpathSync(join(root, 'project/src/a.ts')))).toBe(true)
  })

  it('still refuses a path that escapes the project', () => {
    expect(allowed(join(root, 'project'), join(root, 'elsewhere.ts'))).toBe(false)
    expect(allowed(join(root, 'project'), '/etc/hosts')).toBe(false)
  })

  /**
   * The hole this deliberately does **not** close.
   *
   * A symlink inside the project pointing outside still passes, because the
   * lexical check accepts it and this only ever adds acceptances. Closing it
   * means trusting the canonical answer alone, which would also refuse a linked
   * `node_modules` or a linked package in a monorepo — a change to what the
   * boundary means rather than a repair of it. Recorded on the board instead.
   */
  it('documents that an outward link inside the project is still allowed', () => {
    symlinkSync('/etc', join(root, 'project/escape'))
    expect(allowed(join(root, 'project'), join(root, 'project/escape/hosts'))).toBe(true)
  })
})
