import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { integrationHarness, OUTPUT } from './integration-harness.mjs'

const h = await integrationHarness('polish')
const workbenchText = async (selector) =>
  (await h.driver.workbench()).evaluate(
    `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((element)=>element.textContent).join('\\n')`
  )
try {
  writeFileSync(join(h.alpha, 'code.txt'), 'hello\n')
  await h.start()
  const a = await h.add(h.alpha)
  await h.api('setProjectProfile', { projectId: a.projectId, profileId: 'read-only' })

  const DRAFT = 'A draft I have not sent yet'
  await h.select(a)
  await h.setText(`[data-conversation="${a.conversationId}"] .composer textarea`, DRAFT)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  await h.driver.command('Developer: Reload Window', { navigates: true })
  await h.driver.waitInWebview(
    'window.chorus!==undefined && document.querySelector(".quick-rail")!==null',
    { timeoutMs: 60_000 }
  )
  await h.driver.waitInWebview(
    `document.querySelector('[data-conversation="${a.conversationId}"] .composer textarea')?.value===${JSON.stringify(DRAFT)}`,
    { timeoutMs: 30_000 }
  )
  h.check('an unsent draft survives Reload Window')
  await h.setText(`[data-conversation="${a.conversationId}"] .composer textarea`, '')

  const mermaid = await h.send(
    a,
    '@claude Reply with exactly this and nothing else:\n\nMERMAID_OK\n\n```mermaid\nflowchart LR\n  A --> B\n```'
  )
  await h.waitReply(a, mermaid, 'MERMAID_OK')
  await h.driver.waitInWebview(
    `document.querySelector('[data-conversation="${a.conversationId}"] .md-diagram img')!==null`,
    { timeoutMs: 30_000 }
  )
  h.check('a Mermaid diagram renders under the webview content security policy')
  await h.driver.screenshot(join(OUTPUT, 'polish-01-mermaid.png'))

  const background = await (
    await h.view()
  ).evaluate(`getComputedStyle(document.body).backgroundColor`)
  const settingsPath = join(h.userDataDir, 'User', 'settings.json')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  writeFileSync(
    settingsPath,
    JSON.stringify({ ...settings, 'workbench.colorTheme': 'Default Light Modern' }, null, 2)
  )
  await h.driver.waitInWebview(
    `document.documentElement.classList.contains('chorus-theme-light')`,
    { timeoutMs: 30_000 }
  )
  await h.driver.poll(
    'light Chorus palette',
    async () =>
      (await (await h.view()).evaluate(`getComputedStyle(document.body).backgroundColor`)) !==
      background
  )
  await h.driver.screenshot(join(OUTPUT, 'polish-02-light.png'))
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  h.check('the Chorus palette follows a VS Code theme change', { from: background })

  const before = await h.send(
    a,
    '@claude Run this exact shell command once: touch attention-proof.txt. Then reply APPROVED_OK.'
  )
  await h.native({ action: 'open', path: join(h.alpha, 'code.txt') })
  await h.driver.poll(
    'Chorus hidden behind a file',
    async () =>
      (await h.native({ action: 'state' })).tabs.find((tab) => tab.label === 'Chorus')?.active ===
      false
  )
  await h.driver.poll(
    'native approval notification',
    async () => /needs a decision/.test(await workbenchText('.notification-toast')),
    120_000
  )
  const toast = await workbenchText('.notification-toast')
  assert.match(toast, /Allow once/)
  assert.match(toast, /Deny/)
  await h.driver.poll('attention badge', async () =>
    /Chorus \(1\)/.test(await workbenchText('.statusbar-item'))
  )
  const badge = await workbenchText('.activitybar .badge-content')
  assert.match(badge, /1/)
  h.check('a hidden Chorus raises a native decision notification with its choices', toast)
  await h.driver.screenshot(join(OUTPUT, 'polish-03-attention.png'))
  await (
    await h.driver.workbench()
  ).evaluate(
    `Array.from(document.querySelectorAll('.notification-toast a.monaco-button, .notification-toast .monaco-button')).find((button)=>button.textContent==='Allow once').click()`
  )
  await h.driver.poll(
    'the approved command on disk',
    () => existsSync(join(h.alpha, 'attention-proof.txt')),
    120_000
  )
  h.check('Allow once in a native notification reaches the real agent and the command ran')
  await h.driver.poll(
    'attention cleared',
    async () => !/Chorus \(/.test(await workbenchText('.statusbar-item'))
  )
  h.check('the badge and status clear once the decision is made')

  await h.driver.command('Chorus: Open')
  await h.driver.waitInWebview('document.querySelector(".quick-rail")!==null')
  await h.waitReply(a, before, 'APPROVED_OK')
  const MOVED = 'A draft that moves with the tab'
  await h.setText(`[data-conversation="${a.conversationId}"] .composer textarea`, MOVED)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  await h.native({ action: 'command', command: 'workbench.action.moveEditorToNewWindow' })
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  await h.driver.waitInWebview(
    `document.querySelector('[data-conversation="${a.conversationId}"] .composer textarea')?.value===${JSON.stringify(MOVED)} && document.querySelector('[data-conversation="${a.conversationId}"]')?.textContent.includes('APPROVED_OK')`,
    { timeoutMs: 30_000 }
  )
  h.check('moving the Chorus tab to a new window keeps the transcript and the draft')
  await h.driver.screenshot(join(OUTPUT, 'polish-04-complete.png'))
} catch (error) {
  console.error(error)
  if (h.driver !== undefined)
    await h.driver.screenshot(join(OUTPUT, 'polish-failure.png')).catch(() => undefined)
  process.exitCode = 1
} finally {
  h.save()
  await h.close()
}
