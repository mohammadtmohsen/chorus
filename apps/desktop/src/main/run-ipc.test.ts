import { electronIpcRegistrar, electronShellClient } from './electron-shell-client.js'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { LOCAL_HOST, type RunCommands } from '@chorus/event-store'
import type { RunChange, RunProject, RunSnapshot } from './project-run.js'
import type { DetectedScripts } from './project-scripts.js'
import type { ShellRole } from './traffic-ipc.js'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, raw: unknown) => unknown>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, raw: unknown) => unknown) => {
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    },
  },
}))

const { RunIpc } = await import('./run-ipc.js')
const { RUN_PUSH_CHANNEL } = await import('../shared/run-ipc.js')

const COMMANDS: RunCommands = {
  version: 1,
  defaultId: 'dev',
  commands: [{ id: 'dev', label: 'dev', command: 'npm run dev' }],
}

const IDLE: RunSnapshot = { process: { kind: 'idle' }, cleanupPending: false }

const SCRIPTS: DetectedScripts = {
  manager: 'npm',
  managerSource: 'lockfile',
  conflictingLockfiles: [],
  scripts: [{ name: 'dev', command: 'npm run dev' }],
  expo: false,
  variables: [],
}

interface Sender {
  readonly id: number
  readonly mainFrame: object
  readonly sent: { channel: string; payload: unknown }[]
  readonly send: (channel: string, payload: unknown) => void
  readonly isDestroyed: () => boolean
}

function sender(id: number): Sender {
  const sent: { channel: string; payload: unknown }[] = []
  return {
    id,
    mainFrame: {},
    sent,
    send: (channel, payload) => {
      sent.push({ channel, payload })
    },
    isDestroyed: () => false,
  }
}

const eventFrom = (from: Sender, frame: object = from.mainFrame): unknown => ({
  sender: from,
  senderFrame: frame,
})

interface Harness {
  readonly ipc: InstanceType<typeof RunIpc>
  readonly projects: Map<string, RunProject>
  readonly saved: [string, RunCommands | null][]
  readonly detected: string[]
  readonly calls: string[]
  readonly emit: (change: RunChange) => void
  readonly shell: (id: number, role: ShellRole) => Sender
}

function build(platform: NodeJS.Platform = 'darwin'): Harness {
  handlers.clear()
  const projects = new Map<string, RunProject>([
    [
      'p1',
      {
        host: LOCAL_HOST,
        canonicalRoot: '/repo/p1',
        runCommands: COMMANDS,
        trafficOrigin: 'http://10.0.0.5:8080',
        trafficEnvVar: 'EXPO_PUBLIC_API_BASE_URL',
      },
    ],
    [
      'p2',
      {
        host: LOCAL_HOST,
        canonicalRoot: '/repo/p2',
        runCommands: null,
        trafficOrigin: null,
        trafficEnvVar: null,
      },
    ],
    [
      'remote',
      {
        host: 'devbox',
        canonicalRoot: '/home/me/app',
        runCommands: null,
        trafficOrigin: null,
        trafficEnvVar: null,
      },
    ],
  ])
  const saved: [string, RunCommands | null][] = []
  const detected: string[] = []
  const calls: string[] = []
  let listener: (change: RunChange) => void = () => undefined
  const answer = (name: string, projectId: string): Promise<RunSnapshot> => {
    calls.push(`${name} ${projectId}`)
    return Promise.resolve(IDLE)
  }
  const ipc = new RunIpc(
    {
      runner: {
        run: (projectId, commandId) => answer(`run:${commandId ?? 'default'}`, projectId),
        restart: (projectId) => answer('restart', projectId),
        stop: (projectId) => answer('stop', projectId),
        stopRecording: (projectId) => answer('stopRecording', projectId),
        snapshot: () => IDLE,
        subscribe: (next) => {
          listener = next
          return () => {
            listener = () => undefined
          }
        },
      },
      project: (projectId) => projects.get(projectId) ?? null,
      isAdopted: (projectId) => projects.has(projectId),
      setCommands: (projectId, commands) => {
        saved.push([projectId, commands])
        const current = projects.get(projectId)
        if (current !== undefined) projects.set(projectId, { ...current, runCommands: commands })
      },
      detect: (root) => {
        detected.push(root)
        return Promise.resolve(SCRIPTS)
      },
      platform,
    },
    electronIpcRegistrar
  )
  return {
    ipc,
    projects,
    saved,
    detected,
    calls,
    emit: (change) => {
      listener(change)
    },
    shell: (id, role) => {
      const made = sender(id)
      ipc.registerShell(electronShellClient(made as unknown as WebContents), role)
      return made
    },
  }
}

const call = async (channel: string, event: unknown, raw: unknown): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`${channel} was never registered`)
  return await handler(event, raw)
}

const pushes = (shell: Sender): unknown[] =>
  shell.sent.filter((each) => each.channel === RUN_PUSH_CHANNEL).map((each) => each.payload)

describe('who may ask', () => {
  it('refuses a document that is not a registered shell, or a frame inside one', async () => {
    const { shell } = build()
    const stranger = sender(99)
    const main = shell(1, { kind: 'main' })
    await expect(call('run:state', eventFrom(stranger), { projectId: 'p1' })).rejects.toThrow()
    await expect(call('run:state', eventFrom(main, {}), { projectId: 'p1' })).rejects.toThrow()
  })

  it('lets the main shell act on adopted projects only', async () => {
    const { shell, calls } = build()
    const main = shell(1, { kind: 'main' })
    await call('run:start', eventFrom(main), { projectId: 'p1' })
    await expect(call('run:start', eventFrom(main), { projectId: 'unknown' })).rejects.toThrow()
    expect(calls).toEqual(['run:default p1'])
  })

  it('lets a detached shell act on its own project and nothing else', async () => {
    const { shell, calls } = build()
    const detached = shell(2, { kind: 'detached', projectId: 'p2' })
    await call('run:stop', eventFrom(detached), { projectId: 'p2' })
    await expect(call('run:stop', eventFrom(detached), { projectId: 'p1' })).rejects.toThrow()
    expect(calls).toEqual(['stop p2'])
  })

  it('refuses a request that does not match the contract before anything runs', async () => {
    const { shell, calls } = build()
    const main = shell(1, { kind: 'main' })
    await expect(
      call('run:start', eventFrom(main), { projectId: 'p1', command: 'rm -rf ~' })
    ).rejects.toThrow()
    await expect(call('run:restart', eventFrom(main), { projectId: '' })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('forgets a released shell and every handler once closed', async () => {
    const { ipc, shell } = build()
    const main = shell(1, { kind: 'main' })
    ipc.releaseShell(electronShellClient(main as unknown as WebContents))
    await expect(call('run:state', eventFrom(main), { projectId: 'p1' })).rejects.toThrow()
    ipc.close()
    expect(handlers.size).toBe(0)
  })
})

describe('what the state says', () => {
  it('carries the process, cleanup, saved commands and availability', async () => {
    const { shell } = build()
    const main = shell(1, { kind: 'main' })
    expect(await call('run:state', eventFrom(main), { projectId: 'p1' })).toEqual({
      ...IDLE,
      commands: COMMANDS,
      available: true,
    })
  })

  it('is not available for a remote project or on Windows, whatever the shell', async () => {
    const local = build()
    const main = local.shell(1, { kind: 'main' })
    expect(await call('run:state', eventFrom(main), { projectId: 'remote' })).toMatchObject({
      available: false,
    })
    const windows = build('win32')
    const other = windows.shell(1, { kind: 'main' })
    expect(await call('run:state', eventFrom(other), { projectId: 'p1' })).toMatchObject({
      available: false,
    })
  })

  it('detects scripts in a local project and refuses a remote one', async () => {
    const { shell, detected } = build()
    const main = shell(1, { kind: 'main' })
    await call('run:detect', eventFrom(main), { projectId: 'p1' })
    await expect(call('run:detect', eventFrom(main), { projectId: 'remote' })).rejects.toThrow()
    expect(detected).toEqual(['/repo/p1'])
  })
})

describe('telling every window', () => {
  it('pushes saved commands to the main shell and the owning detached window only', async () => {
    const { shell, saved } = build()
    const main = shell(1, { kind: 'main' })
    const owner = shell(2, { kind: 'detached', projectId: 'p2' })
    const other = shell(3, { kind: 'detached', projectId: 'p1' })
    const commands = {
      version: 1,
      defaultId: 'start',
      commands: [{ id: 'start', label: 'start', command: 'npm start' }],
    }

    const answered = await call('run:configure', eventFrom(owner), { projectId: 'p2', commands })

    expect(saved).toEqual([['p2', commands]])
    expect(answered).toMatchObject({ commands, available: true })
    expect(pushes(main)).toEqual([{ projectId: 'p2', ...IDLE, commands, available: true }])
    expect(pushes(owner)).toEqual(pushes(main))
    expect(pushes(other)).toEqual([])
  })

  it('refuses commands the contract does not allow, and saves nothing', async () => {
    const { shell, saved } = build()
    const main = shell(1, { kind: 'main' })
    const duplicated = {
      version: 1,
      defaultId: 'dev',
      commands: [
        { id: 'dev', label: 'dev', command: 'npm run dev' },
        { id: 'dev', label: 'again', command: 'npm run dev' },
      ],
    }
    await expect(
      call('run:configure', eventFrom(main), { projectId: 'p1', commands: duplicated })
    ).rejects.toThrow()
    expect(saved).toEqual([])
  })

  it('forwards a run change to the windows that may see that project', () => {
    const { shell, emit } = build()
    const main = shell(1, { kind: 'main' })
    const own = shell(2, { kind: 'detached', projectId: 'p1' })
    const other = shell(3, { kind: 'detached', projectId: 'p2' })

    emit({ projectId: 'p1', ...IDLE })

    expect(pushes(main)).toHaveLength(1)
    expect(pushes(own)).toEqual([{ projectId: 'p1', ...IDLE, commands: COMMANDS, available: true }])
    expect(pushes(other)).toEqual([])
  })

  it('stops forwarding once closed', () => {
    const { ipc, shell, emit } = build()
    const main = shell(1, { kind: 'main' })
    ipc.close()
    emit({ projectId: 'p1', ...IDLE })
    expect(pushes(main)).toEqual([])
  })
})
