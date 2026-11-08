import { Notification, type BrowserWindow } from 'electron'
import { raise } from './detached-windows.js'

const MAX_SHOWN = 50
const shown = new Set<Notification>()

export function showDesktopNotification(
  request: { readonly title: string; readonly body: string },
  windowFor: () => BrowserWindow | null
): void {
  if (!Notification.isSupported()) return
  const banner = new Notification({ title: request.title, body: request.body, silent: true })
  shown.add(banner)
  if (shown.size > MAX_SHOWN) {
    const oldest = shown.values().next().value
    if (oldest !== undefined) shown.delete(oldest)
  }
  const forget = (): void => {
    shown.delete(banner)
  }
  banner.on('click', () => {
    forget()
    raise(windowFor())
  })
  banner.on('close', forget)
  banner.show()
}
