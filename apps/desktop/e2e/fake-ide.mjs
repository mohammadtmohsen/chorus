import { connect } from 'node:net'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wait } from './harness.mjs'

/**
 * A VS Code window that is not VS Code.
 *
 * It speaks the real protocol over the real socket to the real app, so what is
 * exercised here is the whole path: descriptor discovery, the token handshake,
 * root filtering, focus arbitration, and the snapshot request that Send makes.
 * Only the editor is pretend, which is the one part that cannot be automated on
 * a build machine.
 */

const DESCRIPTOR_DIR = join(tmpdir(), 'chorus-ide')

function descriptorNames() {
  try {
    return new Set(readdirSync(DESCRIPTOR_DIR).filter((n) => n.endsWith('.json')))
  } catch {
    return new Set()
  }
}

/** What is already there, so the app's own descriptor can be told apart. */
export function existingDescriptors() {
  return descriptorNames()
}

/**
 * The descriptor the app under test just published.
 *
 * Matched by "new since launch" rather than by pid: the harness starts Electron
 * through `npx`, so the pid it can see is not necessarily the one that ends up
 * owning the socket.
 */
export async function waitForDescriptor(before, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const name of descriptorNames()) {
      if (before.has(name)) continue
      try {
        return JSON.parse(readFileSync(join(DESCRIPTOR_DIR, name), 'utf8'))
      } catch {
        // Written but not yet flushed; try again on the next pass.
      }
    }
    await wait(100)
  }
  throw new Error('the app never published an IDE descriptor')
}

export class FakeIde {
  #socket
  #buffer = ''
  #snapshot = () => ({ outcome: 'unavailable', reason: 'unsupported' })
  /** Every frame Chorus sent, for assertions about what it asked and when. */
  received = []
  roots = []

  constructor(socket) {
    this.#socket = socket
  }

  static async connect(descriptor, { windowId = 'fake-1', focused = true } = {}) {
    const socket = connect(descriptor.socketPath)
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.setEncoding('utf8')
    const ide = new FakeIde(socket)

    socket.on('data', (chunk) => {
      ide.#buffer += chunk
      for (;;) {
        const nl = ide.#buffer.indexOf('\n')
        if (nl === -1) break
        const line = ide.#buffer.slice(0, nl)
        ide.#buffer = ide.#buffer.slice(nl + 1)
        if (line.trim() === '') continue
        const frame = JSON.parse(line)
        ide.received.push(frame)
        if (frame.method === 'setRoots') ide.roots = frame.params.roots
        if (frame.method === 'currentContext') {
          ide.#write({ jsonrpc: '2.0', id: frame.id, result: ide.#snapshot(frame.params.root) })
        }
      }
    })

    ide.#write({
      jsonrpc: '2.0',
      id: `init-${windowId}`,
      method: 'initialize',
      params: {
        token: descriptor.token,
        protocolVersion: descriptor.protocolVersion,
        clientVersion: '0.0.0-e2e',
        windowId,
        ideName: 'Fake Code',
        isTrusted: true,
        focused,
      },
    })
    return ide
  }

  #write(frame) {
    this.#socket.write(`${JSON.stringify(frame)}\n`)
  }

  /** Wait until Chorus has told this window which roots it cares about. */
  async awaitRoots(timeout = 15_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (this.received.some((f) => f.method === 'setRoots')) return this.roots
      await wait(100)
    }
    throw new Error('Chorus never sent setRoots')
  }

  /** Report one file as the active editor for `root`. */
  report(root, { file, startLine = 10, endLine = 12, isDirty = false, focused = true } = {}) {
    this.#write({
      jsonrpc: '2.0',
      method: 'stateChanged',
      params: {
        windowId: this.windowId ?? 'fake-1',
        focused,
        roots: [
          {
            root,
            status: 'ready',
            editor: {
              source: 'current',
              filePath: file,
              fileUrl: `file://${file}`,
              languageId: 'typescript',
              documentVersion: 1,
              isDirty,
              selection: {
                start: { line: startLine, character: 0 },
                end: { line: endLine, character: 4 },
                isEmpty: false,
                selectedBytes: 11,
              },
            },
          },
        ],
      },
    })
  }

  /** Report that this window has nothing to offer for `root`. */
  reportNothing(root, status = 'unmatched') {
    this.#write({
      jsonrpc: '2.0',
      method: 'stateChanged',
      params: {
        windowId: this.windowId ?? 'fake-1',
        focused: true,
        roots: [{ root, status, editor: null }],
      },
    })
  }

  /** What to answer when Chorus asks for the selected text at Send. */
  onSnapshot(fn) {
    this.#snapshot = fn
  }

  close() {
    this.#socket.destroy()
  }
}
