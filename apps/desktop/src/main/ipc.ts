import { ipcMain, type BrowserWindow } from 'electron'
import {
  CONVERSATION_NOTE_JOURNAL_CHANNEL,
  IPC_CONTRACT,
  type ConversationNoteJournalResponse,
  type IpcChannel,
} from '../shared/ipc.js'
import { desktopIpcHost } from './desktop-ipc-host.js'
import * as handlers from './ipc-handlers.js'
import type { ChorusRuntime } from './runtime.js'
import { isShellSender } from './shell-windows.js'
export { answerConversationNoteJournal, splitFileLocation } from './ipc-handlers.js'

export function buildHandlers(
  runtime: ChorusRuntime,
  mainWindow: () => BrowserWindow | null
): handlers.IpcHandlers {
  return handlers.buildHandlers(runtime, desktopIpcHost(mainWindow))
}

export function registerIpcHandlers(
  runtime: ChorusRuntime,
  mainWindow: () => BrowserWindow | null
): void {
  const table = buildHandlers(runtime, mainWindow)
  for (const channel of Object.keys(IPC_CONTRACT) as IpcChannel[]) {
    ipcMain.handle(channel, async (event, rawRequest: unknown) => {
      if (!isShellSender(event)) throw new Error(`"${channel}" is only available to Chorus windows`)
      return handlers.dispatch(table, channel, rawRequest)
    })
  }
  ipcMain.on(CONVERSATION_NOTE_JOURNAL_CHANNEL, (event, rawRequest: unknown) => {
    let reply: ConversationNoteJournalResponse
    try {
      reply = handlers.answerConversationNoteJournal(runtime, isShellSender(event), rawRequest)
    } catch {
      reply = { ok: false, error: 'The note journal could not be answered' }
    }
    event.returnValue = reply
  })
}

export const forwardLimitsToRenderer = (
  runtime: ChorusRuntime
): ReturnType<typeof handlers.forwardLimitsToRenderer> => {
  handlers.forwardLimitsToRenderer(
    runtime,
    desktopIpcHost(() => null)
  )
}
export const forwardContextUsageToRenderer = (
  runtime: ChorusRuntime
): ReturnType<typeof handlers.forwardContextUsageToRenderer> => {
  handlers.forwardContextUsageToRenderer(
    runtime,
    desktopIpcHost(() => null)
  )
}
export const forwardTasksToRenderer = (
  runtime: ChorusRuntime
): ReturnType<typeof handlers.forwardTasksToRenderer> => {
  handlers.forwardTasksToRenderer(
    runtime,
    desktopIpcHost(() => null)
  )
}
export const forwardConversationNotesToRenderer = (
  runtime: ChorusRuntime
): ReturnType<typeof handlers.forwardConversationNotesToRenderer> =>
  handlers.forwardConversationNotesToRenderer(
    runtime,
    desktopIpcHost(() => null)
  )
export const forwardActivityToRenderer = (
  runtime: ChorusRuntime
): ReturnType<typeof handlers.forwardActivityToRenderer> => {
  handlers.forwardActivityToRenderer(
    runtime,
    desktopIpcHost(() => null)
  )
}
export const forwardAttentionToRenderer = (
  runtime: ChorusRuntime
): ReturnType<typeof handlers.forwardAttentionToRenderer> => {
  handlers.forwardAttentionToRenderer(
    runtime,
    desktopIpcHost(() => null)
  )
}
export const forwardTerminalToRenderer = (
  runtime: ChorusRuntime
): ReturnType<typeof handlers.forwardTerminalToRenderer> =>
  handlers.forwardTerminalToRenderer(
    runtime,
    desktopIpcHost(() => null)
  )
export const forwardWorkbenchContextToRenderer = (
  runtime: ChorusRuntime
): ReturnType<typeof handlers.forwardWorkbenchContextToRenderer> =>
  handlers.forwardWorkbenchContextToRenderer(
    runtime,
    desktopIpcHost(() => null)
  )
export const forwardEventsToRenderer = (
  runtime: ChorusRuntime
): ReturnType<typeof handlers.forwardEventsToRenderer> =>
  handlers.forwardEventsToRenderer(
    runtime,
    desktopIpcHost(() => null)
  )
