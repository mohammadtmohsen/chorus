import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { ownProcessTree } from '@chorus/shared/process-tree'

export interface TransportClose {
  readonly code: number | null
  readonly signal: string | null
  readonly error?: Error
}

/**
 * A line-delimited duplex channel. Kept as an interface so the JSON-RPC client
 * can be tested without spawning a real `codex app-server`.
 */
export interface Transport {
  send(line: string): void
  onLine(handler: (line: string) => void): void
  onClose(handler: (info: TransportClose) => void): void
  onStderr(handler: (chunk: string) => void): void
  close(): void | Promise<void>
}

export interface StdioTransportOptions {
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

/**
 * `codex app-server` speaking newline-delimited JSON on stdio — the default
 * transport, and the right one for an embedded desktop client (plan §2.1).
 */
export function createStdioTransport(options: StdioTransportOptions = {}): Transport {
  const child: ChildProcessWithoutNullStreams = spawn(
    options.command ?? 'codex',
    [...(options.args ?? ['app-server'])],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
    }
  )
  const handlers = new Set<(info: TransportClose) => void>()
  let exited: TransportClose | null = null
  let closing = false
  let reportExit: () => void = () => undefined
  const rootExited = new Promise<void>((resolve) => {
    reportExit = resolve
  })
  const tree =
    child.pid === undefined
      ? undefined
      : ownProcessTree(child.pid, { processGroup: process.platform !== 'win32', rootExited })
  const lines = readline.createInterface({ input: child.stdout })
  child.stderr.resume()
  child.stderr.on('error', () => undefined)
  child.stdin.on('error', () => undefined)

  const end = (info: TransportClose): void => {
    if (exited !== null) return
    exited = info
    for (const handler of handlers) handler(info)
  }
  const onExit = (info: TransportClose): void => {
    reportExit()
    if (closing || tree === undefined) {
      end(info)
      return
    }
    void tree.stop().then(
      () => {
        end(info)
      },
      (error: unknown) => {
        end({
          ...info,
          error: new Error('Owned provider processes could not be stopped.', { cause: error }),
        })
      }
    )
  }
  child.once('exit', (code, signal) => {
    onExit({ code, signal })
  })
  child.once('error', (error) => {
    onExit({ code: null, signal: null, error })
  })

  return {
    send: (line) => {
      child.stdin.write(line + '\n')
    },
    onLine: (handler) => {
      lines.on('line', handler)
    },
    onClose: (handler) => {
      handlers.add(handler)
      if (exited !== null) handler(exited)
    },
    onStderr: (handler) => {
      child.stderr.on('data', (chunk: Buffer) => {
        handler(chunk.toString())
      })
    },
    close: async () => {
      closing = true
      const graceful = (): void => {
        child.stdin.end()
      }
      if (tree === undefined) graceful()
      else await tree.stop(graceful)
      lines.close()
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    },
  }
}
