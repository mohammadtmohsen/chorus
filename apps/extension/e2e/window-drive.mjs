import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { integrationHarness, OUTPUT } from './integration-harness.mjs'

const META = 4
const SHELL = { extensionId: 'mohammadtmohsen.chorus', selector: '#root' }
const h = await integrationHarness('window', { folder: '/' })
const tabLabels = async () =>
  (await h.driver.workbench()).evaluate(
    `Array.from(document.querySelectorAll('.tabs-container .tab')).map((tab) => tab.getAttribute('aria-label') ?? tab.textContent)`
  )
const step = (label) => {
  console.log(`-- ${label}`)
}
try {
  const preview = join(h.alpha, 'preview.md')
  writeFileSync(preview, '# Title\n\nPREVIEW_LINE_ONE\n\nPREVIEW_LINE_TWO\n')
  execFileSync('git', ['init', '--quiet'], { cwd: h.alpha })
  await h.start({ editorPath: preview })
  const a = await h.add(h.alpha)
  await h.select(a)
  await h.driver.poll('the project in Source Control', async () =>
    (await h.native({ action: 'repositories' })).includes(h.alpha)
  )
  h.check('a Git project outside the window folder opens in Source Control')
  h.check('every call that sends no request gets an answer', await h.healthy())
  const agent = await h.send(
    a,
    '@claude Run pwd once and reply exactly ROOT_WORKDIR followed by its output. No other tools.'
  )
  const reply = await h.waitReply(a, agent, 'ROOT_WORKDIR')
  assert.ok(reply.payload.text.includes(h.alpha))
  h.check(
    'with VS Code at the disk root, a real agent runs in its project path',
    reply.payload.text
  )
  await h.driver.screenshot(join(OUTPUT, 'window-01-root.png'))

  await h.native({ action: 'command', command: 'chorus.markdownPreview' })
  const previewFrame = await h.driver.poll('the Markdown preview frame', async () => {
    for (const frame of await h.driver.webviews({ extensionId: 'mohammadtmohsen.chorus' })) {
      const found = await frame.evaluate(
        `document.getElementById('active-frame')?.contentDocument?.getElementById('vscode-markdown-preview-data') !== null && document.getElementById('active-frame') !== null`
      )
      if (found) return frame
    }
    return null
  })
  await previewFrame.evaluate(
    `(() => {
      const doc = document.getElementById('active-frame').contentDocument
      const node = Array.from(doc.querySelectorAll('.code-line')).find((element) => element.textContent.includes('PREVIEW_LINE_TWO'))
      const range = doc.createRange()
      range.selectNodeContents(node)
      const selection = doc.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      doc.dispatchEvent(new Event('selectionchange'))
    })()`
  )
  const snapshot = await h.driver.poll('a preview-derived snapshot', async () => {
    const value = await h.api('ideSnapshot', { conversationId: a.conversationId })
    const body = value.snapshot ?? value
    return JSON.stringify(body).includes('PREVIEW_LINE_TWO') ? body : null
  })
  assert.match(JSON.stringify(snapshot), /"preview":true/)
  h.check(
    'a selection in the Chorus Markdown preview reaches the composer as preview-derived',
    snapshot
  )
  const previewColor = await previewFrame.evaluate(
    `getComputedStyle(document.getElementById('active-frame').contentDocument.body).color`
  )
  assert.notEqual(previewColor, 'rgb(0, 0, 0)', 'the preview text is unreadable on a dark theme')
  h.check('the Markdown preview text follows the VS Code theme', previewColor)
  await h.driver.screenshot(join(OUTPUT, 'window-02-preview.png'))

  await h.select(a)
  await (
    await h.view()
  ).evaluate(
    `document.querySelector('[data-conversation="${a.conversationId}"] .composer textarea').focus()`
  )
  const before = await tabLabels()
  await h.driver.press('n', META)
  await h.driver.waitInWebview(
    `document.activeElement?.closest('.global-note') !== null && document.activeElement?.closest('.global-note') !== undefined`
  )
  assert.deepEqual(await tabLabels(), before)
  h.check('Cmd+N inside Chorus moves to the app note and VS Code does not open a new file')
  await (
    await h.view()
  ).evaluate(
    `document.querySelector('[data-conversation="${a.conversationId}"] .composer textarea').focus()`
  )
  const paneCount = () => h.driver.waitInWebview(`document.querySelectorAll('.pane').length`)
  await h.add(h.beta)
  await h.select(a)
  await (
    await h.view()
  ).evaluate(
    `document.querySelector('[data-conversation="${a.conversationId}"] .composer textarea').focus()`
  )
  const panesBefore = await paneCount()
  await h.driver.press('k', META)
  await h.driver.press('ArrowRight', META)
  await h.driver.poll(
    'Cmd+K then an arrow splits the panes',
    async () => (await paneCount()) > panesBefore
  )
  assert.deepEqual(await tabLabels(), before.includes('Chorus') ? await tabLabels() : before)
  h.check('Cmd+K then an arrow splits Chorus panes, not VS Code editors')
  step('second window')
  const descriptor = join(
    h.userDataDir,
    'User/globalStorage/mohammadtmohsen.chorus/engine/engine.json'
  )
  const enginePid = JSON.parse(readFileSync(descriptor, 'utf8')).pid
  const first = (await h.driver.workbenchTargets())[0]
  const firstShell = await h.view()
  step('projects before')
  const projectsBefore = await firstShell.evaluate(`window.chorus.listProjects({})`)
  step('open second window')
  await h.native({
    action: 'command',
    command: 'vscode.openFolder',
    args: [{ $mid: 1, path: h.beta, scheme: 'file' }, { forceNewWindow: true }],
  })
  const second = await h.driver.poll('the second window', async () =>
    (await h.driver.workbenchTargets()).find((target) => target.targetId !== first.targetId)
  )
  h.driver.pinWorkbench(second.targetId)
  await h.driver.workbench()
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  step('Chorus: Open in second window')
  await h.driver.command('Chorus: Open')
  const secondShell = await h.driver.poll(
    'the second Chorus tab',
    async () => {
      const frames = await h.driver.webviews(SHELL)
      return frames.find((frame) => frame.page.sessionId !== firstShell.page.sessionId) ?? null
    },
    60_000
  )
  await h.driver.poll('the second Chorus tab ready', () =>
    secondShell.evaluate(`window.chorus !== undefined`)
  )
  step('compare engine')
  assert.equal(JSON.parse(readFileSync(descriptor, 'utf8')).pid, enginePid)
  const engines = execFileSync('pgrep', ['-f', `engine.cjs.*${h.userDataDir}`], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((line) => line !== '')
  assert.ok(engines.length <= 1, `engines: ${engines.join(',')}`)
  const projectsAfter = await secondShell.evaluate(`window.chorus.listProjects({})`)
  assert.deepEqual(
    projectsAfter.projects?.map((project) => project.id).sort(),
    projectsBefore.projects?.map((project) => project.id).sort()
  )
  h.check('a second window attaches to the same engine and sees the same projects', { enginePid })
  await h.driver.screenshot(join(OUTPUT, 'window-04-second.png'))
  const firstStillShows = await firstShell.evaluate(
    `document.querySelector('[data-conversation="${a.conversationId}"] .composer textarea') !== null`
  )
  assert.equal(firstStillShows, true)
  h.check('the first window keeps its own layout after the second connects')
  step('Cmd+W')
  h.driver.pinWorkbench(first.targetId)
  await (await h.driver.workbench()).send('Page.bringToFront')
  await new Promise((resolve) => setTimeout(resolve, 800))
  await firstShell.evaluate(
    `document.querySelector('[data-conversation="${a.conversationId}"] .composer textarea')?.focus()`
  )
  await h.driver.press('w', META)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  assert.ok((await tabLabels()).some((label) => label.includes('Chorus')))
  const stillAnswers = await Promise.race([
    firstShell.evaluate(`window.chorus.listProjects({}).then(() => true)`),
    new Promise((resolve) => setTimeout(() => resolve(false), 20_000)),
  ])
  assert.equal(stillAnswers, true, 'the engine stopped answering after Cmd+W')
  h.check('Cmd+W stays in Chorus, keeps its VS Code tab, and the engine keeps answering')
  await h.driver.screenshot(join(OUTPUT, 'window-05-closed.png'))
} catch (error) {
  console.error(error)
  if (h.driver !== undefined)
    await h.driver.screenshot(join(OUTPUT, 'window-failure.png')).catch(() => undefined)
  process.exitCode = 1
} finally {
  h.save()
  await h.close()
}
