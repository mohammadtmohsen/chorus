import type { ApprovalRequest } from '@chorus/agent-protocol'
import type { ApprovalId } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { evaluate } from './engine.js'
import { profileById } from './rules.js'

/**
 * What Trusted mode must still refuse when the agent is on Windows.
 *
 * Trusted allows any command by profile, so the only thing standing between it
 * and an irreversible action is `UNIVERSAL_DENIES` — which was written entirely
 * in Unix shell and matched case-sensitively. Every case below was allowed
 * outright before this phase: no card, no prompt, no record of a person
 * deciding.
 *
 * These are asserted through `evaluate` against the real Trusted profile rather
 * than against the regex, because "the pattern matches" and "the engine denies"
 * are different claims and only the second one is the guarantee.
 */

const TRUSTED = profileById('trusted')
const base = { id: 'w1' as ApprovalId, agentId: 'claude' as const, expiresAt: 0 }

/**
 * Claude's Bash tool hands over one shell string, so this is the realistic
 * shape. Splitting on spaces the way a test helper wants would quietly change
 * what is being tested — the subject is `command.join(' ')` either way.
 */
const command = (line: string): ApprovalRequest => ({
  ...base,
  kind: 'command',
  command: [line],
  cwd: 'C:\\repo',
  withNetwork: false,
})

const decisionFor = (line: string): string => evaluate(command(line), TRUSTED).decision

describe('universal denies on Windows shells', () => {
  it.each([
    ['del /s /q C:\\repo', 'cmd recursive delete'],
    ['del /S /Q C:\\repo', 'cmd, uppercase switches'],
    ['DEL /s /q C:\\repo', 'cmd, uppercase verb — the shell does not care'],
    ['rd /s /q C:\\repo\\node_modules', 'cmd rd'],
    ['rmdir /s /q C:\\repo', 'cmd rmdir'],
    ['erase /s C:\\repo\\*', 'cmd erase'],
    ['Remove-Item -Recurse -Force C:\\repo', 'PowerShell, spelled out'],
    ['Remove-Item -Force -Recurse C:\\repo', 'PowerShell, flags reordered'],
    ['remove-item -recurse C:\\repo', 'PowerShell, lowercase'],
    ['Remove-Item -Rec C:\\repo', 'PowerShell prefix abbreviation'],
    ['Remove-Item -R C:\\repo', 'PowerShell single-letter prefix'],
    ['ri -Recurse C:\\repo', 'the ri alias'],
  ])('denies %s (%s)', (line) => {
    expect(decisionFor(line)).toBe('deny')
  })

  it('denies a recursive delete hidden behind a composition', () => {
    // The whole point of a universal deny is that `&&` does not help.
    expect(decisionFor('cd C:\\repo && del /s /q .')).toBe('deny')
  })
})

describe('the .exe suffix hole', () => {
  /*
   * `\bgit\s+push` does not match `git.exe push`: `\bgit` matches, then `\s+`
   * meets `.exe`. A universal deny that a four-character suffix walks through
   * is not universal, and on Windows the suffixed form is a normal thing for an
   * agent to emit.
   */
  it.each([
    'git.exe push --force origin main',
    'git.exe reset --hard HEAD~5',
    'git.exe filter-branch --all',
    'rm.exe -rf C:\\repo',
  ])('denies %s', (line) => {
    expect(decisionFor(line)).toBe('deny')
  })

  it('still denies the unsuffixed form', () => {
    expect(decisionFor('git push --force origin main')).toBe('deny')
    expect(decisionFor('rm -rf /')).toBe('deny')
  })
})

describe('case-insensitive denies', () => {
  it.each(['Git Push --Force origin main', 'GIT RESET --HARD HEAD', 'RM -RF /tmp/x'])(
    'denies %s, because cmd and PowerShell do not care about case',
    (line) => {
      expect(decisionFor(line)).toBe('deny')
    }
  )
})

describe('what must NOT be denied', () => {
  /*
   * The other half of the guarantee. A deny is a wall with no door — Trusted
   * cannot open it — so widening these patterns has a real cost if they catch
   * something ordinary. `del` without `/s` removes named files and is not
   * recursive; `Remove-Item` without `-Recurse` is the same.
   */
  it.each([
    ['del C:\\repo\\stale.log', 'a single file, no /s'],
    ['Remove-Item C:\\repo\\stale.log', 'PowerShell, no -Recurse'],
    ['Remove-Item -Force C:\\repo\\a.log', '-Force alone is not recursion'],
    ['git push origin main', 'an ordinary push'],
    ['git reset --soft HEAD~1', 'soft reset keeps the working tree'],
    ['rmdir C:\\repo\\empty', 'removing an empty directory'],
  ])('does not deny %s (%s)', (line) => {
    expect(decisionFor(line)).not.toBe('deny')
  })
})

describe('Windows credential paths reach a person', () => {
  const fileChange = (path: string): ApprovalRequest => ({
    ...base,
    kind: 'fileChange',
    files: [{ path, patch: '@@ -0,0 +1 @@\n+x' }],
  })

  it.each([
    'C:\\Users\\me\\_netrc',
    'C:\\Users\\me\\certs\\client.pfx',
    'C:\\Users\\me\\certs\\key.pem',
  ])('asks before touching %s', (path) => {
    // `ask`, not `deny`: only the user can tell a secret from a fixture.
    expect(evaluate(fileChange(path), TRUSTED).decision).toBe('ask')
  })

  it('still asks for the posix spellings', () => {
    expect(evaluate(fileChange('/home/me/.netrc'), TRUSTED).decision).toBe('ask')
    expect(evaluate(fileChange('/home/me/.aws/credentials'), TRUSTED).decision).toBe('ask')
  })
})
