import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureBuilt, launch, wait } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ID = 'preview-selection-drive'
const ELECTRON_APP = resolve(HERE, '../node_modules/electron/dist/Electron.app')
const LABEL = 'from the rendered preview; lines are the enclosing block'
const skipAgent = process.env.PREVIEW_DRIVE_SKIP_AGENT === '1'
const only = process.env.PREVIEW_DRIVE_ONLY?.split(',') ?? null
const wanted = (name) => only === null || only.includes(name)

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const say = (text) => {
  console.log(`\n── ${text}`)
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'chorus-preview-')))
let userData = join(base, 'data')
const projectRoot = join(base, 'project')
mkdirSync(join(projectRoot, 'docs'), { recursive: true })
writeFileSync(
  join(projectRoot, 'docs', 'readme.md'),
  [
    '---',
    'title: Fixture front matter',
    '---',
    '',
    '# Preview heading',
    '',
    'First paragraph ALPHA sentence.',
    'It wraps onto a second source line.',
    '',
    '- Parent item BRAVO',
    '  - Nested child CHARLIE',
    '',
    'Closing paragraph DELTA.',
    '',
    '<section>Raw html block ECHO</section>',
    '',
    'After html FOXTROT.',
    '',
  ].join('\n')
)
mkdirSync(join(projectRoot, '.vscode'), { recursive: true })
writeFileSync(
  join(projectRoot, '.vscode', 'settings.json'),
  JSON.stringify({ 'files.autoSave': 'off' })
)
writeFileSync(join(projectRoot, 'docs', 'dirty.md'), '# Dirty file\n\nUnsaved HOTEL line.\n')
writeFileSync(join(projectRoot, 'docs', 'other.md'), '# Other file\n\nPlain GOLF line.\n')
writeFileSync(
  join(projectRoot, 'docs', 'big.md'),
  Array.from({ length: 1200 }, (_, index) => `Paragraph ${String(index)} ${'x'.repeat(70)}\n`).join(
    '\n'
  )
)

const env = {
  CHORUS_WORKBENCH_E2E_ROOTS: projectRoot,
  CHORUS_WORKBENCH_CACHE: resolve(HERE, '../../../.workbench-cache'),
  CHORUS_DEBUG: '1',
}

const sql = (statement) => {
  const result = spawnSync('sqlite3', ['-json', join(userData, 'chorus.v2.db'), statement], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`sqlite3: ${result.stderr}`)
  return result.stdout.trim() === '' ? [] : JSON.parse(result.stdout)
}

const seedProject = () => {
  const columns = sql('pragma table_info(projects)')
  const values = {
    id: PROJECT_ID,
    name: 'preview-drive',
    root: projectRoot,
    canonical_root: projectRoot,
    canonical_key: projectRoot.toLowerCase(),
    created_at: Date.now(),
    updated_at: Date.now(),
    last_opened_at: Date.now(),
  }
  const required = columns
    .filter((column) => column.notnull === 1 && column.dflt_value === null)
    .map((column) => column.name)
  const missing = required.filter((name) => values[name] === undefined)
  if (missing.length > 0) throw new Error(`no seed value for: ${missing.join(', ')}`)
  const names = Object.keys(values).filter((name) => columns.some((c) => c.name === name))
  const literals = names.map((name) =>
    typeof values[name] === 'number' ? String(values[name]) : `'${values[name]}'`
  )
  sql(`insert into projects (${names.join(', ')}) values (${literals.join(', ')})`)
}

let app
const page = async (body) =>
  JSON.parse(
    await app.evaluate(`(async () => JSON.stringify(await (async () => { ${body} })()))()`)
  )

const eventually = async (what, predicate, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await predicate()
      if (last !== false && last !== null && last !== undefined) return last
    } catch (error) {
      last = error.message
    }
    await wait(250)
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`)
}

const connect = async (url) => {
  const socket = new WebSocket(url)
  await new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', fail, { once: true })
  })
  let next = 0
  const pending = new Map()
  const children = new Set()
  const send = (method, params = {}, sessionId) =>
    new Promise((done, fail) => {
      next += 1
      pending.set(next, { done, fail })
      socket.send(
        JSON.stringify({
          id: next,
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        })
      )
    })
  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Target.attachedToTarget') {
      children.add(message.params.sessionId)
      send('Target.setAutoAttach', autoAttach, message.params.sessionId).catch(() => undefined)
    }
    if (message.method === 'Target.detachedFromTarget') children.delete(message.params.sessionId)
    const settle = pending.get(message.id)
    if (settle === undefined) return
    pending.delete(message.id)
    if (message.error === undefined) settle.done(message.result)
    else settle.fail(new Error(message.error.message))
  })
  await send('Target.setAutoAttach', autoAttach)
  return {
    send,
    children,
    close: () => {
      socket.close()
    },
  }
}

const evaluateIn = async (client, expression, contextId, sessionId) => {
  const reply = await client.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    },
    sessionId
  )
  if (reply.exceptionDetails !== undefined) {
    throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
  }
  return reply.result.value
}

let surface
const inSurface = (expression) => evaluateIn(surface, expression)

const previewFrames = async () => {
  const names = new Set(
    await inSurface(`[...document.querySelectorAll('iframe.webview')].map((node) => node.name)`)
  )
  const frames = new Map()
  for (const sessionId of [undefined, ...surface.children]) {
    const reply = await surface.send('Page.getFrameTree', {}, sessionId).catch(() => null)
    if (reply === null) continue
    const walk = (tree) => {
      frames.set(tree.frame.id, { ...tree.frame, sessionId })
      for (const child of tree.childFrames ?? []) walk(child)
    }
    walk(reply.frameTree)
  }
  return [...frames.values()]
    .filter((frame) => names.has(frames.get(frame.parentId)?.name))
    .map((frame) => ({ ...frame, webview: frames.get(frame.parentId).name }))
}

const inFrame = async (frame, expression) => {
  const { executionContextId } = await surface.send(
    'Page.createIsolatedWorld',
    { frameId: frame.id, worldName: 'preview-drive' },
    frame.sessionId
  )
  return evaluateIn(surface, expression, executionContextId, frame.sessionId)
}

const framesWithPreview = async () => {
  const ready = []
  for (const frame of await previewFrames()) {
    const source = await inFrame(
      frame,
      `document.querySelector('.markdown-body') === null ? null : JSON.parse(document.getElementById('vscode-markdown-preview-data').getAttribute('data-settings')).source`
    ).catch(() => null)
    if (source === null) continue
    const rect = await inSurface(
      `(() => { const f = document.querySelector('iframe.webview[name="${String(frame.webview)}"]'); if (f === null) return null; const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`
    )
    if (rect !== null && rect.width > 0) ready.push({ ...frame, source, rect })
  }
  return ready.sort((a, b) => a.rect.x - b.rect.x)
}

const pointIn = async (frame, selector) => {
  const inner = await inFrame(
    frame,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, height: r.height } })()`
  )
  return { x: frame.rect.x + inner.x + 8, y: frame.rect.y + inner.y + inner.height / 2 }
}

const clickAt = async (client, { x, y }, count = 1) => {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (let clickCount = 1; clickCount <= count; clickCount += 1) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount,
    })
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount,
    })
  }
}

const selectedIn = (frame) => inFrame(frame, `getSelection().toString()`)

const selectContents = (frame, selector) =>
  inFrame(
    frame,
    `(() => { const s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(document.querySelector(${JSON.stringify(selector)})); s.addRange(r); return s.toString() })()`
  )

const pill = () =>
  page(
    `const node = document.querySelector('.composer-ide-pill'); return node === null ? null : node.textContent`
  )

let conversationId
const snapshot = () =>
  page(`return await window.chorus.ideSnapshot({ conversationId: '${conversationId}' })`)

const focusSurface = async () => {
  execFileSync('open', ['-a', ELECTRON_APP])
  await surface.send('Page.bringToFront')
  await wait(400)
}

const clickComposer = async () => {
  await app.send('Page.bringToFront')
  const rect = await page(
    `const r = document.querySelector('textarea[role="combobox"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`
  )
  await clickAt(app, rect)
}

const openFile = async (path) => {
  const answer = await page(
    `return await window.chorus.ideOpenFile({ conversationId: '${conversationId}', path: ${JSON.stringify(path)} })`
  )
  return answer.ok === true ? true : false
}

const titleAction = (group, label) =>
  inSurface(`(() => {
    const groups = [...document.querySelectorAll('.editor-group-container')]
      .filter((node) => node.getBoundingClientRect().width > 0)
      .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
    const action = [...(groups[${String(group)}]?.querySelectorAll('.editor-actions a.action-label') ?? [])]
      .find((node) => (node.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(label)}))
    if (action === undefined) return false
    action.click()
    return true
  })()`)

const titleLabels = (group) =>
  inSurface(`(() => {
    const groups = [...document.querySelectorAll('.editor-group-container')]
      .filter((node) => node.getBoundingClientRect().width > 0)
      .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
    return [...(groups[${String(group)}]?.querySelectorAll('.editor-actions a.action-label') ?? [])]
      .map((node) => node.getAttribute('aria-label'))
  })()`)

const logTail = () => {
  try {
    return readFileSync(join(userData, 'logs', 'chorus.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('workbench context') || line.includes('editor snapshot'))
      .slice(-6)
      .map((line) => line.slice(0, 260))
      .join('\n')
  } catch {
    return '(no log)'
  }
}

const lastContext = () => {
  const lines = readFileSync(join(userData, 'logs', 'chorus.log'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('"workbench context"'))
  return JSON.parse(lines[lines.length - 1]).fields
}

const surfaces = async () => {
  const response = await fetch(`http://127.0.0.1:${String(app.debugPort)}/json/list`)
  return (await response.json()).filter(
    (target) => target.type === 'page' && target.url.includes('workbench.html')
  )
}

const hasComposer = () =>
  page(`return document.querySelector('textarea[role="combobox"]') !== null`)

const openProject = async () => {
  await eventually('the project on the rail', () =>
    page(`return document.querySelector('[data-rail-project="${PROJECT_ID}"]') !== null`)
  )
  await wait(1_500)
  await page(`document.querySelector('[data-rail-project="${PROJECT_ID}"]').click(); return true`)
}

const room = async () => {
  const composed = await eventually('a composer', hasComposer, 20_000).catch(() => false)
  if (composed === false) {
    await page(`await window.chorus.beginConversation({ projectId: '${PROJECT_ID}' }); return true`)
    await eventually('a composer after starting a chat', hasComposer, 90_000)
  }
  const sessions = await eventually('a live room', async () => {
    const answer = await page(`return await window.chorus.readActiveSessions()`)
    const list = Array.isArray(answer) ? answer : (answer.sessions ?? [])
    return list.length > 0 ? list : false
  })
  return sessions[0].conversationId
}

const enlargeWindow = async () => {
  const size = await page(
    `window.resizeTo(1800, 1050); await new Promise((done) => setTimeout(done, 1000)); return [outerWidth, outerHeight]`
  )
  console.log(`   window ${JSON.stringify(size)}`)
}

const attachSurface = async () => {
  const [target] = await eventually(
    'the editor surface',
    async () => {
      const found = await surfaces()
      return found.length > 0 ? found : false
    },
    240_000
  )
  await enlargeWindow()
  surface = await connect(target.webSocketDebuggerUrl)
  await eventually(
    'the gate handle',
    () => inSurface(`typeof window.__chorusGate === 'object'`),
    180_000
  )
}

async function sidePreview() {
  say('a preview opened to the side, the way the title bar does it')
  check(
    'the gate opens the Markdown source',
    await eventually('the source file', () => openFile('docs/readme.md'), 120_000)
  )
  await eventually(
    'the Open Preview action',
    () => titleAction(0, 'Open Preview to the Side'),
    120_000
  )
  const [frame] = await eventually(
    'the rendered preview',
    async () => {
      const ready = await framesWithPreview()
      return ready.length > 0 ? ready : false
    },
    120_000
  )
  check('the preview renders in a webview frame', frame !== undefined, frame?.source)
  return frame
}

async function noSelection() {
  say('no selection')
  await focusSurface()
  const text = await eventually('a pill for the preview', pill, 60_000)
  check('the pill names the previewed file', /^readme\.md:\d+$/.test(text), text)
  const shot = await snapshot()
  check(
    'the snapshot names the file with nothing quoted',
    shot.outcome === 'ok' &&
      shot.relativePath === 'docs/readme.md' &&
      shot.isEmpty === true &&
      shot.text === '' &&
      shot.preview === undefined,
    JSON.stringify(shot)
  )
}

async function realGesture(frame) {
  say('real clicks, then real focus into the composer')
  await focusSurface()
  await clickAt(surface, await pointIn(frame, '.markdown-body p.code-line'), 3)
  const focused = await eventually(
    'the click to give the surface focus',
    () => inSurface('document.hasFocus()'),
    5_000
  ).catch((error) => error.message)
  check('the click gives the surface focus', focused === true, String(focused))
  await wait(900)
  check('the triple-click selects a paragraph', (await selectedIn(frame)).includes('ALPHA'))
  await clickAt(surface, await pointIn(frame, '.markdown-body > p:nth-of-type(2)'), 3)
  await wait(900)
  const selected = await selectedIn(frame)
  check('a second selection replaces it', selected.includes('DELTA'), selected)
  const before = await pill()
  check(
    'the pill waits while focus stays in the preview',
    before !== 'readme.md:13-14',
    String(before)
  )
  await clickComposer()
  const left = await eventually(
    'focus to leave the surface',
    async () => (await inSurface('document.hasFocus()')) === false,
    5_000
  ).catch((error) => error.message)
  check('focus leaves the surface document', left === true, String(left))
  const after = await eventually(
    'the pill to show the second selection',
    async () => {
      const now = await pill()
      return now === 'readme.md:13-14' ? now : false
    },
    5_000
  ).catch((error) => error.message)
  check(
    'leaving the preview moves the pill',
    after === 'readme.md:13-14' && before !== after,
    `${String(before)} → ${after}`
  )
  const still = await selectedIn(frame)
  check('the selection survives the focus move', still.includes('DELTA'), still)
  const shot = await snapshot()
  check(
    'Send would quote the selection',
    shot.outcome === 'ok' &&
      shot.relativePath === 'docs/readme.md' &&
      shot.startLine === 13 &&
      shot.endLine === 14 &&
      shot.isEmpty === false &&
      shot.text.includes('DELTA') &&
      !shot.text.includes('ALPHA') &&
      shot.preview === true &&
      shot.editor === 'workbench' &&
      shot.modelVersion === undefined,
    JSON.stringify(shot)
  )
}

async function mapping(frame) {
  say('line mapping against the real rendered document')
  const cases = [
    {
      name: 'a parent list item and its nested child',
      selector: '.markdown-body > ul > li',
      startLine: 10,
      endLine: 12,
      needle: 'BRAVO',
    },
    {
      name: 'the nested child alone',
      selector: '.markdown-body ul ul li',
      startLine: 11,
      endLine: 12,
      needle: 'CHARLIE',
    },
    {
      name: 'a raw HTML block',
      selector: '.markdown-body section',
      startLine: 15,
      endLine: 16,
      needle: 'ECHO',
    },
    {
      name: 'rendered front matter',
      selector: '.frontmatter td',
      startLine: 1,
      endLine: 4,
      needle: 'Fixture front matter',
    },
  ]
  for (const item of cases) {
    const selected = await selectContents(frame, item.selector)
    const shot = await snapshot()
    check(
      item.name,
      shot.outcome === 'ok' &&
        shot.startLine === item.startLine &&
        shot.endLine === item.endLine &&
        shot.text === selected &&
        shot.text.includes(item.needle),
      `${String(shot.startLine)}-${String(shot.endLine)} ${JSON.stringify(selected)}`
    )
  }
}

async function sendForReal(frame) {
  say('a real message to a real agent')
  await focusSurface()
  await clickAt(surface, await pointIn(frame, '.markdown-body > p:nth-of-type(2)'), 3)
  await wait(500)
  const selected = await selectedIn(frame)
  check('the second selection is the closing paragraph', selected.includes('DELTA'), selected)
  await clickComposer()
  await wait(800)
  const prompt =
    '@claude Repeat the exact selected text from the editor context in this message, then stop. Use no tools.'
  await app.send('Input.insertText', { text: prompt })
  await wait(300)
  const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })
  const sent = await eventually(
    'the message in the log',
    () => {
      const [row] = sql(
        `select seq, type, payload from events where conversation_id = '${conversationId}' and payload like '%${LABEL}%' order by seq limit 1`
      )
      return row ?? false
    },
    30_000
  )
  const payload = sent.payload
  check('the logged message names the file', payload.includes('docs/readme.md'), sent.type)
  check('the logged message carries the preview label', payload.includes(LABEL))
  check('the logged message quotes the selection', payload.includes('Closing paragraph DELTA'))
  check('the logged message carries no edit version', !/readme\.md:\d+(-\d+)?` `v\d+/.test(payload))
  const start = payload.indexOf('Editor context')
  console.log(`   logged: ${payload.slice(start, start + 200)}`)
  const answer = await eventually(
    'the agent to answer',
    () => {
      const rows = sql(
        `select seq, actor, type, payload from events where conversation_id = '${conversationId}' and seq > ${String(sent.seq)} and actor not in ('user', 'system') and type not like '%reasoning%' and payload like '%DELTA%' order by seq limit 1`
      )
      return rows[0] ?? false
    },
    180_000
  ).catch((error) => error.message)
  check(
    'the agent saw the selected text',
    typeof answer === 'object',
    typeof answer === 'object'
      ? `${answer.actor} ${answer.type} ${answer.payload.slice(0, 160)}`
      : answer
  )
}

async function dirtyBuffer() {
  say('an unsaved buffer behind the preview')
  check('the file opens', await openFile('docs/dirty.md'))
  await wait(1_000)
  await eventually(
    'the Open Preview action for the dirty file',
    async () =>
      (await titleAction(0, 'Open Preview to the Side')) ||
      (await titleAction(1, 'Open Preview to the Side')),
    30_000
  ).catch(async (error) => {
    console.log(`   viewport ${String(await inSurface('innerWidth'))}`)
    console.log(`   group 0 actions: ${JSON.stringify(await titleLabels(0))}`)
    console.log(`   group 1 actions: ${JSON.stringify(await titleLabels(1))}`)
    console.log(
      `   groups: ${JSON.stringify(
        await inSurface(
          `[...document.querySelectorAll('.editor-group-container')].map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.width), n.querySelector('.tab.active')?.getAttribute('aria-label')] })`
        )
      )}`
    )
    throw error
  })
  const frame = await eventually(
    'the dirty file preview',
    async () => {
      const ready = await framesWithPreview()
      return ready.find((candidate) => candidate.source.endsWith('dirty.md')) ?? false
    },
    60_000
  )
  await focusSurface()
  const source = await eventually(
    'the source line',
    () =>
      inSurface(`(() => {
        const node = [...document.querySelectorAll('.monaco-editor .view-line')]
          .find((candidate) => candidate.textContent.includes('HOTEL'))
        if (node === undefined) return false
        const r = node.getBoundingClientRect()
        return { x: r.x + 40, y: r.y + r.height / 2 }
      })()`),
    20_000
  )
  await clickAt(surface, source)
  await wait(500)
  await surface.send('Input.insertText', { text: 'edited ' })
  const tab = await eventually(
    'the tab to show unsaved changes',
    () => inSurface(`document.querySelector('.tab.dirty') !== null`),
    5_000
  ).catch((error) => error.message)
  check('the editor itself says the buffer is unsaved', tab === true, String(tab))
  await eventually(
    'the preview to render the edit',
    async () => (await inFrame(frame, `document.body.innerText`)).includes('edited'),
    10_000
  )
  await clickAt(surface, await pointIn(frame, '.markdown-body p.code-line'), 3)
  await wait(900)
  const shot = await snapshot()
  check(
    'the preview reports the unsaved buffer',
    shot.outcome === 'ok' && shot.isDirty === true && shot.text.includes('edited'),
    JSON.stringify(shot)
  )
  check(
    'the tab still says unsaved at that moment',
    (await inSurface(`document.querySelector('.tab.dirty') !== null`)) === true
  )
}

async function twoPreviews(side) {
  say('two previews side by side')
  await focusSurface()
  const source = await inSurface(`(() => {
    const groups = [...document.querySelectorAll('.editor-group-container')]
      .filter((node) => node.getBoundingClientRect().width > 0)
      .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
    const editor = groups[0]?.querySelector('.monaco-editor .view-lines')
    if (!editor) return null
    const r = editor.getBoundingClientRect()
    return { x: r.x + 40, y: r.y + 10 }
  })()`)
  await clickAt(surface, source)
  await wait(800)
  console.log(`   group 0 actions: ${JSON.stringify(await titleLabels(0))}`)
  await eventually('the reopen action', () => titleAction(0, 'Open as Preview'), 30_000)
  const both = await eventually(
    'two rendered previews',
    async () => {
      const ready = await framesWithPreview()
      return ready.length >= 2 ? ready : false
    },
    60_000
  )
  check('both variants render at once', both.length === 2, `${String(both.length)} frames`)
  const [left, right] = both
  check('the two previews are separate frames', left.webview !== right.webview)
  check(
    'the reopened preview takes the same frame path',
    (await inSurface(`document.querySelectorAll('iframe.webview').length`)) >= 2
  )

  await focusSurface()
  await clickAt(surface, await pointIn(left, '.markdown-body p.code-line'), 3)
  await wait(700)
  await clickAt(surface, await pointIn(right, '.markdown-body > p:nth-of-type(2)'), 3)
  await wait(700)
  check('the left preview keeps its selection', (await selectedIn(left)).includes('ALPHA'))
  check('the right preview keeps its selection', (await selectedIn(right)).includes('DELTA'))
  const rightShot = await snapshot()
  check(
    'only the active right preview is read',
    rightShot.outcome === 'ok' &&
      rightShot.text.includes('DELTA') &&
      !rightShot.text.includes('ALPHA'),
    JSON.stringify(rightShot)
  )
  await clickAt(surface, await pointIn(left, '.markdown-body p.code-line'), 3)
  await wait(700)
  const leftShot = await snapshot()
  check(
    'only the active left preview is read',
    leftShot.outcome === 'ok' &&
      leftShot.text.includes('ALPHA') &&
      !leftShot.text.includes('DELTA'),
    JSON.stringify(leftShot)
  )
  check('the opened side preview is still addressable', side.webview !== null)
}

async function tooLarge() {
  say('a selection over the byte cap')
  check('the big file opens', await openFile('docs/big.md'))
  await wait(800)
  await eventually(
    'the Open Preview action for the big file',
    async () =>
      (await titleAction(0, 'Open Preview to the Side')) ||
      (await titleAction(1, 'Open Preview to the Side')),
    30_000
  )
  const frame = await eventually(
    'the big preview',
    async () => {
      const ready = await framesWithPreview()
      return ready.find((candidate) => candidate.source.endsWith('big.md')) ?? false
    },
    90_000
  )
  await focusSurface()
  await clickAt(surface, await pointIn(frame, '.markdown-body p.code-line'), 1)
  await wait(800)
  const selected = await selectContents(frame, 'body')
  const shot = await snapshot()
  check(
    'the existing tooLarge outcome applies',
    shot.outcome === 'tooLarge' && shot.selectedBytes > 64 * 1024,
    `${String(selected.length)} chars → ${JSON.stringify(shot).slice(0, 120)}`
  )
  await inFrame(frame, `getSelection().removeAllRanges()`)
}

async function textEditor() {
  say('a text editor still reports as it always did')
  check('the other file opens', await openFile('docs/other.md'))
  await wait(1_500)
  await focusSurface()
  const line = await eventually(
    'the rendered source line',
    () =>
      inSurface(`(() => {
        const node = [...document.querySelectorAll('.monaco-editor .view-line')]
          .find((candidate) => candidate.textContent.includes('GOLF'))
        if (node === undefined) return false
        const r = node.getBoundingClientRect()
        return { x: r.x + 40, y: r.y + r.height / 2 }
      })()`),
    20_000
  )
  await clickAt(surface, line, 3)
  await wait(700)
  const shot = await eventually(
    'the editor snapshot',
    async () => {
      const now = await snapshot()
      return now.outcome === 'ok' && now.relativePath === 'docs/other.md' && now.text !== ''
        ? now
        : false
    },
    10_000
  ).catch((error) => error.message)
  check(
    'raw text, lines and a version, with no preview flag',
    typeof shot === 'object' &&
      shot.startLine === 3 &&
      shot.text.includes('Plain GOLF line.') &&
      shot.preview === undefined &&
      typeof shot.modelVersion === 'number',
    JSON.stringify(shot)
  )
  const text = await eventually(
    'the pill on the text editor',
    async () => {
      const now = await pill()
      return now !== null && now.startsWith('other.md:3') ? now : false
    },
    5_000
  ).catch((error) => error.message)
  check('the pill follows the text editor', text.startsWith('other.md:3'), text)
}

async function restored() {
  say('a restored session, with no click in the editor')
  check('the source reopens', await openFile('docs/readme.md'))
  await wait(1_000)
  await eventually(
    'the Open Preview action again',
    async () =>
      (await titleAction(0, 'Open Preview to the Side')) ||
      (await titleAction(1, 'Open Preview to the Side')),
    30_000
  )
  const frame = await eventually(
    'a preview to leave active',
    async () => {
      const ready = await framesWithPreview()
      return ready.find((candidate) => candidate.source.endsWith('readme.md')) ?? false
    },
    60_000
  )
  await focusSurface()
  await clickAt(surface, await pointIn(frame, '.markdown-body p.code-line'), 1)
  await wait(1_200)
  const first = await pill()
  console.log(`   before quitting: ${String(first)}`)
  surface.close()
  await app.stop()
  await wait(2_000)
  app = await launch({ userData, keepData: true, env })
  await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
  await app.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await openProject()
  conversationId = await room()
  await attachSurface()
  const text = await eventually(
    'a pill with no click in the editor',
    async () => {
      const now = await pill()
      return now !== null && /\.md:\d+/.test(now) ? now : false
    },
    120_000
  ).catch((error) => error.message)
  check('the pill returns by itself', /\.md:\d+/.test(text), text)
  const context = lastContext()
  check(
    'that report comes from the restored preview',
    context.scheme === 'file' && context.editorTypeId.includes('webview'),
    `${String(context.scheme)} ${String(context.editorTypeId)}`
  )
}

const cleanup = () => {
  const listing = execFileSync('/bin/ps', ['-Awwo', 'pid=,command='], { encoding: 'utf8' })
  for (const line of listing.split('\n')) {
    if (!line.includes(base)) continue
    const pid = Number.parseInt(line.trim(), 10)
    if (!Number.isInteger(pid) || pid === process.pid) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      continue
    }
  }
}

const restoreProtocolOwner = () => {
  spawnSync('osascript', [
    '-l',
    'JavaScript',
    '-e',
    'ObjC.import("CoreServices"); $.LSSetDefaultHandlerForURLScheme($("chorus"), $("dev.chorus.desktop"))',
  ])
}

const freshProfile = async (name) => {
  if (surface !== undefined) surface.close()
  if (app !== undefined) await app.stop()
  userData = join(base, name)
  mkdirSync(userData, { recursive: true })
  app = await launch({ userData, keepData: true, env })
  await app.until(`typeof window.chorus === 'object'`, { timeout: 120_000 })
  await app.stop()
  await wait(1_000)
  seedProject()
  app = await launch({ userData, keepData: true, env })
  await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
  await openProject()
  conversationId = await room()
  console.log(`conversation ${conversationId}`)
  await attachSurface()
  check('the editor surface and gate handle are up', true)
  return sidePreview()
}

ensureBuilt()
console.log(`fixture ${base}`)
try {
  if (wanted('main')) {
    const side = await freshProfile('main')
    await noSelection()
    await realGesture(side)
    await mapping(side)
    if (skipAgent) console.log('\n(agent turn skipped)')
    else await sendForReal(side)
    await twoPreviews(side)
    await tooLarge()
    await textEditor()
    await restored()
  }
  if (wanted('dirty')) {
    await freshProfile('dirty')
    await dirtyBuffer()
  }
} catch (error) {
  failures.push(error.message)
  console.log(`\nSTOPPED: ${error.message}`)
  console.log(`main log tail:\n${logTail()}`)
  if (app !== undefined) {
    const outputPath = join(tmpdir(), 'preview-selection-drive.output.log')
    writeFileSync(outputPath, app.output())
    console.log(`app output: ${outputPath}`)
  }
} finally {
  if (failures.length > 0) console.log(`main log tail:\n${logTail()}`)
  if (surface !== undefined) surface.close()
  if (app !== undefined) await app.stop().catch(() => undefined)
  cleanup()
  await wait(500)
  cleanup()
  restoreProtocolOwner()
  if (existsSync(base))
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}

console.log(`\n${failures.length === 0 ? 'ALL HELD' : `${String(failures.length)} FAILED`}`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
