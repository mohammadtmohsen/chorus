import { getService } from '@codingame/monaco-vscode-api'
import { ICommandService } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands.service'
import { IExtensionService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensions/common/extensions.service'
import { IRemoteAgentService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/remote/common/remoteAgentService.service'
import { ITerminalService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/terminal/browser/terminal.service'
import { IWorkingCopyService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopyService.service'
import type { WorkbenchConnection } from '../../../shared/workbench-ipc.js'

export async function serveWorkbenchLifecycle(connection: WorkbenchConnection): Promise<void> {
  const [commands, extensions, remote, terminals, copies] = await Promise.all([
    getService(ICommandService),
    getService(IExtensionService),
    getService(IRemoteAgentService),
    getService(ITerminalService),
    getService(IWorkingCopyService),
  ])
  const pids = (): number[] => [
    ...new Set(
      terminals.instances
        .map((instance) => instance.processId)
        .filter(
          (pid): pid is number => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1
        )
    ),
  ]
  const attest = async (): Promise<void> => {
    if (connection.processNonce === undefined) return
    await commands.executeCommand('chorus.internal.processOwner', connection.processNonce)
  }
  let closing = false
  let reporting = Promise.resolve()
  window.chorusWorkbench.onProcessCloseRequest(async (phase) => {
    if (phase === 'prepare') {
      if (copies.hasDirty) return { refusal: 'unsaved' }
      if (connection.processNonce === undefined) return []
      await reporting.catch(() => undefined)
      await attest()
      return pids()
    }
    closing = true
    const failures: unknown[] = []
    try {
      if (!(await extensions.stopExtensionHosts('Closing project', true))) {
        throw new Error('An editor extension prevented shutdown.')
      }
    } catch (error) {
      failures.push(error)
    }
    if (connection.processNonce !== undefined) {
      try {
        await window.chorusWorkbench.reportProcesses(pids())
      } catch (error) {
        failures.push(error)
      }
    }
    for (const instance of [...terminals.instances]) {
      try {
        instance.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      await remote.endConnection()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length !== 0) {
      throw new AggregateError(
        failures,
        failures.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')
      )
    }
    return []
  })
  const report = async (): Promise<void> => {
    if (connection.processNonce === undefined) return
    await attest()
    await window.chorusWorkbench.reportProcesses(pids())
  }
  const reportLater = (): void => {
    if (closing || connection.processNonce === undefined) return
    reporting = reporting.catch(() => undefined).then(report)
    void reporting.catch(() => undefined)
  }
  terminals.onDidCreateInstance((instance) => {
    instance.onProcessIdReady(reportLater)
    reportLater()
  })
  for (const instance of terminals.instances) instance.onProcessIdReady(reportLater)
  reportLater()
}
