import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  OpenProjectsFile,
  parseOpenProjects,
  type OpenProjectsState,
} from '../../desktop/src/main/open-projects.js'
import type { WorkspaceSnapshot } from '../../desktop/src/shared/workspace-layout.js'
import type { ChorusRuntime } from '../../desktop/src/main/runtime.js'

const Storage = z.record(z.string(), z.string())

export const DESKTOP_WORKSPACE_KEY = 'chorus-desktop'

export function desktopClientDirectory(dataDirectory: string): string {
  return join(
    dataDirectory,
    'clients',
    createHash('sha256').update(DESKTOP_WORKSPACE_KEY).digest('hex')
  )
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

export function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, path)
}

export function seedFromDesktop(dataDirectory: string): void {
  const sessions = join(dataDirectory, 'engine-sessions.json')
  const desktop = join(dataDirectory, 'open-projects.json')
  if (existsSync(sessions) || !existsSync(desktop)) return
  const saved = parseOpenProjects(readJson(desktop))
  const directory = desktopClientDirectory(dataDirectory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeJson(join(directory, 'open-projects.json'), OpenProjectsFile.parse({ version: 1, ...saved }))
  writeJson(sessions, OpenProjectsFile.parse({ version: 1, ...saved, workspace: null }))
}

export class ClientState {
  readonly directory: string
  readonly conversationIds: Set<string>
  workspace: WorkspaceSnapshot | null
  readonly storage: Record<string, string>

  constructor(dataDirectory: string, key: string) {
    const name = createHash('sha256').update(key).digest('hex')
    this.directory =
      key === DESKTOP_WORKSPACE_KEY
        ? desktopClientDirectory(dataDirectory)
        : join(dataDirectory, 'clients', name)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const saved = parseOpenProjects(readJson(join(this.directory, 'open-projects.json')))
    this.workspace = saved.workspace
    this.conversationIds = new Set(
      saved.projects.flatMap((project) =>
        project.conversations.map((conversation) => conversation.conversationId)
      )
    )
    const storage = Storage.safeParse(readJson(join(this.directory, 'storage.json')))
    this.storage = storage.success ? storage.data : {}
  }

  remember(runtime: ChorusRuntime): void {
    const state = runtime.snapshotOpenProjects()
    const projects = state.projects
      .map((project) => ({
        ...project,
        conversations: project.conversations.filter((conversation) =>
          this.conversationIds.has(conversation.conversationId)
        ),
      }))
      .filter((project) => project.conversations.length > 0)
    writeJson(join(this.directory, 'open-projects.json'), {
      version: 1,
      projects,
      workspace: this.workspace,
    })
  }

  setStorage(key: string, value: string | null): void {
    if (!key.startsWith('chorus:message-mode:')) throw new Error('storage-key-refused')
    if (value === null) Reflect.deleteProperty(this.storage, key)
    else this.storage[key] = value
    writeJson(join(this.directory, 'storage.json'), this.storage)
  }
}

export function enginePersistence(dataDirectory: string): {
  read(): OpenProjectsState
  write(state: OpenProjectsState): void
} {
  const path = join(dataDirectory, 'engine-sessions.json')
  return {
    read: () => parseOpenProjects(readJson(path)),
    write: (state) => {
      writeJson(path, OpenProjectsFile.parse({ version: 1, ...state, workspace: null }))
    },
  }
}
