import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'

/**
 * A line-delimited duplex channel. Kept as an interface so the JSON-RPC client
 * can be tested without spawning a real `codex app-server`.
 */
export interface Transport {
  send(line: string): void
  onLine(handler: (line: string) => void): void
  onClose(handler: (info: { code: number | null; signal: string | null }) => void): void
  onStderr(handler: (chunk: string) => void): void
  close(): void
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
    }
  )

  const lines = readline.createInterface({ input: child.stdout })

  return {
    send: (line) => {
      child.stdin.write(line + '\n')
    },
    onLine: (handler) => {
      lines.on('line', handler)
    },
    onClose: (handler) => {
      child.on('exit', (code, signal) => {
        handler({ code, signal })
      })
    },
    onStderr: (handler) => {
      child.stderr.on('data', (chunk: Buffer) => {
        handler(chunk.toString())
      })
    },
    close: () => {
      child.kill('SIGTERM')
    },
  }
}
