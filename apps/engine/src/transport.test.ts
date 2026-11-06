import { mkdtempSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { prepareChildEnvironment } from './child-environment.js'
import { acquireDirectoryLock, socketPathFor } from './lock.js'
import { encodeFrame, FrameReader } from './wire.js'
import { MAX_FRAME_BYTES } from './protocol.js'

describe('engine transport boundaries', () => {
  it('frames Unicode and Traffic bodies larger than one megabyte across arbitrary chunks', () => {
    const received: unknown[] = []
    const reader = new FrameReader((value) => {
      received.push(value)
    })
    const text = 'ع'.repeat(1_100_000)
    const frame = Buffer.from(encodeFrame({ text }))
    for (let index = 0; index < frame.length; index += 997)
      reader.push(frame.subarray(index, index + 997))
    expect(received).toEqual([{ text }])
    expect(() => encodeFrame({ text: 'x'.repeat(MAX_FRAME_BYTES) })).toThrow()
  })
  it('scrubs host IPC variables while preserving shell integration and restoring Node options', () => {
    const environment = {
      PATH: '/bin',
      ELECTRON_RUN_AS_NODE: '1',
      VSCODE_IPC_HOOK_CLI: '/socket',
      VSCODE_NODE_OPTIONS: '--max-old-space-size=4096',
      VSCODE_PORTABLE: '/portable',
      VSCODE_SHELL_LOGIN: '1',
      VSCODE_ENV_APPEND: '{}',
      SNAP: 'x',
      GDK_PIXBUF_MODULE_FILE: 'x',
      CHORUS_TRAFFIC: 'http://127.0.0.1:1234',
    }
    prepareChildEnvironment(environment, 'darwin')
    expect(environment).toEqual({
      PATH: '/bin',
      NODE_OPTIONS: '--max-old-space-size=4096',
      VSCODE_PORTABLE: '/portable',
      VSCODE_SHELL_LOGIN: '1',
      VSCODE_ENV_APPEND: '{}',
      CHORUS_TRAFFIC: 'http://127.0.0.1:1234',
    })
  })
  it('owns one writer lock and recovers after a process is killed', async () => {
    const data = mkdtempSync(join(tmpdir(), 'chorus-lock-test-'))
    const first = acquireDirectoryLock(data)
    expect(first).not.toBeNull()
    expect(acquireDirectoryLock(data)).toBeNull()
    expect(statSync(join(data, 'engine-lock.sqlite')).mode & 0o777).toBe(0o600)
    first?.release()
    const native = createRequire(import.meta.url).resolve('better-sqlite3')
    const source = `const Database = require(${JSON.stringify(native)}); const db = new Database(${JSON.stringify(join(data, 'engine-lock.sqlite'))}); db.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE'); process.stdout.write('locked'); setInterval(() => {}, 1000);`
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
    let error = ''
    child.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString()
    })
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => {
          resolve()
        })
        child.once('error', reject)
        child.once('exit', () => {
          reject(new Error(error))
        })
      })
      expect(acquireDirectoryLock(data)).toBeNull()
      await new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve()
        })
        child.kill('SIGKILL')
      })
      const second = acquireDirectoryLock(data)
      expect(second).not.toBeNull()
      second?.release()
      expect(Buffer.byteLength(socketPathFor(`${data}/${'long'.repeat(80)}`))).toBeLessThan(104)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
})
