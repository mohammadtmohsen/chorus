import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AgentIdSchema, Logger } from '@chorus/shared'
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
import { enginePersistence, writeJson } from './state.js'
import type { EnginePeer, PeerRegistry } from './peers.js'
import {
  DESKTOP_CAPABILITIES,
  EXTENSION_CAPABILITIES,
} from '../../desktop/src/shared/host-capabilities.js'
import { ENGINE_VERSION } from './version.js'
import type { WorkbenchAskDiffResult } from '../../desktop/src/shared/workbench-ipc.js'
import { OfferedSecret, SecretId as SecretIdSchema } from './protocol.js'

export const SecretHostParams = OfferedSecret.extend({ id: SecretIdSchema })
export type SecretHostParams = z.infer<typeof SecretHostParams>
export const ConsoleReadHostParams = z.object({
  projectId: z.string(),
  request: z.object({
    count: z.number().int().positive(),
    skip: z.number().int().nonnegative(),
    levels: z.array(z.string()).optional(),
  }),
})
export type ConsoleReadHostParams = z.infer<typeof ConsoleReadHostParams>
export const ConsoleRunHostParams = z.object({
  projectId: z.string(),
  request: z.object({
    expression: z.string(),
    timeoutMs: z.number().int().positive(),
    actor: AgentIdSchema,
  }),
})
export type ConsoleRunHostParams = z.infer<typeof ConsoleRunHostParams>
export const ConsoleDisposeHostParams = z.object({ projectId: z.string() })
export type ConsoleDisposeHostParams = z.infer<typeof ConsoleDisposeHostParams>

const SecretRevision = z.object({
  revision: z.number().int().nonnegative(),
  set: z.boolean(),
  legacy: z.enum(['desktop', 'vscode']).nullable().default(null),
})
type SecretRevision = z.infer<typeof SecretRevision>
const SecretRevisions = z.partialRecord(SecretIdSchema, SecretRevision)

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
  private readonly acknowledgedKeys = new Map<SecretId, string>()
  private readonly revisions = new Map<SecretId, SecretRevision>()
  private readonly pendingSaves = new Map<
    SecretId,
    { readonly token: symbol; readonly value: string | null }[]
  >()
  private writes: Promise<void> = Promise.resolve()
  private runtime: ChorusRuntime | null = null
  private contextSink: ((report: WorkbenchContextReport) => void) | null = null
  private surfaceGoneSink: ((place: WorkbenchPlace) => void) | null = null
  private completionInvalidation: (() => void) | null = null

  constructor(
    readonly userDataPath: string,
    readonly registry: PeerRegistry,
    private readonly log: Logger = new Logger()
  ) {
    this.openProjects = enginePersistence(userDataPath)
    const revisionsPath = join(userDataPath, 'secret-revisions.json')
    if (existsSync(revisionsPath)) {
      try {
        const saved = SecretRevisions.safeParse(
          JSON.parse(readFileSync(revisionsPath, 'utf8')) as unknown
        )
        if (saved.success) {
          for (const [id, revision] of Object.entries(saved.data))
            this.revisions.set(SecretIdSchema.parse(id), revision)
        } else this.log.warn('saved secret revisions were invalid; starting empty')
      } catch {
        this.log.warn('saved secret revisions could not be read; starting empty')
      }
    }
    this.editor = {
      hasSurface: (place) => {
        const project = this.runtime?.projects.findByPlace(place)
        return (
          project !== null &&
          project !== undefined &&
          this.registry.clients().some((peer) => peer.projectIds.has(project.id))
        )
      },
      refreshTerminalEnv: () => {
        for (const peer of this.desktopPeers())
          void peer.requestHost('editor.refreshTerminalEnv', {}).catch(() => undefined)
      },
      reopenProject: (place) => {
        for (const peer of this.desktopPeers(place))
          void peer.requestHost('editor.reopenProject', { place }).catch(() => undefined)
      },
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
  loadSecrets(peer: EnginePeer, secrets: Partial<Record<SecretId, OfferedSecret>>): Promise<void> {
    return this.queueSecretWrite(async () => {
      for (const [id, offered] of Object.entries(secrets))
        await this.reconcile(peer, SecretIdSchema.parse(id), offered)
    })
  }
  flushSecrets(): Promise<void> {
    return this.writes
  }
  private queueSecretWrite(work: () => void | Promise<void>): Promise<void> {
    const result = this.writes.catch(() => undefined).then(work)
    this.writes = result
    void result.catch(() => undefined)
    return result
  }
  private refreshKey(id: SecretId): void {
    const pending = this.pendingSaves.get(id)
    const latest = pending?.[pending.length - 1]
    const value = latest === undefined ? (this.acknowledgedKeys.get(id) ?? null) : latest.value
    if (value === null) this.keys.delete(id)
    else this.keys.set(id, value)
    this.completionInvalidation?.()
  }
  private adopt(id: SecretId, offered: OfferedSecret, legacy: SecretRevision['legacy']): void {
    const revision = { revision: offered.revision, set: offered.value !== null, legacy }
    const saved = new Map(this.revisions)
    saved.set(id, revision)
    writeJson(join(this.userDataPath, 'secret-revisions.json'), Object.fromEntries(saved))
    this.revisions.set(id, revision)
    if (offered.value === null) this.acknowledgedKeys.delete(id)
    else this.acknowledgedKeys.set(id, offered.value)
    this.refreshKey(id)
  }
  private nextRevision(known: { revision: number } | undefined): number {
    return Math.max(Date.now(), (known?.revision ?? 0) + 1)
  }
  private currentSecret(id: SecretId): SecretHostParams | null {
    const known = this.revisions.get(id)
    if (known === undefined) return null
    const value = this.acknowledgedKeys.get(id) ?? null
    if (known.set && value === null) return null
    return { id, value, revision: known.revision }
  }
  private repair(peer: EnginePeer, id: SecretId): void {
    const params = this.currentSecret(id)
    if (params !== null) void peer.requestHost('secret', params).catch(() => undefined)
  }
  private fanOut(id: SecretId, source?: EnginePeer): void {
    for (const peer of this.registry.clients()) if (peer !== source) this.repair(peer, id)
  }
  private async reconcile(peer: EnginePeer, id: SecretId, offered: OfferedSecret): Promise<void> {
    const known = this.revisions.get(id)
    if (offered.revision === 0) {
      const desktopWins = peer.client.kind === 'desktop' && known?.legacy === 'vscode'
      if (known === undefined || desktopWins) {
        if (offered.value === null && known === undefined) return
        const migration = { value: offered.value, revision: this.nextRevision(known) }
        const token = Symbol(id)
        const pending = this.pendingSaves.get(id) ?? []
        pending.unshift({ token, value: offered.value })
        this.pendingSaves.set(id, pending)
        this.refreshKey(id)
        try {
          const acknowledged = await peer.requestHost('secret', { id, ...migration })
          if (acknowledged !== migration.revision)
            throw new Error('secret-revision-not-acknowledged')
          this.adopt(id, migration, peer.client.kind)
          this.fanOut(id, peer)
        } catch {
          this.log.warn('legacy secret migration was not acknowledged', { secretId: id })
          if (offered.value !== null) {
            this.acknowledgedKeys.set(id, offered.value)
            this.refreshKey(id)
          }
        } finally {
          const remaining =
            this.pendingSaves.get(id)?.filter((entry) => entry.token !== token) ?? []
          if (remaining.length === 0) this.pendingSaves.delete(id)
          else this.pendingSaves.set(id, remaining)
          this.refreshKey(id)
        }
      } else this.repair(peer, id)
      return
    }
    const current = known?.revision ?? 0
    if (offered.revision > current) {
      this.adopt(id, offered, null)
      this.fanOut(id, peer)
    } else if (offered.revision < current) this.repair(peer, id)
    else if (known?.set === false) {
      if (offered.value !== null) this.repair(peer, id)
    } else if (offered.value !== null && !this.acknowledgedKeys.has(id)) {
      this.acknowledgedKeys.set(id, offered.value)
      this.refreshKey(id)
      this.fanOut(id, peer)
    }
  }
  private updateSecret(id: SecretId, value: string | null): void {
    const peer = this.registry.choose()
    const token = Symbol(id)
    const pending = this.pendingSaves.get(id) ?? []
    pending.push({ token, value })
    this.pendingSaves.set(id, pending)
    this.refreshKey(id)
    void this.queueSecretWrite(async () => {
      try {
        if (peer === null) throw new Error('no-connected-window')
        const revision = this.nextRevision(this.revisions.get(id))
        const acknowledged = await peer.requestHost('secret', { id, value, revision })
        if (acknowledged !== revision) throw new Error('secret-revision-not-acknowledged')
        this.adopt(id, { value, revision }, null)
        this.fanOut(id)
      } finally {
        const remaining = this.pendingSaves.get(id)?.filter((entry) => entry.token !== token) ?? []
        if (remaining.length === 0) this.pendingSaves.delete(id)
        else this.pendingSaves.set(id, remaining)
        this.refreshKey(id)
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
    const peer = this.registry.context.getStore()
    const client = peer?.client
    return {
      capabilities: client?.kind === 'desktop' ? DESKTOP_CAPABILITIES : EXTENSION_CAPABILITIES,
      appVersion: peer?.hello.appVersion ?? ENGINE_VERSION,
      electronVersion: client?.kind === 'desktop' ? client.electronVersion : '',
      chromeVersion: client?.kind === 'desktop' ? client.chromeVersion : '',
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
    const path = z
      .string()
      .nullable()
      .parse(
        await this.registry.request('pickDirectory', {
          title: options.buttonLabel,
          buttonLabel: options.buttonLabel,
          createDirectory: options.properties.includes('createDirectory'),
        })
      )
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
    }
  }
  invalidateCompletionCredential(): void {
    this.completionInvalidation?.()
  }
  private desktopPeers(place?: WorkbenchPlace): EnginePeer[] {
    const project = place === undefined ? null : this.projectForPlace(place)
    return this.registry
      .clients()
      .filter(
        (peer) =>
          peer.client.kind === 'desktop' &&
          (place === undefined || (project !== null && peer.projectIds.has(project.id)))
      )
  }
  applyTheme(theme: Parameters<IpcHost['applyTheme']>[0]): void {
    for (const peer of this.desktopPeers())
      void peer.requestHost('applyTheme', { theme }).catch(() => undefined)
  }
  async prepareProjectClose(place: WorkbenchPlace): Promise<void> {
    await Promise.all(
      this.desktopPeers(place).map((peer) =>
        peer.requestHost('editor.prepareProjectClose', { place })
      )
    )
  }
  async closeProject(place: WorkbenchPlace): Promise<void> {
    await Promise.all(
      this.desktopPeers(place).map((peer) => peer.requestHost('editor.closeProject', { place }))
    )
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
