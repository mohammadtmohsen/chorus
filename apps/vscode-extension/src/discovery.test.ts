import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pidIsAlive, readDescriptors } from './discovery.js'

let dir: string
const alive = { isAlive: () => true }
const dead = { isAlive: () => false }

function write(name: string, value: unknown, mode = 0o600): void {
  const path = join(dir, name)
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode })
  chmodSync(path, mode)
}

const valid = {
  pid: 4242,
  socketPath: '/tmp/chorus-ide/4242.sock',
  token: 'secret',
  protocolVersion: 1,
  chorusVersion: '0.4.0',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chorus-disc-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readDescriptors', () => {
  it('reads a valid descriptor', () => {
    write('4242.json', valid)
    expect(readDescriptors(dir, alive)).toEqual([valid])
  })

  /* No directory means no Chorus is running, which is a normal state and not
     an error the extension should surface. */
  it('returns nothing when the directory does not exist', () => {
    expect(readDescriptors(join(dir, 'nope'), alive)).toEqual([])
  })

  /* A crash leaves the file behind. Liveness is checked by pid rather than
     assumed from the file existing. */
  it('skips a descriptor whose process is gone', () => {
    write('4242.json', valid)
    expect(readDescriptors(dir, dead)).toEqual([])
  })

  /* The process that wrote it owns its cleanup; an extension racing to tidy up
     would eventually delete a live one. */
  it('leaves a stale descriptor on disk', () => {
    write('4242.json', valid)
    readDescriptors(dir, dead)
    expect(readDescriptors(dir, alive)).toEqual([valid])
  })

  /* A descriptor anyone else can read has already leaked its token. */
  it('refuses a world-readable descriptor', () => {
    write('4242.json', valid, 0o644)
    expect(readDescriptors(dir, alive)).toEqual([])
  })

  it('skips malformed JSON without throwing', () => {
    write('bad.json', '{not json')
    write('4242.json', valid)
    expect(readDescriptors(dir, alive)).toEqual([valid])
  })

  it.each([
    ['a missing token', { ...valid, token: undefined }],
    ['an empty socket path', { ...valid, socketPath: '' }],
    ['a non-numeric pid', { ...valid, pid: 'x' }],
    ['a negative pid', { ...valid, pid: -1 }],
  ])('rejects %s', (_label, value) => {
    write('4242.json', value)
    expect(readDescriptors(dir, alive)).toEqual([])
  })

  it('ignores files that are not descriptors', () => {
    write('4242.sock', 'not json at all')
    expect(readDescriptors(dir, alive)).toEqual([])
  })

  it('reads several processes at once', () => {
    write('1.json', { ...valid, pid: 1 })
    write('2.json', { ...valid, pid: 2 })
    expect(
      readDescriptors(dir, alive)
        .map((d) => d.pid)
        .sort()
    ).toEqual([1, 2])
  })
})

describe('pidIsAlive', () => {
  it('finds this process', () => {
    expect(pidIsAlive(process.pid)).toBe(true)
  })

  it('does not find an implausible pid', () => {
    expect(pidIsAlive(0x7ffffff)).toBe(false)
  })
})
