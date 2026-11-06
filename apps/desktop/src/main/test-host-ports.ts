import type { HostPorts } from './host-ports.js'

export function testHostPorts(userDataPath: string): HostPorts {
  return {
    userDataPath,
    editor: {
      hasSurface: () => false,
      refreshTerminalEnv: () => undefined,
      reopenProject: () => undefined,
      askDiff: () => Promise.resolve({ requestId: 'test', ok: false }),
      edit: () =>
        Promise.resolve({
          requestId: 'test',
          ok: false,
          refusal: 'no-editor',
          message: 'unavailable',
          version: null,
        }),
      snapshot: () => Promise.resolve(undefined),
    },
    secrets: {
      read: () => null,
      isSet: () => false,
      write: () => undefined,
      clear: () => undefined,
    },
    windows: {
      pickDirectory: () => Promise.resolve(null),
      pickFiles: () => Promise.resolve([]),
      writeClipboard: () => undefined,
      revealInFolder: () => undefined,
      openExternal: () => Promise.resolve(undefined),
      notify: () => undefined,
      setAttentionCount: () => undefined,
    },
  }
}
