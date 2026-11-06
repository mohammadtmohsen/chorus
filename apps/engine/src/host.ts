import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { IpcHost, WorkbenchContextReport } from '../../desktop/src/main/ipc-host.js'
import type { WorkbenchPlace } from '../../desktop/src/main/project-root.js'
import { WorkbenchContext } from '../../desktop/src/shared/workbench-ipc.js'
import { DiagnosticPush, DIAGNOSTIC_PUSH_CHANNEL } from '../../desktop/src/shared/ipc.js'
import { LOCAL_HOST } from '@chorus/event-store'
import { isInside, relativeInside, platformForRoot } from '@chorus/ide-protocol/paths'
import { toDisplayRange, type DiagnosticParams } from '@chorus/ide-protocol/protocol'
import type { ChorusRuntime } from '../../desktop/src/main/runtime.js'
import type { SecretId } from '../../desktop/src/main/host-ports.js'
import { probeAgentsWithSecrets } from '../../desktop/src/main/agent-probe-core.js'
import { checkTypesafeValue } from '../../desktop/src/main/typesafe-core.js'
import {
  checkRemoteHost,
  REMOTE_CHECK_DEADLINE_MS,
} from '../../desktop/src/main/remote-host-check.js'
import { SshRemoteHost } from '../../desktop/src/main/remote-host.js'
import {
  copyNoteImageTo,
  fetchNoteImage,
  saveNoteImage,
} from '../../desktop/src/main/note-image-store.js'
import messages from '../../desktop/src/renderer/src/i18n/en.json'
import { enginePersistence } from './state.js'
import type { PeerRegistry } from './peers.js'
import { EXTENSION_CAPABILITIES } from '../../desktop/src/shared/host-capabilities.js'
import { ENGINE_VERSION } from './version.js'
import type { WorkbenchAskDiffResult } from '../../desktop/src/shared/workbench-ipc.js'

const AskDiffResult = z.object({
  requestId: z.string(),
  ok: z.boolean(),
  message: z.string().optional(),
})
const EditResult = z.discriminatedUnion('ok', [
  z.object({ requestId: z.string(), ok: z.literal(true), version: z.number() }),
  z.object({
    requestId: z.string(),
    ok: z.literal(false),
    refusal: z.enum(['conflict', 'outside-project', 'no-editor', 'unopenable', 'failed']),
    message: z.string(),
    version: z.number().nullable(),
  }),
])
const Snapshot = WorkbenchContext.extend({ text: z.string(), preview: z.literal(true).optional() })
  .nullable()
  .optional()

function askResult(raw: unknown): WorkbenchAskDiffResult {
  const value = AskDiffResult.parse(raw)
  return {
    requestId: value.requestId,
    ok: value.ok,
    ...(value.message === undefined ? {} : { message: value.message }),
  }
}

export class EngineHost implements IpcHost {
  readonly openProjects: ReturnType<typeof enginePersistence>
  readonly editor: IpcHost['editor']
  readonly windows: IpcHost['windows']
  readonly secrets: IpcHost['secrets']
  readonly images: IpcHost['images']
  private readonly keys = new Map<SecretId, string>()
  private writes: Promise<void> = Promise.resolve()
  private runtime: ChorusRuntime | null = null
  private contextSink: ((report: WorkbenchContextReport) => void) | null = null
  private surfaceGoneSink: ((place: WorkbenchPlace) => void) | null = null
  private completionInvalidation: (() => void) | null = null

  constructor(
    readonly userDataPath: string,
    readonly registry: PeerRegistry
  ) {
    this.openProjects = enginePersistence(userDataPath)
    this.editor = {
      hasSurface: (place) => {
        const project = this.runtime?.projects.findByPlace(place)
        return (
          project !== null &&
          project !== undefined &&
          this.registry.clients().some((peer) => peer.projectIds.has(project.id))
        )
      },
      refreshTerminalEnv: () => undefined,
      reopenProject: () => undefined,
      askDiff: async (root, request) => {
        const project = this.runtime?.projects
          .list()
          .find((entry) => entry.canonicalRoot === root || entry.agentCwd === root)
        const peer = project === undefined ? null : this.registry.choose(project.id)
        const requestId = randomUUID()
        if (peer === null || project === undefined)
          return { requestId, ok: false, message: messages.extension.editorUnavailable }
        const place = { host: project.host, root: project.canonicalRoot }
        const revealPath =
          request.close === true && project.host !== LOCAL_HOST
            ? posix.join(place.root, request.path.replace(/\\/g, '/'))
            : request.revealPath
        return askResult(
          await peer.requestHost('editor.askDiff', {
            place,
            request: { ...request, requestId, ...(revealPath === undefined ? {} : { revealPath }) },
          })
        )
      },
      edit: async (place, request) => {
        const project = this.projectForPlace(place)
        const peer = project === null ? null : this.registry.choose(project.id)
        const requestId = randomUUID()
        if (peer === null)
          return {
            requestId,
            ok: false,
            refusal: 'no-editor',
            message: messages.extension.editorUnavailable,
            version: null,
          }
        return EditResult.parse(
          await peer.requestHost('editor.edit', { place, request: { ...request, requestId } })
        )
      },
      snapshot: async (requested) => {
        const project = this.projectForPlace(requested)
        const peer = project === null ? null : this.registry.choose(project.id)
        if (peer === null || project === null) return undefined
        const place = { host: project.host, root: project.canonicalRoot }
        const value = Snapshot.parse(await peer.requestHost('editor.snapshot', { place }))
        if (value === null || value === undefined) return value
        const { preview, ...snapshot } = value
        return { ...snapshot, ...(preview === true ? { preview: true as const } : {}) }
      },
      previewEdit: async (place, request) => {
        const project = this.projectForPlace(place)
        const peer = project === null ? null : this.registry.choose(project.id)
        const requestId = randomUUID()
        if (peer === null)
          return { requestId, ok: false, message: messages.extension.editorUnavailable }
        return askResult(
          await peer.requestHost('editor.previewEdit', {
            place,
            request: { ...request, requestId },
          })
        )
      },
    }
    this.secrets = {
      read: (id) => this.keys.get(id) ?? null,
      isSet: (id) => this.keys.has(id),
      write: (id, value) => {
        this.updateSecret(id, value)
      },
      clear: (id) => {
        this.updateSecret(id, null)
      },
    }
    this.windows = {
      pickDirectory: async (options) =>
        z
          .string()
          .nullable()
          .parse(await this.registry.request('pickDirectory', options)),
      pickFiles: async (options) =>
        z.array(z.string()).parse(await this.registry.request('pickFiles', options)),
      writeClipboard: (text) => {
        void this.registry.request('clipboard', { text }).catch(() => undefined)
      },
      revealInFolder: (path) => {
        void this.registry.request('revealInFolder', { path }).catch(() => undefined)
      },
      openExternal: async (url) => {
        await this.registry.request('openExternal', { url })
      },
      notify: (notice) => {
        void this.registry.request('notify', notice).catch(() => undefined)
      },
      setAttentionCount: (count) => {
        for (const peer of this.registry.clients())
          void peer.requestHost('attention', { count }).catch(() => undefined)
      },
    }
    this.images = {
      copyNoteImageTo,
      fetchNoteImage,
      saveNoteImage,
      pickNoteImage: async (dataDirectory) => {
        const picked = await this.windows.pickFiles({ title: messages.extension.images })
        const path = picked[0]
        if (path === undefined) return { url: null }
        return await saveNoteImage(
          dataDirectory,
          new Uint8Array(await readFile(path)),
          path.split('.').pop() ?? ''
        )
      },
    }
  }

  attach(runtime: ChorusRuntime): void {
    this.runtime = runtime
  }
  private projectForPlace(place: WorkbenchPlace) {
    const exact = this.runtime?.projects.findByPlace(place)
    if (exact !== undefined && exact !== null) return exact
    return (
      this.runtime?.projects
        .list()
        .find((project) => place.host === LOCAL_HOST && project.agentCwd === place.root) ?? null
    )
  }
  reportContext(report: WorkbenchContextReport): void {
    const project = this.runtime?.projects.findByPlace({
      host: report.host,
      root: report.projectRoot,
    })
    if (!project) return
    const path = report.context.relativePath
    if (
      path !== null &&
      (isAbsolute(path) ||
        /^[A-Za-z]:/.test(path) ||
        path.replace(/\\/g, '/').split('/').includes('..'))
    )
      return
    this.contextSink?.(report)
  }
  projectVisibilityChanged(previous: ReadonlySet<string>): void {
    if (this.runtime === null) return
    for (const projectId of previous) {
      const project = this.runtime.projects.get(projectId)
      if (
        project !== null &&
        !this.registry.clients().some((peer) => peer.projectIds.has(projectId))
      )
        this.surfaceGoneSink?.({ host: project.host, root: project.canonicalRoot })
    }
  }
  diagnostic(projectId: string, params: DiagnosticParams): { ok: boolean } {
    const project = this.runtime?.projects.get(projectId)
    if (project === undefined || project === null || this.runtime === null) return { ok: false }
    const platform = platformForRoot(
      project.canonicalRoot,
      project.host === LOCAL_HOST ? process.platform : 'linux'
    )
    if (!isInside(project.canonicalRoot, params.filePath, platform)) return { ok: false }
    const relativePath = relativeInside(project.canonicalRoot, params.filePath, platform)
    if (relativePath === null) return { ok: false }
    const range = toDisplayRange(params.range)
    const conversations = this.runtime.conversationsForPlace({
      host: project.host,
      root: project.canonicalRoot,
    })
    for (const conversationId of conversations) {
      const payload = DiagnosticPush.parse({ ...params, conversationId, relativePath, ...range })
      for (const peer of this.registry.clients()) peer.send(DIAGNOSTIC_PUSH_CHANNEL, payload)
    }
    return { ok: conversations.length > 0 }
  }
  onCompletionInvalidated(handler: () => void): void {
    this.completionInvalidation = handler
  }
  loadSecrets(secrets: Partial<Record<SecretId, string | null>>): void {
    for (const [id, value] of Object.entries(secrets)) {
      if (value === null) this.keys.delete(id as SecretId)
      else this.keys.set(id as SecretId, value)
    }
    this.completionInvalidation?.()
  }
  flushSecrets(): Promise<void> {
    return this.writes
  }
  private updateSecret(id: SecretId, value: string | null): void {
    const peer = this.registry.choose()
    const previous = this.keys.get(id)
    if (value === null) this.keys.delete(id)
    else this.keys.set(id, value)
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        if (peer === null) throw new Error('no-connected-window')
        try {
          await peer.requestHost('secret', { id, value })
        } catch (error) {
          if ((this.keys.get(id) ?? null) === value) {
            if (previous === undefined) this.keys.delete(id)
            else this.keys.set(id, previous)
          }
          throw error
        }
      })
  }
  clients(): ReturnType<PeerRegistry['clients']> {
    return this.registry.clients()
  }
  focused(): ReturnType<PeerRegistry['focused']> {
    return this.registry.focused()
  }
  target(projectId: string): ReturnType<PeerRegistry['choose']> {
    return this.registry.choose(projectId)
  }
  raise(client: ReturnType<PeerRegistry['choose']>): void {
    if (client !== null) void client.requestHost('reveal', {}).catch(() => undefined)
  }
  appInfo(): ReturnType<IpcHost['appInfo']> {
    return {
      capabilities: EXTENSION_CAPABILITIES,
      appVersion: ENGINE_VERSION,
      electronVersion: '',
      chromeVersion: '',
      nodeVersion: process.versions.node,
      platform: process.platform,
      home: homedir(),
    }
  }
  appVersion(): string {
    return ENGINE_VERSION
  }
  getPath(name: 'userData' | 'desktop'): string {
    return name === 'userData' ? this.userDataPath : join(homedir(), 'Desktop')
  }
  async pickDirectory(
    options: Parameters<IpcHost['pickDirectory']>[0]
  ): ReturnType<IpcHost['pickDirectory']> {
    const path = await this.windows.pickDirectory({ title: options.buttonLabel })
    return { canceled: path === null, filePaths: path === null ? [] : [path] }
  }
  notify(request: Parameters<IpcHost['notify']>[0]): void {
    void this.registry.request('notify', request, request.projectId).catch(() => undefined)
  }
  probeAgents: IpcHost['probeAgents'] = () => probeAgentsWithSecrets((id) => this.keys.has(id))
  checkTypesafeKey: IpcHost['checkTypesafeKey'] = () =>
    checkTypesafeValue(this.keys.get('typesafe') ?? null)
  checkRemoteHost: IpcHost['checkRemoteHost'] = (host) =>
    checkRemoteHost(new SshRemoteHost(host), REMOTE_CHECK_DEADLINE_MS)
  extensionDeps(): ReturnType<IpcHost['extensionDeps']> {
    return {
      findCode: () => Promise.resolve(null),
      exec: () => Promise.reject(new Error('editor-unavailable')),
      vsixPath: () => null,
      bundledVersion: () => null,
    }
  }
  invalidateCompletionCredential(): void {
    this.completionInvalidation?.()
  }
  applyTheme(): void {
    return
  }
  prepareProjectClose(): Promise<void> {
    return Promise.resolve()
  }
  closeProject(): Promise<void> {
    return Promise.resolve()
  }
  async reveal(
    root: string,
    request: Parameters<IpcHost['reveal']>[1]
  ): ReturnType<IpcHost['reveal']> {
    const project = this.runtime?.projects
      .list()
      .find((entry) => entry.canonicalRoot === root || entry.agentCwd === root)
    const peer = project === undefined ? this.registry.choose() : this.registry.choose(project.id)
    if (peer === null) return { requestId: randomUUID(), ok: false }
    const place =
      project === undefined ? undefined : { host: project.host, root: project.canonicalRoot }
    const ok = z.boolean().parse(
      await peer.requestHost('openFile', {
        ...request,
        ...(place === undefined ? {} : { place }),
      })
    )
    return { requestId: randomUUID(), ok }
  }
  setContextSink(sink: ((report: WorkbenchContextReport) => void) | null): void {
    this.contextSink = sink
  }
  setSurfaceGoneSink(sink: ((place: WorkbenchPlace) => void) | null): void {
    this.surfaceGoneSink = sink
  }
}
