import { execFileSync } from 'node:child_process'
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
import { createServer } from 'node:http'
import { clearTimeout } from 'node:timers'

const output = '/tmp/chorus-batch2'
mkdirSync(output, { recursive: true })
const root = realpathSync(mkdtempSync(join(output, 'shell-')))
const workspace = join(root, 'workspace')
const alpha = join(workspace, 'alpha')
const beta = join(workspace, 'beta')
const userDataDir = join(root, 'portable', 'user-data')
const extensionsDir = join(root, 'extensions')
for (const directory of [workspace, alpha, beta, extensionsDir, userDataDir])
  mkdirSync(directory, { recursive: true })
writeFileSync(join(alpha, 'alpha.txt'), 'Alpha project\n')
writeFileSync(join(beta, 'beta.txt'), 'Beta project\n')
const vsix = resolve(import.meta.dirname, '../dist/chorus-0.20.0-darwin-arm64.vsix')
const env = { ...process.env }
for (const key of Object.keys(env))
  if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) Reflect.deleteProperty(env, key)
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
const checks = []
const check = (label, detail) => {
  checks.push({ label, detail })
  console.log(`PASS ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
}
let driver
let upstream
const engineDirectory = join(userDataDir, 'User/globalStorage/mohammadtmohsen.chorus/engine')
const writeEvidence = () => {
  writeFileSync(
    join(output, 'shell-results.json'),
    JSON.stringify({ root, workspace, vsix, checks }, null, 2)
  )
  if (driver !== undefined)
    writeFileSync(
      join(output, 'shell-console.json'),
      JSON.stringify(driver.consoleEntries, null, 2)
    )
}
try {
  ;({ driver } = await launchVSCode({
    folder: workspace,
    userDataDir,
    extensionsDir,
    enableProposedApi: 'mohammadtmohsen.chorus',
  }))
  await driver.workbench()
  await driver.command('Chorus: Open')
  await driver.waitInWebview(
    'window.chorus !== undefined && document.querySelector(".empty .primary") !== null',
    { timeoutMs: 60_000 }
  )
  let frame = await driver.webview()
  const initial = await frame.evaluate('window.chorus.listProjects({})')
  if (initial.projects.length !== 0) throw new Error('Opening a window silently adopted a project')
  check('first-run screen with no automatic project')
  await driver.screenshot(join(output, '01-first-run.png'))
  const add = async (path) => {
    frame = await driver.webview()
    await frame.evaluate(
      `(document.querySelector('[aria-label="Add project"]') ?? document.querySelector('.empty .primary')).click()`
    )
    await driver.answerSimpleDialog(path)
    await driver.poll(
      'the selected project',
      async () => {
        const current = await driver.webview()
        const state = await current.evaluate('window.chorus.readActiveSessions()')
        return state.sessions.find((entry) => entry.cwd === path && !entry.starting)
      },
      90_000
    )
  }
  await add(alpha)
  check('add Alpha through the rail')
  await add(beta)
  check('add Beta through the rail')
  frame = await driver.webview()
  const sessions = (await frame.evaluate('window.chorus.readActiveSessions()')).sessions
  if (sessions.length !== 2 || new Set(sessions.map((entry) => entry.projectId)).size !== 2)
    throw new Error(`Wrong project ownership: ${JSON.stringify(sessions)}`)
  check(
    'two projects keep separate conversations',
    sessions.map((entry) => ({ cwd: entry.cwd, projectId: entry.projectId }))
  )
  await driver.screenshot(join(output, '02-projects.png'))
  const replies = []
  for (const [path, agent] of [
    [alpha, 'claude'],
    [beta, 'codex'],
  ]) {
    const current = sessions.find((entry) => entry.cwd === path)
    if (current === undefined) throw new Error(`Missing session for ${path}`)
    frame = await driver.webview()
    await frame.evaluate(
      `window.chorus.sendMessage(${JSON.stringify({ conversationId: current.conversationId, text: `@${agent} This is an authorized read-only extension smoke test. Run pwd once, then reply with exactly WORKDIR followed by its output. Do not ask questions or change files.` })})`
    )
    const reply = await driver.poll(
      `${agent} reporting its project directory`,
      async () => {
        const view = await driver.webview()
        const events = await view.evaluate(
          `window.chorus.history(${JSON.stringify({ conversationId: current.conversationId })})`
        )
        const completed = events.filter(
          (event) => event.actor === agent && event.payload.type === 'agent.message.completed'
        )
        return completed.find((event) => event.payload.text.includes(path))
      },
      180_000
    )
    replies.push({
      conversationId: current.conversationId,
      agent,
      id: reply.id,
      text: reply.payload.text,
    })
    check(`real ${agent} reports its own working directory`, reply.payload.text)
  }
  writeFileSync(join(output, 'real-agent-replies.json'), JSON.stringify(replies, null, 2))
  const a = sessions.find((entry) => entry.cwd === alpha)
  const b = sessions.find((entry) => entry.cwd === beta)
  const view = () => driver.webview()
  const api = async (method, request) =>
    (await view()).evaluate(
      `window.chorus.${method}(${request === undefined ? '' : JSON.stringify(request)})`
    )
  const history = (conversationId) => api('history', { conversationId })
  const selectProject = async (name, conversationId) => {
    const projectId = sessions.find((entry) => entry.conversationId === conversationId)?.projectId
    if (projectId === undefined) throw new Error(`Missing project ${name}`)
    await (
      await view()
    ).evaluate(`document.querySelector('[data-rail-project="${projectId}"]').click()`)
    await driver.waitInWebview(
      `document.querySelector('[data-conversation="${conversationId}"]') !== null`
    )
  }
  const setText = async (selector, value) =>
    (await view()).evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const send = async (conversationId, text) => {
    const through = (await history(conversationId)).at(-1)?.seq ?? 0
    await api('sendMessage', { conversationId, text, mode: 'work' })
    return through
  }
  const waitTurn = (conversationId, afterSeq) =>
    driver.poll(
      'the real agent turn to finish',
      async () =>
        (await history(conversationId)).find(
          (event) => event.seq > afterSeq && event.payload.type === 'turn.completed'
        ),
      180_000
    )
  const click = async (selector) =>
    (await view()).evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const dismissToasts = async () =>
    (await view()).evaluate(
      'document.querySelectorAll(".toast-close").forEach(button => button.click())'
    )
  const enginePid = () => JSON.parse(readFileSync(join(engineDirectory, 'engine.json'), 'utf8')).pid
  const originalPid = enginePid()
  const reload = async () => {
    await driver.command('Developer: Reload Window', { navigates: true })
    await driver.waitInWebview(
      'window.chorus !== undefined && document.querySelector(".quick-rail") !== null',
      { timeoutMs: 60_000 }
    )
    if (enginePid() !== originalPid) throw new Error('Reload Window restarted the engine')
    const originalReply = replies.find((reply) => reply.conversationId === a.conversationId)
    await driver.waitInWebview(
      `document.querySelector('[data-event-id="${originalReply.id}"]')?.textContent.includes(${JSON.stringify(alpha)}) === true`
    )
  }

  await selectProject('alpha', a.conversationId)
  const noteSelector = `[data-conversation="${a.conversationId}"] .conversation-note-body`
  await click(`[data-conversation="${a.conversationId}"] .composer-note`)
  await driver.waitInWebview(
    `document.querySelector(${JSON.stringify(noteSelector)})?.readOnly === false`
  )
  await setText(noteSelector, 'Batch 2 durable conversation note')
  await driver.poll(
    'the note to reach the engine',
    async () =>
      (await api('getConversationNote', { conversationId: a.conversationId })).body ===
      'Batch 2 durable conversation note'
  )
  check('conversation note is saved through the acknowledged mirror')
  await click(`[data-conversation="${a.conversationId}"] .conversation-note-hide`)

  await (
    await view()
  ).evaluate(`(() => {
    const entry = document.querySelector('[data-conversation="${a.conversationId}"] .entry[data-actor=claude][data-kind=message]')
    const paragraph = entry.querySelector('p')
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })()`)
  await driver.waitInWebview('document.querySelector(".quote-offer[data-askable=true]") !== null')
  await (
    await view()
  ).evaluate(
    `(() => { [...document.querySelectorAll('.quote-offer-action')].find(button => button.textContent === 'Ask about this').click() })()`
  )
  await driver.waitInWebview('document.querySelector(".quick-input") !== null')
  await setText(
    '.quick-input',
    'Reply with exactly ASIDE_OK. This is a smoke test; do not use any tools or change files.'
  )
  await (await view()).evaluate('document.querySelector(".quick-form").requestSubmit()')
  await driver.waitInWebview(
    'document.querySelector(".quick-answer")?.textContent.includes("ASIDE_OK")',
    { timeoutMs: 180_000 }
  )
  check('a real aside answers inside the popover')
  await click('.quick-close')

  await click(`[data-conversation="${a.conversationId}"] [data-entry-action="forward"]`)
  const forwarded = await driver.poll(
    'a forwarded chat in Alpha',
    async () => {
      const state = await api('readActiveSessions')
      return state.sessions.find(
        (entry) =>
          entry.projectId === a.projectId &&
          entry.conversationId !== a.conversationId &&
          !entry.starting
      )
    },
    90_000
  )
  await driver.waitInWebview(
    `document.querySelectorAll('.conversation-column[data-project="${a.projectId}"]').length === 2`
  )
  const creation = (await history(forwarded.conversationId)).find(
    (event) => event.payload.type === 'conversation.created'
  )
  if (creation?.payload.continuedFrom !== a.conversationId)
    throw new Error(`Forward lost its source: ${JSON.stringify(creation)}`)
  check('forwarded chat appears beside its source in the same project')
  await driver.screenshot(join(output, '03-forwarded.png'))

  const row = `.conversation-column[data-project="${a.projectId}"]`
  const scrollBefore = await (
    await view()
  ).evaluate(`(() => {
    const row = document.querySelector(${JSON.stringify(row)}).closest('.conversation-scroller')
    if (row.scrollWidth <= row.clientWidth) throw new Error('Conversation row does not overflow')
    row.scrollLeft = Math.min(220, row.scrollWidth - row.clientWidth)
    row.dispatchEvent(new Event('scroll'))
    return row.scrollLeft
  })()`)
  await selectProject('beta', b.conversationId)
  await selectProject('alpha', a.conversationId)
  await driver.waitInWebview(
    `Math.abs(document.querySelector(${JSON.stringify(row)}).closest('.conversation-scroller').scrollLeft - ${scrollBefore}) < 3`
  )
  check('sideways scrolling survives a project switch', scrollBefore)
  await dismissToasts()
  await click(`[data-tab-id="${forwarded.conversationId}"] .conversation-dock-tab-main`)
  await (
    await view()
  ).evaluate(
    `document.querySelector(${JSON.stringify(row)}).closest('.conversation-scroller').scrollLeft = 0`
  )
  frame = await view()
  const dragPoints = await frame.evaluate(`(() => {
    const source = document.querySelector('[data-tab-id="${forwarded.conversationId}"] .conversation-dock-tab-main').getBoundingClientRect()
    const target = document.querySelector('[data-conversation="${a.conversationId}"]').closest('.conversation-column').getBoundingClientRect()
    return { from: { x: source.x + 40, y: source.y + 12 }, to: { x: target.x + target.width / 2, y: target.y + 10 } }
  })()`)
  await frame.drag(dragPoints.from, dragPoints.to)
  await driver.waitInWebview(
    'document.querySelector(".conversation-branch[data-orientation=column]") !== null'
  )
  check('dragging a chat creates a vertical split')
  frame = await view()
  const sash = await frame.evaluate(
    `(() => { const sash = document.querySelector('.conversation-branch[data-orientation=column] .conversation-sash').getBoundingClientRect(); return { x: sash.x + sash.width / 2, y: sash.y + sash.height / 2 } })()`
  )
  const heightBefore = await frame.evaluate(
    `document.querySelector('[data-conversation="${a.conversationId}"]').getBoundingClientRect().height`
  )
  await frame.drag(sash, { x: sash.x, y: sash.y + 40 })
  const heightAfter = await frame.evaluate(
    `document.querySelector('[data-conversation="${a.conversationId}"]').getBoundingClientRect().height`
  )
  if (Math.abs(heightAfter - heightBefore) < 15)
    throw new Error('The conversation sash did not resize')
  check('the split sash resizes the actual chat boxes', { heightBefore, heightAfter })
  await driver.screenshot(join(output, '04-split.png'))

  await selectProject('beta', b.conversationId)
  await dismissToasts()
  const workbench = await driver.workbench()
  const nativeGroups = await workbench.evaluate(
    'document.querySelectorAll(".part.editor .editor-group-container").length'
  )
  await (await view()).evaluate('document.querySelector(".composer textarea").focus()')
  await driver.press('\\', 4)
  await driver.waitInWebview('document.querySelectorAll("[data-workspace-pane]").length === 2')
  if (
    (await workbench.evaluate(
      'document.querySelectorAll(".part.editor .editor-group-container").length'
    )) !== nativeGroups
  )
    throw new Error('VS Code also handled the Chorus split shortcut')
  check('Cmd+Backslash splits Chorus without splitting the VS Code editor')
  frame = await view()
  const cross = await frame.evaluate(`(() => {
    const source = document.querySelector('[data-tab-id="${forwarded.conversationId}"] .conversation-dock-tab-main').getBoundingClientRect()
    const target = document.querySelector('.conversation-column[data-project="${b.projectId}"]').getBoundingClientRect()
    return { from: { x: source.x + 25, y: source.y + 10 }, to: { x: target.x + target.width / 2, y: target.y + target.height / 2 } }
  })()`)
  await frame.drag(cross.from, cross.to)
  await driver.waitInWebview(
    `document.querySelectorAll('.conversation-column[data-project="${a.projectId}"]').length === 2 && document.querySelectorAll('.conversation-column[data-project="${b.projectId}"]').length === 1`
  )
  check('dropping a chat on another project is refused without losing it')

  await selectProject('alpha', a.conversationId)
  const beforeApproval = await send(
    a.conversationId,
    '@claude This is an authorized permission-card smoke test. Use the Write tool to create approval-smoke.txt containing exactly APPROVAL_OK. This project is Read only, so wait for its approval card. Do not use Bash, Edit, or another tool instead. After approval and writing the file, reply APPROVAL_WRITTEN.'
  )
  await driver.waitInWebview(
    `document.querySelector('[data-conversation="${a.conversationId}"] .approval') !== null`,
    { timeoutMs: 180_000 }
  )
  const pendingApproval = (await api('readActiveSessions')).sessions.find(
    (entry) => entry.conversationId === a.conversationId
  ).pendingApprovalIds[0]
  await reload()
  await driver.waitInWebview(
    `document.querySelector('[data-conversation="${a.conversationId}"] .approval') !== null`
  )
  const afterReload = (await api('readActiveSessions')).sessions.find(
    (entry) => entry.conversationId === a.conversationId
  )
  if (afterReload.pendingApprovalIds[0] !== pendingApproval)
    throw new Error('Reload replaced the pending approval')
  if (
    (await (
      await view()
    ).evaluate(
      `document.querySelectorAll('[data-conversation="${a.conversationId}"] .approval').length`
    )) !== 1
  )
    throw new Error('Reload duplicated the approval card')
  await click(`[data-conversation="${a.conversationId}"] .approval-actions .btn--go`)
  await waitTurn(a.conversationId, beforeApproval)
  if (readFileSync(join(alpha, 'approval-smoke.txt'), 'utf8').trim() !== 'APPROVAL_OK')
    throw new Error('The approved write did not complete')
  check('the same approval card survives Reload Window and answers the real agent')
  if (
    (await api('getConversationNote', { conversationId: a.conversationId })).body !==
    'Batch 2 durable conversation note'
  )
    throw new Error('Reload lost the conversation note')
  check('the conversation note survives Reload Window')
  await driver.screenshot(join(output, '05-reloaded-approval.png'))

  const beforeQuestion = await send(
    a.conversationId,
    '@claude Use AskUserQuestion now to ask one question headed Smoke with options Alpha and Beta. Wait for my answer, then reply with QUESTION_OK. This tests the question card; do not ask using ordinary prose.'
  )
  await driver.waitInWebview(
    `document.querySelector('[data-conversation="${a.conversationId}"] .question') !== null`,
    { timeoutMs: 180_000 }
  )
  await click(`[data-conversation="${a.conversationId}"] .question-option`)
  await click(`[data-conversation="${a.conversationId}"] .question-actions .btn--go`)
  await waitTurn(a.conversationId, beforeQuestion)
  check('a real question card sends the selected answer')

  const slowRequests = new Set()
  upstream = createServer((request, response) => {
    const path = request.url ?? '/'
    const respond = () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"smoke":"TRAFFIC_OK"}')
    }
    if (path.startsWith('/lifecycle-')) {
      slowRequests.add(path)
      const timer = setTimeout(respond, 45_000)
      response.once('close', () => {
        clearTimeout(timer)
        slowRequests.delete(path)
      })
    } else respond()
  })
  await new Promise((resolve) => {
    upstream.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${upstream.address().port}`
  await api('setProjectProfile', { projectId: a.projectId, profileId: 'trusted' })
  const beforeStop = await send(
    a.conversationId,
    `@claude Authorized lifecycle test: use Bash now to run curl --max-time 90 -fsS ${origin}/lifecycle-reload in the foreground with a 90000ms tool timeout. This local fixture holds the HTTP response while the window reloads. Wait for it before replying. Do not use sleep, monitors, loops or background mode.`
  )
  await driver.poll(
    'the real foreground HTTP request to reach the fixture',
    async () => slowRequests.has('/lifecycle-reload'),
    180_000
  )
  await reload()
  await driver.waitInWebview(
    `document.querySelector('[data-conversation="${a.conversationId}"] .send--stop') !== null`
  )
  if (!slowRequests.has('/lifecycle-reload'))
    throw new Error('Reload interrupted the real HTTP command')
  await click(`[data-conversation="${a.conversationId}"] .send--stop`)
  await waitTurn(a.conversationId, beforeStop)
  await driver.poll(
    'Stop cancels the real HTTP command',
    async () => !slowRequests.has('/lifecycle-reload'),
    15_000
  )
  check('Reload Window preserves a running turn and Stop interrupts it')

  const beforeClose = await send(
    a.conversationId,
    `@claude Authorized lifecycle test: use Bash now to run curl --max-time 90 -fsS ${origin}/lifecycle-reopen in the foreground with a 90000ms tool timeout. This local fixture holds the HTTP response while the window closes and reopens. Wait for it before replying. Do not use sleep, monitors, loops or background mode.`
  )
  await driver.poll(
    'the second real HTTP request to reach the fixture',
    async () => slowRequests.has('/lifecycle-reopen'),
    180_000
  )
  await driver.quit()
  driver = undefined
  if (enginePid() !== originalPid) throw new Error('Closing VS Code stopped the engine')
  ;({ driver } = await launchVSCode({
    folder: workspace,
    userDataDir,
    extensionsDir,
    enableProposedApi: 'mohammadtmohsen.chorus',
  }))
  await driver.workbench()
  await driver.command('Chorus: Open')
  await driver.waitInWebview(
    `window.chorus !== undefined && document.querySelector('[data-conversation="${a.conversationId}"] .send--stop') !== null`,
    { timeoutMs: 60_000 }
  )
  if (enginePid() !== originalPid) throw new Error('Reopening VS Code replaced the live engine')
  if (!slowRequests.has('/lifecycle-reopen'))
    throw new Error('Closing the window interrupted the real HTTP command')
  await click(`[data-conversation="${a.conversationId}"] .send--stop`)
  await waitTurn(a.conversationId, beforeClose)
  await driver.poll(
    'Stop cancels the surviving HTTP command',
    async () => !slowRequests.has('/lifecycle-reopen'),
    15_000
  )
  check('closing and reopening the window leaves the same real turn running')

  await api('configureTraffic', {
    projectId: a.projectId,
    config: { origin, port: null, envVar: 'CHORUS_SMOKE_TRAFFIC', access: 'loopback' },
  })
  await api('configureRun', {
    projectId: a.projectId,
    commands: {
      version: 1,
      defaultId: 'smoke',
      commands: [{ id: 'smoke', label: 'Smoke', command: 'printf RUN_OK; sleep 60' }],
    },
  })
  const run = await api('startRun', { projectId: a.projectId })
  writeFileSync(join(output, 'run-result.json'), JSON.stringify(run, null, 2))
  await driver.waitInWebview('document.querySelector(".project-terminal-box") !== null')
  await (
    await view()
  ).evaluate(
    `(() => { const box = document.querySelector('.project-terminal-box'); if (box.dataset.collapsed === 'true') box.querySelector('.conversation-dock-toggle').click() })()`
  )
  await (
    await view()
  ).evaluate(
    'window.__terminalEvents = []; window.chorus.onTerminalOutput(push => window.__terminalEvents.push(push))'
  )
  const shellCount = await (
    await view()
  ).evaluate(
    'document.querySelector(".project-terminal-box").querySelectorAll("[data-shell-id]").length'
  )
  await click('.project-terminal-box .conversation-dock-add')
  await driver.waitInWebview(
    `document.querySelector('.project-terminal-box').querySelectorAll('[data-shell-id]').length === ${shellCount + 1}`
  )
  const shellId = await (
    await view()
  ).evaluate(
    `Array.from(document.querySelector('.project-terminal-box').querySelectorAll('[data-shell-id]')).at(-1).dataset.shellId`
  )
  const shell = `[data-shell-id="${shellId}"]`
  await driver.waitInWebview(`document.querySelector('${shell} .xterm-helper-textarea') !== null`)
  await (await view()).evaluate(`document.querySelector('${shell} .xterm-helper-textarea').focus()`)
  await driver.insertText('pwd')
  await driver.press('Enter')
  await driver.waitInWebview(
    `window.__terminalEvents.some(push => push.kind === 'data' && push.data.includes(${JSON.stringify(alpha)}))`
  )
  check('the packaged node-pty shell starts in the project root')
  await driver.insertText('printf "SHELL_ENV=%s\\n" "$CHORUS_SMOKE_TRAFFIC"')
  await driver.press('Enter')
  await driver.waitInWebview(
    'window.__terminalEvents.some(push => push.kind === "data" && push.data.includes("SHELL_ENV=http://127.0.0.1:"))'
  )
  check('the project shell receives its Traffic variable')
  await driver.insertText('vim -Nu NONE -n alpha.txt')
  await driver.press('Enter')
  await driver.waitInWebview(
    `document.querySelector('${shell} .xterm-rows')?.textContent.includes('Alpha project')`
  )
  check('vim runs in the packaged terminal')
  await driver.press('Escape')
  await driver.insertText(':q!')
  await driver.press('Enter')
  await api('stopRun', { projectId: a.projectId })
  await api('startTraffic', { projectId: a.projectId })
  const capture = await api('attachTraffic', { projectId: a.projectId })
  const response = await fetch(`http://127.0.0.1:${capture.state.port}/smoke-batch2`)
  if (!response.ok || !(await response.text()).includes('TRAFFIC_OK'))
    throw new Error('Traffic did not forward the real request')
  const traffic = await driver.poll('the captured HTTP request', async () => {
    const state = await api('attachTraffic', { projectId: a.projectId })
    return state.rows.find((entry) => entry.source === 'http' && entry.u.includes('/smoke-batch2'))
  })
  check('Traffic captures a real forwarded HTTP request', traffic)
  const trafficTurn = await send(
    a.conversationId,
    '@claude Use chorus_project read_traffic and read_terminal. Reply with TRAFFIC_READ_OK and the captured path containing smoke-batch2, and TERMINAL_READ_OK with the RUN_OK output from the project dev command. Do not change files.'
  )
  await waitTurn(a.conversationId, trafficTurn)
  const trafficHistory = (await history(a.conversationId)).filter(
    (event) => event.seq > trafficTurn
  )
  for (const tool of ['read_traffic', 'read_terminal'])
    if (
      !trafficHistory.some(
        (event) => event.payload.type === 'tool.started' && event.payload.name.includes(tool)
      )
    )
      throw new Error(`The agent did not call ${tool}`)
  const trafficReply = trafficHistory.find(
    (event) =>
      event.seq > trafficTurn &&
      event.payload.type === 'agent.message.completed' &&
      event.payload.text.includes('smoke-batch2')
  )
  if (trafficReply === undefined) throw new Error('The agent did not read captured Traffic')
  check('the real agent reads its project Traffic')
  if (
    !trafficReply.payload.text.includes('TERMINAL_READ_OK') ||
    !trafficReply.payload.text.includes('RUN_OK')
  )
    throw new Error('The agent did not read the project dev command output')
  check('the real agent reads its project dev command output')
  await api('stopRun', { projectId: a.projectId })
  await api('stopTraffic', { projectId: a.projectId })
  await driver.screenshot(join(output, '06-terminal-traffic.png'))
  writeEvidence()
} catch (error) {
  console.error(error)
  if (driver !== undefined) {
    try {
      await driver.screenshot(join(output, 'failure.png'))
    } catch {
      process.stderr.write('Could not capture failure screenshot\n')
    }
    try {
      const frame = await driver.webview({ timeoutMs: 2000 })
      writeFileSync(
        join(output, 'failure-dom.txt'),
        await frame.evaluate('document.body.innerText')
      )
    } catch {
      process.stderr.write('Could not read failure DOM\n')
    }
  }
  writeEvidence()
  process.exitCode = 1
} finally {
  if (upstream !== undefined) {
    upstream.closeAllConnections()
    await new Promise((resolve) => {
      upstream.close(resolve)
    })
  }
  if (driver !== undefined) await driver.quit()
  const descriptor = join(engineDirectory, 'engine.json')
  if (existsSync(descriptor)) {
    const { pid } = JSON.parse(readFileSync(descriptor, 'utf8'))
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      process.stderr.write('Test engine already stopped\n')
    }
  }
  console.log(`Evidence: ${output}; test profile: ${root}`)
}
