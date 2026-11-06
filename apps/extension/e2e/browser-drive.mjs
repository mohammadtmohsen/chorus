import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { integrationHarness, OUTPUT } from './integration-harness.mjs'

const VISIBLE_ADDRESS =
  "Array.from(document.querySelectorAll('.browser-address-input')).find((input)=>input.checkVisibility())"
const h = await integrationHarness('browser')
const markerA = `ALPHA_PAGE_${randomUUID().slice(0, 8)}`
const markerB = `BETA_PAGE_${randomUUID().slice(0, 8)}`
const server = createServer((request, response) => {
  const beta = request.url?.startsWith('/beta') === true
  const title = beta ? 'Beta page' : request.url === '/second' ? 'Second page' : 'Alpha page'
  const marker = beta ? markerB : markerA
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end(
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><a href="/second">Second</a><script>console.log(${JSON.stringify(marker)});console.log('PAGE_OBJECT',{marker:${JSON.stringify(marker)}});window.fixtureMarker=${JSON.stringify(marker)};</script></body></html>`
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
try {
  await h.start()
  const a = await h.add(h.alpha)
  const b = await h.add(h.beta)
  const readConsole = async (projectId) => {
    const value = await h.api('subscribeConsole', { projectId })
    await h.api('unsubscribeConsole', { subscriptionId: value.subscriptionId })
    return value
  }
  const navigate = async (session, path) => {
    await h.select(session)
    await h.driver.waitInWebview(`${VISIBLE_ADDRESS}?.disabled===false`)
    await (
      await h.view()
    ).evaluate(
      `(() => {const input=${VISIBLE_ADDRESS};input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(origin + path)});input.dispatchEvent(new Event('input',{bubbles:true}));input.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})()`
    )
    await h.driver.poll('native browser page', async () =>
      (await h.native({ action: 'state' })).tabs.find(
        (tab) =>
          tab.label ===
          (path === '/beta' ? 'Beta page' : path === '/second' ? 'Second page' : 'Alpha page')
      )
    )
  }
  await navigate(a, '/alpha')
  await h.driver.waitInWebview(
    `document.querySelector('.console-panel')?.textContent.includes(${JSON.stringify(markerA)})===true`
  )
  const alphaBrowser = await h.api('attachBrowser', { projectId: a.projectId })
  assert.equal(alphaBrowser.state.live, true)
  h.check('project Browser opens a native VS Code tab and streams page logs into its Console')
  await h.driver.screenshot(join(OUTPUT, 'browser-01-console.png'))
  await h.setText('.console-input', 'console.log("CONSOLE_INPUT_OK"); 6*7')
  await (
    await h.view()
  ).evaluate(
    `document.querySelector('.console-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}))`
  )
  await h.driver.waitInWebview(
    `document.querySelector('.console-panel')?.textContent.includes('CONSOLE_INPUT_OK')===true && document.querySelector('.console-panel')?.textContent.includes('42')===true`
  )
  h.check('Console input executes JavaScript in the native page')
  const snapshot = await readConsole(a.projectId)
  const handle = snapshot.snapshot.entries
    .flatMap((entry) => entry.values)
    .find((value) => value.handle !== null)?.handle
  assert.ok(handle)
  await h.click('[aria-label="Add this page to favorites"]')
  await h.driver.waitInWebview('document.querySelector(".browser-favorite-open")!==null')
  await navigate(a, '/second')
  await h.driver.waitInWebview('document.querySelector("[aria-label=Back]")?.disabled===false')
  await h.click('[aria-label="Back"]')
  await h.driver.poll(
    'browser back',
    async () =>
      (await h.api('attachBrowser', { projectId: a.projectId })).state.url === `${origin}/alpha`
  )
  await h.click('[aria-label="Forward"]')
  await h.driver.poll(
    'browser forward',
    async () =>
      (await h.api('attachBrowser', { projectId: a.projectId })).state.url === `${origin}/second`
  )
  const invalidated = await h.api('expandConsole', { projectId: a.projectId, handle })
  assert.notEqual(invalidated.status, 'ok')
  await h.click('.browser-favorite-open')
  await h.driver.poll(
    'favorite navigation',
    async () =>
      (await h.api('attachBrowser', { projectId: a.projectId })).state.url === `${origin}/alpha`
  )
  h.check(
    'back, forward and favorites navigate the native page; navigation invalidates old object handles',
    invalidated
  )
  await navigate(b, '/beta')
  await h.driver.poll('beta page logs in its own Console', async () =>
    JSON.stringify(await readConsole(b.projectId)).includes(markerB)
  )
  await h.driver.waitInWebview(
    `Array.from(document.querySelectorAll('.console-panel')).some((panel)=>panel.checkVisibility() && panel.textContent.includes(${JSON.stringify(markerB)}))`
  )
  const betaSnapshot = await readConsole(b.projectId)
  assert.equal(JSON.stringify(betaSnapshot).includes(markerA), false)
  const alphaSnapshot = await readConsole(a.projectId)
  assert.equal(JSON.stringify(alphaSnapshot).includes(markerB), false)
  h.check('browser logs remain isolated by their fixed project ownership')
  const waitBrowserReply = async (session, after, includes) =>
    h.driver.poll(
      `browser agent ${includes}`,
      async () => {
        const reply = (await h.events(session)).find(
          (event) =>
            event.seq > after &&
            event.payload.type === 'agent.message.completed' &&
            event.payload.text.includes(includes)
        )
        if (reply !== undefined) return reply
        const pending =
          (await h.api('readActiveSessions')).sessions.find(
            (entry) => entry.conversationId === session.conversationId
          )?.pendingApprovalIds ?? []
        if (pending.length > 0) {
          await h.select(session)
          const text = await (
            await h.view()
          ).evaluate(
            `document.querySelector('[data-conversation="${session.conversationId}"] .approval')?.textContent ?? ''`
          )
          if (!/browser|console|javascript/i.test(text))
            throw new Error(`Unexpected approval: ${text}`)
          await h.click(
            `[data-conversation="${session.conversationId}"] .approval-actions .btn--go`
          )
        }
        return null
      },
      180_000
    )
  await h.select(a)
  const read = await h.send(
    a,
    '@claude Use only mcp__chorus_browser__read_console to read your project page logs. Reply BROWSER_READ_OK with every PAGE marker you saw. No other tools.'
  )
  const readReply = await waitBrowserReply(a, read, 'BROWSER_READ_OK')
  assert.ok(readReply.payload.text.includes(markerA))
  assert.equal(readReply.payload.text.includes(markerB), false)
  h.check('a real agent reads only its own project Console', readReply.payload.text)
  const refused = await h.send(
    a,
    '@claude Use only mcp__chorus_browser__run_javascript with expression "window.fixtureMarker" once. This project is deliberately Read only, so report the tool refusal after READ_ONLY_RESULT. Do not change permissions or use another tool.'
  )
  const refusedReply = await waitBrowserReply(a, refused, 'READ_ONLY_RESULT')
  assert.match(refusedReply.payload.text, /read.?only|refus|not allowed/i)
  h.check('real agent JavaScript is refused by the Read only profile', refusedReply.payload.text)
  await h.api('setProjectProfile', { projectId: a.projectId, profileId: 'trusted' })
  const run = await h.send(
    a,
    '@claude Use only mcp__chorus_browser__run_javascript once with expression "window.fixtureMarker". Wait for any approval. Reply BROWSER_RUN_OK with its returned value. No other tools.'
  )
  const runReply = await waitBrowserReply(a, run, 'BROWSER_RUN_OK')
  assert.ok(runReply.payload.text.includes(markerA))
  h.check('real agent JavaScript follows the project permission rules', runReply.payload.text)
  await h.driver.command('Developer: Reload Window', { navigates: true })
  await h.driver.waitInWebview(
    'window.chorus!==undefined && document.querySelector(".quick-rail")!==null',
    { timeoutMs: 60_000 }
  )
  await h.select(a)
  const recovered = await h.api('attachBrowser', { projectId: a.projectId })
  assert.ok(recovered.state.live || recovered.state.error !== null)
  if (recovered.state.live) {
    await h.api('evaluateConsole', {
      projectId: a.projectId,
      browserId: recovered.browserId,
      expression: 'console.log("RECOVERED_SESSION_OK")',
    })
    await h.driver.waitInWebview(
      'document.querySelector(".console-panel")?.textContent.includes("RECOVERED_SESSION_OK")===true'
    )
  } else
    await h.driver.waitInWebview(
      'document.querySelector(".browser-placeholder")?.textContent.trim().length>0'
    )
  h.check(
    'Reload Window restores browser ownership and CDP or explains a failed recovery',
    recovered.state
  )
  await h.native({ action: 'closeTab', label: 'Alpha page' })
  await h.driver.poll(
    'closed browser state',
    async () => !(await h.api('attachBrowser', { projectId: a.projectId })).state.live
  )
  h.check('closing the native browser tab updates the project Browser box')
  await h.driver.screenshot(join(OUTPUT, 'browser-02-complete.png'))
} catch (error) {
  console.error(error)
  if (h.driver !== undefined)
    await h.driver.screenshot(join(OUTPUT, 'browser-failure.png')).catch(() => undefined)
  process.exitCode = 1
} finally {
  h.save()
  await h.close()
  await new Promise((resolve) => server.close(resolve))
}
if (process.exitCode !== 1) {
  const plain = await integrationHarness('browser-no-flag', { proposal: false })
  try {
    await plain.start()
    const project = await plain.add(plain.alpha)
    await plain.select(project)
    await plain.driver.waitInWebview(
      'document.querySelector(".browser-placeholder")?.textContent.includes("Enable Browser Tools")===true'
    )
    assert.equal(
      await (
        await plain.view()
      ).evaluate(
        'Array.from(document.querySelectorAll(".browser-placeholder button")).some(button=>button.textContent==="Enable Browser Tools")'
      ),
      true
    )
    assert.ok(
      await (await plain.view()).evaluate('document.querySelector(".composer textarea")!==null')
    )
    plain.check('without the proposal, Browser Tools explains setup and chats still work')
    const commands = await plain.native({ action: 'commands' })
    assert.ok(commands.includes('chorus.enableBrowserTools'))
    await plain.driver.screenshot(join(OUTPUT, 'browser-03-no-flag.png'))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    plain.save()
    await plain.close()
  }
}
