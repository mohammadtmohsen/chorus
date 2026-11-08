import { ipcMain, type WebContents } from 'electron'
import {
  CONVERSATION_NOTE_JOURNAL_ASYNC_CHANNEL,
  ConversationNoteJournalRequest,
  ConversationNoteJournalResponse,
  IPC_CONTRACT,
} from '../shared/ipc.js'
import { TRAFFIC_CONTRACT } from '../shared/traffic-ipc.js'
import { RUN_CONTRACT } from '../shared/run-ipc.js'
import { GIT_CONTRACT } from '../shared/git-ipc.js'
import type { EngineClient } from '../../../engine/src/client.js'
import messages from '../renderer/src/i18n/en.json'
import { isShellSender } from './shell-windows.js'

export function registerIpcHandlers(clientFor: (sender: WebContents) => EngineClient): void {
  const channels = new Set([
    ...Object.keys(IPC_CONTRACT),
    ...Object.keys(TRAFFIC_CONTRACT),
    ...Object.keys(RUN_CONTRACT),
    ...Object.keys(GIT_CONTRACT),
  ])
  for (const channel of channels) {
    ipcMain.handle(channel, async (event, request: unknown) => {
      if (!isShellSender(event)) throw new Error(messages.extension.channelRefused)
      return await clientFor(event.sender).invoke(channel, request)
    })
  }
  ipcMain.handle(CONVERSATION_NOTE_JOURNAL_ASYNC_CHANNEL, async (event, raw: unknown) => {
    if (!isShellSender(event)) throw new Error(messages.extension.channelRefused)
    const request = ConversationNoteJournalRequest.parse(raw)
    return ConversationNoteJournalResponse.parse(
      await clientFor(event.sender).request({ kind: 'journal', request })
    )
  })
}
