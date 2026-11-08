import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { launchVSCode } from './vscode-driver.mjs'

export const OUTPUT = '/tmp/chorus-batch3'
const NO_REQUEST_CALLS = [
  'getAppInfo',
  'probeAgents',
  'profiles',
  'refreshLimits',
  'readDiagnostics',
  'exportDiagnostics',
]

async function stopEngine(dataDirectory, executable) {
  rmSync(join(dataDirectory, 'engine-install.json'), { force: true })
  const ownsProcess = (command) => {
    const prefix = `${executable} ${join(dataDirectory, 'engine-runtime')}/`
    if (!command.startsWith(prefix)) return false
    const build = command.slice(prefix.length).split('/')[0]
    const expected =
      `${executable} ${join(dataDirectory, 'engine-runtime', build, 'engine.cjs')} ` +
      `--data ${dataDirectory} --build ${build}`
    return (
      /^[a-f0-9]{64}$/.test(build) &&
      (command === expected || command === `${expected} --probe-lock`)
    )
  }
  const signaled = new Set()
  const generations = new Map()
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
      return false
    }
  }
  const deadline = Date.now() + 30_000
  let emptySince = null
  while (Date.now() < deadline) {
    const descriptorPath = join(dataDirectory, 'engine.json')
    try {
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
      if (
        typeof descriptor.generation !== 'string' ||
        !Number.isSafeInteger(descriptor.pid) ||
        descriptor.pid < 1
      )
        throw new Error(`Invalid engine descriptor for ${dataDirectory}`)
      generations.set(descriptor.generation, descriptor.pid)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
    })
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
      .filter((match) => match !== null && ownsProcess(match[2]))
    if (processes.length === 0 && ![...generations.values(), ...signaled].some(alive)) {
      emptySince ??= Date.now()
      if (Date.now() - emptySince >= 1000) return
    } else {
      emptySince = null
      for (const match of processes) {
        const pid = Number(match[1])
        if (signaled.has(pid)) continue
        try {
          const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
            encoding: 'utf8',
          }).trim()
          if (command !== match[2]) continue
          process.kill(pid, 'SIGTERM')
          signaled.add(pid)
        } catch (error) {
          if (error.code !== 'ESRCH' && error.status !== 1) throw error
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Engine did not exit for ${dataDirectory}: ${[...generations.keys()].join(', ')}`)
}

export async function integrationHarness(
  name,
  { folder, args = [], settings = {}, preinstall = [] } = {}
) {
  mkdirSync(OUTPUT, { recursive: true })
  const root = realpathSync(mkdtempSync(join(OUTPUT, `${name}-`)))
  const workspace = join(root, 'workspace')
  const alpha = join(workspace, 'alpha')
  const beta = join(workspace, 'beta')
  const nested = join(alpha, 'sub')
  const control = join(root, 'control')
  const userDataDir = join(root, 'portable', 'user-data')
  const extensionsDir = join(root, 'extensions')
  const engineDataDirectory = join(root, 'engine-data')
  for (const path of [workspace, alpha, beta, nested, control, extensionsDir, engineDataDirectory])
    mkdirSync(path, { recursive: true })
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'))
  const vsix = resolve(
    import.meta.dirname,
    `../dist/chorus-${manifest.version}-${process.platform}-${process.arch}.vsix`
  )
  const desktopRoot = resolve(import.meta.dirname, '../../desktop')
  const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
  const executable = desktopRequire(join(desktopRoot, 'node_modules/electron'))
  const pointer = join(engineDataDirectory, 'engine-install.json')
  const temporary = `${pointer}.${randomUUID()}.tmp`
  writeFileSync(
    temporary,
    JSON.stringify({
      version: manifest.version,
      executable,
      shipped: resolve(import.meta.dirname, '../../engine/dist/runtime'),
    }),
    { mode: 0o600 }
  )
  renameSync(temporary, pointer)
  const env = {
    ...process.env,
    CHORUS_E2E_CONTROL: control,
    CHORUS_ENGINE_DATA: engineDataDirectory,
  }
  for (const key of Object.keys(env))
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_'))
      Reflect.deleteProperty(env, key)
  execFileSync(
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    [
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      '--install-extension',
      vsix,
      '--force',
    ],
    { env, encoding: 'utf8', timeout: 60_000 }
  )
  for (const extension of preinstall)
    execFileSync(
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      [
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        extensionsDir,
        '--install-extension',
        extension,
      ],
      { env, encoding: 'utf8', timeout: 180_000 }
    )
  let driver
  const checks = []
  const save = () => {
    writeFileSync(
      join(OUTPUT, `${name}-results.json`),
      JSON.stringify({ root, workspace, vsix, checks }, null, 2)
    )
    if (driver !== undefined) {
      writeFileSync(
        join(OUTPUT, `${name}-console.json`),
        JSON.stringify(driver.consoleEntries, null, 2)
      )
      writeFileSync(join(OUTPUT, `${name}-vscode.log`), driver.output())
    }
  }
  const check = (label, detail) => {
    checks.push({ label, detail })
    save()
    console.log(`PASS ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
  }
  const native = async (request) => {
    const id = randomUUID()
    writeFileSync(join(control, 'request.json'), JSON.stringify({ ...request, id }))
    const answer = await driver.poll(`native ${request.action}`, () => {
      const path = join(control, 'answer.json')
      if (!existsSync(path)) return null
      const value = JSON.parse(readFileSync(path, 'utf8'))
      return value.id === id ? value : null
    })
    if (!answer.ok) throw new Error(answer.error)
    return answer.value
  }
  const start = async ({ editorPath, before } = {}) => {
    try {
      ;({ driver } = await launchVSCode({
        folder: folder === undefined ? workspace : (folder ?? undefined),
        args,
        settings,
        developmentPath: join(import.meta.dirname, 'fixture'),
        userDataDir,
        extensionsDir,
        env,
      }))
      await driver.workbench()
      if (before !== undefined) await before()
      await native({ action: 'state' })
      if (editorPath !== undefined) await native({ action: 'open', path: editorPath })
      await driver.command('Chorus: Open')
      await driver.waitInWebview(
        'window.chorus !== undefined && document.querySelector(".empty .primary") !== null',
        { timeoutMs: 60_000 }
      )
    } catch (error) {
      await close()
      throw error
    }
  }
  const view = () => driver.webview({ extensionId: 'mohammadtmohsen.chorus', selector: '#root' })
  const api = async (method, request) =>
    (await view()).evaluate(
      `window.chorus.${method}(${request === undefined ? '' : JSON.stringify(request)})`
    )
  const healthy = async () => {
    const outcomes = await (
      await view()
    ).evaluate(
      `Promise.all(${JSON.stringify(NO_REQUEST_CALLS)}.map(async (name) => [name, await Promise.race([window.chorus[name]().then(() => 'answered', (error) => 'rejected: ' + error.message), new Promise((resolve) => setTimeout(() => resolve('no answer'), 30000))])]))`
    )
    const wrong = outcomes.filter(([, outcome]) => outcome !== 'answered')
    if (wrong.length > 0) throw new Error(`Calls not answered: ${JSON.stringify(wrong)}`)
    const notices = await (
      await view()
    ).evaluate(
      `Array.from(document.querySelectorAll('.notice--bad')).map((notice) => notice.textContent)`
    )
    if (notices.length > 0) throw new Error(`Error banner showing: ${JSON.stringify(notices)}`)
    return outcomes
  }
  const click = async (selector) =>
    (await view()).evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const setText = async (selector, text) =>
    (await view()).evaluate(
      `(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`
    )
  const add = async (path) => {
    await click('[aria-label="Add project"], .empty .primary')
    await driver.answerSimpleDialog(path)
    return await driver.poll(
      'project session',
      async () =>
        (await api('readActiveSessions')).sessions.find(
          (entry) => entry.cwd === path && !entry.starting
        ),
      90_000
    )
  }
  const select = async (session) => {
    await click(`[data-rail-project="${session.projectId}"]`)
    await driver.waitInWebview(
      `document.querySelector('[data-conversation="${session.conversationId}"] .composer textarea') !== null`
    )
  }
  const send = async (session, text, { composer = false, mode = 'work' } = {}) => {
    const through =
      (await api('history', { conversationId: session.conversationId })).at(-1)?.seq ?? 0
    if (composer) {
      await select(session)
      await setText(`[data-conversation="${session.conversationId}"] .composer textarea`, text)
      await driver.waitInWebview(
        `document.querySelector('[data-conversation="${session.conversationId}"] button.send[type="submit"]')?.disabled === false`
      )
      await click(`[data-conversation="${session.conversationId}"] button.send[type="submit"]`)
    } else await api('sendMessage', { conversationId: session.conversationId, text, mode })
    return through
  }
  const events = (session) => api('history', { conversationId: session.conversationId })
  const waitReply = async (session, after, includes) =>
    driver.poll(
      `agent reply ${includes}`,
      async () =>
        (await events(session)).find(
          (event) =>
            event.seq > after &&
            event.payload.type === 'agent.message.completed' &&
            event.payload.text.includes(includes)
        ),
      180_000
    )
  const close = async () => {
    save()
    try {
      if (driver !== undefined) await driver.quit()
    } finally {
      await stopEngine(engineDataDirectory, executable)
      rmSync(engineDataDirectory, { recursive: true, force: true })
    }
  }
  return {
    root,
    workspace,
    alpha,
    beta,
    nested,
    userDataDir,
    extensionsDir,
    engineDataDirectory,
    checks,
    check,
    native,
    start,
    view,
    api,
    healthy,
    click,
    setText,
    add,
    select,
    send,
    events,
    waitReply,
    save,
    close,
    get driver() {
      return driver
    },
  }
}
