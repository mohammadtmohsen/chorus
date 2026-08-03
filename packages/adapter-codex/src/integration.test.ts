import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './codex-adapter.js'

/**
 * Runs against the real `codex app-server` on this machine.
 *
 * Deliberately stops short of starting a turn, so it costs no tokens and takes
 * a second — it exercises the handshake, `thread/start`, and the sandbox and
 * approval-policy encodings, which is exactly the surface the published docs
 * got wrong. Turn-level behaviour is covered by the S3a spike write-up.
 *
 * Skipped unless CHORUS_E2E=1, because CI has no `codex` and no auth.
 */

const enabled = process.env['CHORUS_E2E'] === '1'
const suite = enabled ? describe : describe.skip

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chorus-it-'))
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

suite('CodexAdapter against the real app-server', () => {
  it('reports the installed CLI version', async () => {
    const health = await new CodexAdapter().health()
    expect(health.state).toBe('ready')
    if (health.state === 'ready') expect(health.version).toMatch(/^\d+\.\d+\.\d+/)
  }, 30_000)

  it('completes the handshake and starts a read-only thread', async () => {
    const adapter = new CodexAdapter()
    const session = await adapter.start({
      cwd: fixtureRepo(),
      sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
    })

    // A thread id proves initialize -> initialized -> thread/start all landed,
    // and that our sandbox and approvalPolicy encodings were accepted.
    expect(session.sessionRef).toMatch(/^[0-9a-f-]{36}$/)

    await adapter.dispose()
  }, 60_000)

  it('reports unavailable for a missing binary instead of throwing', async () => {
    const health = await new CodexAdapter({ command: 'codex-does-not-exist' }).health()
    expect(health.state).toBe('unavailable')
  }, 30_000)
})
