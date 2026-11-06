import { z } from 'zod'
import { BROWSER_FRAME_CHANNEL } from '../../../desktop/src/shared/browser-ipc.js'
import { createChorusApi } from '../../../desktop/src/shared/create-chorus-api.js'
import {
  CONVERSATION_NOTE_JOURNAL_PUSH_CHANNEL,
  ConversationNoteJournalResponse,
  type ConversationNoteJournalRequest,
} from '../../../desktop/src/shared/ipc.js'
import { MirroredJournalBackend } from '../../../desktop/src/shared/mirrored-journal.js'
import { mountApp } from '../../../desktop/src/renderer/src/mount-app.js'
import { configureHostResources } from '../../../desktop/src/renderer/src/host-resources.js'
import {
  hostProjectAdopted,
  hostReconnected,
} from '../../../desktop/src/renderer/src/host-actions.js'
import { useWorkspaceStore } from '../../../desktop/src/renderer/src/workspace/store.js'
import messages from '../../../desktop/src/renderer/src/i18n/en.json'
import { PERSON_PACED_CHANNELS } from '../../../engine/src/protocol.js'
import { ShellHostMessage } from '../shared/webview-protocol.js'
import { installThemeMirror } from './theme.js'
import { EXTENSION_CAPABILITIES } from '../../../desktop/src/shared/host-capabilities.js'

interface VsCodeApi {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}
declare function acquireVsCodeApi(): VsCodeApi

const vscode = acquireVsCodeApi()
const reportViewFocus = (focused: boolean): void => {
  vscode.postMessage({ kind: 'viewFocus', focused })
}
window.addEventListener('focus', () => {
  reportViewFocus(true)
})
window.addEventListener('blur', () => {
  reportViewFocus(false)
})
const Backup = z.object({
  storage: z.record(z.string(), z.string()).default({}),
  journals: z.record(z.string(), z.unknown()).default({}),
})
const parsedBackup = Backup.safeParse(vscode.getState())
const backup = parsedBackup.success ? parsedBackup.data : Backup.parse({})
const listeners = new Map<string, Set<(payload: unknown) => void>>()
const buffered = new Map<string, unknown[]>()
const pending = new Map<
  string,
  {
    resolve(value: unknown): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout> | undefined
  }
>()
const journals = new Map<string, MirroredJournalBackend>()
let booted = false
let wasConnected = false
let hasConnected = false
let lastSeq = 0
const persist = (): void => {
  vscode.setState(backup)
}
const publish = (channel: string, payload: unknown): void => {
  const subscribed = listeners.get(channel)
  if (subscribed === undefined || subscribed.size === 0) {
    if (channel === BROWSER_FRAME_CHANNEL) return
    const queue = buffered.get(channel) ?? []
    queue.push(payload)
    buffered.set(channel, queue)
    return
  }
  for (const listener of subscribed) listener(payload)
}
const request = (message: Record<string, unknown>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer =
      message['kind'] === 'invoke' && PERSON_PACED_CHANNELS.has(String(message['channel']))
        ? undefined
        : setTimeout(() => {
            pending.delete(id)
            reject(new Error(messages.extension.requestTimedOut))
          }, 180_000)
    pending.set(id, { resolve, reject, timer })
    vscode.postMessage({ ...message, id })
  })
const journalFor = (conversationId: string): MirroredJournalBackend => {
  let mirror = journals.get(conversationId)
  if (mirror !== undefined) return mirror
  const remote = async (
    operation: ConversationNoteJournalRequest
  ): Promise<ConversationNoteJournalResponse> =>
    ConversationNoteJournalResponse.parse(await request({ kind: 'journal', request: operation }))
  mirror = new MirroredJournalBackend(
    {
      read: () => remote({ conversationId, op: 'read' }),
      compare: (expected, next) => remote({ conversationId, op: 'compare', expected, next }),
    },
    {
      backup: backup.journals[conversationId],
      save: (snapshot) => {
        backup.journals[conversationId] = snapshot
        persist()
      },
    }
  )
  mirror.subscribe(() => {
    publish(CONVERSATION_NOTE_JOURNAL_PUSH_CHANNEL, { conversationId })
  })
  journals.set(conversationId, mirror)
  return mirror
}
let lastFocus = ''
const reportFocus = (): void => {
  const state = useWorkspaceStore.getState()
  const projectIds = Object.values(state.panes).flatMap((pane) => pane.tabs)
  const focusedProjectId =
    state.focusedPaneId === null ? null : (state.panes[state.focusedPaneId]?.activeTabId ?? null)
  const report = {
    kind: 'focus',
    projectIds: [...new Set(projectIds)],
    focusedProjectId,
    lastSeq,
  }
  const encoded = JSON.stringify(report)
  if (encoded === lastFocus) return
  lastFocus = encoded
  vscode.postMessage(report)
}

installThemeMirror()
const status = document.createElement('div')
status.className = 'chorus-host-status'
status.setAttribute('role', 'status')
status.hidden = true
document.body.append(status)
const retry = document.createElement('button')
let restartPending = false
retry.type = 'button'
retry.textContent = messages.extension.retry
retry.addEventListener('click', () => {
  vscode.postMessage({ kind: restartPending ? 'restart' : 'ready' })
})

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const parsed = ShellHostMessage.safeParse(event.data)
  if (!parsed.success) return
  const message = parsed.data
  if (message.kind === 'answer') {
    const waiting = pending.get(message.id)
    if (waiting === undefined) return
    pending.delete(message.id)
    clearTimeout(waiting.timer)
    if (message.ok) waiting.resolve(message.value)
    else waiting.reject(new Error(message.error ?? messages.extension.engineFailed))
  } else if (message.kind === 'push') {
    if (message.channel === 'conversation:events') {
      const events = z.array(z.object({ seq: z.number() })).safeParse(message.payload)
      if (events.success)
        lastSeq = events.data.reduce((seq, entry) => Math.max(seq, entry.seq), lastSeq)
    }
    publish(message.channel, message.payload)
  } else if (message.kind === 'state') {
    const connected = message.state === 'connected'
    const reconnected = connected && !wasConnected && hasConnected
    wasConnected = connected
    if (connected || message.state === 'restart-required') hasConnected = true
    restartPending = message.state === 'restart-required'
    retry.textContent = restartPending ? messages.extension.restart : messages.extension.retry
    status.hidden = connected
    status.replaceChildren()
    if (!connected) {
      const waiting = message.activity
      status.append(
        message.state === 'restart-required'
          ? waiting === undefined
            ? messages.extension.engineRestartRequired
            : messages.extension.engineRestartBusy
                .replaceAll('{{chats}}', String(waiting.conversations.length))
                .replaceAll('{{approvals}}', String(waiting.approvals))
                .replaceAll('{{questions}}', String(waiting.questions))
                .replaceAll('{{runs}}', String(waiting.runs.length))
                .replaceAll('{{starting}}', String(waiting.starting))
          : message.state === 'stopped'
            ? messages.extension.engineStopped
            : messages.extension.reconnecting
      )
      status.append(retry)
    }
    if (connected && booted) {
      if (reconnected) hostReconnected()
      for (const mirror of journals.values()) void mirror.prepare().catch(() => undefined)
    }
  } else if (message.kind === 'projectAdopted') {
    hostProjectAdopted(message.project)
  } else if (message.kind === 'showProject') {
    useWorkspaceStore.getState().openProject(message.projectId)
  } else {
    if (booted) {
      lastFocus = ''
      reportFocus()
      return
    }
    booted = true
    backup.storage = { ...backup.storage, ...message.storage }
    configureHostResources({
      resolveDropUris: async (uris) =>
        z.object({ paths: z.array(z.string()) }).parse(await request({ kind: 'dropFiles', uris }))
          .paths,
      noteImageUrl: (url) => {
        const filename = url.slice('chorus-note://image/'.length)
        return /^[a-f0-9]{16}\.(?:png|jpe?g|gif|webp)$/.test(filename)
          ? `${message.imageBase}/${filename}`
          : ''
      },
    })
    const api = createChorusApi({
      invoke: (channel, outgoing) => request({ kind: 'invoke', channel, request: outgoing }),
      on: (channel, listener) => {
        const subscribed = listeners.get(channel) ?? new Set()
        subscribed.add(listener)
        listeners.set(channel, subscribed)
        const queued = buffered.get(channel)
        if (queued !== undefined) {
          buffered.delete(channel)
          queueMicrotask(() => {
            if (subscribed.has(listener)) for (const payload of queued) listener(payload)
          })
        }
        return () => {
          subscribed.delete(listener)
        }
      },
      pathForFile: () => '',
      prepareConversationNoteJournal: ({ conversationId }) => journalFor(conversationId).prepare(),
      noteJournal: (outgoing) => journalFor(outgoing.conversationId).answer(outgoing),
    })
    const container = document.getElementById('root')
    if (container === null) throw new Error(messages.extension.engineFailed)
    mountApp(container, {
      api,
      capabilities: EXTENSION_CAPABILITIES,
      storage: {
        getItem: (key) => backup.storage[key] ?? null,
        setItem: (key, value) => {
          backup.storage[key] = value
          persist()
          void request({ kind: 'storage', key, value }).catch(() => undefined)
        },
      },
    })
    useWorkspaceStore.subscribe(reportFocus)
    window.addEventListener('focus', reportFocus)
    reportFocus()
  }
})
vscode.postMessage({ kind: 'ready' })
reportViewFocus(document.hasFocus())
