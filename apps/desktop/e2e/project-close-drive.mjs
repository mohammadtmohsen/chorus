import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureBuilt, launch, wait } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ID = 'project-close-drive'
const SERIAL = 'FAKE-PHONE'
const NOTE = 'Keep the idempotency keys.'
const DRAFT = ' Typed just before closing.'
const PORTS = { told: 39_211, silent: 39_212 }

const only = (process.env.CLOSE_DRIVE_ONLY ?? 'notes,phone,editor').split(',')
const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const say = (text) => {
  console.log(`\n── ${text}`)
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'chorus-close-')))
const userData = join(base, 'data')
const bin = join(base, 'bin')
const state = join(base, 'state')
const projectRoot = join(base, 'project')
for (const directory of [userData, bin, state, projectRoot])
  mkdirSync(directory, { recursive: true })
writeFileSync(join(projectRoot, 'notes.md'), '# project-close fixture\n')
const listed = join(state, 'listed')
const present = join(state, 'present')
const adbLog = join(state, 'adb.log')
const psBroken = join(state, 'ps-broken')
writeFileSync(listed, '')
writeFileSync(present, '')
writeFileSync(adbLog, '')

const script = (name, body) => {
  const path = join(bin, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

script(
  'adb',
  `#!/bin/bash
serial=""
if [ "$1" = "-s" ]; then serial="$2"; shift 2; fi
echo "$serial $*" >> "${adbLog}"
case "$1" in
  track-devices)
    last="__none__"
    while true; do
      now="$(cat "${listed}" 2>/dev/null)"
      if [ "$now" != "$last" ]; then
        last="$now"
        body="$now"
        if [ -n "$body" ]; then body="$body"$'\\n'; fi
        printf '%04x%s' "\${#body}" "$body"
      fi
      sleep 0.1
    done
    ;;
  reverse)
    if ! grep -q "^$serial" "${present}" 2>/dev/null; then
      echo "adb: error: device '$serial' not found" >&2
      exit 1
    fi
    ;;
esac
exit 0
`
)
script(
  'ps',
  `#!/bin/bash
if [ -e "${psBroken}" ]; then echo 'ps: simulated failure' >&2; exit 1; fi
exec /bin/ps "$@"
`
)
const shell = script(
  'login-shell',
  `#!/bin/zsh
if [[ "$1" == "-lic" && "$2" == 'printf %s "$PATH"' ]]; then
  real=$(/bin/zsh -lic 'printf %s "$PATH"' 2>/dev/null)
  printf %s "${bin}:$real"
  exit 0
fi
exec /bin/zsh "$@"
`
)

const env = {
  PATH: `${bin}:${process.env.PATH}`,
  SHELL: shell,
  CHORUS_WORKBENCH_CACHE: resolve(HERE, '../../../.workbench-cache'),
}

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
    name: 'close-drive',
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
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 240)})`)
}

const pressClose = async () => {
  const key = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 4 }
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

const rail = () =>
  page(`
    const tile = document.querySelector('[data-rail-project="${PROJECT_ID}"]')
    return tile === null
      ? { present: false }
      : {
          present: true,
          placement: tile.getAttribute('data-placement'),
          current: tile.getAttribute('aria-current'),
          state: tile.getAttribute('data-state'),
        }
  `)

const rooms = () =>
  page(`
    const answer = await window.chorus.readActiveSessions()
    const list = Array.isArray(answer) ? answer : (answer.sessions ?? [])
    return list.map((room) => ({ id: room.conversationId, project: room.projectId }))
  `)

const alertText = () =>
  page(`
    const node = document.querySelector('.notice--bad')
    return node === null ? null : node.textContent
  `)

const dialogOpen = () =>
  page(`return document.querySelector('[role="alertdialog"], [role="dialog"]') !== null`)

const surfaces = async () => {
  const response = await fetch(`http://127.0.0.1:${String(app.debugPort)}/json/list`)
  return (await response.json()).filter(
    (target) => target.type === 'page' && target.url.includes('workbench.html')
  )
}

const openProject = async () => {
  await wait(1_500)
  await page(`document.querySelector('[data-rail-project="${PROJECT_ID}"]').click(); return true`)
}

const waitClosed = async (what, timeoutMs = 60_000) =>
  eventually(
    what,
    async () => {
      const tile = await rail()
      const open = await rooms()
      return tile.current === null && open.length === 0 && (await surfaces()).length === 0
        ? tile
        : false
    },
    timeoutMs
  )

const hasComposer = () =>
  page(`return document.querySelector('textarea[role="combobox"]') !== null`)

const processOwners = () => {
  const found = spawnSync('find', [userData, '-path', '*process-owners/*.json'], {
    encoding: 'utf8',
  })
  return found.stdout.split('\n').filter((line) => line !== '')
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const serverProcesses = () =>
  execFileSync('/bin/ps', ['-Awwo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(join(userData, 'workbench-server')))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid))

const adbLines = () =>
  readFileSync(adbLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '')

async function notesFlow() {
  say('notes survive closing a project')
  await openProject()
  if (!(await eventually('the project to open', async () => (await rail()).current === 'true')))
    return
  const composed = await eventually('a composer', hasComposer, 20_000).catch(() => false)
  if (composed === false) {
    await page(`await window.chorus.beginConversation({ projectId: '${PROJECT_ID}' }); return true`)
    await eventually('a composer after starting a chat', hasComposer, 60_000)
  }
  const [room] = await eventually('a live room', async () => {
    const open = await rooms()
    return open.length > 0 ? open : false
  })
  check('a chat is open in the project', room !== undefined, room?.id)

  await eventually(
    'the note toggle',
    () =>
      page(
        `const toggle = document.querySelector('[aria-label="Show this chat\\'s note"]'); return toggle !== null && !toggle.disabled`
      ),
    90_000
  )
  await page(
    `document.querySelector('[aria-label="Show this chat\\'s note"]').click(); return true`
  )
  await eventually('the note field', () =>
    page(`return document.querySelector('.conversation-note-body') !== null`)
  )
  await page(`document.querySelector('.conversation-note-body').focus(); return true`)
  await app.send('Input.insertText', { text: NOTE })
  await eventually('the note to save', () =>
    page(
      `const note = await window.chorus.getConversationNote({ conversationId: '${room.id}' }); return note.body === ${JSON.stringify(NOTE)}`
    )
  )
  check('the note is typed into the real field and saved', true, NOTE)

  await app.send('Input.insertText', { text: DRAFT })
  await pressClose()
  await wait(300)
  check('closing an idle project asks nothing', (await dialogOpen()) === false)
  const stopping = await waitClosed('the project to close', 90_000).catch((error) => error.message)
  check(
    'the project closes',
    typeof stopping !== 'string',
    typeof stopping === 'string' ? stopping : JSON.stringify(stopping)
  )
  check('closing shows no failure', (await alertText()) === null, (await alertText()) ?? undefined)

  const kept = await page(
    `return await window.chorus.getConversationNote({ conversationId: '${room.id}' })`
  )
  check('the saved note is still stored', kept.body.startsWith(NOTE), JSON.stringify(kept.body))
  const journal = await page(
    `return window.chorus.readConversationNoteJournal({ conversationId: '${room.id}' })`
  )
  console.log(`      draft journal after close: ${JSON.stringify(journal).slice(0, 180)}`)

  await openProject()
  await eventually('the project to reopen', async () => (await rail()).current === 'true')
  await page(
    `document.querySelector('button[aria-label="Past conversations"]')?.click(); return true`
  )
  await eventually('the history list', () =>
    page(`return document.querySelector('.history-row') !== null`)
  )
  await page(`document.querySelector('.history-row').click(); return true`)
  await eventually('the chat to come back', hasComposer, 90_000)
  const shown = await eventually(
    'the note to show',
    () =>
      page(`
        const field = document.querySelector('.conversation-note-body')
        return field === null || field.value === '' ? false : field.value
      `),
    45_000
  ).catch((error) => error.message)
  check('the reopened chat shows the note', String(shown).includes(NOTE), JSON.stringify(shown))
  check(
    'the reopened chat keeps the draft typed just before closing',
    String(shown).includes(DRAFT.trim()),
    JSON.stringify(shown)
  )

  await wait(1_000)
  await pressClose()
  await waitClosed('the project to close again', 90_000)
}

async function capture(port) {
  await openProject()
  await eventually('the project to open', async () => (await rail()).current === 'true')
  await eventually('the editor surface', async () => (await surfaces()).length > 0, 240_000)
  const started = await page(`
    await window.chorus.configureTraffic({
      projectId: '${PROJECT_ID}',
      config: { origin: 'http://127.0.0.1:9', port: ${String(port)}, access: 'loopback' },
    })
    return await window.chorus.startTraffic({ projectId: '${PROJECT_ID}' })
  `)
  check(`capture starts on port ${String(port)}`, started.state?.capturing === true)
  writeFileSync(present, `${SERIAL}\tdevice\n`)
  writeFileSync(listed, `${SERIAL}\tdevice`)
  await eventually('the port to be forwarded to the phone', () =>
    adbLines().some((line) => line === `${SERIAL} reverse tcp:${String(port)} tcp:${String(port)}`)
  )
  check('the fake adb received the forward', true, `${SERIAL} tcp:${String(port)}`)
}

async function closeAfterUnplug(label, port) {
  const before = adbLines().length
  await pressClose()
  const closed = await waitClosed(`the project to close (${label})`, 45_000).catch(
    (error) => error.message
  )
  const alert = await alertText()
  check(
    `${label}: the project closes`,
    typeof closed !== 'string',
    typeof closed === 'string' ? `${closed} · alert: ${String(alert)}` : undefined
  )
  check(`${label}: no failure is shown`, alert === null, alert ?? undefined)
  const removals = adbLines()
    .slice(before)
    .filter((line) => line.includes('--remove'))
  console.log(`      removals tried: ${JSON.stringify(removals)}`)
  if (typeof closed === 'string') {
    writeFileSync(present, `${SERIAL}\tdevice\n`)
    writeFileSync(listed, `${SERIAL}\tdevice`)
    await wait(500)
    await pressClose()
    await waitClosed(`recovery from ${label}`, 45_000).catch(() => undefined)
    writeFileSync(present, '')
    writeFileSync(listed, '')
    await wait(500)
  }
  return { port, removals }
}

async function phoneFlow() {
  say('an unplugged phone that adb reports as gone')
  await capture(PORTS.told)
  writeFileSync(present, '')
  writeFileSync(listed, '')
  await wait(800)
  const told = await closeAfterUnplug('reported unplug', PORTS.told)
  check('reported unplug: no removal is even tried', told.removals.length === 0)

  say('a phone that vanishes before adb reports it')
  await capture(PORTS.silent)
  writeFileSync(present, '')
  const silent = await closeAfterUnplug('unreported unplug', PORTS.silent)
  check(
    'unreported unplug: the removal was tried and adb said not found',
    silent.removals.length > 0
  )
  writeFileSync(listed, '')
  await wait(300)
}

async function editorFlow() {
  say('an editor process that cannot be confirmed stopped')
  await openProject()
  await eventually('the project to open', async () => (await rail()).current === 'true')
  await eventually('the editor surface', async () => (await surfaces()).length > 0, 240_000)
  const reports = await eventually(
    'the extension host to attest its pid',
    () => {
      const found = processOwners()
      return found.length > 0 ? found : false
    },
    180_000
  )
  const owned = JSON.parse(readFileSync(reports[reports.length - 1], 'utf8'))
  check('the extension host reported itself', alive(owned.pid), `pid ${String(owned.pid)}`)
  await wait(4_000)
  const servers = serverProcesses()
  check('the editor server is running', servers.length > 0, `pids ${servers.join(',')}`)

  writeFileSync(psBroken, '')
  await pressClose()
  const shown = await eventually('a failure to show', alertText, 60_000).catch(
    (error) => error.message
  )
  check(
    'with inspection broken, the close reports failure',
    typeof shown === 'string' && shown.includes('Editor shutdown could not be confirmed'),
    String(shown)
  )
  const held = await rail()
  check('the project stays open for a retry', held.current === 'true', JSON.stringify(held))

  rmSync(psBroken)
  await wait(1_000)
  await pressClose()
  const closed = await waitClosed('the retried close', 60_000).catch((error) => error.message)
  check(
    'the retry closes the project',
    typeof closed !== 'string',
    typeof closed === 'string' ? closed : undefined
  )
  const left = await alertText()
  check('the failure is gone after the retry', left === null, left ?? undefined)
  if (left !== null) {
    const logged = spawnSync(
      'grep',
      ['-rhE', 'Workbench|Owned|shutdown', userData, '--include=*.log'],
      {
        encoding: 'utf8',
      }
    )
    console.log(
      `      main log:\n${logged.stdout.split('\n').slice(-24).join('\n').slice(0, 5000)}`
    )
    console.log(
      `      app output:\n${app
        .output()
        .split('\n')
        .filter((line) => /Workbench|Owned|shutdown|PID/.test(line))
        .slice(-24)
        .join('\n')
        .slice(0, 5000)}`
    )
  }
  await eventually('the extension host to exit', () => !alive(owned.pid), 20_000).catch(
    () => undefined
  )
  check('the extension host has exited', !alive(owned.pid), `pid ${String(owned.pid)}`)
  await eventually('the server to exit', () => serverProcesses().length === 0, 20_000).catch(
    () => undefined
  )
  check('the last project took the editor server with it', serverProcesses().length === 0)
}

const cleanup = () => {
  rmSync(psBroken, { force: true })
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

ensureBuilt()
console.log(`fixture ${base}`)
try {
  app = await launch({ userData, keepData: true, env })
  await app.until(`typeof window.chorus === 'object'`, { timeout: 120_000 })
  await app.stop()
  await wait(1_000)
  seedProject()

  app = await launch({ userData, keepData: true, env })
  await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
  await app.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await eventually('the project on the rail', async () => (await rail()).present === true)
  check('the seeded project is on the rail', true, JSON.stringify(await rail()))

  if (only.includes('notes')) await notesFlow()
  if (only.includes('phone')) await phoneFlow()
  if (only.includes('editor')) await editorFlow()
} catch (error) {
  failures.push(error.message)
  console.log(`\nSTOPPED: ${error.message}`)
  if (app !== undefined) {
    appendFileSync(join(tmpdir(), 'project-close-drive.output.log'), app.output())
    console.log(`app output: ${join(tmpdir(), 'project-close-drive.output.log')}`)
    await page(`return document.body.innerText.slice(0, 600)`)
      .then((text) => {
        console.log(`on screen: ${JSON.stringify(text)}`)
      })
      .catch(() => undefined)
  }
} finally {
  if (app !== undefined) await app.stop().catch(() => undefined)
  cleanup()
  await wait(500)
  cleanup()
  if (existsSync(base)) rmSync(base, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? 'ALL HELD' : `${String(failures.length)} FAILED`}`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
