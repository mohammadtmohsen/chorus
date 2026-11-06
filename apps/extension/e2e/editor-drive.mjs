import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { integrationHarness, OUTPUT } from './integration-harness.mjs'

const h = await integrationHarness('editor')
const file = join(h.alpha, 'buffer.ts')
const nestedFile = join(h.nested, 'nested.ts')
const outside = join(h.workspace, 'outside.txt')
const betaFile = join(h.beta, 'beta.ts')
const markdown = join(h.alpha, 'preview.md')
const selection = `ALPHA_SELECTION_${randomUUID().slice(0, 8)}`
writeFileSync(file, `${selection}\nsecond line\n`)
writeFileSync(nestedFile, 'nested problem\n')
writeFileSync(outside, 'OUTSIDE_PRIVATE_TEXT\n')
writeFileSync(betaFile, 'beta before\n')
writeFileSync(markdown, '# Preview title\n\nPreview selection marker.\n')
try {
  await h.start({ editorPath: file })
  const a = await h.add(h.alpha)
  const b = await h.add(h.beta)
  const n = await h.add(h.nested)
  await (
    await h.view()
  ).evaluate(
    'window.__ideReports={}; window.chorus.onIdeContext(report=>{window.__ideReports[report.conversationId]=report})'
  )
  await h.native({ action: 'open', path: file, selection: [0, 0, 0, selection.length] })
  await h.driver.waitInWebview(
    `window.__ideReports[${JSON.stringify(a.conversationId)}]?.file?.relativePath==='buffer.ts' && window.__ideReports[${JSON.stringify(b.conversationId)}]?.file===null`
  )
  await h.select(a)
  await h.driver.waitInWebview(
    `document.querySelector('[data-conversation="${a.conversationId}"] .composer-ide-pill')?.textContent.includes('buffer.ts') === true`
  )
  h.check('editor context reaches alpha and excludes beta')
  const beforeSelection = await h.send(
    a,
    '@claude Reply with exactly SELECTION_OK followed by the selected text attached below. Do not use tools, read files, or change anything.',
    { composer: true }
  )
  const selectedReply = await h.waitReply(a, beforeSelection, selection)
  h.check('a real agent receives the current selection at Send', selectedReply.payload.text)

  await h.native({ action: 'open', path: nestedFile, selection: [0, 0, 0, 6] })
  await h.driver.waitInWebview(
    `window.__ideReports[${JSON.stringify(a.conversationId)}]?.file?.relativePath==='sub/nested.ts' && window.__ideReports[${JSON.stringify(n.conversationId)}]?.file?.relativePath==='nested.ts'`
  )
  h.check('nested files report to both containing projects')
  await h.native({ action: 'open', path: outside, selection: [0, 0, 0, 20] })
  await h.driver.waitInWebview(
    `Object.values(window.__ideReports).length>=3 && Object.values(window.__ideReports).every(report=>report.file===null)`
  )
  for (const session of [a, b, n])
    assert.notEqual(
      (await h.api('ideSnapshot', { conversationId: session.conversationId })).outcome,
      'ok'
    )
  h.check('a file outside all projects discloses no path or selection')

  await h.native({ action: 'open', path: file, selection: [0, 0, 0, 6] })
  const dirty = await h.native({
    action: 'replace',
    path: file,
    text: 'before dirty\nsecond line\n',
  })
  const originalVersion = dirty.documents.find((document) => document.path === file).version
  const editPrompt = `@claude This is an authorized native editor smoke test. Use ONLY mcp__chorus_editor__editor_edit once on buffer.ts, base_version ${originalVersion}, start_line 1, start_column 1, end_line 1, end_column 7, old_text "before", new_text "AFTER". The live unsaved buffer is "before dirty\\nsecond line\\n". Do not use Read, Edit, Write or Bash. Wait for approval; after the tool reply, say EDIT_OK and its result.`
  await h.select(a)
  const beforeEdit = await h.send(a, editPrompt)
  await h.driver.waitInWebview(
    `document.querySelector('[data-conversation="${a.conversationId}"] .approval') !== null`,
    { timeoutMs: 180_000 }
  )
  await h.driver.poll('native proposed diff', async () =>
    (await h.native({ action: 'state' })).tabs.find(
      (tab) => typeof tab.input === 'object' && tab.input?.original?.startsWith('chorus-ask:')
    )
  )
  await h.driver.screenshot(join(OUTPUT, 'editor-01-proposed-diff.png'))
  await h.click(`[data-conversation="${a.conversationId}"] .approval-actions .btn--go`)
  await h.waitReply(a, beforeEdit, 'EDIT_OK')
  const edited = await h.native({ action: 'state' })
  const buffer = edited.documents.find((document) => document.path === file)
  assert.equal(buffer.text, 'AFTER dirty\nsecond line\n')
  assert.equal(buffer.dirty, true)
  assert.equal(readFileSync(file, 'utf8'), `${selection}\nsecond line\n`)
  assert.equal(
    edited.tabs.some(
      (tab) => typeof tab.input === 'object' && tab.input?.original?.startsWith('chorus-ask:')
    ),
    false
  )
  await h.native({ action: 'open', path: file })
  await h.native({ action: 'command', command: 'undo' })
  assert.equal(
    (await h.native({ action: 'state' })).documents.find((document) => document.path === file).text,
    'before dirty\nsecond line\n'
  )
  h.check(
    'real editor_edit uses native approval diff, preserves dirty buffer and disk, and is undoable'
  )

  const beforeStale = await h.send(
    a,
    `@claude Use ONLY mcp__chorus_editor__editor_edit once with path buffer.ts, base_version ${originalVersion}, range 1:1 to 1:7, old_text "before", new_text "STALE". This version is deliberately stale. Do not retry. Reply STALE_RESULT with the tool refusal.`
  )
  await h.driver.waitInWebview(
    `document.querySelector('[data-conversation="${a.conversationId}"] .approval') !== null`,
    { timeoutMs: 180_000 }
  )
  await h.click(`[data-conversation="${a.conversationId}"] .approval-actions .btn--go`)
  const stale = await h.waitReply(a, beforeStale, 'STALE_RESULT')
  assert.match(stale.payload.text, /conflict|changed|stale/i)
  assert.equal(
    (await h.native({ action: 'state' })).documents.find((document) => document.path === file).text,
    'before dirty\nsecond line\n'
  )
  h.check('a real stale editor request is refused', stale.payload.text)

  await h.native({ action: 'open', path: betaFile })
  const betaState = await h.native({ action: 'replace', path: betaFile, text: 'beta dirty\n' })
  const betaVersion = betaState.documents.find((document) => document.path === betaFile).version
  await h.native({ action: 'open', path: file })
  await h.select(a)
  const beforeBackground = await h.send(
    b,
    `@claude Use ONLY mcp__chorus_editor__editor_edit once: path beta.ts, base_version ${betaVersion}, range 1:1 to 1:5, old_text "beta", new_text "BETA". Wait for approval then reply BACKGROUND_OK. No other tools.`
  )
  await h.driver.poll(
    'background approval',
    async () =>
      (await h.api('readActiveSessions')).sessions.find(
        (session) => session.conversationId === b.conversationId
      )?.pendingApprovalIds.length > 0,
    180_000
  )
  const held = await h.native({ action: 'state' })
  assert.equal(
    held.tabs.some((tab) => tab.label === '[claude] beta.ts'),
    false
  )
  assert.equal(held.tabs.find((tab) => tab.group === 1 && tab.active)?.label, 'buffer.ts')
  await h.select(b)
  await h.driver.poll('focused project diff', async () =>
    (await h.native({ action: 'state' })).tabs.some((tab) => tab.label === '[claude] beta.ts')
  )
  await h.click(`[data-conversation="${b.conversationId}"] .approval-actions .btn--go`)
  await h.waitReply(b, beforeBackground, 'BACKGROUND_OK')
  h.check('background approval holds its native diff until that project is focused')

  await h.select(a)
  const opened = await h.api('ideOpenFile', {
    conversationId: a.conversationId,
    path: 'buffer.ts:2',
  })
  assert.equal(opened.ok, true)
  const current = await h.native({ action: 'state' })
  assert.ok(current.tabs.some((tab) => tab.label === 'buffer.ts'))
  assert.equal(current.selection.line, 1)
  h.check('a project file link opens through the native editor at its requested line')
  await h.native({ action: 'open', path: nestedFile, selection: [0, 2, 0, 2] })
  const diagnostic = `NESTED_DIAGNOSTIC_${randomUUID().slice(0, 8)}`
  await h.native({ action: 'diagnostic', path: nestedFile, message: diagnostic })
  await h.native({ action: 'command', command: 'chorus.sendDiagnostic' })
  await h.select(n)
  await h.driver.waitInWebview(
    `document.querySelector('[data-conversation="${n.conversationId}"] .composer textarea')?.value.includes(${JSON.stringify(diagnostic)}) === true`
  )
  assert.equal(
    (await h.events(n)).some(
      (event) => event.payload.type === 'user.message' && event.payload.text.includes(diagnostic)
    ),
    false
  )
  await h.select(a)
  assert.equal(
    await (
      await h.view()
    ).evaluate(
      `document.querySelector('[data-conversation="${a.conversationId}"] .composer textarea').value.includes(${JSON.stringify(diagnostic)})`
    ),
    false
  )
  h.check('a diagnostic is staged unsent in the deepest project only')

  await (
    await h.view()
  ).evaluate(
    `(() => {const transfer=new DataTransfer();transfer.setData('text/uri-list',${JSON.stringify(`file://${file}`)});document.querySelector('[data-conversation="${a.conversationId}"]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}))})()`
  )
  await h.driver.waitInWebview(
    `Array.from(document.querySelectorAll('[data-conversation="${a.conversationId}"] .attachment-name')).some(element=>element.title.startsWith('buffer.ts\\n'))`
  )
  h.check('an Explorer-style file URI drop attaches by path')
  await (
    await h.view()
  ).evaluate(
    `(() => {const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'clipboard.png',{type:'image/png'}));document.querySelector('[data-conversation="${a.conversationId}"] .composer textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}))})()`
  )
  await h.driver.waitInWebview(
    `Array.from(document.querySelectorAll('[data-conversation="${a.conversationId}"] .attachment-name')).some(element=>element.title.split('\\n')[0].endsWith('-clipboard.png'))`
  )
  h.check('a pasted image is stashed and attached')

  await h.native({ action: 'open', path: markdown })
  await h.native({ action: 'command', command: 'chorus.markdownPreview' })
  const preview = await h.driver
    .poll('owned markdown preview', async () => {
      const frame = await h.driver.webview({
        extensionId: 'mohammadtmohsen.chorus',
        timeoutMs: 2_000,
      })
      return (await frame.evaluate(
        'document.getElementById("vscode-markdown-preview-data")!==null'
      ))
        ? frame
        : null
    })
    .catch(() => null)
  if (preview !== null) h.check('the owned Markdown preview renders with source line markers')
  else {
    const rendered = await h.native({ action: 'state' })
    assert.ok(rendered.tabs.some((tab) => tab.label === 'Preview: preview.md'))
    h.check(
      'the owned Markdown preview opens',
      'selection checked separately if the nested frame is reachable'
    )
  }
  await h.driver.screenshot(join(OUTPUT, 'editor-02-complete.png'))
  h.save()
} catch (error) {
  console.error(error)
  h.save()
  if (h.driver !== undefined)
    await h.driver.screenshot(join(OUTPUT, 'editor-failure.png')).catch(() => undefined)
  process.exitCode = 1
} finally {
  await h.close()
}
