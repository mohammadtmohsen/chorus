import { mountApp } from './mount-app.js'
import { desktopHostViews } from './desktop-host-views.js'
import { DESKTOP_CAPABILITIES } from '../../shared/host-capabilities.js'
import type { WindowRole } from '../../shared/detached-window-ipc.js'

const container = document.getElementById('root')
if (container === null) throw new Error('Missing #root container')

const DETACHED_HASH = '#detached='
const role: WindowRole = window.location.hash.startsWith(DETACHED_HASH)
  ? {
      kind: 'detached',
      projectId: decodeURIComponent(window.location.hash.slice(DETACHED_HASH.length)),
    }
  : { kind: 'main' }

mountApp(container, {
  api: window.chorus,
  role,
  views: desktopHostViews,
  capabilities: DESKTOP_CAPABILITIES,
})
