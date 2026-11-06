import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
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
export async function integrationHarness(
  name,
  { proposal = true, folder, args = [], settings = {}, preinstall = [], runtimeArguments } = {}
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
  for (const path of [workspace, alpha, beta, nested, control, extensionsDir])
    mkdirSync(path, { recursive: true })
  const vsix = resolve(import.meta.dirname, '../dist/chorus-0.20.0-darwin-arm64.vsix')
  const env = { ...process.env, CHORUS_E2E_CONTROL: control }
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
    ;({ driver } = await launchVSCode({
      folder: folder === undefined ? workspace : (folder ?? undefined),
      args,
      settings,
      developmentPath: join(import.meta.dirname, 'fixture'),
      userDataDir,
      extensionsDir,
      ...(proposal ? { enableProposedApi: 'mohammadtmohsen.chorus' } : {}),
      ...(runtimeArguments === undefined ? {} : { runtimeArguments }),
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
    if (driver !== undefined) await driver.quit()
    const descriptor = join(
      userDataDir,
      'User/globalStorage/mohammadtmohsen.chorus/engine/engine.json'
    )
    if (existsSync(descriptor)) {
      try {
        process.kill(JSON.parse(readFileSync(descriptor, 'utf8')).pid, 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
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
