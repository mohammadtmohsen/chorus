import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureBuilt, launch, wait } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REMOTE =
  process.env.REVIEW_DRIVE_REMOTE ?? 'git@gitlab.com:mohammad.t.mohsen/chorus-review-sandbox.git'
let IID = Number(process.env.REVIEW_DRIVE_IID ?? '0')
const TARGET = process.env.REVIEW_DRIVE_TARGET ?? 'main'
const FILE = process.env.REVIEW_DRIVE_FILE ?? 'src/list.ts'
const REQUESTED_LINE = process.env.REVIEW_DRIVE_LINE
const CLICKS = Number(process.env.REVIEW_DRIVE_CLICKS ?? '3')
const SECRETS =
  process.env.REVIEW_DRIVE_SECRETS ??
  join(homedir(), 'Library/Application Support/@chorus/desktop/agent-secrets.json')
const PROJECT_ID = 'review-comment-drive'
const BODY = `chorus review drive ${String(Date.now())}`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const say = (text) => {
  console.log(`\n── ${text}`)
}

ensureBuilt()
const base = realpathSync(mkdtempSync(join(tmpdir(), 'chorus-review-drive-')))
const userData = join(base, 'data')
const projectRoot = join(base, 'project')
const pusher = join(base, 'pusher')
mkdirSync(userData, { recursive: true })

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const openMergeRequest = () => {
  const branch = `drive/${String(Date.now())}`
  git(pusher, 'switch', '-q', '-c', branch, `origin/${TARGET}`)
  const path = join(pusher, FILE)
  writeFileSync(
    path,
    readFileSync(path, 'utf8')
      .replace('items.length + 5', 'items.length * 5')
      .replace('items.length + 12', 'items.length * 12')
      .replace('  return items\n', '  return items.filter(Boolean)\n')
  )
  git(pusher, 'commit', '-q', '-am', `drive ${branch}`)
  const pushed = spawnSync(
    'git',
    [
      'push',
      '-o',
      'merge_request.create',
      '-o',
      `merge_request.target=${TARGET}`,
      '-o',
      `merge_request.title=Review drive ${branch}`,
      'origin',
      branch,
    ],
    { cwd: pusher, encoding: 'utf8' }
  )
  git(pusher, 'switch', '-q', TARGET)
  const found = /merge_requests\/(\d+)/.exec(`${pushed.stdout}${pushed.stderr}`)
  if (pushed.status !== 0 || found === null) {
    throw new Error(`could not open a merge request: ${pushed.stderr.slice(-400)}`)
  }
  return Number(found[1])
}

const env = { CHORUS_WORKBENCH_CACHE: resolve(HERE, '../../../.workbench-cache') }

const sql = (statement) => {
  const result = spawnSync('sqlite3', ['-json', join(userData, 'chorus.v2.db'), statement], {
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`sqlite3: ${result.stderr}`)
  return result.stdout.trim() === '' ? [] : JSON.parse(result.stdout)
}

const seedProject = () => {
  const columns = sql('pragma table_info(projects)')
  const values = {
    id: PROJECT_ID,
    name: 'review-drive',
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

const surfaces = async () => {
  const response = await fetch(`http://127.0.0.1:${String(app.debugPort)}/json/list`)
  return (await response.json()).filter(
    (target) => target.type === 'page' && target.url.includes('workbench.html')
  )
}

async function attach(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => socket.addEventListener('open', r, { once: true }))
  let id = 0
  const send = (method, params = {}) =>
    new Promise((resolvePromise, reject) => {
      const mine = ++id
      const onMessage = (message) => {
        const reply = JSON.parse(message.data)
        if (reply.id !== mine) return
        socket.removeEventListener('message', onMessage)
        if (reply.error !== undefined) {
          reject(new Error(`${method}: ${JSON.stringify(reply.error).slice(0, 300)}`))
          return
        }
        resolvePromise(reply.result)
      }
      socket.addEventListener('message', onMessage)
      socket.send(JSON.stringify({ id: mine, method, params }))
      setTimeout(() => {
        reject(new Error(`timed out: ${method}`))
      }, 60_000)
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(
        `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
      )
    }
    return result.result?.value
  }
  const json = async (body) =>
    JSON.parse(await evaluate(`(async () => JSON.stringify(await (async () => { ${body} })()))()`))
  return { send, evaluate, json, close: () => socket.close() }
}

const click = async (target, x, y) => {
  await target.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await target.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  })
  await target.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  })
}

const press = async (target, key, code, keyCode) => {
  await target.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
  })
  await target.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
  })
}

const typeText = async (target, text) => {
  for (const character of text) {
    await target.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: character,
      text: character,
      unmodifiedText: character,
    })
    await target.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character })
  }
}

const readReview = async () =>
  page(
    `return await window.chorus.readGitReview({ projectId: '${PROJECT_ID}', iid: ${String(IID)} })`
  )

const postedCount = (review) =>
  review.threads.filter((thread) => thread.notes.some((note) => note.body === BODY)).length

const widgetState = (surface) =>
  surface.json(`
    const widgets = [...document.querySelectorAll('.review-widget')]
    const draft = widgets.some((w) =>
      [...w.querySelectorAll('.comment-form')].some(
        (n) =>
          n.textContent.replace(/\u00a0/g, ' ').includes(${JSON.stringify(BODY)}) ||
          [...n.querySelectorAll('textarea')].some((t) => t.value.includes(${JSON.stringify(BODY)}))
      )
    )
    const shown = widgets.some((w) =>
      [...w.querySelectorAll('.comment-body, .review-comment-contents')].some((n) => n.textContent.replace(/\u00a0/g, ' ').includes(${JSON.stringify(BODY)}))
    )
    const toasts = [...document.querySelectorAll('.notifications-toasts .notification-toast, .notification-list-item')]
      .map((n) => n.textContent.replace(/\\s+/g, ' ').trim())
      .filter((t) => t !== '')
    return { widgets: widgets.length, draft, shown, toasts }
  `)

const lineRect = (surface, line) =>
  surface.json(`
    const modified = document.querySelector('.monaco-diff-editor .editor.modified')
    if (modified === null) return null
    const number = [...modified.querySelectorAll('.line-numbers')].find((n) => n.textContent.trim() === '${String(line)}')
    if (number === undefined) return null
    const top = number.closest('[style*="top"]')?.style.top ?? number.parentElement.style.top
    const line = [...modified.querySelectorAll('.view-lines .view-line')].find((n) => n.style.top === top)
    const rect = (line ?? number).getBoundingClientRect()
    return { x: rect.left + 30, y: rect.top + rect.height / 2, text: line?.textContent ?? null }
  `)

const commentInput = (surface) =>
  surface.json(`
    const input = document.querySelector('.review-widget .comment-form .monaco-editor, .review-widget .comment-form textarea')
    if (input === null) return null
    const rect = input.getBoundingClientRect()
    return { x: rect.left + 20, y: rect.top + Math.min(rect.height / 2, 12) }
  `)

const widgetShape = (surface) =>
  surface.json(`
    const widget = document.querySelector('.review-widget')
    const walk = (node, depth) =>
      depth > 4 ? '' : [...node.children].map((child) => '  '.repeat(depth) + child.tagName.toLowerCase() + '.' + [...child.classList].join('.') + '\\n' + walk(child, depth + 1)).join('')
    return {
      active: document.activeElement === null ? null : document.activeElement.tagName + '.' + [...document.activeElement.classList].join('.'),
      shape: widget === null ? null : walk(widget, 0).slice(0, 3000),
    }
  `)

const commentButton = (surface) =>
  surface.json(`
    const button = [...document.querySelectorAll('.review-widget .monaco-button, .review-widget .monaco-text-button')]
      .find((b) => b.textContent.trim() === 'Comment')
    if (button === undefined) return null
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  `)

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

const restoreLinkHandler = () => {
  const restored = spawnSync(
    'osascript',
    [
      '-l',
      'JavaScript',
      '-e',
      'ObjC.import("CoreServices"); $.LSSetDefaultHandlerForURLScheme($("chorus"), $("dev.chorus.desktop"))',
    ],
    { encoding: 'utf8' }
  )
  return restored.status === 0 && restored.stdout.trim() === '0'
}

let cleaned = false
const cleanupAll = () => {
  if (cleaned) return
  cleaned = true
  try {
    cleanup()
  } catch (error) {
    failures.push(`process cleanup: ${error.message}`)
  }
  if (!restoreLinkHandler()) failures.push('the chorus:// handler was not restored')
  rmSync(base, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await Promise.race([app?.stop() ?? Promise.resolve(), wait(10_000)]).catch(() => undefined)
    try {
      if (app?.pid !== undefined) process.kill(app.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') failures.push(`stopping the app: ${error.message}`)
    }
    cleanupAll()
    console.log(`\ninterrupted by ${signal}; cleaned up ${base}`)
    process.exit(130)
  })
}

console.log(`fixture ${base}`)
console.log(`body "${BODY}"`)
let surface
try {
  say('fixture')
  git(base, 'clone', '-q', REMOTE, projectRoot)
  git(base, 'clone', '-q', REMOTE, pusher)
  if (IID === 0) IID = openMergeRequest()
  check('a fresh merge request to review', IID > 0, `!${String(IID)}`)
  check('the sandbox cloned', existsSync(join(projectRoot, FILE)), REMOTE)
  if (existsSync(SECRETS)) copyFileSync(SECRETS, join(userData, 'agent-secrets.json'))
  check('the GitLab token file was copied', existsSync(join(userData, 'agent-secrets.json')))

  app = await launch({ userData, keepData: true, env })
  await app.until(`typeof window.chorus === 'object'`, { timeout: 120_000 })
  await eventually(
    'the database to be created',
    () =>
      existsSync(join(userData, 'chorus.v2.db')) &&
      sql(`select count(*) as n from sqlite_master where name = 'projects'`)[0].n > 0,
    120_000
  )
  await app.stop()
  await wait(1_000)
  seedProject()

  app = await launch({ userData, keepData: true, env })
  await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
  await app.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await eventually(
    'the project on the rail',
    () => page(`return document.querySelector('[data-rail-project="${PROJECT_ID}"]') !== null`),
    60_000
  )
  await wait(1_500)
  await page(`document.querySelector('[data-rail-project="${PROJECT_ID}"]').click(); return true`)
  const [target] = await eventually(
    'the editor surface',
    async () => {
      const found = await surfaces()
      return found.length > 0 ? found : false
    },
    240_000
  )
  surface = await attach(target)
  await surface.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await eventually(
    'the workbench to render',
    () => surface.evaluate(`document.querySelector('.monaco-workbench .part.editor') !== null`),
    180_000
  )

  say('review')
  const loaded = await eventually(
    'the review to load',
    async () => {
      const reply = await readReview()
      if (reply.outcome?.kind === 'failed') return { failed: reply.outcome.failure }
      return reply.outcome?.kind === 'ready' && reply.review !== null ? reply : false
    },
    180_000
  )
  if ('failed' in loaded) throw new Error(`the review failed to load: ${loaded.failed}`)
  const before = loaded.review
  const display = before.version.display
  check(
    'the review shows the merged result',
    display.headSha !== before.version.headSha,
    `version ${String(before.version.id)}, display head ${display.headSha.slice(0, 9)}`
  )
  const file = before.files.find((entry) => entry.path === FILE)
  check('the file is commentable', file?.commentable === true, JSON.stringify(file))
  const existing = postedCount(before)
  const taken = new Set(
    before.threads.filter((thread) => thread.path === FILE).map((thread) => thread.newLine)
  )
  const line =
    REQUESTED_LINE === undefined
      ? [6, 13, 32, 7, 14, 5, 12, 8, 15, 4, 11, 9, 16, 3, 10].find(
          (candidate) => !taken.has(candidate)
        )
      : Number(REQUESTED_LINE)
  check('a line without a thread to comment on', line !== undefined, `line ${String(line)}`)

  const opened = await page(
    `return await window.chorus.openGitDiff({ projectId: '${PROJECT_ID}', iid: ${String(IID)}, versionId: ${String(before.version.id)}, path: '${FILE}' })`
  )
  check('the diff opened', opened.failure === null, JSON.stringify(opened))
  await eventually('line to render in the diff', () => lineRect(surface, line), 60_000)

  say('target branch moves after the review loaded')
  writeFileSync(
    join(pusher, 'README.md'),
    `${readFileSync(join(pusher, 'README.md'), 'utf8')}\nmoved ${new Date().toISOString()}\n`
  )
  git(pusher, 'commit', '-q', '-am', 'move the target branch')
  git(pusher, 'push', '-q', 'origin', TARGET)
  check('pushed to the target branch', true, git(pusher, 'rev-parse', '--short', 'HEAD'))
  await wait(5_000)

  say('comment')
  const runCommand = async (title) => {
    await press(surface, 'F1', 'F1', 112)
    await wait(600)
    await surface.send('Input.insertText', { text: title })
    await wait(800)
    await press(surface, 'Enter', 'Enter', 13)
    await wait(600)
  }
  await runCommand('Collapse All Comments')
  const settledPlace = await eventually(
    'line to render after collapsing',
    () => lineRect(surface, line),
    20_000
  )
  await click(surface, settledPlace.x, settledPlace.y)
  await wait(300)
  await runCommand('Add Comment on Current Selection')
  const button = await eventually('the comment widget', () => commentButton(surface), 20_000).catch(
    async (error) => {
      console.log(
        `palette: ${JSON.stringify(
          await surface.json(`
            const rows = [...document.querySelectorAll('.quick-input-list .monaco-list-row')].slice(0, 6).map((r) => r.textContent.trim())
            const active = document.activeElement
            return { rows, active: active === null ? null : active.tagName + '.' + [...active.classList].join('.'), widgets: document.querySelectorAll('.review-widget').length }
          `)
        )}`
      )
      throw error
    }
  )
  const input = await eventually('the comment input', () => commentInput(surface), 20_000)
  await click(surface, input.x, input.y)
  await wait(300)
  await typeText(surface, BODY)
  const typed = await eventually(
    'the draft to hold the text',
    async () => (await widgetState(surface)).draft,
    10_000
  ).catch(async (error) => {
    console.log(`widget: ${JSON.stringify(await widgetShape(surface))}`)
    throw error
  })
  check('the draft holds the comment text', typed === true)
  const landed = []
  for (let i = 0; i < CLICKS; i++) {
    landed.push((await commentButton(surface)) !== null)
    await click(surface, button.x, button.y)
    await wait(80)
  }
  check(
    `all ${String(CLICKS)} clicks landed on an open draft`,
    landed.every(Boolean),
    JSON.stringify(landed)
  )
  const seen = new Set()
  const settleUntil = Date.now() + 15_000
  while (Date.now() < settleUntil) {
    for (const text of (await widgetState(surface)).toasts) seen.add(text)
    await wait(250)
  }

  say('result')
  const settled = await widgetState(surface)
  for (const text of settled.toasts) seen.add(text)
  const held = await page(
    `return await window.chorus.readActiveGitReview({ projectId: '${PROJECT_ID}' })`
  )
  const heldHead = held.review?.version.display.headSha ?? null
  const refusedAfterPost = [...seen].some(
    (text) => /merge request changed/i.test(text) && /could not refresh/.test(text)
  )
  check(
    'the race happened: the write met a moved merged head',
    (heldHead !== null && heldHead !== display.headSha) || refusedAfterPost,
    `held ${display.headSha.slice(0, 9)} → ${String(heldHead?.slice(0, 9))}, refresh refused after post: ${String(refusedAfterPost)}`
  )
  const after = (await readReview()).review
  const posted = after === null ? -1 : postedCount(after) - existing
  check(
    `exactly one comment with this body in the review after ${String(CLICKS)} clicks`,
    posted === 1,
    `${String(posted)} posted`
  )
  check('the draft closed', settled.draft === false, JSON.stringify(settled))
  check(
    'no error was shown at any point',
    ![...seen].some((text) => /changed|could not|failed|Error/i.test(text)),
    JSON.stringify([...seen].map((text) => text.slice(0, 160)))
  )
  check('the posted comment shows in the editor', settled.shown === true, JSON.stringify(settled))
} catch (error) {
  failures.push(error.message)
  console.log(`\nSTOPPED: ${error.message}`)
  if (app !== undefined) {
    appendFileSync(join(tmpdir(), 'review-comment-drive.output.log'), app.output())
    console.log(`app output: ${join(tmpdir(), 'review-comment-drive.output.log')}`)
  }
  if (surface !== undefined) {
    await widgetState(surface)
      .then((state) => {
        console.log(`editor: ${JSON.stringify(state)}`)
      })
      .catch(() => undefined)
  }
} finally {
  surface?.close()
  if (app !== undefined) await app.stop().catch(() => undefined)
  try {
    cleanup()
  } catch (error) {
    failures.push(`process cleanup: ${error.message}`)
  }
  await wait(500)
  cleanupAll()
}

console.log(`\n${failures.length === 0 ? 'ALL HELD' : `${String(failures.length)} FAILED`}`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
