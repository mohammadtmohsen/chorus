import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const CODE_BINARY = '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
const DEFAULT_TIMEOUT_MS = 30_000

const DEFAULT_SETTINGS = {
  'files.simpleDialog.enable': true,
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'telemetry.telemetryLevel': 'off',
  'window.restoreWindows': 'none',
  'chat.disableAIFeatures': true,
  'security.workspace.trust.enabled': false,
}

const childEnvironment = (extra) => {
  const env = { ...process.env, ...extra }
  for (const name of Object.keys(env)) {
    if (name === 'ELECTRON_RUN_AS_NODE' || name.startsWith('VSCODE_'))
      Reflect.deleteProperty(env, name)
  }
  return env
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.waiting = new Map()
    this.listeners = new Set()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const waiting = this.waiting.get(message.id)
        this.waiting.delete(message.id)
        if (waiting !== undefined) clearTimeout(waiting.timer)
        if (message.error !== undefined) {
          waiting?.reject(new Error(`${waiting.method}: ${message.error.message}`))
        } else {
          waiting?.resolve(message.result)
        }
        return
      }
      for (const listener of this.listeners) listener(message)
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`CDP timed out: ${method}`))
      }, 30_000)
      this.waiting.set(id, { resolve, reject, method, timer })
      this.socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }

  listen(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    for (const waiting of this.waiting.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('CDP closed'))
    }
    this.waiting.clear()
    this.socket.close()
  }
}

async function readDevToolsEndpoint(userDataDir, child, log) {
  const path = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`VS Code exited with ${String(child.exitCode)}: ${log().slice(-2000)}`)
    }
    if (existsSync(path)) {
      const [port, browserPath] = readFileSync(path, 'utf8').trim().split('\n')
      if (port !== undefined && browserPath !== undefined) {
        return `ws://127.0.0.1:${port}${browserPath}`
      }
    }
    await sleep(100)
  }
  throw new Error(`VS Code did not publish a debugger: ${log().slice(-2000)}`)
}

class Page {
  constructor(driver, sessionId) {
    this.driver = driver
    this.sessionId = sessionId
  }

  send(method, params) {
    return this.driver.cdp.send(method, params, this.sessionId)
  }

  async evaluate(expression, contextId) {
    const reply = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    })
    if (reply.exceptionDetails !== undefined) {
      const detail = reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text
      throw new Error(`evaluate failed: ${detail}`)
    }
    return reply.result.value
  }
}

class WebviewFrame {
  constructor(page, contextId) {
    this.page = page
    this.contextId = contextId
  }

  evaluate(expression) {
    return this.page.evaluate(expression, this.contextId)
  }

  async drag(from, to) {
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
    await this.page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    })
    for (let step = 1; step <= 12; step += 1) {
      await this.page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + ((to.x - from.x) * step) / 12,
        y: from.y + ((to.y - from.y) * step) / 12,
        button: 'left',
        buttons: 1,
      })
    }
    await this.page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    })
  }
}

export class VSCodeDriver {
  constructor({ child, cdp, userDataDir, output }) {
    this.child = child
    this.cdp = cdp
    this.userDataDir = userDataDir
    this.output = output
    this.pages = new Map()
    this.contexts = new Map()
    this.frames = new Map()
    this.targets = new Map()
    this.consoleEntries = []
    cdp.listen((message) => {
      this.observe(message)
    })
  }

  observe({ method, params, sessionId }) {
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      this.targets.set(params.targetInfo.targetId, params.targetInfo)
    } else if (method === 'Target.targetDestroyed') {
      this.targets.delete(params.targetId)
    } else if (method === 'Target.attachedToTarget') {
      this.targets.set(params.targetInfo.targetId, params.targetInfo)
      void this.prepareSession(params.sessionId)
    } else if (method === 'Runtime.executionContextCreated') {
      const contexts = this.contexts.get(sessionId) ?? new Map()
      contexts.set(params.context.id, params.context)
      this.contexts.set(sessionId, contexts)
    } else if (method === 'Runtime.executionContextDestroyed') {
      this.contexts.get(sessionId)?.delete(params.executionContextId)
    } else if (method === 'Runtime.executionContextsCleared') {
      this.contexts.get(sessionId)?.clear()
    } else if (method === 'Runtime.consoleAPICalled') {
      this.consoleEntries.push({
        level: params.type,
        text: params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
      })
    } else if (method === 'Runtime.exceptionThrown') {
      this.consoleEntries.push({
        level: 'exception',
        text: params.exceptionDetails.exception?.description ?? params.exceptionDetails.text,
      })
    }
  }

  async prepareSession(sessionId) {
    try {
      await this.cdp.send('Runtime.enable', {}, sessionId)
      await this.cdp.send('Page.enable', {}, sessionId)
      await this.cdp.send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId
      )
    } catch {
      return
    }
  }

  sessionOf(targetId) {
    return this.pages.get(targetId)
  }

  async attach(targetId) {
    const known = this.pages.get(targetId)
    if (known !== undefined) return known
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await this.prepareSession(sessionId)
    const page = new Page(this, sessionId)
    this.pages.set(targetId, page)
    return page
  }

  async workbenchTargets() {
    const { targetInfos } = await this.cdp.send('Target.getTargets')
    return targetInfos.filter((info) => info.type === 'page' && info.url.includes('workbench'))
  }

  pinWorkbench(targetId) {
    this.pinnedWorkbench = targetId
  }

  async webviews({ extensionId, selector } = {}) {
    const { targetInfos } = await this.cdp.send('Target.getTargets')
    const frames = []
    for (const target of targetInfos) {
      if (
        !(target.type === 'page' || target.type === 'iframe') ||
        !target.url.startsWith('vscode-webview://') ||
        (extensionId !== undefined &&
          !decodeURIComponent(target.url).toLowerCase().includes(extensionId.toLowerCase()))
      )
        continue
      const page = await this.attach(target.targetId)
      const { frameTree } = await page.send('Page.getFrameTree')
      const inner = (frameTree.childFrames ?? [])[0]?.frame ?? frameTree.frame
      const context = [...(this.contexts.get(page.sessionId)?.values() ?? [])].find(
        (entry) => entry.auxData?.frameId === inner.id && entry.auxData?.isDefault === true
      )
      if (context === undefined) continue
      const frame = new WebviewFrame(page, context.id)
      if (selector === undefined) {
        frames.push(frame)
        continue
      }
      const matched = await Promise.race([
        frame
          .evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`)
          .catch(() => false),
        sleep(3_000).then(() => false),
      ])
      if (matched) frames.push(frame)
    }
    return frames
  }

  async workbench() {
    return this.poll('the workbench page', async () => {
      const { targetInfos } = await this.cdp.send('Target.getTargets')
      const target = targetInfos.find(
        (info) =>
          info.type === 'page' &&
          info.url.includes('workbench') &&
          (this.pinnedWorkbench === undefined || info.targetId === this.pinnedWorkbench)
      )
      if (target === undefined) return null
      const page = await this.attach(target.targetId)
      const ready = await page.evaluate('document.querySelector(".monaco-workbench") !== null')
      return ready ? page : null
    })
  }

  async webview({ extensionId, timeoutMs, selector } = {}) {
    return this.poll(
      `a webview for ${extensionId ?? 'any extension'}`,
      async () => {
        const { targetInfos } = await this.cdp.send('Target.getTargets')
        const candidates = targetInfos.filter(
          (info) =>
            (info.type === 'page' || info.type === 'iframe') &&
            info.url.startsWith('vscode-webview://') &&
            (extensionId === undefined ||
              decodeURIComponent(info.url).toLowerCase().includes(extensionId.toLowerCase()))
        )
        for (const target of candidates) {
          const page = await this.attach(target.targetId)
          const { frameTree } = await page.send('Page.getFrameTree')
          const inner =
            (frameTree.childFrames ?? []).find(
              (child) =>
                child.frame.name === 'active-frame' ||
                child.frame.url.includes('fake.html') ||
                child.frame.id !== undefined
            )?.frame ?? frameTree.frame
          const contexts = [...(this.contexts.get(page.sessionId)?.values() ?? [])]
          const context = contexts.find(
            (entry) => entry.auxData?.frameId === inner.id && entry.auxData?.isDefault === true
          )
          if (context !== undefined) {
            const frame = new WebviewFrame(page, context.id)
            if (
              selector === undefined ||
              (await frame.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`))
            )
              return frame
          }
        }
        return null
      },
      timeoutMs
    )
  }

  async poll(what, attempt, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      try {
        const answer = await attempt()
        if (answer !== null && answer !== undefined && answer !== false) return answer
      } catch (error) {
        last = error
      }
      await sleep(150)
    }
    throw new Error(`Timed out waiting for ${what}${last === null ? '' : `: ${String(last)}`}`)
  }

  async waitInWebview(expression, { extensionId, timeoutMs } = {}) {
    return this.poll(
      expression,
      async () => {
        const frame = await this.webview({ extensionId, timeoutMs: 2_000 })
        return frame.evaluate(expression)
      },
      timeoutMs
    )
  }

  async press(key, modifiers = 0) {
    const page = await this.workbench()
    const codes = { '\\': 'Backslash', '[': 'BracketLeft', ']': 'BracketRight' }
    const code =
      codes[key] ??
      (/^\d$/.test(key) ? `Digit${key}` : key.length === 1 ? `Key${key.toUpperCase()}` : key)
    const virtual = {
      Enter: 13,
      Escape: 27,
      F1: 112,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      '\\': 220,
      '[': 219,
      ']': 221,
    }
    const windowsVirtualKeyCode = virtual[key] ?? key.toUpperCase().charCodeAt(0)
    const base = {
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    }
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  async insertText(text) {
    const page = await this.workbench()
    await page.send('Input.insertText', { text })
  }

  async command(title, { navigates = false } = {}) {
    await this.press('F1')
    const page = await this.workbench()
    await this.poll('the command palette', () =>
      page.evaluate('document.querySelector(".quick-input-widget .input") !== null')
    )
    await sleep(150)
    await this.insertText(title)
    await sleep(500)
    if (!navigates) {
      await this.press('Enter')
      return
    }
    const before = await page.evaluate('performance.timeOrigin')
    void this.press('Enter').catch(() => undefined)
    await this.poll('the reloaded workbench document', async () => {
      const current = await this.workbench()
      return (await current.evaluate('performance.timeOrigin')) !== before
    })
  }

  async answerSimpleDialog(path) {
    const page = await this.workbench()
    await this.poll('the file dialog', () =>
      page.evaluate(
        `(() => {
          const widget = document.querySelector('.quick-input-widget')
          return widget !== null && widget.style.display !== 'none'
        })()`
      )
    )
    await sleep(300)
    await page.evaluate(
      `(() => {
        const input = document.querySelector('.quick-input-widget .input')
        input.focus()
        input.select()
      })()`
    )
    await this.insertText(path)
    await sleep(500)
    await this.press('Enter')
    await this.poll('the folder dialog confirmation', () =>
      page.evaluate(`(() => {
        const widget = document.querySelector('.quick-input-widget')
        if (widget === null || widget.style.display === 'none') return true
        const accept = widget.querySelector('.monaco-button:not(.secondary)')
        if (accept === null) return false
        accept.click()
        return true
      })()`)
    )
  }

  async screenshot(path) {
    const page = await this.workbench()
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }

  async quit() {
    void this.cdp.send('Browser.close').catch(() => undefined)
    await sleep(500)
    this.cdp.close()
    const deadline = Date.now() + 5_000
    while (this.child.exitCode === null && Date.now() < deadline) await sleep(100)
    if (this.child.exitCode === null) this.child.kill('SIGKILL')
  }
}

export async function launchVSCode({
  folder,
  developmentPath,
  extensionsDir,
  userDataDir,
  settings = {},
  env = {},
  args = [],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chorus-vscode-'))
  const dataDir = userDataDir ?? join(root, 'portable', 'user-data')
  if (basename(dataDir) !== 'user-data') throw new Error('A test profile must be named user-data')
  const portable = dirname(dataDir)
  const extensions = extensionsDir ?? join(root, 'extensions')
  mkdirSync(join(dataDir, 'User'), { recursive: true })
  mkdirSync(extensions, { recursive: true })
  const settingsPath = join(dataDir, 'User', 'settings.json')
  if (!existsSync(settingsPath) || Object.keys(settings).length > 0) {
    writeFileSync(settingsPath, JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }, null, 2))
  }
  const argv = [
    `--user-data-dir=${dataDir}`,
    `--extensions-dir=${extensions}`,
    '--remote-debugging-port=0',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window',
    ...(developmentPath === undefined ? [] : [`--extensionDevelopmentPath=${developmentPath}`]),
    ...args,
    ...(folder === undefined ? [] : [folder]),
  ]
  const previousPort = join(dataDir, 'DevToolsActivePort')
  if (existsSync(previousPort)) unlinkSync(previousPort)
  const child = spawn(CODE_BINARY, argv, {
    env: { ...childEnvironment(env), VSCODE_PORTABLE: portable },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const collect = (chunk) => {
    output += chunk.toString()
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const endpoint = await readDevToolsEndpoint(dataDir, child, () => output).catch((error) => {
    child.kill('SIGTERM')
    throw error
  })
  const socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  }).catch((error) => {
    socket.close()
    child.kill('SIGTERM')
    throw error
  })
  const cdp = new Cdp(socket)
  const driver = new VSCodeDriver({ child, cdp, userDataDir: dataDir, output: () => output })
  await cdp.send('Target.setDiscoverTargets', { discover: true })
  return { driver, root, userDataDir: dataDir, extensionsDir: extensions }
}
import { clearTimeout } from 'node:timers'
